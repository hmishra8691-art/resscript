-- 0005_job_ownership_and_readers/test.sql — pgTAP.
--
-- The centrepiece is the stolen-claim test. It is the reason this migration exists: a
-- stalled worker must not be able to complete a job that has since been reassigned. That
-- interleaving is unreachable through the public API and would only ever be observed in
-- production as "a job reported success but its output is wrong", which is close to
-- undebuggable after the fact. It is asserted directly here instead.
--
-- Two harness properties this file has to respect, both learned the hard way:
--
--  * EVERY SECTION USES ITS OWN JOB `kind`. ops.claim_job takes the oldest DUE job of a
--    kind, so a section that enqueues `noop` and then claims `noop` can be handed a job
--    left queued by an earlier section. The resulting failure looks like a bug in the
--    sweeper. jobs_kind_fmt allows any ^[a-z][a-z0-9_]{1,63}$, so kinds are free.
--  * ENQUEUE AND INSPECT ARE SEPARATE STATEMENTS. ops.enqueue_job is a VOLATILE function;
--    a single statement that calls it and joins the result against ops.jobs sees the
--    statement's snapshot, taken before the INSERT, and returns zero rows. The row is
--    visible to the next statement.
--
-- Signature-shape assertions for the job RPCs live HERE rather than in 0003, because 0005
-- is the migration that currently defines those signatures (see db/README.md, "When a
-- later migration changes an earlier migration's objects").
BEGIN;
SELECT plan(68);

-- ---------------------------------------------------------------------------
-- Signatures
-- ---------------------------------------------------------------------------
-- pgTAP wants domain arguments SCHEMA-QUALIFIED: 'app.ulid', not 'ulid'. A bare 'ulid'
-- silently fails to match and the assertion reports "function does not exist".
SELECT has_function('ops', 'heartbeat_job', ARRAY['app.ulid', 'text', 'jsonb'],
  'ops.heartbeat_job takes the worker identity');
SELECT has_function('ops', 'complete_job', ARRAY['app.ulid', 'text', 'jsonb'],
  'ops.complete_job takes the worker identity');
SELECT has_function('ops', 'fail_job',
  ARRAY['app.ulid', 'text', 'jsonb', 'boolean', 'integer'],
  'ops.fail_job takes the worker identity and an explicit retry delay');
SELECT has_function('app', 'get_job', ARRAY['app.ulid'], 'app.get_job exists');
SELECT has_function('ops', 'enqueue_job',
  ARRAY['text', 'jsonb', 'text', 'app.ulid', 'app.ulid', 'app.ulid', 'integer', 'integer'],
  'ops.enqueue_job takes p_delay_ms in the last position, not p_created_by uuid');
SELECT hasnt_function('ops', 'enqueue_job',
  ARRAY['text', 'jsonb', 'text', 'app.ulid', 'app.ulid', 'app.ulid', 'integer', 'uuid'],
  'the old enqueue_job with a trailing uuid is removed: a caller passing a delay into it '
  'was a type error waiting for its first scheduled job');
SELECT has_function('app', 'resolve_invitation', ARRAY['bytea'],
  'app.resolve_invitation exists');

-- The old unscoped forms must be GONE, not overloaded. An overload would silently keep the
-- racy path callable from any call site that omits the worker.
SELECT hasnt_function('ops', 'complete_job', ARRAY['app.ulid', 'jsonb'],
  'the unscoped complete_job(app.ulid, jsonb) overload is removed, not shadowed');
SELECT hasnt_function('ops', 'heartbeat_job', ARRAY['app.ulid', 'jsonb'],
  'the unscoped heartbeat_job(app.ulid, jsonb) overload is removed');
SELECT hasnt_function('ops', 'fail_job', ARRAY['app.ulid', 'jsonb', 'boolean'],
  'the unscoped fail_job(app.ulid, jsonb, boolean) overload is removed');
SELECT hasnt_function('ops', 'fail_job', ARRAY['app.ulid', 'text', 'jsonb', 'boolean'],
  'there is exactly ONE fail_job: the four-argument form is not left behind as an overload '
  'that skips the retry-delay parameter');

-- ---------------------------------------------------------------------------
-- enqueue_job returns (id, created)
-- ---------------------------------------------------------------------------
CREATE TEMP TABLE t (id app.ulid);
INSERT INTO t SELECT e.id FROM ops.enqueue_job('happy', '{}', 'ok-1') e;

-- (id, created) is what lets the API answer 201 vs 200 on a repeated Idempotency-Key.
SELECT ok((SELECT e.created FROM ops.enqueue_job('idem', '{}', 'first-time') e),
  'a fresh enqueue reports created = true');
SELECT ok(NOT (SELECT e.created FROM ops.enqueue_job('idem', '{}', 'first-time') e),
  'a repeated idempotency key reports created = false rather than looking identical to a '
  'fresh insert');
SELECT is(
  (SELECT e.id FROM ops.enqueue_job('idem', '{}', 'first-time') e),
  (SELECT j.id FROM ops.jobs j WHERE j.idempotency_key = 'first-time'),
  'and still returns a handle to the existing job');
SELECT results_eq(
  $$ SELECT count(*)::int FROM ops.jobs WHERE idempotency_key = 'first-time' $$, ARRAY[1],
  'three enqueues under one idempotency key still produce exactly one row');

-- created_by is derived from the session, never from a parameter (0005 dropped
-- p_created_by), so an unauthenticated service-role enqueue records NULL rather than
-- whatever the caller claimed.
SELECT results_eq(
  $$ SELECT created_by FROM ops.jobs WHERE idempotency_key = 'ok-1' $$, ARRAY[NULL::uuid],
  'created_by comes from app.current_user_id(), which is NULL with no JWT — not from a '
  'caller-supplied and therefore spoofable argument');

-- ---------------------------------------------------------------------------
-- Deferred enqueue (p_delay_ms)
-- ---------------------------------------------------------------------------
-- Enqueue in its own statement: joining ops.enqueue_job against ops.jobs in ONE statement
-- returns zero rows, because the statement's snapshot predates the function's INSERT.
CREATE TEMP TABLE d (id app.ulid);
INSERT INTO d SELECT e.id
  FROM ops.enqueue_job('deferred', '{}', 'delayed-1', NULL, NULL, NULL, 3, 30000) e;
SELECT ok(
  (SELECT j.run_after > clock_timestamp() + interval '20 seconds'
     FROM ops.jobs j WHERE j.id = (SELECT id FROM d)),
  'p_delay_ms defers the job by writing run_after');
SELECT is(
  (SELECT count(*)::int FROM ops.jobs j
    WHERE j.idempotency_key = 'delayed-1' AND j.run_after <= clock_timestamp()),
  0, 'a deferred job is not yet claimable');
SELECT is((SELECT (ops.claim_job(ARRAY['deferred'], 'worker-Z')).id), NULL,
  'claim_job will not hand out a job whose run_after is in the future');

-- ---------------------------------------------------------------------------
-- claim_job requires a worker identity (0005 §1a)
-- ---------------------------------------------------------------------------
-- Without this, locked_by can be NULL while a job is running, every anonymous caller
-- matches `locked_by IS NOT DISTINCT FROM p_worker`, and the whole compare-and-set below
-- is defeated by simply not naming yourself.
SELECT throws_ok($$ SELECT ops.claim_job(ARRAY['happy']) $$, '22023', NULL,
  'claim_job refuses an anonymous claim, so locked_by is never NULL while running and the '
  'ownership guard cannot be bypassed by omitting the worker');
SELECT throws_ok($$ SELECT ops.claim_job(ARRAY['happy'], '  ') $$, '22023', NULL,
  'claim_job refuses a blank worker identity too');

-- ---------------------------------------------------------------------------
-- Happy path still works
-- ---------------------------------------------------------------------------
SELECT is((SELECT (ops.claim_job(ARRAY['happy'], 'worker-A')).id), (SELECT id FROM t),
  'worker-A claims the job');
SELECT ok(ops.heartbeat_job((SELECT id FROM t), 'worker-A', '{"step":1,"total":2}'),
  'the claiming worker can heartbeat');
SELECT results_eq(
  $$ SELECT progress ->> 'step' FROM ops.jobs WHERE idempotency_key = 'ok-1' $$, ARRAY['1'],
  'heartbeat writes progress for the studio job view');
SELECT ok(ops.complete_job((SELECT id FROM t), 'worker-A', '{"rows":7}'),
  'the claiming worker can complete');
SELECT results_eq(
  $$ SELECT status::text FROM ops.jobs WHERE idempotency_key = 'ok-1' $$, ARRAY['succeeded'],
  'the job is succeeded');
SELECT results_eq(
  $$ SELECT locked_by FROM ops.jobs WHERE idempotency_key = 'ok-1' $$, ARRAY[NULL::text],
  'completion releases the claim');

-- ---------------------------------------------------------------------------
-- The stolen-claim race — the reason for this migration
-- ---------------------------------------------------------------------------
CREATE TEMP TABLE r (id app.ulid);
INSERT INTO r SELECT e.id FROM ops.enqueue_job('race', '{}', 'race-1') e;

-- worker-A claims, then stalls: force the heartbeat far into the past.
SELECT is((SELECT (ops.claim_job(ARRAY['race'], 'worker-A')).id), (SELECT id FROM r),
  'worker-A claims the race job — and it is the job this section enqueued, not one left '
  'queued by an earlier section');
UPDATE ops.jobs SET heartbeat_at = clock_timestamp() - interval '1 hour'
 WHERE id = (SELECT id FROM r);

SELECT is(ops.requeue_stalled_jobs(interval '2 minutes'), 1,
  'the sweeper requeues the stalled job');
SELECT results_eq(
  $$ SELECT status::text FROM ops.jobs WHERE idempotency_key = 'race-1' $$, ARRAY['queued'],
  'the job is back on the queue');

-- worker-B picks it up.
SELECT is((ops.claim_job(ARRAY['race'], 'worker-B')).locked_by, 'worker-B',
  'worker-B claims the reassigned job');
SELECT results_eq(
  $$ SELECT attempts FROM ops.jobs WHERE idempotency_key = 'race-1' $$, ARRAY[2],
  'the reassignment burned an attempt');

-- worker-A now wakes up. Under 0003's status-only guard every one of these would have
-- succeeded and clobbered worker-B.
SELECT ok(NOT ops.heartbeat_job((SELECT id FROM r), 'worker-A'),
  'the stalled worker''s heartbeat is refused, which is how it learns to stop working');
SELECT ok(NOT ops.complete_job((SELECT id FROM r), 'worker-A', '{"stale":true}'),
  'the stalled worker CANNOT complete a job that was reassigned');
SELECT is(ops.fail_job((SELECT id FROM r), 'worker-A', '{}', true), 'not_owner',
  'the stalled worker''s failure report is refused with not_owner, not silently applied');

SELECT results_eq(
  $$ SELECT status::text FROM ops.jobs WHERE idempotency_key = 'race-1' $$, ARRAY['running'],
  'the job is still running under worker-B, untouched by worker-A');
SELECT results_eq(
  $$ SELECT locked_by FROM ops.jobs WHERE idempotency_key = 'race-1' $$, ARRAY['worker-B'],
  'and the claim still belongs to worker-B: a refused transition releases nothing');
SELECT results_eq(
  $$ SELECT result FROM ops.jobs WHERE idempotency_key = 'race-1' $$, ARRAY[NULL::jsonb],
  'worker-A''s stale result was NOT written');

-- worker-B, the legitimate owner, still finishes normally.
SELECT ok(ops.complete_job((SELECT id FROM r), 'worker-B', '{"rows":9}'),
  'the legitimate owner completes');
SELECT results_eq(
  $$ SELECT result ->> 'rows' FROM ops.jobs WHERE idempotency_key = 'race-1' $$, ARRAY['9'],
  'the stored result is worker-B''s, not worker-A''s');

-- 'not_owner' is distinct from "no such running job", because only the first means another
-- worker is still on it and this one must stay quiet rather than retry.
SELECT is(ops.fail_job((SELECT id FROM r), 'worker-B', '{}', true), 'not_owner',
  'fail_job on an already-finished job also reports not_owner — the caller holds no claim');
SELECT is(ops.fail_job('job_0Z000000000000000000000000', 'worker-B', '{}', true), 'not_owner',
  'fail_job on a job id that does not exist reports not_owner rather than raising');

-- ---------------------------------------------------------------------------
-- Backoff is written to run_after (the column apps/worker maps to available_at)
-- ---------------------------------------------------------------------------
CREATE TEMP TABLE b (id app.ulid);
INSERT INTO b SELECT e.id
  FROM ops.enqueue_job('backoff', '{}', 'backoff-1', NULL, NULL, NULL, 5) e;
SELECT is((SELECT (ops.claim_job(ARRAY['backoff'], 'worker-C')).id), (SELECT id FROM b),
  'worker-C claims the backoff job');
SELECT is(ops.fail_job((SELECT id FROM b), 'worker-C', '{"code":"boom"}', true), 'queued',
  'a retryable failure with budget left returns queued');
SELECT ok(
  (SELECT run_after > clock_timestamp() FROM ops.jobs WHERE idempotency_key = 'backoff-1'),
  'run_after is pushed into the future, so the retry is a real delay and not an instant '
  'burn through the attempt budget');
SELECT results_eq(
  $$ SELECT locked_by FROM ops.jobs WHERE idempotency_key = 'backoff-1' $$, ARRAY[NULL::text],
  'a requeued job releases its claim, so the next worker can take it');

-- An explicit Retry-After from an upstream must beat the computed backoff, or an
-- integration that told us to wait five minutes gets hammered after two seconds.
CREATE TEMP TABLE ra (id app.ulid);
INSERT INTO ra SELECT e.id
  FROM ops.enqueue_job('retryafter', '{}', 'retry-after-1', NULL, NULL, NULL, 5) e;
SELECT is((SELECT (ops.claim_job(ARRAY['retryafter'], 'worker-D')).id), (SELECT id FROM ra),
  'worker-D claims the retry-after job');
SELECT is(
  ops.fail_job((SELECT id FROM ra), 'worker-D', '{"code":"rate_limited"}', true, 300000),
  'queued', 'an explicit retry delay still returns queued');
SELECT ok(
  (SELECT run_after > clock_timestamp() + interval '4 minutes'
     FROM ops.jobs WHERE idempotency_key = 'retry-after-1'),
  'p_retry_after_ms overrides the 2^attempts backoff, so an upstream Retry-After is honoured '
  'instead of being retried in two seconds');

-- p_retry = false must go terminal even with budget remaining.
CREATE TEMP TABLE pf (id app.ulid);
INSERT INTO pf SELECT e.id
  FROM ops.enqueue_job('permfail', '{}', 'perm-1', NULL, NULL, NULL, 9) e;
SELECT is((SELECT (ops.claim_job(ARRAY['permfail'], 'worker-E')).id), (SELECT id FROM pf),
  'worker-E claims the permanent-failure job');
SELECT is(ops.fail_job((SELECT id FROM pf), 'worker-E', '{"code":"bad_payload"}', false),
  'failed',
  'p_retry = false fails terminally even with 8 attempts of budget left: a malformed '
  'payload will not become well-formed on the third attempt');

-- ---------------------------------------------------------------------------
-- app.get_job: reachable, tenant-scoped, and payload-free
-- ---------------------------------------------------------------------------
-- Reachability is asserted first because it is the failure this reader was moved out of
-- schema `ops` to avoid: EXECUTE without USAGE on the schema is inert, and `authoring` has
-- no USAGE on ops by design (B §0).
SELECT is(has_function_privilege('authoring', 'app.get_job(app.ulid)', 'EXECUTE'), true,
  'authoring holds EXECUTE on app.get_job');
SELECT is(has_schema_privilege('authoring', 'app', 'USAGE'), true,
  'and USAGE on the schema it lives in, so the grant is not inert');
SELECT is(has_table_privilege('authoring', 'ops.jobs', 'SELECT'), false,
  'authoring still cannot SELECT ops.jobs directly: the reader is the ONLY path, which is '
  'what keeps the tenancy filter unforgettable');

SELECT is(
  (SELECT count(*)::int FROM information_schema.parameters
    WHERE specific_schema = 'app' AND parameter_name = 'payload'
      AND specific_name LIKE 'get_job%'),
  0,
  'app.get_job does not return jobs.payload: a compile payload can carry survey content '
  'and the studio needs only status and progress');

-- With no JWT claims set, app.current_org() is NULL, so get_job must return nothing at all
-- rather than falling open.
SELECT is((SELECT count(*)::int FROM app.get_job((SELECT id FROM t))), 0,
  'app.get_job returns zero rows when there is no org context: it fails closed');

-- The tenancy claim itself, which needs two orgs to mean anything.
SELECT set_config('rs.ids', ops.test_seed_two_orgs()::text, true);
CREATE FUNCTION pg_temp.tid(k text) RETURNS text LANGUAGE sql STABLE AS
$$ SELECT current_setting('rs.ids', true)::jsonb ->> k $$;
CREATE FUNCTION pg_temp.act_as(p_user uuid, p_org text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', p_user, 'role', 'authoring',
                      'app_metadata', json_build_object('active_org_id', p_org))::text,
    true);
  EXECUTE 'SET LOCAL ROLE authoring';
END $$;

-- The job id travels in a GUC rather than a temp table: a temp table created by the
-- migration runner is not readable by `authoring`, and every assertion below runs as
-- `authoring`. (0004's suite publishes its fixture ids the same way, for the same reason.)
CREATE TEMP TABLE g (id app.ulid);
INSERT INTO g SELECT e.id FROM ops.enqueue_job('tenantjob', '{"secret":"payload"}',
  'tenant-1', pg_temp.tid('org_a')::app.ulid, pg_temp.tid('prj_a')::app.ulid) e;
SELECT set_config('rs.jobid', (SELECT id FROM g), true);
CREATE FUNCTION pg_temp.jobid() RETURNS app.ulid LANGUAGE sql STABLE AS
$$ SELECT current_setting('rs.jobid', true)::app.ulid $$;

-- pgTAP lives in `public`, which 0001 hardened; granted inside this rolled-back
-- transaction only (same reasoning as 0004's suite).
GRANT USAGE ON SCHEMA public TO authoring;

SELECT pg_temp.act_as(pg_temp.tid('user_a')::uuid, pg_temp.tid('org_a'));
SELECT is((SELECT count(*)::int FROM app.get_job(pg_temp.jobid())), 1,
  'org A''s owner can read org A''s job through app.get_job');
SELECT is((SELECT j.status FROM app.get_job(pg_temp.jobid()) j), 'queued',
  'and gets the status the studio needs to render progress');

SELECT pg_temp.act_as(pg_temp.tid('user_b')::uuid, pg_temp.tid('org_b'));
SELECT is((SELECT count(*)::int FROM app.get_job(pg_temp.jobid())), 0,
  'org B cannot read org A''s job even though it holds the job id');
SELECT pg_temp.act_as(pg_temp.tid('user_b')::uuid, pg_temp.tid('org_a'));
SELECT is((SELECT count(*)::int FROM app.get_job(pg_temp.jobid())), 0,
  'forging active_org_id to org A gains nothing: get_job filters on current_org() AND the '
  'membership-backed can_see_project(), so it returns zero rows rather than raising');

-- A project-scoped member must not see a job for a project they are not staffed on.
SELECT pg_temp.act_as(pg_temp.tid('user_a2')::uuid, pg_temp.tid('org_a'));
SELECT is((SELECT count(*)::int FROM app.get_job(pg_temp.jobid())), 1,
  'a member scoped to project A can read project A''s job');
RESET ROLE;
UPDATE ops.jobs SET project_id = pg_temp.tid('prj_a2')::app.ulid WHERE id = pg_temp.jobid();
SELECT pg_temp.act_as(pg_temp.tid('user_a2')::uuid, pg_temp.tid('org_a'));
SELECT is((SELECT count(*)::int FROM app.get_job(pg_temp.jobid())), 0,
  'the same member cannot read a job for the sibling project they are NOT staffed on');

-- ---------------------------------------------------------------------------
-- app.resolve_invitation
-- ---------------------------------------------------------------------------
RESET ROLE;
SELECT set_config('request.jwt.claims', '', true);

SELECT is(
  (SELECT r.org_slug FROM app.resolve_invitation(
     app.hash_invitation_token('token-for-org-a')) r),
  'org-a',
  'resolve_invitation finds an invitation by token hash for a caller who is not yet a '
  'member and therefore can never be granted a SELECT policy on app.invitations');
SELECT is(
  (SELECT count(*)::int FROM app.resolve_invitation(
     app.hash_invitation_token('not-a-real-token'))),
  0, 'an unknown token hash resolves to nothing');
SELECT is_empty($$
  SELECT 1 FROM information_schema.parameters
   WHERE specific_schema = 'app' AND specific_name LIKE 'resolve_invitation%'
     AND parameter_name IN ('token', 'token_hash') AND parameter_mode = 'OUT'
$$, 'resolve_invitation returns no token material, only what the accept screen needs');
SELECT is(has_function_privilege('authoring', 'app.resolve_invitation(bytea)', 'EXECUTE'),
  true, 'authoring can execute resolve_invitation');

-- ---------------------------------------------------------------------------
-- Structural guards still clear
-- ---------------------------------------------------------------------------
SELECT is_empty($$ SELECT ops.tables_without_rls() $$,
  '0005 added no table without RLS');
SELECT is_empty($$
  SELECT n.nspname || '.' || p.proname
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname IN ('app','content','runtime','export','billing','ops')
     AND p.prosecdef
     AND NOT EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig, '{}')) c
                      WHERE c LIKE 'search\_path=%')
$$, '0005''s new SECURITY DEFINER functions all pin search_path');

SELECT * FROM finish();
ROLLBACK;
