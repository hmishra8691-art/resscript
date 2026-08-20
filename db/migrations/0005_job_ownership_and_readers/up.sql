-- migration: 0005_job_ownership_and_readers
-- Closes three integration gaps found when apps/worker and apps/studio were wired against
-- migrations 0003 and 0004. All three were found by tests, not by review.
SET lock_timeout = '3s';
SET statement_timeout = '60s';

-- ---------------------------------------------------------------------------
-- 1. Worker-scoped job transitions (compare-and-set on locked_by)
-- ---------------------------------------------------------------------------
-- 0003 guarded heartbeat/complete/fail on `status = 'running'` alone. That is not enough.
-- The losing interleaving:
--
--   worker A claims job J          -> status=running, locked_by=A
--   A's process stalls (GC pause, network partition, paused container)
--   requeue_stalled_jobs()          -> status=queued,  locked_by=NULL
--   worker B claims job J           -> status=running, locked_by=B, attempts=2
--   A wakes up and calls complete_job(J, resultA)
--     -> guard `status = 'running'` PASSES, because B is running it
--     -> A's stale result overwrites B's in-flight work and the row goes terminal
--
-- The job reports success with a result computed from an aborted attempt, and B's write
-- lands on a finished row. Nothing in the status alone can detect this; the transition has
-- to be scoped to the worker that actually holds the claim.
--
-- All three transitions therefore take the caller's worker identity and compare-and-set on
-- it. A worker that has lost its claim gets a falsy return and is expected to discard its
-- result — which is what `apps/worker`'s consumer loop now does.
DROP FUNCTION IF EXISTS ops.heartbeat_job(app.ulid, jsonb);
DROP FUNCTION IF EXISTS ops.complete_job(app.ulid, jsonb);
DROP FUNCTION IF EXISTS ops.fail_job(app.ulid, jsonb, boolean);

CREATE FUNCTION ops.heartbeat_job(p_id app.ulid, p_worker text, p_progress jsonb DEFAULT NULL)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_n int;
BEGIN
  UPDATE ops.jobs j
     SET heartbeat_at = clock_timestamp(),
         progress     = COALESCE(p_progress, j.progress)
   WHERE j.id = p_id
     AND j.status = 'running'
     AND j.locked_by IS NOT DISTINCT FROM p_worker;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n = 1;
END $$;
COMMENT ON FUNCTION ops.heartbeat_job(app.ulid, text, jsonb) IS
  'Liveness plus progress in one round trip. Scoped to the claiming worker: returns false '
  'when the caller no longer holds the claim, which is how a worker discovers the stalled '
  'sweeper gave its job away and that it should abandon the attempt (roadmap M0.4).';

CREATE FUNCTION ops.complete_job(p_id app.ulid, p_worker text, p_result jsonb DEFAULT '{}')
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
   WHERE j.id = p_id
     AND j.status = 'running'
     AND j.locked_by IS NOT DISTINCT FROM p_worker;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n = 1;
END $$;
COMMENT ON FUNCTION ops.complete_job(app.ulid, text, jsonb) IS
  'Terminal success, scoped to the claiming worker. Returns false when the caller lost its '
  'claim; the caller must then DISCARD its result rather than retry, because another worker '
  'is already producing the authoritative one.';

-- ops.fail_job is defined once, in section 1c below, with its p_retry_after_ms parameter
-- included. The first draft of this migration created the four-argument form here and then
-- dropped it forty lines later to add the fifth parameter, which left an orphaned COMMENT
-- and a `has_function(…, 4 args)` assertion for a function that no longer existed by the
-- end of the same transaction. One definition, one signature.

-- ---------------------------------------------------------------------------
-- 1a. claim_job must be told who is claiming
-- ---------------------------------------------------------------------------
-- The compare-and-set above is `locked_by IS NOT DISTINCT FROM p_worker`, which is the
-- correct comparison for a nullable column — but it also means that if locked_by can be
-- NULL while a job is running, then every anonymous caller matches every anonymous claim
-- and the three transitions above are stealable again by exactly the interleaving this
-- migration exists to prevent. 0003 let p_worker default to NULL, so that state was
-- reachable.
--
-- Rather than switch to `=` (which would silently make an anonymous claim uncompletable,
-- i.e. a stuck job instead of a corrupted one), require the identity at claim time. Then
-- locked_by is non-NULL for the entire lifetime of a claim and the two comparisons coincide.
-- apps/worker already passes p_worker on every call, so nothing has to change there.
CREATE OR REPLACE FUNCTION ops.claim_job(p_kinds text[] DEFAULT NULL, p_worker text DEFAULT NULL)
RETURNS ops.jobs
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_job ops.jobs;
BEGIN
  IF p_worker IS NULL OR btrim(p_worker) = '' THEN
    RAISE EXCEPTION 'claim_job requires a worker identity'
      USING ERRCODE = 'invalid_parameter_value',
            HINT = 'ops.heartbeat_job / complete_job / fail_job compare-and-set on '
                   'locked_by; an anonymous claim cannot be scoped to its owner.';
  END IF;
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
  'Atomically claims the oldest due job, optionally restricted to a set of kinds, using '
  'FOR UPDATE SKIP LOCKED so concurrent workers never block each other and never claim the '
  'same row. Increments attempts at CLAIM time, not at failure time, so a worker SIGKILLed '
  'before it can report anything still burns exactly one attempt. p_worker is REQUIRED '
  '(0005): locked_by is the compare-and-set key for every subsequent transition, so a claim '
  'with no owner would make those transitions unscoped. The parameter keeps its NULL '
  'default only so the signature stays stable for named-argument callers; passing NULL '
  'raises.';

-- ---------------------------------------------------------------------------
-- 1b. enqueue_job: report whether the row was created, and accept a delay
-- ---------------------------------------------------------------------------
-- Two gaps, both found by wiring apps/worker against 0003:
--
--  * 0003 returned a bare app.ulid, so a caller could not tell "I enqueued this" from "this
--    was already queued under the same idempotency key". The API needs that distinction to
--    answer 201 vs 200, and the studio needs it to avoid telling a user their click started
--    work when it attached to an in-flight job.
--  * There was no way to enqueue a job that should not run yet. 0003's parameter in that
--    position was p_created_by uuid, and the worker was passing a delay integer into it —
--    a type error waiting for its first scheduled job. Deferred enqueue is needed for
--    reminder emails (P3-06) and for any retry the caller schedules itself.
--
-- p_created_by is dropped from the signature rather than kept: it always defaulted to
-- app.current_user_id(), no caller passed it, and a nullable "who did this" that can be
-- spoofed by the caller is worse than one derived from the session.
DROP FUNCTION IF EXISTS ops.enqueue_job(text, jsonb, text, app.ulid, app.ulid, app.ulid, integer, uuid);

CREATE FUNCTION ops.enqueue_job(
  p_kind              text,
  p_payload           jsonb DEFAULT '{}',
  p_idempotency_key   text  DEFAULT NULL,
  p_org_id            app.ulid DEFAULT NULL,
  p_project_id        app.ulid DEFAULT NULL,
  p_survey_version_id app.ulid DEFAULT NULL,
  p_max_attempts      integer DEFAULT 3,
  p_delay_ms          integer DEFAULT 0
) RETURNS TABLE (id app.ulid, created boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_id app.ulid;
BEGIN
  INSERT INTO ops.jobs (kind, payload, idempotency_key, org_id, project_id,
                        survey_version_id, max_attempts, created_by, run_after)
  VALUES (p_kind, COALESCE(p_payload, '{}'), p_idempotency_key, p_org_id, p_project_id,
          p_survey_version_id, p_max_attempts, app.current_user_id(),
          clock_timestamp()
            + make_interval(secs => GREATEST(COALESCE(p_delay_ms, 0), 0) / 1000.0))
  -- DO NOTHING, not DO UPDATE: the existing job may already be running, and overwriting its
  -- payload mid-flight would make the worker's own input change underneath it.
  ON CONFLICT (kind, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
  RETURNING ops.jobs.id INTO v_id;

  IF v_id IS NOT NULL THEN
    RETURN QUERY SELECT v_id, true;
    RETURN;
  END IF;

  SELECT j.id INTO v_id
    FROM ops.jobs j
   WHERE j.kind = p_kind AND j.idempotency_key = p_idempotency_key;

  IF v_id IS NULL THEN
    -- Only reachable if the conflicting row was deleted between the INSERT and the SELECT.
    RAISE EXCEPTION 'enqueue_job: could not enqueue or locate job (kind=%, key=%)',
      p_kind, p_idempotency_key USING ERRCODE = 'internal_error';
  END IF;
  RETURN QUERY SELECT v_id, false;
END $$;
COMMENT ON FUNCTION ops.enqueue_job(text, jsonb, text, app.ulid, app.ulid, app.ulid, integer, integer) IS
  'B §10.1, roadmap M0.4: "double-clicking the trigger produces exactly one job row". '
  'Returns (id, created) — created = false means an existing job under the same idempotency '
  'key was returned, which the API maps to 200 rather than 201. p_delay_ms defers the job by '
  'writing run_after. SECURITY DEFINER because schema ops is unreachable by authoring: the '
  'API enqueues through this function and cannot touch the table.';

-- ---------------------------------------------------------------------------
-- 1c. fail_job: allow the caller to override the computed backoff
-- ---------------------------------------------------------------------------
-- The 2^attempts schedule is the right default, but a worker that has just been told
-- "Retry-After: 300" by an external API knows better than the default does, and retrying
-- earlier than instructed is how an integration gets rate-limit banned. NULL keeps the
-- computed backoff, so the common path is unchanged.
CREATE FUNCTION ops.fail_job(
  p_id             app.ulid,
  p_worker         text,
  p_error          jsonb DEFAULT '{}',
  p_retry          boolean DEFAULT true,
  p_retry_after_ms integer DEFAULT NULL
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_job    ops.jobs;
  v_status text;
  v_delay  interval;
BEGIN
  SELECT * INTO v_job
    FROM ops.jobs
   WHERE id = p_id
     AND status = 'running'
     AND locked_by IS NOT DISTINCT FROM p_worker
   FOR UPDATE;

  IF v_job.id IS NULL THEN RETURN 'not_owner'; END IF;

  IF p_retry AND v_job.attempts < v_job.max_attempts THEN
    -- Capped because an uncapped exponential on max_attempts = 50 schedules the last retry
    -- after the heat death of the cluster, and a job nobody looks at for an hour should
    -- simply fail and raise an alert.
    v_delay := CASE
      WHEN COALESCE(p_retry_after_ms, 0) > 0
        THEN make_interval(secs => p_retry_after_ms / 1000.0)
      ELSE least(power(2, v_job.attempts) * interval '1 second', interval '10 minutes')
    END;
    UPDATE ops.jobs
       SET status       = 'queued',
           error        = COALESCE(p_error, '{}'),
           run_after    = clock_timestamp() + v_delay,
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
COMMENT ON FUNCTION ops.fail_job(app.ulid, text, jsonb, boolean, integer) IS
  'Records a failure, scoped to the claiming worker. Returns ''queued'' when retry budget '
  'remains, ''failed'' when exhausted, ''not_owner'' when the caller lost its claim. '
  'p_retry_after_ms overrides the 2^attempts backoff for the case where an upstream told us '
  'exactly when to come back. p_retry = false is for errors known to be permanent: a '
  'malformed payload will not become well-formed on the third attempt, and retrying it '
  'wastes a worker slot and delays the alert.';

-- ---------------------------------------------------------------------------
-- 2. A read path for job state
-- ---------------------------------------------------------------------------
-- 0003 granted `authoring` nothing in schema ops, but the studio has to render publish and
-- export progress (roadmap M0.4 frontend, API §2.16). Without a reader the only options are
-- widening the grant on ops.jobs — which exposes every tenant's payloads — or reading with
-- the service role from application code, which moves a tenancy check out of the database
-- and into a place a future refactor can drop. Neither is acceptable, so: a narrow
-- SECURITY DEFINER reader that filters on the caller's own org and returns no payload.
--
-- It lives in `app`, not in `ops`, and that placement is load-bearing. EXECUTE on a
-- function is not sufficient to call it: the caller also needs USAGE on its schema, and
-- `authoring` deliberately has none on `ops` (Deliverable B §0 lists ops as service-role
-- only, and both 0001's and 0003's test.sql assert `has_schema_privilege('authoring',
-- 'ops', 'USAGE') = false`). A GRANT EXECUTE on ops.get_job would therefore have been
-- inert — the studio would have got `permission denied for schema ops` on its first call.
-- Granting USAGE on ops instead would trade a documented plane boundary for one
-- convenience function. So the reader is a control-plane read in the control-plane schema,
-- which is what `app` is for, and `ops` stays unreachable.
CREATE FUNCTION app.get_job(p_id app.ulid)
RETURNS TABLE (
  id                app.ulid,
  kind              text,
  status            text,
  progress          jsonb,
  attempts          integer,
  max_attempts      integer,
  error             jsonb,
  result            jsonb,
  org_id            app.ulid,
  project_id        app.ulid,
  survey_version_id app.ulid,
  created_at        timestamptz,
  started_at        timestamptz,
  finished_at       timestamptz,
  run_after         timestamptz
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT j.id, j.kind, j.status::text, j.progress, j.attempts, j.max_attempts,
         j.error, j.result, j.org_id, j.project_id, j.survey_version_id,
         j.created_at, j.started_at, j.finished_at, j.run_after
    FROM ops.jobs j
   WHERE j.id = p_id
     -- A job with no org (a platform-level maintenance job) is never visible to a tenant.
     AND j.org_id IS NOT NULL
     AND j.org_id = app.current_org()
     AND (j.project_id IS NULL OR app.can_see_project(j.project_id));
$$;
COMMENT ON FUNCTION app.get_job(app.ulid) IS
  'The only read path into ops.jobs for the authoring role. Lives in `app` rather than '
  '`ops` because EXECUTE without schema USAGE is inert and authoring has no USAGE on ops '
  '(Deliverable B §0: ops is service-role only). Filters on app.current_org() INSIDE the '
  'function so the tenancy check cannot be forgotten at a call site, and omits jobs.payload '
  'entirely — a compile payload can carry survey content and the studio only needs status '
  'and progress. Returns zero rows rather than raising for a job in another org, so probing '
  'job ids reveals nothing about whether they exist.';

REVOKE EXECUTE ON FUNCTION app.get_job(app.ulid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.get_job(app.ulid) TO authoring;

-- ---------------------------------------------------------------------------
-- 3. Invitation acceptance
-- ---------------------------------------------------------------------------
-- The invitee is by definition not yet a member of the org, so no RLS policy on
-- app.invitations can let them read their own invitation — and adding one would mean
-- exposing the invitation table to non-members, which is worse. Acceptance therefore needs
-- a definer-rights lookup keyed on the token hash. Keyed on the HASH, never the id: the
-- token is the only secret, so possession of it is the authorization, and an attacker who
-- can enumerate invitation ids learns nothing.
CREATE FUNCTION app.resolve_invitation(p_token_hash bytea)
RETURNS TABLE (
  id         app.ulid,
  org_id     app.ulid,
  org_name   text,
  org_slug   text,
  email      text,
  role       app.org_role,
  expires_at timestamptz,
  accepted_at timestamptz
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT i.id, i.org_id, o.name, o.slug, i.email, i.role, i.expires_at, i.accepted_at
    FROM app.invitations i
    JOIN app.organizations o ON o.id = i.org_id
   WHERE i.token_hash = p_token_hash
     AND o.deleted_at IS NULL;
$$;
COMMENT ON FUNCTION app.resolve_invitation(bytea) IS
  'Resolves an invitation by token hash for a caller who is not yet a member and therefore '
  'cannot be granted a SELECT policy on app.invitations. Returns expired and already-'
  'accepted invitations too, so the API can tell the user *why* their link does not work '
  'instead of showing "not found" for four different causes. Returns no token material.';

REVOKE EXECUTE ON FUNCTION app.resolve_invitation(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.resolve_invitation(bytea) TO authoring;

-- ---------------------------------------------------------------------------
-- 4. Forward note for P1-03 (content.variables)
-- ---------------------------------------------------------------------------
-- Recorded here because it was found in P1-02 and will otherwise be rediscovered as a bug
-- on the first multi-select save. Deliverable B specifies
--   CHECK ((kind = 'derived') = (expression IS NOT NULL))
-- on content.variables. That is unsatisfiable for STRUCTURALLY derived variables: the
-- set<enum> view over a multi-select's boolean fan-out, and an NPS band, are derived but
-- have no authorable expression — the compiler synthesizes them, and the logic AST has no
-- operator that collects the true members of a fan-out. packages/schema already relaxed its
-- equivalent rule (SCH-1015) to require an expression only for AUTHORED derived variables,
-- identified by the absence of a `source`. The CHECK must carry the same carve-out:
--   CHECK (kind <> 'derived' OR expression IS NOT NULL OR source IS NOT NULL)
-- P1-03 owns content.variables and must land it that way.
DO $$ BEGIN
  RAISE NOTICE '0005: P1-03 must apply the vars_derived_expr carve-out (see comment above)';
END $$;
