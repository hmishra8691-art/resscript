-- 0018_quota_reconciliation — recompute committed from the event log, and rebuild (P2-08).
--
-- Roadmap P2-08's backend line: "A scheduled and on-demand job recomputing committed per cell
-- from response_events, writing reconciled_committed, flooring in_flight at the count of active
-- sessions holding the cell, and emitting quota.drift. Rebuild-Redis-from-Postgres-plus-events as
-- a single job."
--
-- WHY THE EVENT LOG IS THE ORACLE AND NOT THE COUNTER. ADR-008 makes Redis the arbiter of whether
-- a respondent may proceed and Postgres the durable record. Neither is the oracle for "how many
-- completes does this cell actually have" — the counter is a running total maintained by two
-- systems, and a running total is exactly the thing that drifts. `runtime.response_events` is
-- append-only and carries one `quota_committed` row per (session, cell) at the moment it happened;
-- counting those rows is the only answer that does not depend on any counter being right. That is
-- what makes reconciliation a CHECK rather than a second opinion.
--
-- WHY DRIFT IS REPORTED AND NOT SILENTLY REPAIRED. `reconcile` writes `reconciled_committed` and
-- leaves `committed` alone; `repair` is a separate call. A job that silently corrected the live
-- counter would erase the evidence of whatever caused the drift — and R2 in the risk register is
-- explicit that quota drift is a data-integrity signal, not a nuisance to be swept up. An operator
-- sees the delta per cell, decides, and then repairs.
--
-- WHY in_flight IS FLOORED RATHER THAN RECOMPUTED. A reservation lives in Redis and its holder set
-- is the authority; Postgres cannot know how many are live. What it CAN know is a lower bound: the
-- number of sessions that hold the cell and are still active. Flooring at that bound fixes the
-- failure that matters (a counter whose in_flight has leaked upward blocks a cell forever) without
-- claiming a number the record cannot support.
--
-- Migration header first (B §14, read by tools/ci/lint-migrations.mjs from the first 60 lines).
-- Expand-only: three functions and their grants. No tables, no renames, no in-place type changes.
SET lock_timeout = '3s';
SET statement_timeout = '120s';

-- ---------------------------------------------------------------------------
-- 0. What this migration deliberately does NOT create
-- ---------------------------------------------------------------------------
--   * An alerting side effect. `reconcile` RETURNS the drift per cell; emitting `quota.drift` to
--     the observability pipeline is the caller's job, because a database function that talked to
--     an alert sink would be untestable and would fire during a rollback.
--   * A schedule. "Scheduled and on-demand" is one function called two ways; the scheduler is
--     ops infrastructure, not a migration.
--   * Automatic repair on drift detection. See the header — that is the decision this deliberately
--     leaves to a human.

-- ---------------------------------------------------------------------------
-- 1. runtime.reconcile_quota_counters — the check
-- ---------------------------------------------------------------------------
CREATE FUNCTION runtime.reconcile_quota_counters(
  p_survey_version_id app.ulid,
  p_include_test      boolean DEFAULT false
) RETURNS TABLE (
  cell_id              app.ulid,
  committed            integer,
  reconciled_committed integer,
  drift                integer,
  in_flight_floor      integer
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = '' SET statement_timeout = '60s' AS $$
DECLARE v_now timestamptz := clock_timestamp();
BEGIN
  -- The write first, the report second. Folding both into one statement would make the report a
  -- CTE whose execution order relative to the UPDATE Postgres does not guarantee, and a
  -- reconciliation that sometimes reported pre-update values is worse than one that costs a second
  -- pass over a table with one row per cell.
  UPDATE runtime.quota_counters qc
     SET reconciled_committed = COALESCE((
           -- DISTINCT on the session, not a row count: the write path is at-least-once (E §5), so
           -- a retried finalize can append the same quota_committed event twice and counting rows
           -- would over-report the very thing being checked.
           SELECT count(DISTINCT e.session_id)::integer
             FROM runtime.response_events e
            WHERE e.survey_version_id = qc.survey_version_id
              AND e.event_type = 'quota_committed'
              AND (p_include_test OR NOT e.is_test)
              AND e.payload ? 'cell_id'
              AND (e.payload ->> 'cell_id')::app.ulid = qc.cell_id), 0),
         reconciled_at = v_now,
         -- The one value this job DOES correct. Postgres cannot know the true in_flight (Redis
         -- owns it), but it knows a lower bound: sessions holding the cell that are still live.
         -- Flooring there fixes the failure that matters — a leaked in_flight blocks a cell
         -- forever — without claiming a number the record cannot support.
         in_flight = COALESCE((
           SELECT count(*)::integer FROM runtime.quota_holds h
            WHERE h.survey_version_id = qc.survey_version_id
              AND h.committed_at IS NULL
              AND h.held_until > v_now
              AND runtime.quota_cell_id(h.survey_version_id, h.plan_id, h.cell_key)
                  = qc.cell_id), 0)
   WHERE qc.survey_version_id = p_survey_version_id
     AND (p_include_test OR NOT qc.is_test);

  RETURN QUERY
  SELECT qc.cell_id,
         qc.committed,
         qc.reconciled_committed,
         -- `committed` is left ALONE by this job, so drift is the evidence rather than a repaired
         -- value. See the header on why silently correcting it would be worse.
         qc.committed - qc.reconciled_committed,
         qc.in_flight
    FROM runtime.quota_counters qc
   WHERE qc.survey_version_id = p_survey_version_id
     AND (p_include_test OR NOT qc.is_test)
   ORDER BY qc.cell_id;
END $$;
COMMENT ON FUNCTION runtime.reconcile_quota_counters(app.ulid, boolean) IS
  'Recomputes committed per cell from the append-only event log — the only oracle that does not '
  'depend on a counter being right (P2-08). Writes reconciled_committed and floors in_flight at '
  'the live-hold count; leaves `committed` ALONE, because silently correcting it would erase the '
  'evidence of whatever caused the drift (risk register R2).';

-- ---------------------------------------------------------------------------
-- 2. runtime.repair_quota_counters — the deliberate second step
-- ---------------------------------------------------------------------------
-- Separate from `reconcile` on purpose: an operator looks at the drift, decides, and then repairs.
-- The roadmap's acceptance line is exactly this shape — "detected by the next reconciliation run,
-- reported per cell with the exact delta, and repairable by one job invocation".
CREATE FUNCTION runtime.repair_quota_counters(
  p_survey_version_id app.ulid
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = '' SET statement_timeout = '60s' AS $$
DECLARE v_count integer;
BEGIN
  WITH repaired AS (
    UPDATE runtime.quota_counters qc
       SET committed = qc.reconciled_committed,
           -- The epoch moves forward so a write-behind flush still in flight from BEFORE the
           -- repair cannot overwrite it. Without this the repair would be undone by a late drain
           -- carrying the drifted value, which is the subtlest way a fix fails to hold.
           redis_epoch = qc.redis_epoch + 1
     WHERE qc.survey_version_id = p_survey_version_id
       AND qc.reconciled_committed IS NOT NULL
       AND qc.reconciled_committed <> qc.committed
    RETURNING 1
  )
  SELECT count(*)::integer INTO v_count FROM repaired;
  RETURN v_count;
END $$;
COMMENT ON FUNCTION runtime.repair_quota_counters(app.ulid) IS
  'Sets committed to the event-log recomputation for every drifting cell, and BUMPS redis_epoch '
  'so a write-behind flush still in flight from before the repair cannot undo it — the subtlest '
  'way a fix fails to hold.';

-- ---------------------------------------------------------------------------
-- 3. runtime.quota_rebuild_state — everything Redis needs to be rebuilt
-- ---------------------------------------------------------------------------
-- The roadmap asks for "rebuild-Redis-from-Postgres-plus-events as a single job". The SQL half is
-- this: one row per cell carrying the authoritative committed (from the event log), the target,
-- and the live holds. The Redis half is a loop in the drain process — which is where it belongs,
-- because Postgres cannot write to Redis and a function that tried would be untestable.
CREATE FUNCTION runtime.quota_rebuild_state(
  p_survey_version_id app.ulid
) RETURNS TABLE (
  plan_id    app.ulid,
  cell_id    app.ulid,
  cell_key   text,
  mode       text,
  target     integer,
  committed  integer,
  holders    text[]
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = '' SET statement_timeout = '60s' AS $$
  SELECT qc.plan_id,
         qc.cell_id,
         array_to_string(c.cell_key, '|'),
         c.mode::text,
         qc.target,
         -- The event log, not qc.committed: a rebuild exists because the counters are suspect.
         COALESCE((SELECT count(DISTINCT e.session_id)::integer
                     FROM runtime.response_events e
                    WHERE e.survey_version_id = qc.survey_version_id
                      AND e.event_type = 'quota_committed'
                      AND NOT e.is_test
                      AND (e.payload ->> 'cell_id')::app.ulid = qc.cell_id), 0),
         COALESCE((SELECT array_agg(h.session_id::text ORDER BY h.session_id)
                     FROM runtime.quota_holds h
                    WHERE h.survey_version_id = qc.survey_version_id
                      AND h.committed_at IS NULL
                      AND h.held_until > clock_timestamp()
                      AND runtime.quota_cell_id(h.survey_version_id, h.plan_id, h.cell_key)
                          = qc.cell_id), '{}')
    FROM runtime.quota_counters qc
    JOIN content.quota_cells c
      ON c.survey_version_id = qc.survey_version_id AND c.id = qc.cell_id
   WHERE qc.survey_version_id = p_survey_version_id
     AND NOT qc.is_test
   ORDER BY qc.plan_id, c.cell_key
$$;
COMMENT ON FUNCTION runtime.quota_rebuild_state(app.ulid) IS
  'The SQL half of rebuild-Redis-from-Postgres-plus-events (P2-08): committed recomputed from the '
  'event log rather than read from the counter, because a rebuild exists precisely because the '
  'counters are suspect. The Redis writes are the drain process''s half.';

-- ---------------------------------------------------------------------------
-- 4. Grants
-- ---------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION runtime.reconcile_quota_counters(app.ulid, boolean) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION runtime.repair_quota_counters(app.ulid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION runtime.quota_rebuild_state(app.ulid) FROM PUBLIC;

-- The reconciliation job runs as the respondent plane's writer, like the drain it accompanies.
GRANT EXECUTE ON FUNCTION runtime.reconcile_quota_counters(app.ulid, boolean) TO runtime_writer;
GRANT EXECUTE ON FUNCTION runtime.repair_quota_counters(app.ulid) TO runtime_writer;
GRANT EXECUTE ON FUNCTION runtime.quota_rebuild_state(app.ulid) TO runtime_writer;
