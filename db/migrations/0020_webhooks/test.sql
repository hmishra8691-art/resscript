-- 0020_webhooks — tests.
--
-- The webhook system's value is entirely in properties that are invisible when it works and
-- catastrophic when it does not, so every assertion below targets one of them:
--
--   * THE OUTBOX IS TRANSACTIONAL. A disposition that rolls back leaves no event. This is the
--     whole reason the outbox exists instead of an inline POST, and it is asserted by rolling one
--     back and looking.
--   * THE TRIGGER FIRES ON THE FACT, NOT THE CALLER. A session dispositioned by any writer
--     produces an event; a heartbeat that touches nothing else does not.
--   * ONE EVENT, ONE DELIVERY, HOWEVER MANY DISPATCHES. At-least-once delivery is the cost of an
--     outbox, so the unique keys are what keep a retry from becoming a second webhook.
--   * THE SECRET IS UNREADABLE BY THE PEOPLE WHO MANAGE THE SUBSCRIPTION. An admin creates,
--     lists and rotates; only the worker's role can read the key back. That is what makes
--     "shown once at creation" enforceable rather than a UI convention.
--   * NO ORG PARAMETER ANYWHERE (B §2). Asserted structurally, by argument name, because this is
--     the check that caught a real cross-tenant write vector in 0017.

BEGIN;
SELECT plan(60);

GRANT USAGE ON SCHEMA public TO authoring, runtime_writer, analytics_reader, runtime_rpc_owner;

SELECT set_config('rs.ids', ops.test_seed_two_orgs()::text, true);
CREATE FUNCTION pg_temp.tid(k text) RETURNS text LANGUAGE sql STABLE AS
$$ SELECT current_setting('rs.ids', true)::jsonb ->> k $$;

CREATE FUNCTION pg_temp.act_as(p_user uuid, p_org text, p_role text DEFAULT 'authoring')
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', p_user, 'role', p_role,
                      'app_metadata', json_build_object('active_org_id', p_org))::text,
    true);
  EXECUTE format('SET LOCAL ROLE %I', p_role);
END $$;

-- The 'V' terminator is 0016's: zero-padding alone is not injective, so 'w1' and 'w10' would
-- otherwise collide and every uniqueness assertion below would pass for the wrong reason.
CREATE FUNCTION pg_temp.wid(p_prefix text, p_tag text) RETURNS app.ulid LANGUAGE sql IMMUTABLE AS
$$ SELECT (p_prefix || '_0' || rpad(translate(upper(p_tag), 'ILOU', '110V') || 'V', 25, '0'))::app.ulid $$;

-- A live token, seeded as superuser: token minting is 0009's publish transaction.
INSERT INTO runtime.survey_tokens (token, org_id, survey_id, survey_version_id, artifact_hash,
                                   status, is_test)
SELECT 'whbcdefghij0123456789klmnp', pg_temp.tid('org_a')::app.ulid,
       pg_temp.tid('svy_a')::app.ulid, v.id, v.artifact_hash, 'production', false
  FROM app.survey_versions v WHERE v.id = pg_temp.tid('ver_a_frozen')::app.ulid;

CREATE FUNCTION pg_temp.sid(p_tag text) RETURNS app.ulid LANGUAGE sql IMMUTABLE AS
$$ SELECT ('ses_0' || rpad(translate(upper(p_tag), 'ILOU', '110V') || 'V', 25, '0'))::app.ulid $$;

-- ---------------------------------------------------------------------------
-- 1. Structure
-- ---------------------------------------------------------------------------
SELECT has_table('app', 'webhooks', 'app.webhooks exists');
SELECT has_table('app', 'webhook_deliveries', 'app.webhook_deliveries exists');
SELECT has_table('runtime', 'webhook_outbox',
  'runtime.webhook_outbox exists — the outbox is in the RUNTIME plane, because ADR-001 forbids '
  'the runtime writing to the control plane''s queue');
SELECT has_type('app', 'webhook_event', 'the subscribable event set is its own registry');

SELECT ok(
  (SELECT relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'app' AND c.relname = 'webhooks'),
  'RLS is FORCED on app.webhooks');
SELECT ok(
  (SELECT relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'runtime' AND c.relname = 'webhook_outbox'),
  'RLS is FORCED on the outbox');

-- B §2, asserted structurally. This is the check that caught a real cross-tenant write vector in
-- 0017, where every quota function had taken a p_org_id.
SELECT is(
  (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname IN ('app', 'runtime')
      AND p.proname LIKE 'webhook%'
      AND pg_get_function_arguments(p.oid) LIKE '%org_id%'),
  0,
  'NO webhook function takes an org_id — a caller-supplied org id is a cross-tenant write vector '
  '(B 2), and every one of these derives the org from the row the trigger wrote');

SELECT ok(
  NOT has_function_privilege('public', 'app.webhook_claim(text)', 'EXECUTE'),
  'webhook_claim is not executable by PUBLIC — it returns the signing secret');
SELECT ok(
  NOT has_function_privilege('authoring', 'app.webhook_claim(text)', 'EXECUTE'),
  'and not by authoring either: that is the second layer on the secret, so an admin who reads the '
  'delivery log still cannot obtain the key');
SELECT ok(
  NOT has_function_privilege('authoring', 'app.webhook_dispatch_batch(integer)', 'EXECUTE')
  AND NOT has_function_privilege('runtime_writer', 'app.webhook_dispatch_batch(integer)', 'EXECUTE'),
  'dispatch is reachable by neither authoring nor runtime_writer — it is system machinery, and '
  'apps/worker runs it as the connection role rather than on any user''s behalf');

-- ---------------------------------------------------------------------------
-- 2. The subscription, and its constraints
-- ---------------------------------------------------------------------------
-- user_a is org A's owner (rank 70), which outranks the admin floor.
SELECT pg_temp.act_as(pg_temp.tid('user_a')::uuid, pg_temp.tid('org_a'));

INSERT INTO app.webhooks (id, org_id, url, secret, events)
VALUES (pg_temp.wid('whk', 'wa'), pg_temp.tid('org_a')::app.ulid,
        'https://hooks.acme.example/resscript', repeat('a', 44),
        ARRAY['session.completed']::app.webhook_event[]);
SELECT is((SELECT count(*)::int FROM app.webhooks), 1, 'an owner can create a subscription');

SELECT throws_ok(
  format($ins$INSERT INTO app.webhooks (id, org_id, url, secret, events)
          VALUES (%L, %L, 'http://hooks.acme.example/x', %L,
                  ARRAY['session.completed']::app.webhook_event[])$ins$,
    pg_temp.wid('whk', 'wplain'), pg_temp.tid('org_a'), repeat('a', 44)),
  '23514', NULL,
  'a plaintext http:// endpoint is refused — an org''s integration is not a reason to send '
  'completion data in clear text');

SELECT throws_ok(
  format($ins$INSERT INTO app.webhooks (id, org_id, url, secret, events)
          VALUES (%L, %L, 'https://user@hooks.acme.example/x', %L,
                  ARRAY['session.completed']::app.webhook_event[])$ins$,
    pg_temp.wid('whk', 'wuser'), pg_temp.tid('org_a'), repeat('a', 44)),
  '23514', NULL,
  'userinfo in the URL is refused: https://metadata@evil.example/ is a URL whose host most '
  'readers get wrong, and a credential in a stored URL is a credential in every log line');

SELECT throws_ok(
  format($ins$INSERT INTO app.webhooks (id, org_id, url, secret, events)
          VALUES (%L, %L, 'https://169.254.169.254/latest/meta-data/', %L,
                  ARRAY['session.completed']::app.webhook_event[])$ins$,
    pg_temp.wid('whk', 'wip'), pg_temp.tid('org_a'), repeat('a', 44)),
  '23514', NULL,
  'a bare IP literal is refused — an allowlist of hostnames is auditable, a bare address is how '
  'the private ranges get reached with no DNS record to look at');

SELECT throws_ok(
  format($ins$INSERT INTO app.webhooks (id, org_id, url, secret, events)
          VALUES (%L, %L, 'https://hooks.acme.example/x', 'short',
                  ARRAY['session.completed']::app.webhook_event[])$ins$,
    pg_temp.wid('whk', 'wshort'), pg_temp.tid('org_a')),
  '23514', NULL,
  'a short secret is refused — a forgeable signature fails SILENTLY: every request verifies and '
  'nothing looks wrong');

SELECT throws_ok(
  format($ins$INSERT INTO app.webhooks (id, org_id, url, secret, events)
          VALUES (%L, %L, 'https://hooks.acme.example/x', %L, '{}'::app.webhook_event[])$ins$,
    pg_temp.wid('whk', 'wempty'), pg_temp.tid('org_a'), repeat('a', 44)),
  '23514', NULL,
  'an empty event list is refused: it receives nothing while looking configured');

SELECT throws_ok(
  format($ins$INSERT INTO app.webhooks (id, org_id, url, secret, events)
          VALUES (%L, %L, 'https://hooks.acme.example/x', %L,
                  ARRAY['session.completed','session.completed']::app.webhook_event[])$ins$,
    pg_temp.wid('whk', 'wdup'), pg_temp.tid('org_a'), repeat('a', 44)),
  '23514', NULL,
  'a duplicated event is refused');

-- The secret column, which is the point of the column-level REVOKE.
SELECT throws_ok(
  'SELECT secret FROM app.webhooks',
  '42501', NULL,
  'an OWNER cannot read the secret back — the column REVOKE is what makes "shown once at '
  'creation" an enforced property rather than a UI convention');

SELECT lives_ok(
  'SELECT id, url, events, enabled FROM app.webhooks',
  'but every other column reads normally, so the subscription is still manageable');

SELECT lives_ok(
  format('UPDATE app.webhooks SET secret = %L WHERE id = %L',
         repeat('b', 44), pg_temp.wid('whk', 'wa')),
  'and rotation still works: writing a key you cannot read is exactly the asymmetry wanted here');

-- The role floor. user_a2 is org A's reviewer; a programmer is also below admin.
SELECT pg_temp.act_as(pg_temp.tid('user_a2')::uuid, pg_temp.tid('org_a'));
SELECT is((SELECT count(*)::int FROM app.webhooks), 0,
  'a reviewer cannot even SEE a subscription — a webhook forwards completion data to an arbitrary '
  'endpoint, which is org configuration, not survey editing');

-- ---------------------------------------------------------------------------
-- 3. The trigger: the outbox is appended by the FACT, not by a caller
-- ---------------------------------------------------------------------------
RESET ROLE;
SET LOCAL ROLE runtime_writer;

SELECT runtime.start_session('whbcdefghij0123456789klmnp', pg_temp.sid('s1'),
                             repeat('deadbeef', 4), 'en', false);
RESET ROLE;

SELECT is((SELECT count(*)::int FROM runtime.webhook_outbox), 0,
  'starting a session appends NO event — only a terminal disposition is an event');

-- A heartbeat, which is the common case by far: the trigger is `AFTER UPDATE OF disposition`, so
-- this must not even evaluate the function.
UPDATE runtime.sessions SET last_seen_at = now() WHERE id = pg_temp.sid('s1');
SELECT is((SELECT count(*)::int FROM runtime.webhook_outbox), 0,
  'a last_seen_at heartbeat appends nothing — the trigger is OF disposition, so the millions of '
  'heartbeat updates never pay for this feature');

UPDATE runtime.sessions SET disposition = 'COMPLETE', status = 'completed', finished_at = now()
 WHERE id = pg_temp.sid('s1');

SELECT is((SELECT count(*)::int FROM runtime.webhook_outbox), 1,
  'a session reaching COMPLETE appends exactly one outbox row');
SELECT is((SELECT event::text FROM runtime.webhook_outbox), 'session.completed',
  'mapped through runtime.webhook_event_for');
SELECT is((SELECT payload->>'session_id' FROM runtime.webhook_outbox), pg_temp.sid('s1')::text,
  'and the payload is denormalized at append time, so a retried delivery reports the event that '
  'fired rather than the session''s current state');
SELECT is((SELECT event_key FROM runtime.webhook_outbox),
  pg_temp.sid('s1')::text || ':COMPLETE',
  'the idempotency key is DERIVED, which makes a duplicate append impossible rather than unlikely');

-- Re-running the same UPDATE must not append again.
UPDATE runtime.sessions SET disposition = 'COMPLETE' WHERE id = pg_temp.sid('s1');
SELECT is((SELECT count(*)::int FROM runtime.webhook_outbox), 1,
  'setting the SAME disposition again appends nothing — IS NOT DISTINCT FROM, because '
  'OLD.disposition is NULL for every unfinished session and a plain <> would be NULL and fire for '
  'nothing at all');

-- A RE-disposition, though, IS a new event a receiver must see.
UPDATE runtime.sessions SET disposition = 'FRAUD' WHERE id = pg_temp.sid('s1');
SELECT is((SELECT count(*)::int FROM runtime.webhook_outbox), 2,
  'a re-disposition (a fraud review, a support correction) IS a new event — the disposition is in '
  'the key for exactly this reason');
SELECT is(
  (SELECT event::text FROM runtime.webhook_outbox WHERE event_key LIKE '%FRAUD'),
  'session.terminated',
  'and FRAUD coarsens to session.terminated: exposing our fraud taxonomy over a webhook would '
  'tell a panel vendor which of their respondents we flagged, and why');

-- The mapping itself, exhaustively, since a wrong row here is a webhook delivered to the wrong
-- subscribers.
SELECT is(runtime.webhook_event_for('SCREENOUT')::text, 'session.screenout', 'SCREENOUT maps');
SELECT is(runtime.webhook_event_for('QUOTA_FULL')::text, 'session.quota_full', 'QUOTA_FULL maps');
SELECT is(runtime.webhook_event_for('ABANDONED')::text, 'session.abandoned',
  'and the three non-redirect dispositions fall to session.abandoned');

-- ---------------------------------------------------------------------------
-- 4. Dispatch: one event, one delivery per subscription, however many runs
-- ---------------------------------------------------------------------------
-- As the connection role, NOT as an impersonated user: webhook delivery is system machinery
-- acting on nobody's behalf, which is why apps/worker's asUser pattern (SET LOCAL ROLE authoring
-- with the job's claims) does not apply to it. The posture section below asserts that `authoring`
-- cannot reach these functions at all.
RESET ROLE;

-- ONE delivery, not two, and that is the event filter working: org A's subscription asked for
-- session.completed only, and the second outbox row is the FRAUD re-disposition, which coarsens to
-- session.terminated. I expected 2 here and was wrong — the assertion is more valuable as written,
-- because "an event nobody subscribed to creates no delivery" is the property that keeps a new
-- disposition from silently fanning out to every existing subscriber.
SELECT is(app.webhook_dispatch_batch(), 1,
  'only the SUBSCRIBED event fans out — the session.terminated row matches no subscription and '
  'creates no delivery');

SELECT is(app.webhook_dispatch_batch(), 0,
  'a SECOND dispatch creates nothing: the dispatched_at stamp and the unique (webhook_id, '
  'event_key) make a double run a no-op, which is what allows two workers to drain concurrently');

SELECT is((SELECT count(*)::int FROM app.webhook_deliveries), 1,
  'and the delivery log has exactly one row, not two');

SELECT is(
  (SELECT count(*)::int FROM runtime.webhook_outbox WHERE dispatched_at IS NULL), 0,
  'every outbox row is stamped — and NOT deleted, because the row is the evidence the event was '
  'observed and a queue that erases its history cannot answer "did this ever fire"');

-- The claim path, which is the only route to the secret.
-- Claimed ONCE into a temp table, then asserted on. Each call to webhook_claim consumes a claim
-- and takes the lease, so two assertions each making their own call would have the second one
-- looking at an empty result — which is how the "rotated secret" assertion first failed, for a
-- reason that had nothing to do with rotation.
CREATE TEMP TABLE claim1 AS SELECT * FROM app.webhook_claim('worker-1');
SELECT is((SELECT count(*)::int FROM claim1), 1, 'the worker claims one delivery at a time');
SELECT is((SELECT secret FROM claim1), repeat('b', 44),
  'and receives the ROTATED secret — the claim reads the live subscription, so a rotation takes '
  'effect on the next attempt rather than on the next event');
SELECT is((SELECT payload->>'disposition' FROM claim1), 'COMPLETE',
  'along with the payload as it was appended, not as the session reads now');

SELECT throws_ok(
  $$ SELECT * FROM app.webhook_claim('') $$,
  '22023', NULL,
  'a claim with no worker identity is refused: an attempt nobody can be traced to is not one');

SELECT is((SELECT count(*)::int FROM app.webhook_deliveries WHERE attempts > 0), 1,
  'attempts increment AT CLAIM TIME — a worker that dies mid-request must not leave a delivery '
  'that looks unattempted, or a poison payload retries forever');

SELECT is((SELECT count(*)::int FROM app.webhook_claim('worker-1')), 0,
  'and a claimed delivery is not re-claimed: the LEASE excludes it. FOR UPDATE SKIP LOCKED alone '
  'was not enough and I had it wrong — the row lock lasts only as long as the claiming '
  'transaction, so once a worker commits its attempt bump the row is pending again and a second '
  'worker takes it while the first is still waiting on the receiver');

-- Recording an outcome.
SELECT lives_ok(
  format($rec$SELECT app.webhook_record_attempt(%L, 'delivered', 200, 'ok')$rec$,
    (SELECT id FROM app.webhook_deliveries ORDER BY created_at LIMIT 1)),
  'an outcome records');
SELECT is(
  (SELECT count(*)::int FROM app.webhook_deliveries
    WHERE status = 'delivered' AND delivered_at IS NOT NULL), 1,
  'delivered implies delivered_at, by biconditional — a row claiming success with no time makes '
  'every "when did this land" query wrong');

SELECT throws_ok(
  format($rec$SELECT app.webhook_record_attempt(%L, 'pending')$rec$,
    (SELECT id FROM app.webhook_deliveries ORDER BY created_at LIMIT 1)),
  '22023', NULL,
  'an OUTCOME cannot be "pending" — that is the state a delivery starts in, not one an attempt '
  'can conclude with');

-- A receiver's enormous error page is truncated rather than raising and losing the outcome.
SELECT lives_ok(
  format($rec$SELECT app.webhook_record_attempt(%L, 'failed', 500, %L, 'HTTP 500')$rec$,
    (SELECT id FROM app.webhook_deliveries ORDER BY created_at LIMIT 1),
    repeat('x', 20000)),
  'a 20 KB error body is truncated, not rejected — losing the outcome to protect a column would '
  'be the wrong trade');
SELECT is(
  (SELECT length(response_body) FROM app.webhook_deliveries
    ORDER BY created_at LIMIT 1), 4096,
  'at the CHECK''s own bound');

-- ---------------------------------------------------------------------------
-- 5. Tenancy
-- ---------------------------------------------------------------------------
RESET ROLE;
-- Org B subscribes to the same event. Its deliveries must not include org A's completions.
SELECT pg_temp.act_as(pg_temp.tid('user_b')::uuid, pg_temp.tid('org_b'));
INSERT INTO app.webhooks (id, org_id, url, secret, events)
VALUES (pg_temp.wid('whk', 'wb'), pg_temp.tid('org_b')::app.ulid,
        'https://hooks.other.example/resscript', repeat('c', 44),
        ARRAY['session.completed','session.terminated']::app.webhook_event[]);

RESET ROLE;
SELECT is(app.webhook_dispatch_batch(), 0,
  'org B''s new subscription gets NOTHING from org A''s already-dispatched events — the match is '
  'on the event''s own org_id, and there is no argument that could change that');

RESET ROLE;
SELECT pg_temp.act_as(pg_temp.tid('user_b')::uuid, pg_temp.tid('org_b'));
SELECT is((SELECT count(*)::int FROM app.webhook_deliveries), 0,
  'and org B sees none of org A''s delivery log');

SELECT throws_ok(
  format('SELECT app.webhook_requeue(%L)',
    (SELECT id FROM app.webhook_deliveries WHERE org_id = pg_temp.tid('org_a')::app.ulid
      ORDER BY created_at LIMIT 1)),
  'P0002', NULL,
  'and a cross-org redelivery reads as NOT FOUND, indistinguishable from a delivery that never '
  'existed (0004''s existence-oracle rule)');

-- Redelivery, in-org.
SELECT pg_temp.act_as(pg_temp.tid('user_a')::uuid, pg_temp.tid('org_a'));
SELECT set_config('rs.did',
  (SELECT id::text FROM app.webhook_deliveries ORDER BY created_at LIMIT 1), true);
SELECT lives_ok(
  format('SELECT app.webhook_requeue(%L)', current_setting('rs.did')),
  'an admin can force a redelivery');
-- A requeue with a delay is the worker's retry; the same call with no delay is the admin's
-- redelivery. Asserted together because they being one function is the design decision.
SELECT ok(
  (SELECT next_attempt_at FROM app.webhook_deliveries
    WHERE id = current_setting('rs.did')::app.ulid) <= now() + interval '1 second',
  'and a redelivery is immediately claimable — same field the worker uses for backoff');
SELECT is(
  (SELECT status::text FROM app.webhook_deliveries WHERE id = current_setting('rs.did')::app.ulid),
  'pending', 'which returns it to the queue');
SELECT ok(
  (SELECT attempts FROM app.webhook_deliveries WHERE id = current_setting('rs.did')::app.ulid) > 0,
  'and does NOT reset attempts: zeroing the counter would erase the evidence that this endpoint '
  'has failed repeatedly, which is the only number distinguishing broken from briefly unlucky');

-- ---------------------------------------------------------------------------
-- 6. Posture
-- ---------------------------------------------------------------------------
RESET ROLE;
SELECT set_config('request.jwt.claims', '', true);
SELECT ok(NOT has_table_privilege('authoring', 'runtime.webhook_outbox', 'SELECT'),
  'authoring cannot read the outbox — ADR-001, and there is nothing in it an author needs that '
  'app.webhook_deliveries does not show them');
-- The posture 0011's standing assertion forced, and the reason it is right: runtime_writer holds
-- NO privilege on this table at all, not even INSERT. The trigger is SECURITY DEFINER, so the
-- append carries the function owner's privilege and the runtime keeps a capability surface of
-- function signatures only (ADR-009 risk R3). My first version granted INSERT here and 0011
-- rejected it.
SELECT ok(NOT has_table_privilege('runtime_writer', 'runtime.webhook_outbox', 'INSERT')
      AND NOT has_table_privilege('runtime_writer', 'runtime.webhook_outbox', 'SELECT'),
  'runtime_writer holds NO privilege on the outbox — the SECURITY DEFINER trigger is what appends, '
  'so this feature costs the runtime no new surface');
-- 0001's default privileges hand `authoring` full DML on every new table in schema app, so this
-- passing requires the explicit REVOKE in up.sql. Without it the assertion fails even though there
-- is no write POLICY — and relying on a missing policy would be one CREATE POLICY away from a
-- rewritable log.
SELECT ok(NOT has_table_privilege('authoring', 'app.webhook_deliveries', 'UPDATE')
      AND NOT has_table_privilege('authoring', 'app.webhook_deliveries', 'INSERT')
      AND NOT has_table_privilege('authoring', 'app.webhook_deliveries', 'DELETE'),
  'nobody in the control plane can write the delivery log — a log a client can rewrite is not a '
  'log, and the GRANT is revoked as well as the policy being absent');

-- The lease and the backoff share one field, so a retry and a redelivery cannot disagree about
-- when a delivery may next be attempted.
SELECT has_column('app', 'webhook_deliveries', 'next_attempt_at',
  'the lease/backoff field exists');
SELECT has_index('app', 'webhook_deliveries', 'webhook_deliveries_pending_idx',
  'and the claim''s ORDER BY has a matching index, or every poll scans the pending set');

SELECT * FROM finish();
ROLLBACK;
