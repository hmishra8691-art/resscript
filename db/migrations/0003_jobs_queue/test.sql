-- 0003_jobs_queue/test.sql — pgTAP.
--
-- Migration 0005 re-signed enqueue_job, heartbeat_job, complete_job and fail_job. Because
-- every test.sql runs against the FULLY MIGRATED database, the call sites below are written
-- against those CURRENT signatures even though the behaviours they assert were introduced
-- here. The signature-SHAPE assertions moved to 0005, which now owns those signatures — see
-- db/README.md, "When a later migration changes an earlier migration's objects".
--
-- Roadmap M0.4's three job tests, brought forward because the queue lands in 0003:
--   * a job that crashes twice then succeeds ends with attempts = 3 and one succeeded row
--   * a job killed mid-run is requeued by the stalled sweeper
--   * the same idempotency_key enqueued twice returns one job id
-- All three are asserted below against the plain-SQL queue rather than pgmq.
BEGIN;
SELECT plan(41);

-- ---------------------------------------------------------------------------
-- Shape (B §10.1)
-- ---------------------------------------------------------------------------
SELECT has_table('ops', 'jobs', 'ops.jobs exists');
SELECT has_column('ops', 'jobs', 'progress',        'ops.jobs.progress exists (step N of M)');
SELECT has_column('ops', 'jobs', 'attempts',        'ops.jobs.attempts exists');
SELECT has_column('ops', 'jobs', 'idempotency_key', 'ops.jobs.idempotency_key exists');
SELECT has_column('ops', 'jobs', 'heartbeat_at',    'ops.jobs.heartbeat_at exists');
SELECT has_column('ops', 'jobs', 'queue_msg_id',
  'ops.jobs.queue_msg_id is retained so pgmq can be adopted without a schema change');
SELECT has_index('ops', 'jobs', 'jobs_stalled_idx',
  'jobs_stalled_idx exists to support the requeue sweeper (B §10.1)');
SELECT has_index('ops', 'jobs', 'jobs_idem_key', 'jobs_idem_key exists');
SELECT has_index('ops', 'jobs', 'jobs_org_idx',  'jobs_org_idx exists');

-- The sweeper index must be PARTIAL, or it grows with job history instead of with
-- in-flight work and the sweeper gets slower every month.
SELECT isnt_empty($$
  SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
   WHERE c.relname = 'jobs_stalled_idx' AND i.indpred IS NOT NULL
$$, 'jobs_stalled_idx is partial on status = ''running''');

-- FOR UPDATE SKIP LOCKED is the whole concurrency design; assert it is actually there.
SELECT matches(pg_get_functiondef('ops.claim_job(text[],text)'::regprocedure),
  'SKIP LOCKED', 'ops.claim_job uses FOR UPDATE SKIP LOCKED');
SELECT matches(pg_get_functiondef('ops.requeue_stalled_jobs(interval)'::regprocedure),
  'SKIP LOCKED', 'ops.requeue_stalled_jobs uses FOR UPDATE SKIP LOCKED');

-- ---------------------------------------------------------------------------
-- Idempotency (roadmap M0.4: "double-clicking the trigger produces exactly one job row")
-- ---------------------------------------------------------------------------
-- enqueue_job RETURNS TABLE (id, created) since 0005, so every call is a subquery on the
-- row rather than a scalar. A bare `SELECT ops.enqueue_job(...)` yields a composite and
-- fails with "column id has pseudo-type record".
SELECT is(
  (SELECT e.id FROM ops.enqueue_job('compile', '{"a":1}', 'idem-1') e),
  (SELECT e.id FROM ops.enqueue_job('compile', '{"a":2}', 'idem-1') e),
  'ops.enqueue_job with a repeated idempotency key returns ONE id');
SELECT results_eq(
  $$ SELECT count(*)::int FROM ops.jobs WHERE idempotency_key = 'idem-1' $$, ARRAY[1],
  'ops.enqueue_job with a repeated idempotency key creates ONE row');
SELECT results_eq(
  $$ SELECT payload ->> 'a' FROM ops.jobs WHERE idempotency_key = 'idem-1' $$, ARRAY['1'],
  'the second enqueue does not overwrite the first payload: the worker''s input must not '
  'change underneath it mid-flight');
SELECT isnt(
  (SELECT e.id FROM ops.enqueue_job('export', '{}', 'idem-1') e),
  (SELECT e.id FROM ops.enqueue_job('compile', '{}', 'idem-1') e),
  'the idempotency key is scoped per kind, not globally');
SELECT isnt(
  (SELECT e.id FROM ops.enqueue_job('compile', '{}', NULL) e),
  (SELECT e.id FROM ops.enqueue_job('compile', '{}', NULL) e),
  'two jobs with no idempotency key are two jobs (the index is partial)');

SELECT throws_ok($$ SELECT * FROM ops.enqueue_job('Compile Now', '{}') $$, '23514', NULL,
  'a job kind must be a legal identifier so it is safe as a metric label');

-- ---------------------------------------------------------------------------
-- claim / heartbeat / complete
-- ---------------------------------------------------------------------------
CREATE TABLE pg_temp.j AS
  SELECT e.id FROM ops.enqueue_job('project', '{"v":1}', 'life-1') e;

SELECT results_eq($$ SELECT status FROM ops.jobs WHERE idempotency_key = 'life-1' $$,
  ARRAY['queued'], 'a new job is queued');

CREATE TABLE pg_temp.claimed AS SELECT * FROM ops.claim_job(ARRAY['project'], 'worker-1');
SELECT results_eq($$ SELECT id FROM pg_temp.claimed $$,
  $$ SELECT id FROM pg_temp.j $$, 'claim_job returns the queued job');
SELECT results_eq($$ SELECT status, attempts FROM pg_temp.claimed $$,
  $$ VALUES ('running', 1) $$,
  'claim_job marks the job running and burns one attempt AT CLAIM TIME, so a worker '
  'SIGKILLed before it can report anything cannot retry forever');
SELECT results_eq($$ SELECT locked_by FROM pg_temp.claimed $$, ARRAY['worker-1'],
  'claim_job records which worker took the job');

SELECT is((SELECT id FROM ops.claim_job(ARRAY['project'], 'worker-2')), NULL,
  'a second worker claiming the same kind gets nothing rather than the same row');

SELECT ok(ops.heartbeat_job((SELECT id FROM pg_temp.j), 'worker-1',
                            '{"step":2,"of":7,"message":"projecting"}'),
  'heartbeat_job succeeds for a running job');
SELECT results_eq(
  $$ SELECT progress ->> 'step' FROM ops.jobs WHERE idempotency_key = 'life-1' $$,
  ARRAY['2'], 'heartbeat_job records progress so studio can say "step 2 of 7"');

SELECT ok(ops.complete_job((SELECT id FROM pg_temp.j), 'worker-1', '{"rows":42}'),
  'complete_job succeeds for a running job');
SELECT results_eq($$
  SELECT status, finished_at IS NOT NULL FROM ops.jobs WHERE idempotency_key = 'life-1'
$$, $$ VALUES ('succeeded', true) $$, 'a completed job is succeeded and has a finish time');
SELECT ok(NOT ops.complete_job((SELECT id FROM pg_temp.j), 'worker-1', '{}'),
  'complete_job is a no-op the second time: one unit of work cannot succeed twice');
SELECT ok(NOT ops.heartbeat_job((SELECT id FROM pg_temp.j), 'worker-1'),
  'heartbeat_job returns false once the job is no longer running, which is how a worker '
  'learns the sweeper took its job away');

-- ---------------------------------------------------------------------------
-- Retry with backoff, and M0.4's "crashes twice then succeeds"
-- ---------------------------------------------------------------------------
CREATE FUNCTION pg_temp.crash_twice_then_succeed()
RETURNS TABLE (final_status text, attempts int, succeeded_rows int)
LANGUAGE plpgsql AS $$
DECLARE v_id app.ulid;
BEGIN
  SELECT e.id INTO v_id FROM ops.enqueue_job('flaky', '{}', 'flaky-1') e;
  -- crash 1
  PERFORM ops.claim_job(ARRAY['flaky'], 'w1');
  PERFORM ops.fail_job(v_id, 'w1', '{"code":"boom"}');
  -- the backoff means the job is not immediately claimable; a worker polling in a tight
  -- loop must not be able to burn the whole retry budget in one millisecond.
  IF (SELECT id FROM ops.claim_job(ARRAY['flaky'], 'w2')) IS NOT NULL THEN
    RETURN QUERY SELECT 'backoff-not-honoured', -1, -1;
    RETURN;
  END IF;
  UPDATE ops.jobs SET run_after = clock_timestamp() WHERE id = v_id;
  -- crash 2
  PERFORM ops.claim_job(ARRAY['flaky'], 'w2');
  PERFORM ops.fail_job(v_id, 'w2', '{"code":"boom"}');
  UPDATE ops.jobs SET run_after = clock_timestamp() WHERE id = v_id;
  -- success on the third attempt
  PERFORM ops.claim_job(ARRAY['flaky'], 'w3');
  PERFORM ops.complete_job(v_id, 'w3', '{}');
  RETURN QUERY
    SELECT j.status, j.attempts,
           (SELECT count(*)::int FROM ops.jobs x
             WHERE x.id = v_id AND x.status = 'succeeded')
      FROM ops.jobs j WHERE j.id = v_id;
END $$;
SELECT results_eq($$ SELECT * FROM pg_temp.crash_twice_then_succeed() $$,
  $$ VALUES ('succeeded', 3, 1) $$,
  'a job that crashes twice then succeeds ends with attempts = 3 and exactly one '
  'succeeded row (roadmap M0.4)');

-- 0005 changed the return for "you hold no claim on this" from NULL to 'not_owner', so the
-- caller can tell it apart from "there is no such running job" — only the first means
-- another worker is still on it and this one must stay quiet.
SELECT is(
  ops.fail_job((SELECT e.id FROM ops.enqueue_job('export', '{}', 'perm-1') e),
               'w', '{}', true),
  'not_owner',
  'fail_job on a job that was never claimed reports not_owner rather than corrupting its '
  'state');

CREATE FUNCTION pg_temp.exhaust_attempts() RETURNS text LANGUAGE plpgsql AS $$
DECLARE v_id app.ulid; v_last text;
BEGIN
  SELECT e.id INTO v_id
    FROM ops.enqueue_job('doomed', '{}', 'doomed-1', NULL, NULL, NULL, 2) e;
  FOR i IN 1..2 LOOP
    UPDATE ops.jobs SET run_after = clock_timestamp() WHERE id = v_id;
    PERFORM ops.claim_job(ARRAY['doomed'], 'w');
    v_last := ops.fail_job(v_id, 'w', '{"code":"boom"}');
  END LOOP;
  RETURN v_last;
END $$;
SELECT is(pg_temp.exhaust_attempts(), 'failed',
  'fail_job stops retrying at max_attempts: a permanently poisoned job must surface to a '
  'human instead of consuming a worker slot forever');

CREATE FUNCTION pg_temp.no_retry() RETURNS text LANGUAGE plpgsql AS $$
DECLARE v_id app.ulid;
BEGIN
  SELECT e.id INTO v_id FROM ops.enqueue_job('nonretry', '{}', 'nonretry-1') e;
  PERFORM ops.claim_job(ARRAY['nonretry'], 'w');
  RETURN ops.fail_job(v_id, 'w', '{"code":"malformed_payload"}', false);
END $$;
SELECT is(pg_temp.no_retry(), 'failed',
  'p_retry = false fails immediately: a malformed payload will not become well-formed on '
  'the third attempt');

-- ---------------------------------------------------------------------------
-- The stalled sweeper (roadmap M0.4: "a job killed mid-run is requeued")
-- ---------------------------------------------------------------------------
CREATE FUNCTION pg_temp.stall_and_sweep(p_max int DEFAULT 3)
RETURNS TABLE (requeued int, status text, error_code text)
LANGUAGE plpgsql AS $$
DECLARE v_id app.ulid; v_n int;
BEGIN
  SELECT e.id INTO v_id
    FROM ops.enqueue_job('stalled_' || p_max, '{}', 'stalled', NULL, NULL, NULL, p_max) e;
  PERFORM ops.claim_job(ARRAY['stalled_' || p_max], 'doomed-worker');
  -- Simulate an OOM-killed worker: the row stays 'running' and the heartbeat goes stale.
  UPDATE ops.jobs SET heartbeat_at = clock_timestamp() - interval '10 minutes'
   WHERE id = v_id;
  v_n := ops.requeue_stalled_jobs(interval '2 minutes');
  RETURN QUERY SELECT v_n, j.status, j.error ->> 'code' FROM ops.jobs j WHERE j.id = v_id;
END $$;
SELECT results_eq($$ SELECT * FROM pg_temp.stall_and_sweep(3) $$,
  $$ VALUES (1, 'queued', 'worker_stalled') $$,
  'requeue_stalled_jobs requeues a job whose worker died, and says why');
SELECT results_eq($$ SELECT * FROM pg_temp.stall_and_sweep(1) $$,
  $$ VALUES (1, 'failed', 'worker_stalled') $$,
  'a stalled job with no attempts left goes to failed, not back to queued: a job that '
  'reliably kills its worker must not take down the fleet in rotation');
SELECT is(ops.requeue_stalled_jobs(interval '2 minutes'), 0,
  'the sweeper is a no-op when every running job is heartbeating');

-- ---------------------------------------------------------------------------
-- Invariants and reachability
-- ---------------------------------------------------------------------------
SELECT throws_ok($$
  UPDATE ops.jobs SET status = 'succeeded', finished_at = NULL WHERE idempotency_key = 'idem-1'
$$, '23514', NULL,
  'a terminal job must carry a finish time, or the duration dashboard is quietly wrong');

-- ops is service-role only (B §0): nothing about the queue is reachable by the
-- application roles, which is why ops needs no RLS.
SELECT is(has_schema_privilege('authoring', 'ops', 'USAGE'), false,
  'authoring cannot reach schema ops');
SELECT is(has_table_privilege('authoring', 'ops.jobs', 'SELECT'), false,
  'authoring has no privilege on ops.jobs');
-- Phrased over pg_proc rather than against one signature, so it keeps meaning something
-- after a migration re-signs these functions — which 0005 did, invalidating the previous
-- spelling of this assertion.
SELECT is_empty($$
  SELECT p.proname || '(' || pg_get_function_arguments(p.oid) || ')'
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'ops' AND has_function_privilege('authoring', p.oid, 'EXECUTE')
$$, 'authoring holds EXECUTE on NO function in schema ops: it cannot even enqueue '
    'directly, and the API does it through the service role');

SELECT is_empty($$ SELECT ops.tables_without_rls() $$,
  '0003 added no table without RLS (ops is outside the enforced set by design)');

SELECT * FROM finish();
ROLLBACK;
