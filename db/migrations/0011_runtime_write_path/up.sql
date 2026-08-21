-- 0011_runtime_write_path — the respondent write path: runtime.sessions,
-- runtime.response_documents, runtime.response_events, and the four RPCs that are the
-- runtime's ONLY way to touch any of them (P1-09/P1-10).
--
-- Deliverable B §8 (the three tables, their partitioning, and "no FKs on the event table —
-- deliberate"), §8.1 (the event enum and the two-level partition strategy), §8.2 (the
-- document upsert and the last_event_seq idempotency guard), §9 (immutability: privileges
-- first, then triggers, then policies), §12 (RLS); Deliverable E §3.1 (SessionState — what
-- the projection must be able to rebuild), §3.2 (storage layout: Redis is a cache, THESE
-- TABLES are the record), §3.3 (artifact pinning), §5 step 8 (one transaction: event append
-- + document upsert), §7.3 (resume looks sessions up by resume_token_hash); ADR-001 (the
-- plane boundary: runtime_writer holds EXECUTE on definer functions and no table privilege),
-- ADR-006 (random_seed is the replay key), ADR-007 (events are the source of truth; the
-- document is a projection), ADR-009 (org_id on every row; the token is the capability);
-- roadmap P1-09 (DB: sessions + documents hash-partitioned 32 ways, RPCs resolve_token /
-- start_session / load_session) and P1-10 (DB: response_events partitioned, tg_append_only,
-- REVOKE UPDATE/DELETE/TRUNCATE, runtime.submit_page, last_event_seq).
--
-- TWO SUPERSESSIONS, recorded here the way 0009 §1 recorded the token alphabet, because both
-- are places where Deliverable B and Deliverable E disagree and one had to win:
--
--   1. random_seed is TEXT (32 lowercase hex chars, 128 bits), not B §8's bigint. E §3.1 and
--      ADR-006 are explicit: "random_seed: string — 128-bit hex, assigned once". A bigint is
--      64 bits and cannot hold it, and halving the seed silently halves the replay keyspace
--      shared with every already-written SessionState in Redis. E wins; the CHECK is the
--      domain B would have wanted.
--
--   2. sessions carries artifact_hash and revision, which B §8's DDL omits and E §3.2's
--      projection column list includes ("ids, disposition, timings, artifact_hash,
--      revision"). E wins, and not cosmetically: the session PINS its artifact (E §3.3), and
--      the pin cannot be derived from survey_versions.artifact_hash because ROLLBACK REPOINTS
--      that column (0009's app.rollback_version) — deriving it would silently migrate every
--      in-flight respondent to the rolled-back bytes, the exact thing pinning exists to
--      prevent. revision is E §3.4's optimistic-concurrency counter; the Redis-miss rebuild
--      needs it or a rebuilt session resets to 0 and the CAS accepts a stale write.
--
-- Migration header first, mandated by Deliverable B §14 and read by
-- tools/ci/lint-migrations.mjs from the first 60 lines. Everything here is expand-only: new
-- enum, three new tables with their partitions, one trigger function, three new functions,
-- one placeholder body replaced (runtime.load_session, a NULL-returning stub since 0004),
-- one function body replaced (ops.ensure_event_partitions, to give the event partitions it
-- creates the same RLS posture as the ones this file creates). No renames, no in-place type
-- changes, no defaults materialized over existing rows.
SET lock_timeout = '3s';
SET statement_timeout = '120s';

-- ---------------------------------------------------------------------------
-- 0. What this migration deliberately does NOT create
-- ---------------------------------------------------------------------------
--   * A GIN index on response_documents.vars. B §8.2 is explicit: the document is rewritten
--     on every page submit, and a GIN on a wide hot-rewrite JSONB column converts a fast
--     write path into pending-list churn. Ad-hoc value queries belong to the flat projection
--     tables (B §11, Phase 2).
--   * Foreign keys on response_events. B §8.1: an FK is an index probe per insert on the
--     hottest write path in the system, multiplied by partition. Integrity is asserted by
--     the write RPC (which holds the session) and audited by reconciliation. Recorded so
--     nobody re-adds them unaware.
--   * The quota counter tables. ADR-008 puts live counters in Redis; the Postgres record is
--     the event log (quota_reserved / quota_committed / quota_released events), and the
--     reconciliation job that compares the two arrives with the quota work itself.
--   * A DELETE path. Nothing in schema runtime deletes; retention and erasure are the
--     control plane's (B §9 redaction, B §10 archival), acting as the service role.

-- ---------------------------------------------------------------------------
-- 1. The enums (B §8 / §8.1)
-- ---------------------------------------------------------------------------
-- 0002 created runtime.disposition (with the K §2 reconciliation its comment records) but
-- not session_status, because no table needed it until now. `status` and `disposition` are
-- two axes, not one: status says whether anyone is still expected (active/abandoned), the
-- disposition says how it ended — a completed session has both, an active one has neither
-- settled, and conflating them is the PARTIAL mistake runtime.disposition's comment names.
CREATE TYPE runtime.session_status AS ENUM
  ('active','completed','terminated','abandoned','quarantined');
COMMENT ON TYPE runtime.session_status IS
  'B §8. The lifecycle axis, orthogonal to runtime.disposition (the outcome axis). '
  'quarantined is the anti-tamper end state: a session flagged past the rejection threshold '
  'is quarantined rather than deleted, because the evidence is the point (E §5 step 3).';

CREATE TYPE runtime.event_type AS ENUM (
  'session_start','page_view','page_submit','validation_failed','derived_recomputed',
  'quota_reserved','quota_committed','quota_released','quota_full',
  'answers_invalidated',
  'logic_divergence','script_error','redirect','disposition_set','resume','admin_redaction');
COMMENT ON TYPE runtime.event_type IS
  'B §8.1''s list plus answers_invalidated, which E §7.2 step 5 requires (ONE event per '
  'back-navigation invalidation, carrying the old values) and B''s list predates. Extending '
  'an enum is expand-only; removing or renaming a member is not, so additions go at the '
  'semantically right spot but removals never happen.';

-- ---------------------------------------------------------------------------
-- 2. runtime.sessions — the projection of E §3.1, hash-partitioned 32 ways
-- ---------------------------------------------------------------------------
-- A PROJECTION, not the authority. The authoritative SessionState lives in Redis and is
-- rebuildable from response_documents + this row + the event tail (E §3.2). This table
-- exists for dashboards, reconciliation, dedup, and the Redis-miss fallback — which is why
-- it carries ids, outcome, timings, the pin and the revision, and NOT the variable state.
CREATE TABLE runtime.sessions (
  id app.ulid NOT NULL,                         -- ses_ ULID; entry time recoverable from it
  survey_version_id app.ulid NOT NULL,
  org_id app.ulid NOT NULL,                     -- ADR-009: on every row, even here
  is_test boolean NOT NULL DEFAULT false,
  status runtime.session_status NOT NULL DEFAULT 'active',
  disposition runtime.disposition,
  -- Supersession 1 (header): E §3.1's 128-bit hex, not B §8's bigint.
  random_seed text NOT NULL CHECK (random_seed ~ '^[0-9a-f]{32}$'),
  -- Supersession 2 (header): the pin and the CAS counter, from E §3.2/§3.4.
  artifact_hash app.sha256 NOT NULL,
  revision int NOT NULL DEFAULT 0 CHECK (revision >= 0),
  respondent_key text,                          -- vendor pid / invitation id, for dedup
  resume_token_hash bytea,                      -- sha256; E §7.3's Postgres resume lookup
  invitation_id app.ulid,
  vendor_ref app.ref,
  language text NOT NULL,
  current_page_id app.ulid,
  page_index int NOT NULL DEFAULT 0,
  quota_cell_ids app.ulid[] NOT NULL DEFAULT '{}',
  soft_quota_flags text[] NOT NULL DEFAULT '{}',
  ip_hash bytea,                                -- salted; the raw IP is never stored (B §8)
  ua_class text, country text, device text,
  quality jsonb NOT NULL DEFAULT '{}',
  started_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  duration_s int,
  PRIMARY KEY (survey_version_id, id)
) PARTITION BY HASH (survey_version_id);

COMMENT ON TABLE runtime.sessions IS
  'B §8 / E §3.2: the durable projection of SessionState. Hash-partitioned by version, not '
  'range-partitioned by time, because the dominant reads are "one session by id within a '
  'version" (the Redis-miss fallback) and "all sessions for this version" (dashboards, '
  'deletion) — both single-partition under hash-by-version, while time partitioning would '
  'spread one study across twelve partitions to buy retention-by-detach that sessions do '
  'not want (they are deleted per project, not per month).';
COMMENT ON COLUMN runtime.sessions.random_seed IS
  'ADR-006: the replay key. 128-bit lowercase hex — see this migration''s header for the '
  'supersession of B §8''s bigint. Assigned once at entry, never rewritten; every '
  'randomization decision in the session is a pure function of it.';
COMMENT ON COLUMN runtime.sessions.artifact_hash IS
  'E §3.3: PINNED at entry. Deliberately denormalized from survey_versions because rollback '
  'repoints that table''s artifact_hash and an in-flight respondent must keep the bytes they '
  'started on. See the header''s supersession note.';
COMMENT ON COLUMN runtime.sessions.revision IS
  'E §3.4: the optimistic-concurrency counter the Redis CAS compares. Persisted so a session '
  'rebuilt after a Redis loss resumes the sequence instead of restarting it at 0, which '
  'would let a stale tab''s write win the CAS.';

-- 32 partitions, per B §8. RLS is enabled AND forced on every child as well as the parent:
-- policies do not inherit, and a partition with RLS off is a way to read another tenant's
-- sessions by naming the child table (0001 makes the same move for app.audit_log's months).
DO $$
DECLARE i int;
BEGIN
  FOR i IN 0..31 LOOP
    EXECUTE format(
      'CREATE TABLE runtime.sessions_h%s PARTITION OF runtime.sessions '
      'FOR VALUES WITH (MODULUS 32, REMAINDER %s)', i, i);
    EXECUTE format('ALTER TABLE runtime.sessions_h%s ENABLE ROW LEVEL SECURITY', i);
    EXECUTE format('ALTER TABLE runtime.sessions_h%s FORCE  ROW LEVEL SECURITY', i);
  END LOOP;
END $$;

CREATE INDEX sessions_version_started_idx
  ON runtime.sessions (survey_version_id, started_at DESC);
CREATE UNIQUE INDEX sessions_respondent_key_idx
  ON runtime.sessions (survey_version_id, respondent_key) WHERE respondent_key IS NOT NULL;
CREATE INDEX sessions_open_idx
  ON runtime.sessions (survey_version_id, last_seen_at) WHERE status = 'active';
CREATE INDEX sessions_ip_idx
  ON runtime.sessions (survey_version_id, ip_hash) WHERE ip_hash IS NOT NULL;
-- E §7.3: resume arrives with a token hash and no version id, so this index cannot be
-- version-prefixed — and therefore cannot be UNIQUE either, because Postgres requires a
-- unique index on a partitioned table to include the partition key. NON-unique on purpose,
-- and the honesty is worth stating: uniqueness of resume tokens is a property of minting
-- them from 256 bits of CSPRNG, not something this table can enforce. A collision is a
-- birthday problem at 2^128 sessions, not an operational event; the lookup function
-- returns a single row regardless.
CREATE INDEX sessions_resume_hash_idx
  ON runtime.sessions (resume_token_hash) WHERE resume_token_hash IS NOT NULL;

COMMENT ON INDEX runtime.sessions_respondent_key_idx IS
  '01 §3.3 step 4''s duplicate check: a unique index makes "has this panel id already '
  'entered this version" a conflict instead of a race between two concurrent entries.';

ALTER TABLE runtime.sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE runtime.sessions FORCE  ROW LEVEL SECURITY;

-- The same posture as 0009's tokens_rpc_read: the ONLY policies are for runtime_rpc_owner,
-- the definer that the RPCs below run as, and they compare org_id to nothing because no
-- runtime RPC takes an org — the session id (134-bit ULID reached via a 134-bit token) is
-- the capability. There is deliberately NO DELETE policy: nothing in this plane deletes.
CREATE POLICY sessions_rpc_select ON runtime.sessions FOR SELECT
  TO runtime_rpc_owner USING (true);
CREATE POLICY sessions_rpc_insert ON runtime.sessions FOR INSERT
  TO runtime_rpc_owner WITH CHECK (true);
CREATE POLICY sessions_rpc_update ON runtime.sessions FOR UPDATE
  TO runtime_rpc_owner USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- 3. runtime.response_documents — current state, hash-partitioned 32 ways (B §8.2)
-- ---------------------------------------------------------------------------
CREATE TABLE runtime.response_documents (
  survey_version_id app.ulid NOT NULL,
  session_id app.ulid NOT NULL,
  org_id app.ulid NOT NULL,
  is_test boolean NOT NULL DEFAULT false,
  status runtime.session_status NOT NULL,
  disposition runtime.disposition,
  vars jsonb NOT NULL DEFAULT '{}',
  page_timings jsonb NOT NULL DEFAULT '{}',
  quota_cell_ids app.ulid[] NOT NULL DEFAULT '{}',
  last_event_seq int NOT NULL DEFAULT 0 CHECK (last_event_seq >= 0),
  projected_at timestamptz,
  started_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  PRIMARY KEY (survey_version_id, session_id)
) PARTITION BY HASH (survey_version_id);

COMMENT ON TABLE runtime.response_documents IS
  'ADR-007: the PROJECTION of the event log — current vars as of last_event_seq. What a '
  'resume reads when Redis lost the session (E §3.2), and what the exporter streams. '
  'Rebuildable from response_events by construction; the reconciliation job asserts it.';
COMMENT ON COLUMN runtime.response_documents.last_event_seq IS
  'B §8.2: the idempotency guard. The upsert in runtime.submit_page carries the seq it '
  'believes it is appending and the UPDATE''s WHERE clause requires the stored value to be '
  'exactly one less; a stale replay (mobile network retry, double-click) matches zero rows '
  'and appends no event. This is E §3.4''s idempotent-replay path expressed as a data-model '
  'property rather than infrastructure.';

DO $$
DECLARE i int;
BEGIN
  FOR i IN 0..31 LOOP
    EXECUTE format(
      'CREATE TABLE runtime.response_documents_h%s PARTITION OF runtime.response_documents '
      'FOR VALUES WITH (MODULUS 32, REMAINDER %s)', i, i);
    EXECUTE format('ALTER TABLE runtime.response_documents_h%s ENABLE ROW LEVEL SECURITY', i);
    EXECUTE format('ALTER TABLE runtime.response_documents_h%s FORCE  ROW LEVEL SECURITY', i);
  END LOOP;
END $$;

CREATE INDEX respdoc_export_idx ON runtime.response_documents (survey_version_id, session_id)
  INCLUDE (disposition, completed_at) WHERE NOT is_test;
CREATE INDEX respdoc_projection_idx ON runtime.response_documents (survey_version_id, updated_at)
  WHERE projected_at IS NULL OR projected_at < updated_at;
CREATE INDEX respdoc_completed_idx ON runtime.response_documents
  (survey_version_id, completed_at DESC) WHERE disposition = 'COMPLETE' AND NOT is_test;

ALTER TABLE runtime.response_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE runtime.response_documents FORCE  ROW LEVEL SECURITY;
CREATE POLICY respdoc_rpc_select ON runtime.response_documents FOR SELECT
  TO runtime_rpc_owner USING (true);
CREATE POLICY respdoc_rpc_insert ON runtime.response_documents FOR INSERT
  TO runtime_rpc_owner WITH CHECK (true);
CREATE POLICY respdoc_rpc_update ON runtime.response_documents FOR UPDATE
  TO runtime_rpc_owner USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- 4. runtime.response_events — append-only, RANGE(created_at) monthly (B §8.1)
-- ---------------------------------------------------------------------------
CREATE TABLE runtime.response_events (
  survey_version_id app.ulid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  event_id app.ulid NOT NULL,
  session_id app.ulid NOT NULL,
  org_id app.ulid NOT NULL,
  seq int NOT NULL CHECK (seq >= 1),            -- per-session monotonic; orders within one ms
  event_type runtime.event_type NOT NULL,
  page_id app.ulid,
  is_test boolean NOT NULL DEFAULT false,
  -- Quoted because VALUES is a fully reserved word in PostgreSQL. B §8.1's DDL spells the
  -- column bare, which does not parse; recorded as a doc erratum rather than renamed,
  -- because the exporter and the reconciliation job are specified against this name.
  "values" jsonb,                               -- accepted values for this submit
  rejected_values jsonb,                        -- E §5 step 3: what the server discarded, and why
  payload jsonb NOT NULL DEFAULT '{}',
  client_trace jsonb,                           -- ADR-004 divergence evidence
  duration_ms int,
  PRIMARY KEY (survey_version_id, created_at, event_id)
) PARTITION BY RANGE (created_at);

COMMENT ON TABLE runtime.response_events IS
  'ADR-007: THE SOURCE OF TRUTH. Everything else — the document, the session projection, the '
  'Redis state, the flat export tables — is a view of this log. Append-only three ways (B '
  '§9): privileges (the REVOKE below survives application bugs), the tg_append_only trigger '
  '(survives a privilege mistake), and RLS with no UPDATE/DELETE policy (survives both). No '
  'FKs and no secondary indexes, deliberately — see §0.';
COMMENT ON COLUMN runtime.response_events.rejected_values IS
  'E §5 step 3''s anti-tamper record: values the server DISCARDED because its own '
  're-evaluation says the question was hidden, the option masked, or the variable not '
  'writable — with the reason. Never merged into the document. This existing per event is '
  'what makes "a respondent edited the DOM to answer a hidden screener" a queryable fact.';

-- The trigger that makes UPDATE/DELETE impossible even for a role that somehow acquires the
-- privilege. Rows only, and it raises rather than silently ignoring: an application path
-- that thinks it can rewrite history must fail loudly enough to be found in review.
CREATE FUNCTION runtime.tg_append_only() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  RAISE EXCEPTION 'runtime.% is append-only (ADR-007); % is not permitted',
    TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END $$;
-- 0006's invariant: no function is executable by PUBLIC, asserted by every suite since.
-- A trigger function is invoked by the trigger machinery, not by callers, so nobody needs
-- EXECUTE on it at all.
REVOKE EXECUTE ON FUNCTION runtime.tg_append_only() FROM PUBLIC;
COMMENT ON FUNCTION runtime.tg_append_only() IS
  'B §9 layer 2. Layer 1 is the REVOKE (privileges survive application bugs); this survives '
  'a privilege mistake; the absent UPDATE/DELETE RLS policies survive both. Attached to the '
  'partitioned parent, so every current and future partition inherits it.';

CREATE TRIGGER response_events_append_only
  BEFORE UPDATE OR DELETE ON runtime.response_events
  FOR EACH ROW EXECUTE FUNCTION runtime.tg_append_only();

-- B §9 layer 1, verbatim.
REVOKE UPDATE, DELETE, TRUNCATE ON runtime.response_events
  FROM PUBLIC, authoring, analytics_reader;

ALTER TABLE runtime.response_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE runtime.response_events FORCE  ROW LEVEL SECURITY;
CREATE POLICY events_rpc_select ON runtime.response_events FOR SELECT
  TO runtime_rpc_owner USING (true);
CREATE POLICY events_rpc_insert ON runtime.response_events FOR INSERT
  TO runtime_rpc_owner WITH CHECK (true);
-- No UPDATE or DELETE policy, on purpose: with FORCE RLS that denies both even to the
-- table's owner, which is B §9's third layer.

-- ---------------------------------------------------------------------------
-- 5. ops.ensure_event_partitions — body replaced to add the RLS posture
-- ---------------------------------------------------------------------------
-- 0001 wrote this function before any of the runtime tables existed, and it already skips
-- absent parents — so simply having created response_events above makes the next scheduled
-- run start producing partitions. Two things the 0001 body could not know are added here:
-- the monthly parents and hash children it creates must ENABLE+FORCE RLS (policies do not
-- inherit; an unprotected partition is direct-access bypass, same argument as §2), and the
-- partitions this migration needs must exist NOW rather than at the next cron tick, because
-- the RPCs below insert into them and 0001 is explicit that a respondent's submit must
-- never depend on DDL succeeding.
CREATE OR REPLACE FUNCTION ops.ensure_event_partitions(p_months_ahead integer DEFAULT 3)
RETURNS integer
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  v_month  date;
  v_parent text;
  v_child  text;
  v_made   int := 0;
  i int;
  j int;
BEGIN
  IF p_months_ahead < 0 OR p_months_ahead > 36 THEN
    RAISE EXCEPTION 'ensure_event_partitions: months_ahead must be 0..36 (got %)', p_months_ahead
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  FOR i IN 0..p_months_ahead LOOP
    v_month := (date_trunc('month', now())::date + (i || ' months')::interval)::date;

    -- runtime.response_events: RANGE(created_at) monthly, sub-partitioned HASH by
    -- survey_version_id into 8 (B §8.1). The to_regclass guard is kept even though the
    -- parent now exists, so this body remains correct if run against a database restored
    -- from a pre-0011 dump mid-upgrade.
    IF to_regclass('runtime.response_events') IS NOT NULL THEN
      v_parent := format('response_events_%s', to_char(v_month, 'YYYYMM'));
      EXECUTE format(
        'CREATE TABLE IF NOT EXISTS runtime.%I PARTITION OF runtime.response_events '
        'FOR VALUES FROM (%L) TO (%L) PARTITION BY HASH (survey_version_id)',
        v_parent, v_month, (v_month + interval '1 month')::date);
      EXECUTE format('ALTER TABLE runtime.%I OWNER TO runtime_rpc_owner', v_parent);
      FOR j IN 0..7 LOOP
        v_child := v_parent || '_h' || j;
        EXECUTE format(
          'CREATE TABLE IF NOT EXISTS runtime.%I PARTITION OF runtime.%I '
          'FOR VALUES WITH (MODULUS 8, REMAINDER %s)', v_child, v_parent, j);
        EXECUTE format('ALTER TABLE runtime.%I OWNER TO runtime_rpc_owner', v_child);
        -- New in 0011: the leaf inherits the parent's append-only trigger automatically,
        -- but NOT its RLS posture. Enable+force with no policies of its own: direct access
        -- to a leaf is denied for everyone, while inserts routed through the grandparent
        -- use the grandparent's policies.
        EXECUTE format('ALTER TABLE runtime.%I ENABLE ROW LEVEL SECURITY', v_child);
        EXECUTE format('ALTER TABLE runtime.%I FORCE  ROW LEVEL SECURITY', v_child);
      END LOOP;
      -- The monthly intermediate is partitioned (holds no rows) but gets the posture too,
      -- for the same reason the grandparent has it: uniformity is what makes the audit
      -- query ("every runtime table has RLS forced") a one-liner with no exemption list.
      EXECUTE format('ALTER TABLE runtime.%I ENABLE ROW LEVEL SECURITY', v_parent);
      EXECUTE format('ALTER TABLE runtime.%I FORCE  ROW LEVEL SECURITY', v_parent);
      v_made := v_made + 1;
    END IF;

    -- app.audit_log: RANGE(created_at) monthly, 24 months online (B §10). Unchanged from
    -- 0001's body.
    IF to_regclass('app.audit_log') IS NOT NULL THEN
      v_child := format('audit_log_%s', to_char(v_month, 'YYYYMM'));
      EXECUTE format(
        'CREATE TABLE IF NOT EXISTS app.%I PARTITION OF app.audit_log '
        'FOR VALUES FROM (%L) TO (%L)',
        v_child, v_month, (v_month + interval '1 month')::date);
      EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY', v_child);
      EXECUTE format('ALTER TABLE app.%I FORCE ROW LEVEL SECURITY', v_child);
      v_made := v_made + 1;
    END IF;
  END LOOP;

  RETURN v_made;
END $$;

REVOKE EXECUTE ON FUNCTION ops.ensure_event_partitions(integer) FROM PUBLIC;

-- Premake the partitions this migration's own RPCs need. Three months ahead, matching the
-- pg_cron schedule 0001 set up, and asserted by this migration's test.
SELECT ops.ensure_event_partitions(3);

-- Table privileges for the definer, following 0009's pattern for survey_tokens: an explicit
-- GRANT of exactly the verbs the policies allow, not ownership. runtime_rpc_owner owning the
-- tables would let a definer bug ALTER them; owning nothing but the functions cannot.
-- Grants on the partitioned parent govern access through the parent, which is the only path
-- the RPCs use. Note the asymmetry, which is the point: no UPDATE and no DELETE on events.
GRANT SELECT, INSERT, UPDATE ON runtime.sessions           TO runtime_rpc_owner;
GRANT SELECT, INSERT, UPDATE ON runtime.response_documents TO runtime_rpc_owner;
GRANT SELECT, INSERT         ON runtime.response_events    TO runtime_rpc_owner;

-- ---------------------------------------------------------------------------
-- 6. runtime.start_session — entry writes, in one transaction
-- ---------------------------------------------------------------------------
-- E §4 step 7: session row + empty document + the session_start event (seq 1), together or
-- not at all. Derives org/survey/version/artifact FROM THE TOKEN inside the definer, taking
-- no org argument (B §2: a cross-tenant request is unphraseable, not merely unauthorized).
-- Returns nothing the caller did not already know, because every extra column returned from
-- this plane is a leak waiting for a bug (the resolve_token comment's argument).
CREATE FUNCTION runtime.start_session(
  p_token text,
  p_session_id app.ulid,
  p_random_seed text,
  p_language text,
  p_is_test boolean,
  p_respondent_key text DEFAULT NULL,
  p_vendor_ref app.ref DEFAULT NULL,
  p_device text DEFAULT NULL,
  p_ua_class text DEFAULT NULL,
  p_country text DEFAULT NULL,
  p_resume_token_hash bytea DEFAULT NULL,
  p_entry_payload jsonb DEFAULT '{}'
) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = '' SET statement_timeout = '3s' AS $$
DECLARE
  v_tok RECORD;
BEGIN
  IF p_token IS NULL OR p_token !~ '^[0-9a-z]{26}$' THEN
    RAISE EXCEPTION 'start_session: invalid token' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_random_seed IS NULL OR p_random_seed !~ '^[0-9a-f]{32}$' THEN
    RAISE EXCEPTION 'start_session: random_seed must be 32 lowercase hex chars (ADR-006)'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT t.org_id, t.survey_version_id, t.artifact_hash, t.is_test
    INTO v_tok
    FROM runtime.survey_tokens t
   WHERE t.token = p_token AND t.revoked_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'start_session: unknown or revoked token'
      USING ERRCODE = 'no_data_found';
  END IF;

  INSERT INTO runtime.sessions
    (id, survey_version_id, org_id, is_test, random_seed, artifact_hash,
     respondent_key, resume_token_hash, vendor_ref, language,
     device, ua_class, country)
  VALUES
    (p_session_id, v_tok.survey_version_id, v_tok.org_id,
     p_is_test OR v_tok.is_test, p_random_seed, v_tok.artifact_hash,
     p_respondent_key, p_resume_token_hash, p_vendor_ref, p_language,
     p_device, p_ua_class, p_country);
  -- A duplicate respondent_key raises unique_violation out of
  -- sessions_respondent_key_idx; the caller maps it to the DUPLICATE disposition. The
  -- conflict IS the dedup check (01 §3.3 step 4) — checking first would be a race.

  INSERT INTO runtime.response_documents
    (survey_version_id, session_id, org_id, is_test, status, vars, last_event_seq, started_at)
  VALUES
    (v_tok.survey_version_id, p_session_id, v_tok.org_id,
     p_is_test OR v_tok.is_test, 'active', '{}', 1, now());

  INSERT INTO runtime.response_events
    (survey_version_id, event_id, session_id, org_id, seq, event_type, is_test, payload)
  VALUES
    (v_tok.survey_version_id,
     ('evt_' || upper(substr(p_session_id, 5)))::app.ulid,
     p_session_id, v_tok.org_id, 1, 'session_start',
     p_is_test OR v_tok.is_test,
     p_entry_payload || jsonb_build_object('artifact_hash', v_tok.artifact_hash::text));
  -- The first event's id is derived from the session id rather than minted. NOT for PK
  -- collision — the events PK includes created_at, so two attempts would not collide there.
  -- The double-birth guard is the sessions PK above: a retried start_session with the same
  -- session id fails on it and the whole transaction rolls back. Deriving the event id just
  -- makes "which event is this session's birth" answerable without a scan.
END $$;
COMMENT ON FUNCTION runtime.start_session IS
  'E §4 step 7 in one transaction: sessions + response_documents + session_start event, all '
  'or none. Derives org/version/artifact from the token inside the definer (B §2). The seed '
  'is validated against ADR-006''s 128-bit hex shape at the boundary, because a truncated '
  'seed makes every later replay silently wrong rather than loudly absent.';
ALTER FUNCTION runtime.start_session(text, app.ulid, text, text, boolean, text, app.ref,
  text, text, text, bytea, jsonb) OWNER TO runtime_rpc_owner;
REVOKE EXECUTE ON FUNCTION runtime.start_session(text, app.ulid, text, text, boolean, text,
  app.ref, text, text, text, bytea, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION runtime.start_session(text, app.ulid, text, text, boolean, text,
  app.ref, text, text, text, bytea, jsonb) TO runtime_writer;

-- ---------------------------------------------------------------------------
-- 7. runtime.load_session — the placeholder from 0004, finally real
-- ---------------------------------------------------------------------------
-- The Redis-miss fallback (E §3.2): ONE session's document plus the projection fields the
-- rebuild needs. Returns jsonb rather than a row type so the shape can grow without a
-- migration; the runtime validates it against SessionState on the way in anyway.
CREATE OR REPLACE FUNCTION runtime.load_session(p_session_id app.ulid)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = '' SET statement_timeout = '3s' AS $$
  SELECT jsonb_build_object(
    'session_id',        s.id,
    'survey_version_id', s.survey_version_id,
    'artifact_hash',     s.artifact_hash,
    'random_seed',       s.random_seed,
    'revision',          s.revision,
    'status',            s.status,
    'disposition',       s.disposition,
    'is_test',           s.is_test,
    'language',          s.language,
    'current_page_id',   s.current_page_id,
    'started_at',        s.started_at,
    'last_seen_at',      s.last_seen_at,
    'vars',              d.vars,
    'page_timings',      d.page_timings,
    'last_event_seq',    d.last_event_seq
  )
  FROM runtime.sessions s
  JOIN runtime.response_documents d
    ON d.survey_version_id = s.survey_version_id AND d.session_id = s.id
  WHERE s.id = p_session_id
$$;
COMMENT ON FUNCTION runtime.load_session(app.ulid) IS
  'E §3.2''s Redis-miss fallback, replacing 0004''s NULL placeholder. One session''s document '
  'and projection, keyed by session id alone: org is implicit in the row, the id is the '
  'capability, and a cross-tenant request is unphraseable. The event TAIL (everything after '
  'last_event_seq) is not read here — the document is the state as of its own seq by '
  'construction, and reading a tail that cannot exist is a query per request for nothing.';

-- (Grant already exists from 0004 and function identity is unchanged by OR REPLACE.)

-- ---------------------------------------------------------------------------
-- 8. runtime.submit_page — E §5 step 8: ONE transaction, guarded by seq
-- ---------------------------------------------------------------------------
CREATE FUNCTION runtime.submit_page(
  p_session_id app.ulid,
  p_expected_seq int,               -- the seq the caller believes it is appending
  p_event_id app.ulid,
  p_event_type runtime.event_type,
  p_page_id app.ulid,
  p_vars jsonb,                     -- the FULL current vars, post-filter, post-derive
  p_values jsonb,                   -- the accepted values of THIS submit
  p_rejected_values jsonb,          -- E §5 step 3's discards, with reasons
  p_payload jsonb,
  p_client_trace jsonb,
  p_duration_ms int,
  p_status runtime.session_status,
  p_disposition runtime.disposition,
  p_current_page_id app.ulid,
  p_page_timings jsonb,
  p_revision int
) RETURNS int                        -- the document's last_event_seq after this call
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = '' SET statement_timeout = '3s' AS $$
DECLARE
  v_doc RECORD;
BEGIN
  -- The guard and the write are one statement: WHERE last_event_seq = expected - 1 makes a
  -- concurrent duplicate (double-click, mobile retry) match zero rows, and matching zero
  -- rows means NO event is appended either — the whole point of doing both in one function.
  UPDATE runtime.response_documents d
     SET vars           = p_vars,
         page_timings   = p_page_timings,
         status         = p_status,
         disposition    = COALESCE(p_disposition, d.disposition),
         last_event_seq = p_expected_seq,
         updated_at     = now(),
         completed_at   = CASE WHEN p_disposition IS NOT NULL AND d.completed_at IS NULL
                               THEN now() ELSE d.completed_at END
   WHERE d.session_id = p_session_id
     AND d.last_event_seq = p_expected_seq - 1
  RETURNING d.survey_version_id, d.org_id, d.is_test, d.last_event_seq INTO v_doc;

  IF NOT FOUND THEN
    -- Replay or conflict. Return the stored seq so the caller can distinguish "already
    -- applied, replay the stored response" (stored >= expected) from "session unknown"
    -- (no row at all -> the SELECT below finds nothing and we signal with -1).
    SELECT d.last_event_seq INTO v_doc
      FROM runtime.response_documents d WHERE d.session_id = p_session_id;
    RETURN COALESCE(v_doc.last_event_seq, -1);
  END IF;

  INSERT INTO runtime.response_events
    (survey_version_id, event_id, session_id, org_id, seq, event_type, page_id, is_test,
     "values", rejected_values, payload, client_trace, duration_ms)
  VALUES
    (v_doc.survey_version_id, p_event_id, p_session_id, v_doc.org_id, p_expected_seq,
     p_event_type, p_page_id, v_doc.is_test,
     p_values, p_rejected_values, COALESCE(p_payload, '{}'), p_client_trace, p_duration_ms);

  UPDATE runtime.sessions s
     SET status          = p_status,
         disposition     = COALESCE(p_disposition, s.disposition),
         current_page_id = p_current_page_id,
         page_index      = s.page_index + CASE WHEN p_event_type = 'page_submit' THEN 1 ELSE 0 END,
         revision        = GREATEST(s.revision, p_revision),
         last_seen_at    = now(),
         finished_at     = CASE WHEN p_disposition IS NOT NULL AND s.finished_at IS NULL
                                THEN now() ELSE s.finished_at END,
         duration_s      = CASE WHEN p_disposition IS NOT NULL AND s.finished_at IS NULL
                                THEN GREATEST(0, extract(epoch FROM now() - s.started_at))::int
                                ELSE s.duration_s END
   WHERE s.id = p_session_id;

  RETURN p_expected_seq;
END $$;
COMMENT ON FUNCTION runtime.submit_page IS
  'E §5 step 8: event append + document upsert + session touch, one transaction (ADR-007), '
  'guarded by B §8.2''s last_event_seq. The guard is in the UPDATE''s WHERE clause, so a '
  'replayed submit matches zero rows, appends zero events, and returns the stored seq — the '
  'caller then replays its stored response (E §3.4). Returns -1 for an unknown session so '
  'the caller can 404 instead of retrying forever. Named submit_page after the roadmap even '
  'though disposition_set and resume events also route through it: one write path, one '
  'guard, one transaction shape is the property worth keeping.';
ALTER FUNCTION runtime.submit_page(app.ulid, int, app.ulid, runtime.event_type, app.ulid,
  jsonb, jsonb, jsonb, jsonb, jsonb, int, runtime.session_status, runtime.disposition,
  app.ulid, jsonb, int) OWNER TO runtime_rpc_owner;
REVOKE EXECUTE ON FUNCTION runtime.submit_page(app.ulid, int, app.ulid, runtime.event_type,
  app.ulid, jsonb, jsonb, jsonb, jsonb, jsonb, int, runtime.session_status,
  runtime.disposition, app.ulid, jsonb, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION runtime.submit_page(app.ulid, int, app.ulid, runtime.event_type,
  app.ulid, jsonb, jsonb, jsonb, jsonb, jsonb, int, runtime.session_status,
  runtime.disposition, app.ulid, jsonb, int) TO runtime_writer;

-- ---------------------------------------------------------------------------
-- 9. runtime.find_session_by_resume — E §7.3's Postgres resume lookup
-- ---------------------------------------------------------------------------
CREATE FUNCTION runtime.find_session_by_resume(p_resume_token_hash bytea)
RETURNS app.ulid
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = '' SET statement_timeout = '3s' AS $$
  SELECT s.id FROM runtime.sessions s
   WHERE s.resume_token_hash = p_resume_token_hash
$$;
COMMENT ON FUNCTION runtime.find_session_by_resume(bytea) IS
  'E §7.3 step 1''s fallback when Redis evicted sess:tok:{hash}. Takes the HASH, never the '
  'token: the raw resume token must not appear in a query, a log line, or pg_stat_statements. '
  'Eligibility (disposition, resume window) is the runtime''s to check against the loaded '
  'session — this function answers "which session", not "may they resume".';
ALTER FUNCTION runtime.find_session_by_resume(bytea) OWNER TO runtime_rpc_owner;
REVOKE EXECUTE ON FUNCTION runtime.find_session_by_resume(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION runtime.find_session_by_resume(bytea) TO runtime_writer;
