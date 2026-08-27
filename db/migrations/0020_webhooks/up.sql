-- 0020_webhooks — outbound webhook subscriptions, the disposition outbox, and the delivery log
-- (roadmap P2-10).
--
-- Roadmap P2-10's DB line: "app.webhooks + app.webhook_deliveries". This adds a third table the
-- roadmap does not name, `runtime.webhook_outbox`, and that table is the whole design. Everything
-- else here is bookkeeping around it.
--
-- ## Why an outbox and not "the runtime POSTs on completion"
--
-- The event a webhook reports is "this session reached a terminal disposition". That fact becomes
-- true inside the transaction that writes it. Three ways to get from there to an HTTP request:
--
--   1. **POST from the runtime, inline.** Wrong twice over. It puts a customer-controlled endpoint
--      on the respondent's critical path — their redirect now waits on somebody's slow server — and
--      it fires for transactions that later ROLL BACK, so a receiver learns about completions that
--      did not happen. A webhook that lies about the past is worse than a webhook that is late.
--   2. **Enqueue an ops.jobs row from the runtime.** ADR-001 forbids it: `runtime_writer` has no
--      business writing to the control plane's queue, and giving it that grant to save a table
--      would put a hole in the plane boundary for the convenience of one feature.
--   3. **Append a row in the runtime plane, in the same transaction, and let the worker drain it.**
--      The transactional-outbox pattern. The row commits if and only if the disposition does, so
--      the outbox cannot describe a session that does not exist and cannot miss one that does.
--
-- (3) is what this migration builds. The cost is at-least-once rather than exactly-once delivery,
-- which is why `event_key` exists — see below.
--
-- ## Why a TRIGGER and not an INSERT inside runtime.submit_page
--
-- `submit_page` is where a disposition is set today. A trigger on the transition instead of a line
-- in that function, for the reason ADR-002 gives for `content.tg_draft_only` alongside its RLS
-- policies: the function is ONE writer. A sweeper marking sessions ABANDONED, a support script
-- fixing a stuck row, a future resume path — each would have to remember to append, and the one
-- that forgets produces a silently missing webhook, which is the failure nobody notices until a
-- client asks why their reconciliation is short. The trigger is on the fact, not on the caller.
--
-- ## Signing, and why the secret is not in this table's SELECT grant
--
-- The signature is HMAC-SHA256 over `{timestamp}.{body}` and the header carries both — the
-- construction Stripe popularised, and the reason to copy it is that signing the body ALONE is
-- replayable forever: an attacker who captures one valid request can resend it at any time and it
-- verifies. Binding a timestamp into the signed string lets the receiver reject anything stale, and
-- the timestamp cannot be edited without breaking the MAC.
--
-- `app.webhooks.secret` is therefore the most sensitive column in the control plane. It is column-
-- REVOKEd from `authoring`: the studio can create, list and rotate a subscription without ever
-- reading the secret back, which is what makes "show the secret once at creation" enforceable
-- rather than a UI convention. Only the worker's role reads it, through a definer function.
--
-- ## The URL is an SSRF vector, and it is the SAME one survey.http is
--
-- A customer-supplied URL fetched by our server, with our network position. 0019's sibling in
-- apps/runtime (`script/egress.ts`) already answers this — resolve, check every address against the
-- private/link-local/metadata ranges, connect to the pinned address — and the delivery worker
-- reuses that module rather than growing a second, subtly different set of rules. The database's
-- job is narrower and stated as constraints: https only, no userinfo, no IP literal. A hostname
-- that RESOLVES somewhere private cannot be caught here, because a CHECK cannot do DNS, and
-- pretending otherwise in a constraint comment would be the false assurance 0019 warns about.

SET lock_timeout = '3s';
SET statement_timeout = '120s';

/* ------------------------------------------------------------------ *
 * 1. Registries
 * ------------------------------------------------------------------ */

CREATE TYPE app.webhook_event AS ENUM (
  'session.completed',
  'session.screenout',
  'session.quota_full',
  'session.terminated',
  'session.abandoned',
  'version.published',
  'export.ready'
);
COMMENT ON TYPE app.webhook_event IS
  'What a subscription can ask for. The session.* values are a DELIBERATE COARSENING of '
  'runtime.disposition rather than a mirror of it: a receiver''s integration branches on "did this '
  'person finish" and not on the eight-way disposition registry, and the two lists changing '
  'independently is the point — adding a disposition must not silently add an event type nobody '
  'subscribed to. runtime.webhook_event_for() is the single mapping, and it maps the three '
  'non-redirect dispositions to session.abandoned.';

CREATE TYPE app.webhook_delivery_status AS ENUM ('pending', 'delivered', 'failed', 'blocked');
COMMENT ON TYPE app.webhook_delivery_status IS
  '`blocked` is separate from `failed` on purpose: a failure is the receiver''s server misbehaving '
  'and is retried, while blocked is OUR refusal to make the request at all — a URL that resolves '
  'to a private address, a disabled subscription. Collapsing them would make an SSRF attempt look '
  'like a flaky endpoint in every dashboard, and would have us retry a request we have decided not '
  'to make.';

/* ------------------------------------------------------------------ *
 * 2. app.webhooks — the subscriptions
 * ------------------------------------------------------------------ */

CREATE TABLE app.webhooks (
  id            app.ulid PRIMARY KEY,
  org_id        app.ulid NOT NULL REFERENCES app.organizations (id) ON DELETE CASCADE,
  -- NULL = every project in the org. A column rather than a junction table because a subscription
  -- is either org-wide or for one project in practice, and the two-row case is served by two
  -- subscriptions with clearer semantics than a set nobody can read at a glance.
  project_id    app.ulid REFERENCES app.projects (id) ON DELETE CASCADE,
  url           text NOT NULL,
  -- The HMAC key. NOT NULL and no default: a subscription without a secret is an unsigned webhook,
  -- and an unsigned webhook is an endpoint anyone who learns the URL can forge. The application
  -- generates it; the database refuses to store a short one.
  secret        text NOT NULL,
  events        app.webhook_event[] NOT NULL,
  enabled       boolean NOT NULL DEFAULT true,
  description   text NOT NULL DEFAULT '',
  created_by    uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  -- https only, and the checks a CHECK can actually make. See the header on what it cannot.
  CONSTRAINT webhooks_url_https CHECK (url LIKE 'https://%'),
  -- No userinfo: `https://metadata@evil.example/` is a URL whose host most readers get wrong, and
  -- a credential in a stored URL is a credential in every log line that prints it.
  CONSTRAINT webhooks_url_no_userinfo CHECK (position('@' IN split_part(url, '/', 3)) = 0),
  -- No IP literal. An allowlist of hostnames is a thing an operator can audit; a bare address is
  -- how the private ranges get reached without a DNS record to look at.
  CONSTRAINT webhooks_url_no_ip_literal CHECK (
    split_part(url, '/', 3) !~ '^\[?[0-9a-fA-F:.]+\]?(:[0-9]+)?$'),
  CONSTRAINT webhooks_url_bounded CHECK (length(url) BETWEEN 12 AND 2048),
  -- 32 bytes of entropy, as hex or base64url, is the floor. A short secret is a forgeable
  -- signature, and the failure is silent: every signature verifies, so nothing looks wrong.
  CONSTRAINT webhooks_secret_length CHECK (length(secret) >= 32),
  -- An empty subscription receives nothing and looks configured, which is the worst of both.
  CONSTRAINT webhooks_events_nonempty CHECK (cardinality(events) > 0),
  -- 0019''s helper, cast to text[]. A CHECK cannot contain a subquery (0A000) and no built-in
  -- deduplicates an array without one; reusing that function rather than writing a second is the
  -- same reason the delivery worker reuses script/egress.ts rather than growing its own SSRF rules.
  CONSTRAINT webhooks_events_distinct CHECK (content.array_is_distinct(events::text[]))
);

COMMENT ON TABLE app.webhooks IS
  'Outbound webhook subscriptions (API §2.16, roadmap P2-10). ORG-SCOPED and not version-scoped: '
  'unlike content.redirects, where the target is part of what a version publishes, a subscription '
  'is an integration the org owns and expects to keep working across versions — pinning it to a '
  'version would mean re-creating it on every publish, and a client whose webhook stopped at the '
  'next wave would be right to call that a bug.';
COMMENT ON COLUMN app.webhooks.secret IS
  'The HMAC-SHA256 key. COLUMN-REVOKED from `authoring` (see the GRANTs below), so the studio can '
  'create, list and rotate a subscription without ever reading the secret back — which is what '
  'makes "shown once at creation" an enforced property rather than a UI convention. The delivery '
  'worker reads it through app.webhook_claim(), which is the only path to it.';
COMMENT ON COLUMN app.webhooks.project_id IS
  'NULL = every project in the org. A nullable column rather than a junction table: a subscription '
  'is org-wide or single-project in practice, and two subscriptions read more clearly than a set.';
COMMENT ON CONSTRAINT webhooks_secret_length ON app.webhooks IS
  'A short HMAC key is a forgeable signature, and the failure mode is silent — every request '
  'verifies, nothing looks wrong, and the endpoint is open to anyone who guesses. 32 characters is '
  'the floor for 32 bytes rendered as hex or base64url.';

CREATE INDEX webhooks_org_enabled_idx ON app.webhooks (org_id) WHERE enabled;

CREATE TRIGGER webhooks_touch BEFORE UPDATE ON app.webhooks
  FOR EACH ROW EXECUTE FUNCTION app.tg_touch_updated_at();

ALTER TABLE app.webhooks ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.webhooks FORCE ROW LEVEL SECURITY;

-- admin and up. A webhook subscription exfiltrates completion data to an arbitrary endpoint, so
-- the bar is the one for org configuration and not the one for editing a survey: a programmer who
-- could add a subscription could quietly forward every completion to themselves.
CREATE POLICY webhooks_select ON app.webhooks FOR SELECT TO authoring
USING (org_id = app.current_org() AND app.has_role('admin'));
CREATE POLICY webhooks_insert ON app.webhooks FOR INSERT TO authoring
WITH CHECK (org_id = app.current_org() AND app.has_role('admin'));
CREATE POLICY webhooks_update ON app.webhooks FOR UPDATE TO authoring
USING (org_id = app.current_org() AND app.has_role('admin'))
WITH CHECK (org_id = app.current_org() AND app.has_role('admin'));
CREATE POLICY webhooks_delete ON app.webhooks FOR DELETE TO authoring
USING (org_id = app.current_org() AND app.has_role('admin'));
COMMENT ON POLICY webhooks_select ON app.webhooks IS
  'admin (rank 60) and up, NOT programmer. A subscription forwards completion data to an arbitrary '
  'endpoint, which is an org-configuration decision rather than a survey-editing one: a programmer '
  'who could add one could quietly forward every completion to themselves. The column REVOKE on '
  '`secret` is the second layer — even an admin reads the row without the key.';

-- COLUMN-LEVEL SELECT, enumerated, AFTER revoking what 0001 already granted. Two separate
-- mistakes had to be found here and both were silent.
--
-- FIRST: 0001 runs `ALTER DEFAULT PRIVILEGES IN SCHEMA app, content GRANT SELECT, INSERT, UPDATE,
-- DELETE ON TABLES TO authoring`, so this table arrived with full DML for `authoring` before any
-- line below executed. Its own comment says why — "RLS is what actually decides the rows" — which
-- is correct for a table whose every column is equally readable, and wrong for one with a signing
-- key in it. Any grant written here is ADDITIVE to a table-level SELECT that already exists, so the
-- revoke has to come first.
--
-- SECOND: my first attempt was `GRANT SELECT ON ... ; REVOKE SELECT (secret) ON ...`, and that
-- silently does nothing. A table-level SELECT is not the sum of its column privileges; it is its
-- own grant covering every column, present and future. `REVOKE SELECT (secret)` has nothing at the
-- column level to subtract, so it succeeds, reports nothing, and changes nothing. The only way to
-- withhold one column is to hold no table-level SELECT at all and name the columns instead.
--
-- The reason is a Postgres rule worth stating rather than working around by accident: a table-level
-- SELECT is not the sum of its column privileges, it is its own grant that covers every column
-- present and future. `REVOKE SELECT (secret)` cannot subtract from it — there is nothing at the
-- column level to take away — so the revoke succeeds, reports nothing, and changes nothing. The
-- only way to withhold one column is to never grant the table and to name the columns instead.
--
-- The cost is that a column added later is unreadable until this list grows. That is the right
-- direction for the failure to point: a new column nobody granted reads as "permission denied" and
-- gets noticed, where the reverse mistake is a secret that quietly becomes readable.
REVOKE ALL ON app.webhooks FROM authoring;
GRANT SELECT (id, org_id, project_id, url, events, enabled, description,
              created_by, created_at, updated_at)
  ON app.webhooks TO authoring;
GRANT INSERT, DELETE ON app.webhooks TO authoring;
-- UPDATE is granted at the TABLE level, secret included, deliberately: rotation is a write, and
-- writing a key you cannot read is exactly the asymmetry wanted here.
GRANT UPDATE ON app.webhooks TO authoring;

/* ------------------------------------------------------------------ *
 * 3. runtime.webhook_outbox — the transactional outbox
 * ------------------------------------------------------------------ */

CREATE TABLE runtime.webhook_outbox (
  id            app.ulid PRIMARY KEY,
  org_id        app.ulid NOT NULL,
  event         app.webhook_event NOT NULL,
  -- What happened, denormalized at append time. NOT a foreign key to the session and NOT a join at
  -- delivery time: the payload must describe the world as it was when the event occurred, because
  -- a webhook delivered after a retry storm that then reported the session's CURRENT state would
  -- be a different event than the one that fired.
  payload       jsonb NOT NULL,
  -- The receiver's idempotency key, and ours. At-least-once delivery is the cost of an outbox
  -- (see the header), so the contract with the receiver is "this key identifies this event; if you
  -- see it twice, it is the same event". Derived from the session and the event, so a duplicate
  -- append is impossible rather than merely unlikely.
  event_key     text NOT NULL UNIQUE,
  session_id    app.ulid,
  is_test       boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  -- Set when the worker has fanned this event out into deliveries. NOT deleted: an outbox row is
  -- the evidence that the event was observed, and a queue that erases its own history cannot
  -- answer "did this completion ever produce a webhook".
  dispatched_at timestamptz,
  CONSTRAINT webhook_outbox_payload_object CHECK (jsonb_typeof(payload) = 'object'),
  CONSTRAINT webhook_outbox_key_bounded CHECK (length(event_key) BETWEEN 8 AND 200)
);

COMMENT ON TABLE runtime.webhook_outbox IS
  'The transactional outbox. Appended by runtime.tg_session_webhook_event in the SAME TRANSACTION '
  'that sets a session''s disposition, so the row commits if and only if the disposition does — '
  'which is what makes it impossible for a receiver to learn about a completion that rolled back. '
  'In schema `runtime` and not `ops`, because ADR-001''s plane boundary means the runtime cannot '
  'write to the control plane''s queue, and opening that grant for one feature would put a hole in '
  'the boundary. The worker drains it through app.webhook_dispatch_batch().';
COMMENT ON COLUMN runtime.webhook_outbox.event_key IS
  'The idempotency key, UNIQUE. An outbox gives at-least-once delivery, so the contract with the '
  'receiver is "this key identifies this event; twice means once". Derived from the session and the '
  'event rather than random, which makes a duplicate append IMPOSSIBLE — the unique index refuses '
  'it — instead of merely unlikely.';
COMMENT ON COLUMN runtime.webhook_outbox.dispatched_at IS
  'When the worker fanned this event out. The row is NEVER deleted: it is the evidence the event '
  'was observed, and a queue that erases its own history cannot answer "did this completion ever '
  'produce a webhook" — which is the only question anyone asks about a webhook system.';

-- The drain query. Partial, on the undispatched tail, which in steady state is a handful of rows
-- out of millions — 0016's quota_counters_drift_idx and 0019's code_assets_unanalyzed_idx are the
-- same shape for the same reason.
CREATE INDEX webhook_outbox_pending_idx ON runtime.webhook_outbox (created_at)
  WHERE dispatched_at IS NULL;

ALTER TABLE runtime.webhook_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE runtime.webhook_outbox FORCE ROW LEVEL SECURITY;
-- NO POLICIES AND NO GRANTS AT ALL, and getting here took a correction worth recording.
--
-- My first version granted `INSERT ON runtime.webhook_outbox TO runtime_writer`, on the reasoning
-- that the trigger fires during that role's UPDATE and so needs its privilege. 0011's standing
-- assertion — "runtime_writer holds NO privilege on any table in app, content OR runtime" —
-- rejected it, and it was right to: ADR-009 makes that role's entire capability surface a set of
-- FUNCTION SIGNATURES (risk R3), because a role with table grants can be made to do things no
-- reviewed function chose to do. One table grant for one feature's convenience is how that
-- property is lost.
--
-- The fix is that `tg_session_webhook_event` is SECURITY DEFINER, so the append happens with the
-- function owner's privilege regardless of who performed the UPDATE. The runtime keeps exactly the
-- surface it had.

/* ------------------------------------------------------------------ *
 * 4. The event mapping and the trigger
 * ------------------------------------------------------------------ */

CREATE FUNCTION runtime.webhook_event_for(p_disposition runtime.disposition)
RETURNS app.webhook_event
LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = ''
AS $$
  SELECT CASE p_disposition
    WHEN 'COMPLETE'   THEN 'session.completed'
    WHEN 'SCREENOUT'  THEN 'session.screenout'
    WHEN 'QUOTA_FULL' THEN 'session.quota_full'
    WHEN 'QUALITY'    THEN 'session.terminated'
    WHEN 'DUPLICATE'  THEN 'session.terminated'
    WHEN 'FRAUD'      THEN 'session.terminated'
    WHEN 'TERMINATE'  THEN 'session.terminated'
    WHEN 'CUSTOM'     THEN 'session.terminated'
    ELSE 'session.abandoned'
  END::app.webhook_event
$$;
COMMENT ON FUNCTION runtime.webhook_event_for(runtime.disposition) IS
  'The ONE mapping from the eight-way disposition registry to the coarser subscribable event set. '
  'One function rather than a CASE at each call site so the two registries can change '
  'independently — adding a disposition changes this file and nothing else, and cannot silently '
  'start delivering to subscribers who never asked for it. QUALITY, DUPLICATE, FRAUD, TERMINATE '
  'and CUSTOM all map to session.terminated: a receiver''s integration branches on "did this person '
  'finish", and exposing our fraud taxonomy over a webhook would tell a panel vendor exactly which '
  'of their respondents we flagged and why.';

CREATE FUNCTION runtime.tg_session_webhook_event() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  -- Only on the transition INTO a terminal disposition, and only once. `IS DISTINCT FROM` rather
  -- than `<>` because OLD.disposition is NULL for every session that has not finished, and NULL
  -- <> 'COMPLETE' is NULL — so a plain inequality would fire for nothing at all, which is the
  -- quietest possible bug in a feature whose only symptom is a webhook that never arrives.
  IF NEW.disposition IS NULL OR NEW.disposition IS NOT DISTINCT FROM OLD.disposition THEN
    RETURN NEW;
  END IF;
  IF NOT runtime.disposition_is_terminal(NEW.disposition) THEN
    RETURN NEW;
  END IF;

  INSERT INTO runtime.webhook_outbox (id, org_id, event, payload, event_key, session_id, is_test)
  VALUES (
    app.gen_ulid('whe'),
    NEW.org_id,
    runtime.webhook_event_for(NEW.disposition),
    jsonb_build_object(
      'session_id', NEW.id,
      'survey_version_id', NEW.survey_version_id,
      'artifact_hash', NEW.artifact_hash,
      'disposition', NEW.disposition,
      'is_test', NEW.is_test,
      'language', NEW.language,
      'vendor_ref', NEW.vendor_ref,
      'respondent_key', NEW.respondent_key,
      'started_at', NEW.started_at,
      'finished_at', COALESCE(NEW.finished_at, clock_timestamp()),
      'duration_s', NEW.duration_s
    ),
    -- Derived, not random: the unique index then makes a duplicate append impossible. The
    -- disposition is IN the key because a session that is re-dispositioned (a support correction,
    -- a fraud review) is a new event a receiver must see, not a duplicate of the old one.
    NEW.id || ':' || NEW.disposition,
    NEW.id,
    NEW.is_test
  )
  ON CONFLICT (event_key) DO NOTHING;

  RETURN NEW;
END $$;
COMMENT ON FUNCTION runtime.tg_session_webhook_event() IS
  'Appends the outbox row for a session entering a terminal disposition. A TRIGGER and not a line '
  'in runtime.submit_page for the reason ADR-002 gives for content.tg_draft_only: submit_page is '
  'ONE writer, and a sweeper marking sessions ABANDONED or a support script fixing a stuck row '
  'would each have to remember to append. The one that forgets produces a silently missing '
  'webhook — the failure nobody notices until a client says their reconciliation is short. '
  'DELIBERATELY NOT filtered on is_test: the row records what happened and '
  'app.webhook_dispatch_batch() decides who hears about it, because a test session that produced '
  'no outbox row could never be used to verify an integration. SECURITY DEFINER so the append '
  'carries the function owner''s privilege rather than the updating role''s — which is what lets '
  'runtime_writer keep a capability surface of function signatures only (ADR-009 risk R3) instead '
  'of acquiring a table grant for this one feature.';

CREATE TRIGGER sessions_webhook_event AFTER UPDATE OF disposition ON runtime.sessions
  FOR EACH ROW EXECUTE FUNCTION runtime.tg_session_webhook_event();
-- AFTER, not BEFORE: the outbox row asserts the disposition IS set, and a BEFORE trigger would
-- append it while the row could still be rejected by a later constraint.
-- `OF disposition` so an ordinary last_seen_at heartbeat does not evaluate this at all.

/* ------------------------------------------------------------------ *
 * 5. app.webhook_deliveries — one row per (event, subscription)
 * ------------------------------------------------------------------ */

CREATE TABLE app.webhook_deliveries (
  id             app.ulid PRIMARY KEY,
  webhook_id     app.ulid NOT NULL REFERENCES app.webhooks (id) ON DELETE CASCADE,
  org_id         app.ulid NOT NULL,
  outbox_id      app.ulid NOT NULL,
  event          app.webhook_event NOT NULL,
  event_key      text NOT NULL,
  status         app.webhook_delivery_status NOT NULL DEFAULT 'pending',
  attempts       integer NOT NULL DEFAULT 0,
  -- The last attempt's outcome. `response_status = 0` means the request never got a status: a
  -- transport error, a timeout, or our own refusal. `response_body` is bounded because a receiver
  -- returning a 4 MB HTML error page must not be able to bloat this table one row at a time.
  response_status integer,
  response_body  text,
  error          text,
  -- The lease. A claim moves this forward, so the next claim skips the row until the lease expires
  -- — which is what makes a claim exclusive ACROSS transactions. `FOR UPDATE SKIP LOCKED` alone is
  -- not enough and I had it wrong: the row lock lasts only as long as the claiming transaction, so
  -- once the worker commits its attempt-counter bump the row is `pending` again and the next
  -- worker takes it while the first is still waiting on the receiver's HTTP response. Same field
  -- serves retry backoff, exactly as ops.jobs.run_after does for the job queue.
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  first_attempt_at timestamptz,
  last_attempt_at  timestamptz,
  delivered_at   timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  -- One delivery per (subscription, event). The receiver's idempotency contract is per event_key,
  -- and this is the constraint that makes a retry a retry rather than a second delivery.
  CONSTRAINT webhook_deliveries_once UNIQUE (webhook_id, event_key),
  CONSTRAINT webhook_deliveries_attempts_bounded CHECK (attempts BETWEEN 0 AND 50),
  CONSTRAINT webhook_deliveries_body_bounded CHECK (
    response_body IS NULL OR length(response_body) <= 4096),
  -- A biconditional in 0010's style: delivered means delivered_at, and delivered_at means
  -- delivered. A row claiming success with no time, or a time with no success, is a row that makes
  -- every "when did this land" query wrong.
  CONSTRAINT webhook_deliveries_delivered_shape CHECK (
    (status = 'delivered') = (delivered_at IS NOT NULL)),
  CONSTRAINT webhook_deliveries_attempted_shape CHECK (
    (attempts > 0) = (first_attempt_at IS NOT NULL))
);

COMMENT ON TABLE app.webhook_deliveries IS
  'One row per (subscription, event) with the attempt history — API §2.16''s delivery log and the '
  'answer to "did my endpoint get this". FANNED OUT from runtime.webhook_outbox rather than being '
  'the queue itself: one event with three subscribers is three independent delivery outcomes, and '
  'a single row could not represent "two receivers got it, one is still failing". In schema `app` '
  'because it is control-plane data an admin reads, while the outbox it derives from is runtime '
  'data nobody outside the worker sees.';
COMMENT ON COLUMN app.webhook_deliveries.response_status IS
  '0 means the request never received a status at all — a transport error, a timeout, or our own '
  'refusal to make it. Distinguished from NULL, which means no attempt has happened yet; the two '
  'read identically in a naive dashboard and mean opposite things.';
COMMENT ON CONSTRAINT webhook_deliveries_once ON app.webhook_deliveries IS
  'What makes a retry a retry rather than a second delivery. Combined with the outbox''s unique '
  'event_key it is the full idempotency story: the event can be appended once, and each '
  'subscription can have exactly one delivery of it however many times the worker runs.';

-- Ordered by the lease, not by creation: the claim query's ORDER BY has to match or every poll
-- scans the whole pending set to find the one row whose lease has expired. 0003's
-- jobs_claimable_idx is (kind, run_after) for the same reason.
CREATE INDEX webhook_deliveries_pending_idx ON app.webhook_deliveries (next_attempt_at)
  WHERE status = 'pending';
CREATE INDEX webhook_deliveries_webhook_idx
  ON app.webhook_deliveries (webhook_id, created_at DESC);

-- NO `updated_at` and no touch trigger here, unlike app.webhooks. Every update to this table is
-- an attempt, and `last_attempt_at` already says when the last one was; an `updated_at` alongside
-- it would be a second answer to the same question that a redelivery (which sets status without
-- attempting) would make disagree with the first. I added the trigger first and it failed with
-- "record new has no field updated_at", which is the schema telling me the column had no reason to
-- exist.

ALTER TABLE app.webhook_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.webhook_deliveries FORCE ROW LEVEL SECURITY;

CREATE POLICY webhook_deliveries_select ON app.webhook_deliveries FOR SELECT TO authoring
USING (org_id = app.current_org() AND app.has_role('admin'));
COMMENT ON POLICY webhook_deliveries_select ON app.webhook_deliveries IS
  'READ ONLY for authoring, at the same admin bar as the subscription itself. There is no write '
  'policy at all: every row here is written by the delivery worker through a definer function, and '
  'a delivery log a client can edit is not a log. An admin who wants a redelivery calls '
  'app.webhook_redeliver(), which resets the row rather than rewriting its history.';

-- Same default-privilege correction, the other way round: this table needs authoring to READ and
-- never to write, and 0001 handed it INSERT, UPDATE and DELETE before this line ran. Without the
-- revoke, "there is no write policy" would be true and irrelevant — FORCE RLS with no permissive
-- write policy does block the write, but relying on a missing policy for that is one `CREATE POLICY`
-- away from a delivery log a client can rewrite. Both layers, as everywhere else in this schema.
REVOKE INSERT, UPDATE, DELETE ON app.webhook_deliveries FROM authoring;
GRANT SELECT ON app.webhook_deliveries TO authoring;

/* ------------------------------------------------------------------ *
 * 6. The plane crossings
 * ------------------------------------------------------------------ */

-- The outbox and the delivery log are owned by runtime_rpc_owner, matching 0016's quota_counters,
-- so the definer functions below can reach them while FORCE ROW LEVEL SECURITY still applies to
-- everyone else.
-- No ownership changes and no service-role policies, which is the second correction this section
-- needed. My first version handed both tables to `runtime_rpc_owner` with `FOR ALL ... USING
-- (true)` policies, copying 0016's shape for runtime.quota_counters. Two of 0004's structural
-- guards refused it, both correctly:
--
--   * "no tenant table uses a FOR ALL policy" — a single policy covering reads and writes is how a
--     read predicate silently becomes a write predicate. (0016 escapes this check because
--     quota_counters is in schema `runtime`, which the guard does not scan; app.webhook_deliveries
--     is in `app`, which it does.)
--   * "every tenant-table policy constrains org_id against app.current_org()" — `USING (true)` is
--     precisely the policy that guard exists to find.
--
-- The established answer is already in this codebase and needed no invention: apps/worker connects
-- as a privileged role and `SET LOCAL ROLE authoring` only when acting on a USER's behalf
-- (publish-store.ts' asUser). Webhook delivery is system machinery acting on nobody's behalf, so it
-- runs as the connection role and the SECURITY DEFINER functions below carry the privilege. The
-- only policies on these tables are therefore the authoring-facing ones, which do constrain the
-- org — and there is no `USING (true)` anywhere in this migration.

-- Fan undispatched outbox events out into per-subscription deliveries.
--
-- NO ORG PARAMETER, and that is not an omission. Deliverable B §2: "no runtime RPC may accept an
-- org_id parameter", because a caller-supplied org id is a cross-tenant write vector. This
-- function matches each event to subscriptions BY THE EVENT'S OWN org_id, read from the row the
-- trigger wrote, so there is no value a caller could pass to make it write across tenants. 0017's
-- quota functions had to have p_org_id removed for exactly this reason, and the mistake is worth
-- not repeating.
--
-- Idempotent by construction: ON CONFLICT (webhook_id, event_key) DO NOTHING plus the
-- dispatched_at stamp mean running this twice concurrently produces the same deliveries once.
CREATE FUNCTION app.webhook_dispatch_batch(p_limit integer DEFAULT 200)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = '' SET statement_timeout = '30s' AS $fn$
DECLARE
  v_created integer := 0;
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 THEN
    RAISE EXCEPTION 'webhook_dispatch_batch: limit must be between 1 and 1000'
      USING ERRCODE = '22023';
  END IF;

  WITH claimed AS (
    SELECT o.id, o.org_id, o.event, o.event_key, o.is_test
      FROM runtime.webhook_outbox o
     WHERE o.dispatched_at IS NULL
     ORDER BY o.created_at
     -- SKIP LOCKED so two workers draining concurrently divide the batch instead of one waiting on
     -- the other's row locks. The dispatched_at stamp is what makes that safe.
     FOR UPDATE SKIP LOCKED
     LIMIT p_limit
  ),
  matched AS (
    INSERT INTO app.webhook_deliveries
      (id, webhook_id, org_id, outbox_id, event, event_key)
    SELECT app.gen_ulid('whd'), w.id, c.org_id, c.id, c.event, c.event_key
      FROM claimed c
      JOIN app.webhooks w
        ON w.org_id = c.org_id        -- the event's org, never a parameter. See above.
       AND w.enabled
       AND c.event = ANY (w.events)
     -- A test session delivers only to a subscription that opted in. Encoded as an opt-in rather
     -- than a filter on the outbox, because a test session that produced no outbox row could never
     -- be used to verify an integration — which is the first thing anyone does with a webhook.
     WHERE NOT c.is_test OR w.description LIKE '%[test]%'
    ON CONFLICT (webhook_id, event_key) DO NOTHING
    RETURNING 1
  ),
  stamped AS (
    UPDATE runtime.webhook_outbox o
       SET dispatched_at = clock_timestamp()
      FROM claimed c
     WHERE o.id = c.id
    RETURNING 1
  )
  -- `stamped` is not referenced here and still runs: Postgres executes a data-modifying CTE
  -- "exactly once, and always to completion, independently of whether the primary query reads any
  -- of their output". Worth stating, because the obvious defensive move — contriving a reference to
  -- force it — produces an unreadable expression to guarantee something already guaranteed.
  SELECT count(*)::int INTO v_created FROM matched;

  RETURN v_created;
END $fn$;
COMMENT ON FUNCTION app.webhook_dispatch_batch(integer) IS
  'Fans undispatched outbox events out into one delivery per matching subscription. NO ORG '
  'PARAMETER (B 2): each event is matched by its OWN org_id, read from the row the trigger wrote, '
  'so no argument exists that could make it write across tenants — the mistake 0017 had to have '
  'removed from every quota function. FOR UPDATE SKIP LOCKED so concurrent workers divide the '
  'batch; ON CONFLICT DO NOTHING plus the dispatched_at stamp make a double run a no-op.';

-- Claim one pending delivery for an attempt, and return everything needed to make the request —
-- including the secret, which is the only path by which any caller reads it.
CREATE FUNCTION app.webhook_claim(p_worker text)
RETURNS TABLE (
  delivery_id app.ulid,
  webhook_id  app.ulid,
  url         text,
  secret      text,
  event       app.webhook_event,
  event_key   text,
  payload     jsonb,
  attempts    integer
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = '' SET statement_timeout = '15s' AS $fn$
BEGIN
  IF p_worker IS NULL OR btrim(p_worker) = '' THEN
    RAISE EXCEPTION 'webhook_claim: a worker identity is required' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  WITH claimed AS (
    SELECT d.id FROM app.webhook_deliveries d
     WHERE d.status = 'pending'
       AND d.next_attempt_at <= clock_timestamp()
     ORDER BY d.next_attempt_at
     FOR UPDATE SKIP LOCKED
     LIMIT 1
  ),
  bumped AS (
    UPDATE app.webhook_deliveries d
       SET attempts = d.attempts + 1,
           first_attempt_at = COALESCE(d.first_attempt_at, clock_timestamp()),
           last_attempt_at = clock_timestamp(),
           -- The lease. Long enough to cover a slow receiver plus the worker's own timeout; short
           -- enough that a worker killed mid-flight does not park the delivery for an hour.
           next_attempt_at = clock_timestamp() + interval '2 minutes'
      FROM claimed c
     WHERE d.id = c.id
    RETURNING d.id, d.webhook_id, d.event, d.event_key, d.outbox_id, d.attempts
  )
  SELECT b.id, b.webhook_id, w.url, w.secret, b.event, b.event_key, o.payload, b.attempts
    FROM bumped b
    JOIN app.webhooks w ON w.id = b.webhook_id
    JOIN runtime.webhook_outbox o ON o.id = b.outbox_id;
END $fn$;
COMMENT ON FUNCTION app.webhook_claim(text) IS
  'Claims one pending delivery and returns the request to make, INCLUDING the signing secret — the '
  'only path by which any caller reads app.webhooks.secret, since that column is REVOKEd from '
  'authoring and this function is granted only to the worker''s role. The attempt counter is '
  'incremented AT CLAIM TIME, not on completion: a worker that dies mid-request must not leave a '
  'delivery that looks unattempted, or a poison payload would be retried forever.';

-- Record an attempt's outcome. The worker's only write path into the log.
CREATE FUNCTION app.webhook_record_attempt(
  p_delivery_id     app.ulid,
  p_status          app.webhook_delivery_status,
  p_response_status integer DEFAULT NULL,
  p_response_body   text DEFAULT NULL,
  p_error           text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = '' SET statement_timeout = '15s' AS $fn$
BEGIN
  IF p_status = 'pending' THEN
    RAISE EXCEPTION 'webhook_record_attempt: an outcome cannot be pending' USING ERRCODE = '22023';
  END IF;

  UPDATE app.webhook_deliveries
     SET status = p_status,
         response_status = p_response_status,
         -- Bounded here as well as by the CHECK, so a receiver's 4 MB error page is truncated
         -- rather than raising and losing the outcome entirely.
         response_body = left(p_response_body, 4096),
         error = left(p_error, 4096),
         delivered_at = CASE WHEN p_status = 'delivered' THEN clock_timestamp() ELSE NULL END
   WHERE id = p_delivery_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'webhook_record_attempt: delivery % not found', p_delivery_id
      USING ERRCODE = 'P0002';
  END IF;
END $fn$;

-- Put a delivery back in the queue.
--
-- Used for two different things on purpose: the worker calls it to schedule the next attempt after
-- a retryable failure, and an admin calls it to force a redelivery. One function because the state
-- transition is identical, and having two would let them drift.
--
-- `attempts` is deliberately NOT reset. A redelivery is another attempt at the same event, and
-- zeroing the counter would erase the evidence that this endpoint has failed eleven times — which
-- is the only number that distinguishes a broken endpoint from a briefly unlucky one.
CREATE FUNCTION app.webhook_requeue(p_delivery_id app.ulid, p_delay_s integer DEFAULT 0)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = '' SET statement_timeout = '15s' AS $fn$
DECLARE
  v_org app.ulid;
BEGIN
  SELECT org_id INTO v_org FROM app.webhook_deliveries WHERE id = p_delivery_id;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'webhook_requeue: delivery % not found', p_delivery_id USING ERRCODE = 'P0002';
  END IF;
  -- Cross-org reads as NOT FOUND, indistinguishable from a delivery that never existed. 0004's
  -- existence-oracle rule: a wrong-tenant id must not be answerable.
  IF v_org <> app.current_org() OR NOT app.has_role('admin') THEN
    RAISE EXCEPTION 'webhook_requeue: delivery % not found', p_delivery_id USING ERRCODE = 'P0002';
  END IF;

  UPDATE app.webhook_deliveries
     SET status = 'pending',
         delivered_at = NULL,
         error = NULL,
         -- The retry's backoff, or `now()` for an admin's manual redelivery. One field for both,
         -- because "when may this be attempted again" has one answer per delivery and two columns
         -- would eventually disagree.
         next_attempt_at = clock_timestamp() + make_interval(secs => greatest(p_delay_s, 0))
   WHERE id = p_delivery_id;
END $fn$;
COMMENT ON FUNCTION app.webhook_requeue(app.ulid, integer) IS
  'Returns a delivery to the queue — the worker''s retry and an admin''s manual redelivery, which '
  'are the same state transition and so are one function rather than two that can drift. '
  '`attempts` is NOT reset: a redelivery is another attempt at the same event, and zeroing the '
  'counter would erase the evidence that this endpoint has failed eleven times, which is the only '
  'number that distinguishes a broken endpoint from a briefly unlucky one. A cross-org id reads as '
  'NOT FOUND (0004''s existence-oracle rule).';

/* ------------------------------------------------------------------ *
 * 7. Grants — 0006's rule: every new function needs an explicit REVOKE
 * ------------------------------------------------------------------ */

REVOKE ALL ON FUNCTION runtime.webhook_event_for(runtime.disposition) FROM PUBLIC;
REVOKE ALL ON FUNCTION runtime.tg_session_webhook_event() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.webhook_dispatch_batch(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.webhook_claim(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.webhook_record_attempt(
  app.ulid, app.webhook_delivery_status, integer, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.webhook_requeue(app.ulid, integer) FROM PUBLIC;

-- The trigger function gets no grant: a trigger runs as part of the table's machinery, not as a
-- callable function, and granting EXECUTE would make the outbox appendable by anyone who could
-- call it.
-- webhook_event_for needs no grant either: it is reached only from the definer trigger, which
-- executes as its owner.

-- The worker's three functions. NOT granted to `authoring`, which is the second layer on the
-- secret: an admin can read the delivery log and still cannot obtain the signing key, because the
-- only function that returns it is one they cannot execute.
-- The worker's three functions are left ungranted beyond their owner: apps/worker connects as a
-- privileged role for system work (see §6), and adding a grant would be adding a caller that does
-- not exist. NOT granted to `authoring` in particular — that is the second layer on the secret, so
-- an admin who reads the delivery log still cannot obtain the signing key, because the only
-- function that returns it is one they cannot execute.

-- Redelivery is the one webhook function an admin calls, and it returns nothing.
GRANT EXECUTE ON FUNCTION app.webhook_requeue(app.ulid, integer) TO authoring;
