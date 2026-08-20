-- 0003_jobs_queue — ops.jobs plus a plain-SQL work queue.
--
-- Deliverable B §10.1 and roadmap M0.4. B says "the queue is pgmq; ops.jobs is not a second
-- queue, it is the durable user-visible record of the things a user pressed a button for,
-- with progress, so studio can say step 4 of 7".
--
-- We implement the claim/heartbeat/complete/fail/requeue cycle on plain SQL with
-- FOR UPDATE SKIP LOCKED instead of requiring pgmq. Reasons, recorded so this is not
-- rediscovered as an accident:
--   1. pgmq is not installable in every environment we must run in (CI containers, a
--      developer's local Postgres, a customer's self-hosted cluster). A migration suite
--      that cannot run without a third-party extension is a migration suite that cannot
--      gate CI, and gating CI is the entire point of M0.2.
--   2. The visible job record and the queue would then be two rows in two systems that can
--      disagree. One row cannot disagree with itself.
--   3. SKIP LOCKED gives us the only property pgmq buys at this scale — concurrent
--      consumers not blocking each other. Compile/export/projection job rates are measured
--      in jobs per minute, not per millisecond.
-- ops.jobs.queue_msg_id is retained so pgmq can be adopted later without a schema change:
-- see db/README.md "Replacing the queue with pgmq".
SET lock_timeout = '3s';
SET statement_timeout = '120s';

-- ---------------------------------------------------------------------------
-- The table (B §10.1)
-- ---------------------------------------------------------------------------
CREATE TABLE ops.jobs (
  id                app.ulid PRIMARY KEY DEFAULT app.gen_ulid('job'),
  org_id            app.ulid,
  project_id        app.ulid,
  survey_version_id app.ulid,
  kind              text NOT NULL,
  status            text NOT NULL DEFAULT 'queued'
                      CHECK (status IN ('queued','running','succeeded','failed','cancelled')),
  idempotency_key   text,
  payload           jsonb NOT NULL DEFAULT '{}',
  progress          jsonb NOT NULL DEFAULT '{}',
  result            jsonb,
  error             jsonb,
  attempts          integer NOT NULL DEFAULT 0,
  max_attempts      integer NOT NULL DEFAULT 3,
  queue_msg_id      bigint,
  run_after         timestamptz NOT NULL DEFAULT now(),
  locked_by         text,
  created_by        uuid,
  created_at        timestamptz NOT NULL DEFAULT now(),
  started_at        timestamptz,
  finished_at       timestamptz,
  heartbeat_at      timestamptz,
  CONSTRAINT jobs_kind_fmt CHECK (kind ~ '^[a-z][a-z0-9_]{1,63}$'),
  CONSTRAINT jobs_attempts_bounded CHECK (attempts >= 0 AND max_attempts BETWEEN 1 AND 50),
  -- A terminal job has a finish time and a running job has a start time. Without this,
  -- "how long did the export take" silently returns NULL for a subset of rows and the
  -- p99 dashboard is quietly wrong.
  CONSTRAINT jobs_terminal_has_finish
    CHECK ((status IN ('succeeded','failed','cancelled')) = (finished_at IS NOT NULL)),
  CONSTRAINT jobs_started_when_attempted
    CHECK (attempts = 0 OR started_at IS NOT NULL)
);
COMMENT ON TABLE ops.jobs IS
  'B §10.1. The durable, user-visible record of an action a user triggered — compile, '
  'project, export, design, reconcile, email — carrying progress so studio can render '
  '"step 4 of 7". Also the queue itself (see this migration''s header for why not pgmq). '
  'Lives in schema ops and is therefore NOT granted to authoring: studio reads job state '
  'through the API, not by selecting from this table, so ops needs no RLS (B §12 forces RLS '
  'on app/content/billing/export only).';
COMMENT ON COLUMN ops.jobs.kind IS
  'compile | project | export | design | reconcile | email (B §10.1). Free text rather than '
  'an enum on purpose: job kinds are an implementation detail of apps/worker and adding one '
  'must not require a migration. The CHECK keeps it a legal identifier so it is safe in a '
  'metric label.';
COMMENT ON COLUMN ops.jobs.idempotency_key IS
  'Unique per (kind, key) via jobs_idem_key. Double-clicking Publish must produce exactly '
  'one job (roadmap M0.4 acceptance), so ops.enqueue_job returns the EXISTING id rather '
  'than raising or inserting a second row.';
COMMENT ON COLUMN ops.jobs.progress IS
  'Free-shaped { step, of, message, ... } written by the worker on each heartbeat. JSONB '
  'rather than columns because every job kind reports differently and the UI only needs '
  '"step N of M" (roadmap M0.4 frontend).';
COMMENT ON COLUMN ops.jobs.attempts IS
  'Incremented by ops.claim_job, not by the worker: a worker that dies before it can record '
  'its own attempt would otherwise retry forever. The stalled sweeper requeues it and the '
  'count is already correct.';
COMMENT ON COLUMN ops.jobs.max_attempts IS
  'Per-job retry budget. ops.fail_job moves the row to ''failed'' once attempts reaches it, '
  'rather than requeueing forever — a permanently poisoned compile must surface to a human, '
  'not consume a worker slot indefinitely.';
COMMENT ON COLUMN ops.jobs.queue_msg_id IS
  'B §10.1 calls this "pgmq handle". Kept nullable and unused by the plain-SQL queue so '
  'that adopting pgmq later is a code change and not a schema migration.';
COMMENT ON COLUMN ops.jobs.run_after IS
  'Earliest time this job may be claimed. Not in B §10.1; required by M0.4''s "retry with '
  'backoff" — without it a failing job is re-claimed in a tight loop and starves every '
  'other job in the queue.';
COMMENT ON COLUMN ops.jobs.locked_by IS
  'Opaque worker identity (pod name, container id) recorded at claim time. Not an '
  'authorization mechanism — SKIP LOCKED already guarantees exclusivity — but the only way '
  'to answer "which worker stalled" from the database during an incident.';
COMMENT ON COLUMN ops.jobs.heartbeat_at IS
  'Liveness. A running job whose heartbeat is older than the sweeper''s threshold is '
  'assumed dead and requeued (ops.requeue_stalled_jobs). This column plus jobs_stalled_idx '
  'is the whole crash-recovery story.';

CREATE UNIQUE INDEX jobs_idem_key ON ops.jobs (kind, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
COMMENT ON INDEX ops.jobs_idem_key IS
  'B §10.1. Partial so that the overwhelming majority of jobs, which carry no idempotency '
  'key, do not collide with each other on NULL.';

CREATE INDEX jobs_org_idx ON ops.jobs (org_id, created_at DESC);
COMMENT ON INDEX ops.jobs_org_idx IS
  'B §10.1. Powers the per-org job list in studio, newest first.';

CREATE INDEX jobs_stalled_idx ON ops.jobs (heartbeat_at) WHERE status = 'running';
COMMENT ON INDEX ops.jobs_stalled_idx IS
  'B §10.1. The requeue sweeper''s only index. Partial on status = ''running'' because the '
  'sweeper never cares about any other status, which keeps this index proportional to '
  'in-flight work rather than to job history — a table with ten million finished jobs still '
  'has a sweeper index of a few hundred entries.';

CREATE INDEX jobs_claimable_idx ON ops.jobs (kind, run_after) WHERE status = 'queued';
COMMENT ON INDEX ops.jobs_claimable_idx IS
  'The claim path''s index, same reasoning as jobs_stalled_idx: partial on '
  'status = ''queued'' so a worker polling every second scans only pending work.';

-- ---------------------------------------------------------------------------
-- enqueue
-- ---------------------------------------------------------------------------
CREATE FUNCTION ops.enqueue_job(
  p_kind              text,
  p_payload           jsonb DEFAULT '{}',
  p_idempotency_key   text  DEFAULT NULL,
  p_org_id            app.ulid DEFAULT NULL,
  p_project_id        app.ulid DEFAULT NULL,
  p_survey_version_id app.ulid DEFAULT NULL,
  p_max_attempts      integer DEFAULT 3,
  p_created_by        uuid DEFAULT NULL
) RETURNS app.ulid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_id app.ulid;
BEGIN
  INSERT INTO ops.jobs (kind, payload, idempotency_key, org_id, project_id,
                        survey_version_id, max_attempts, created_by)
  VALUES (p_kind, COALESCE(p_payload, '{}'), p_idempotency_key, p_org_id, p_project_id,
          p_survey_version_id, p_max_attempts,
          COALESCE(p_created_by, app.current_user_id()))
  -- ON CONFLICT DO NOTHING against the partial index rather than DO UPDATE: the existing
  -- job may already be running, and overwriting its payload mid-flight would make the
  -- worker's view of its own input change underneath it.
  ON CONFLICT (kind, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    SELECT j.id INTO v_id
      FROM ops.jobs j
     WHERE j.kind = p_kind AND j.idempotency_key = p_idempotency_key;
  END IF;
  IF v_id IS NULL THEN
    -- Only reachable if the conflicting row was deleted between the INSERT and the SELECT.
    RAISE EXCEPTION 'enqueue_job: could not enqueue or locate job (kind=%, key=%)',
      p_kind, p_idempotency_key USING ERRCODE = 'internal_error';
  END IF;
  RETURN v_id;
END $$;
COMMENT ON FUNCTION ops.enqueue_job(text, jsonb, text, app.ulid, app.ulid, app.ulid, integer, uuid) IS
  'B §10.1, roadmap M0.4 acceptance: "double-clicking the trigger produces exactly one job '
  'row". Returns the EXISTING job id when the idempotency key repeats, so the caller gets a '
  'handle to the in-flight job instead of an error it would have to special-case at every '
  'call site. SECURITY DEFINER because schema ops is not reachable by authoring: the API '
  'enqueues through this function and cannot touch the table.';

-- ---------------------------------------------------------------------------
-- claim / heartbeat / complete / fail
-- ---------------------------------------------------------------------------
CREATE FUNCTION ops.claim_job(p_kinds text[] DEFAULT NULL, p_worker text DEFAULT NULL)
RETURNS ops.jobs
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_job ops.jobs;
BEGIN
  UPDATE ops.jobs j
     SET status       = 'running',
         attempts     = j.attempts + 1,
         started_at   = COALESCE(j.started_at, clock_timestamp()),
         heartbeat_at = clock_timestamp(),
         locked_by    = p_worker,
         error        = NULL
   WHERE j.id = (
     SELECT c.id
       FROM ops.jobs c
      WHERE c.status = 'queued'
        AND c.run_after <= clock_timestamp()
        AND (p_kinds IS NULL OR c.kind = ANY (p_kinds))
      ORDER BY c.run_after, c.created_at
      -- FOR UPDATE SKIP LOCKED is the entire concurrency design: N workers polling the
      -- same queue each take a different row instead of serializing behind one lock.
      FOR UPDATE SKIP LOCKED
      LIMIT 1)
  RETURNING j.* INTO v_job;
  RETURN v_job;   -- all-NULL composite when the queue is empty; callers check .id IS NULL
END $$;
COMMENT ON FUNCTION ops.claim_job(text[], text) IS
  'Atomically claims the oldest due job, optionally restricted to a set of kinds. Uses '
  'FOR UPDATE SKIP LOCKED so concurrent workers never block each other and never claim the '
  'same row. Increments attempts at CLAIM time, not at failure time, so a worker that is '
  'SIGKILLed before it can report anything still burns exactly one attempt — otherwise a '
  'crash loop retries forever. Returns an all-NULL row when nothing is due.';

CREATE FUNCTION ops.heartbeat_job(p_id app.ulid, p_progress jsonb DEFAULT NULL)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_n int;
BEGIN
  UPDATE ops.jobs j
     SET heartbeat_at = clock_timestamp(),
         progress     = COALESCE(p_progress, j.progress)
   WHERE j.id = p_id AND j.status = 'running';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n = 1;
END $$;
COMMENT ON FUNCTION ops.heartbeat_job(app.ulid, jsonb) IS
  'Liveness plus progress in one round trip, because they are reported at the same moments '
  'and two statements would double the write rate of every long job. Returns false when the '
  'job is no longer ''running'' — which is how a worker discovers that the stalled sweeper '
  'already gave its job away and that it should stop working (roadmap M0.4).';

CREATE FUNCTION ops.complete_job(p_id app.ulid, p_result jsonb DEFAULT '{}')
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_n int;
BEGIN
  UPDATE ops.jobs j
     SET status      = 'succeeded',
         result      = COALESCE(p_result, '{}'),
         error       = NULL,
         finished_at = clock_timestamp(),
         locked_by   = NULL
   WHERE j.id = p_id AND j.status = 'running';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n = 1;
END $$;
COMMENT ON FUNCTION ops.complete_job(app.ulid, jsonb) IS
  'Terminal success. Guarded on status = ''running'' so a worker whose job was requeued '
  'under it cannot resurrect the row and produce two "succeeded" outcomes for one unit of '
  'work.';

CREATE FUNCTION ops.fail_job(
  p_id      app.ulid,
  p_error   jsonb DEFAULT '{}',
  p_retry   boolean DEFAULT true
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_job    ops.jobs;
  v_status text;
BEGIN
  SELECT * INTO v_job FROM ops.jobs WHERE id = p_id AND status = 'running' FOR UPDATE;
  IF v_job.id IS NULL THEN RETURN NULL; END IF;

  IF p_retry AND v_job.attempts < v_job.max_attempts THEN
    -- Exponential backoff, 2^attempts seconds, capped. Capped because an uncapped
    -- exponential on max_attempts = 50 schedules the last retry after the heat death of
    -- the cluster, and because a job nobody will look at for an hour should simply fail.
    UPDATE ops.jobs
       SET status       = 'queued',
           error        = COALESCE(p_error, '{}'),
           run_after    = clock_timestamp()
                          + least(power(2, v_job.attempts) * interval '1 second',
                                  interval '10 minutes'),
           heartbeat_at = NULL,
           locked_by    = NULL
     WHERE id = p_id;
    v_status := 'queued';
  ELSE
    UPDATE ops.jobs
       SET status       = 'failed',
           error        = COALESCE(p_error, '{}'),
           finished_at  = clock_timestamp(),
           heartbeat_at = NULL,
           locked_by    = NULL
     WHERE id = p_id;
    v_status := 'failed';
  END IF;
  RETURN v_status;
END $$;
COMMENT ON FUNCTION ops.fail_job(app.ulid, jsonb, boolean) IS
  'Records a failure and returns the resulting status: ''queued'' when there is retry '
  'budget left, ''failed'' when there is not, NULL when the job was not running. Backoff '
  'is 2^attempts seconds capped at 10 minutes. p_retry = false is for errors the worker '
  'knows are permanent (a malformed payload will not become well-formed on the third '
  'attempt) — retrying those wastes a worker slot and delays the alert.';

CREATE FUNCTION ops.requeue_stalled_jobs(p_stalled_after interval DEFAULT interval '2 minutes')
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_n int;
BEGIN
  WITH stalled AS (
    SELECT j.id, j.attempts, j.max_attempts
      FROM ops.jobs j
     WHERE j.status = 'running'
       AND j.heartbeat_at < clock_timestamp() - p_stalled_after
     ORDER BY j.heartbeat_at
     FOR UPDATE SKIP LOCKED
  )
  UPDATE ops.jobs j
     SET status       = CASE WHEN s.attempts < s.max_attempts THEN 'queued' ELSE 'failed' END,
         finished_at  = CASE WHEN s.attempts < s.max_attempts THEN NULL
                             ELSE clock_timestamp() END,
         run_after    = clock_timestamp(),
         heartbeat_at = NULL,
         locked_by    = NULL,
         error        = jsonb_build_object(
                          'code', 'worker_stalled',
                          'message', format('no heartbeat for %s', p_stalled_after),
                          'last_worker', j.locked_by)
    FROM stalled s
   WHERE j.id = s.id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $$;
COMMENT ON FUNCTION ops.requeue_stalled_jobs(interval) IS
  'The crash-recovery sweeper (B §10.1 jobs_stalled_idx, roadmap M0.4: "a job killed '
  'mid-run is requeued"). A worker that is OOM-killed or whose node disappears leaves a '
  'row in ''running'' forever; nothing else in the system will ever notice. Runs on a '
  'schedule; SKIP LOCKED so two sweeper replicas are harmless. A stalled job that has '
  'exhausted its attempts goes to ''failed'' rather than back to ''queued'', so a job that '
  'reliably kills its worker cannot take down the whole worker fleet in rotation.';

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
-- Schema ops is not granted to authoring, runtime_writer or analytics_reader (B §0: ops is
-- "service role"). These functions are SECURITY DEFINER so the service role can be granted
-- EXECUTE on them by name in M0.4 without ever gaining USAGE on the schema's tables. No
-- GRANT is issued here: nothing needs it yet, and a grant with no consumer is a hole
-- waiting for one.
REVOKE ALL ON ALL TABLES IN SCHEMA ops FROM PUBLIC;
REVOKE ALL ON FUNCTION
  ops.enqueue_job(text, jsonb, text, app.ulid, app.ulid, app.ulid, integer, uuid),
  ops.claim_job(text[], text),
  ops.heartbeat_job(app.ulid, jsonb),
  ops.complete_job(app.ulid, jsonb),
  ops.fail_job(app.ulid, jsonb, boolean),
  ops.requeue_stalled_jobs(interval)
FROM PUBLIC;
