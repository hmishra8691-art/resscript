-- 0018_quota_reconciliation/test.sql — pgTAP.
--
-- The roadmap's P2-08 acceptance line, almost verbatim: "Corrupting a Redis counter by +37 is
-- detected by the next reconciliation run, reported per cell with the exact delta, and repairable
-- by one job invocation that restores agreement with the event log."
--
-- What this file has to prove:
--   * the event log is the oracle: `committed` is recomputed from `quota_committed` events and a
--     drifted counter is reported with the EXACT delta, not a boolean;
--   * a retried finalize does not over-report — the write path is at-least-once, so a duplicate
--     event must count once (DISTINCT session, not a row count). This is the assertion that keeps
--     reconciliation from inventing the drift it exists to find;
--   * reconcile leaves `committed` ALONE — drift is evidence, not something a job quietly erases;
--   * repair is a SECOND, deliberate call, and it BUMPS redis_epoch so a write-behind flush still
--     in flight from before the repair cannot undo it;
--   * a leaked `in_flight` is floored at the live-hold count, because a leak blocks a cell forever;
--   * test events are excluded by default, so QA traffic cannot manufacture drift.
BEGIN;
SELECT plan(18);

GRANT USAGE ON SCHEMA public TO authoring, runtime_writer, analytics_reader, runtime_rpc_owner;

SELECT set_config('rs.ids', ops.test_seed_two_orgs()::text, true);
CREATE FUNCTION pg_temp.tid(k text) RETURNS text LANGUAGE sql STABLE AS
$$ SELECT current_setting('rs.ids', true)::jsonb ->> k $$;

-- A legible id from a legible tag. The 'V' terminator is what makes `s1` and `s10` different ids
-- — see 0017's note on the fixture bug that omitting it caused.
CREATE FUNCTION pg_temp.qid(p_prefix text, p_tag text) RETURNS app.ulid LANGUAGE sql IMMUTABLE AS
$$ SELECT (p_prefix || '_0'
           || rpad(translate(upper(p_tag), 'ILOU', '110V') || 'V', 25, '0'))::app.ulid $$;

CREATE FUNCTION pg_temp.ver() RETURNS app.ulid LANGUAGE sql STABLE AS
$$ SELECT pg_temp.tid('ver_a_draft')::app.ulid $$;
CREATE FUNCTION pg_temp.org() RETURNS app.ulid LANGUAGE sql STABLE AS
$$ SELECT pg_temp.tid('org_a')::app.ulid $$;

CREATE FUNCTION pg_temp.setup() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO content.variables
    (survey_version_id, id, org_id, name, kind, vtype, export_column, sort_key)
  VALUES (pg_temp.ver(), pg_temp.qid('var', 'g'), pg_temp.org(), 'S2', 'hidden', 'text', 'S2', 1);
  INSERT INTO content.quota_dimensions
    (survey_version_id, id, org_id, ref, variable_id, sort_key)
  VALUES (pg_temp.ver(), pg_temp.qid('qd', 'g'), pg_temp.org(), 'GENDER',
          pg_temp.qid('var', 'g'), 1);
  INSERT INTO content.quota_plans
    (survey_version_id, id, org_id, ref, plan_type, dimension_ids, count_at,
     reservation_ttl_s, on_store_unavailable, counter_scope, sort_key)
  VALUES (pg_temp.ver(), pg_temp.qid('qp', 'plan'), pg_temp.org(), 'MAIN', 'interlocked',
          ARRAY[pg_temp.qid('qd', 'g')]::app.ulid[], 'reservation', 5400,
          'fail_closed', 'version', 1);
  INSERT INTO content.quota_cells
    (survey_version_id, id, org_id, plan_id, cell_key, target, mode)
  VALUES (pg_temp.ver(), pg_temp.qid('qc', 'a'), pg_temp.org(), pg_temp.qid('qp', 'plan'),
          ARRAY['A'], 500, 'hard');
  PERFORM runtime.quota_set_target(pg_temp.ver(), pg_temp.qid('qp', 'plan'), 'A', 500);
END $$;

/* One quota_committed event for a session. `runtime.response_events` needs a response document
   first (0011's FK), so the seeding goes through the same shape the write path uses. */
CREATE FUNCTION pg_temp.commit_event(p_session text, p_is_test boolean DEFAULT false)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_sid app.ulid := pg_temp.qid('ses', p_session);
BEGIN
  INSERT INTO runtime.sessions
    (id, survey_version_id, org_id, is_test, status, random_seed, artifact_hash, language)
  VALUES (v_sid, pg_temp.ver(), pg_temp.org(), p_is_test, 'completed',
          repeat('a', 32), repeat('0', 64), 'en')
  ON CONFLICT DO NOTHING;
  INSERT INTO runtime.response_events
    (survey_version_id, event_id, session_id, org_id, seq, event_type, is_test, payload)
  VALUES (pg_temp.ver(), pg_temp.qid('evt', p_session), v_sid, pg_temp.org(), 1,
          'quota_committed', p_is_test,
          jsonb_build_object('cell_id', pg_temp.qid('qc', 'a')))
  ON CONFLICT DO NOTHING;
END $$;

SELECT pg_temp.setup();

-- ---------------------------------------------------------------------------
-- 1. Structure
-- ---------------------------------------------------------------------------
SELECT has_function('runtime', 'reconcile_quota_counters', ARRAY['app.ulid', 'boolean'],
  'runtime.reconcile_quota_counters exists');
SELECT has_function('runtime', 'repair_quota_counters', ARRAY['app.ulid'],
  'runtime.repair_quota_counters exists — a SEPARATE call, deliberately');
SELECT has_function('runtime', 'quota_rebuild_state', ARRAY['app.ulid'],
  'runtime.quota_rebuild_state exists');

-- ---------------------------------------------------------------------------
-- 2. Agreement, then the +37 corruption
-- ---------------------------------------------------------------------------
SELECT pg_temp.commit_event('c1');
SELECT pg_temp.commit_event('c2');
SELECT pg_temp.commit_event('c3');

RESET ROLE;
UPDATE runtime.quota_counters SET committed = 3 WHERE cell_id = pg_temp.qid('qc', 'a');

SELECT is((SELECT r.drift FROM runtime.reconcile_quota_counters(pg_temp.ver()) r),
  0, 'a counter that agrees with the event log reports zero drift');

-- The acceptance line: corrupt by +37.
UPDATE runtime.quota_counters SET committed = committed + 37
 WHERE cell_id = pg_temp.qid('qc', 'a');

SELECT is((SELECT r.drift FROM runtime.reconcile_quota_counters(pg_temp.ver()) r),
  37, 'a counter corrupted by +37 is reported with the EXACT delta, per cell');

SELECT is((SELECT r.reconciled_committed FROM runtime.reconcile_quota_counters(pg_temp.ver()) r),
  3, 'and the recomputation is the event-log truth, not the counter');

SELECT is((SELECT committed FROM runtime.quota_counters WHERE cell_id = pg_temp.qid('qc', 'a')),
  40, 'reconcile left `committed` ALONE — drift is evidence, and a job that silently corrected it '
      'would erase whatever caused it (risk register R2)');

-- ---------------------------------------------------------------------------
-- 3. Repair is the second, deliberate step
-- ---------------------------------------------------------------------------
SELECT is((SELECT redis_epoch FROM runtime.quota_counters
            WHERE cell_id = pg_temp.qid('qc', 'a')), 0::bigint,
  'the epoch starts where the flush left it');

SELECT is(runtime.repair_quota_counters(pg_temp.ver()), 1,
  'one job invocation repairs the drifting cell');

SELECT is((SELECT committed FROM runtime.quota_counters WHERE cell_id = pg_temp.qid('qc', 'a')),
  3, 'and committed now agrees with the event log');

SELECT is((SELECT redis_epoch FROM runtime.quota_counters
            WHERE cell_id = pg_temp.qid('qc', 'a')), 1::bigint,
  'the epoch was BUMPED, so a write-behind flush still in flight from before the repair cannot '
  'undo it — the subtlest way a fix fails to hold');

SELECT is(runtime.repair_quota_counters(pg_temp.ver()), 0,
  'a second repair does nothing, because nothing drifts any more');

-- ---------------------------------------------------------------------------
-- 4. At-least-once delivery must not manufacture drift
-- ---------------------------------------------------------------------------
-- The write path is at-least-once (E §5), so a retried finalize appends a SECOND quota_committed
-- event for the same session. Counting rows would report drift that does not exist — which would
-- make the drift alert fire on healthy surveys and get muted.
RESET ROLE;
INSERT INTO runtime.response_events
  (survey_version_id, event_id, session_id, org_id, seq, event_type, is_test, payload)
VALUES (pg_temp.ver(), pg_temp.qid('evt', 'c1r'), pg_temp.qid('ses', 'c1'), pg_temp.org(), 2,
        'quota_committed', false, jsonb_build_object('cell_id', pg_temp.qid('qc', 'a')));

SELECT is((SELECT r.reconciled_committed FROM runtime.reconcile_quota_counters(pg_temp.ver()) r),
  3, 'a DUPLICATE quota_committed event for one session still counts once — DISTINCT session, '
     'not a row count, because the write path is at-least-once');

SELECT is((SELECT r.drift FROM runtime.reconcile_quota_counters(pg_temp.ver()) r),
  0, 'so a retried finalize does not manufacture drift the operator would have to chase');

-- ---------------------------------------------------------------------------
-- 5. Test traffic cannot manufacture drift either
-- ---------------------------------------------------------------------------
SELECT pg_temp.commit_event('t1', true);

SELECT is((SELECT r.reconciled_committed FROM runtime.reconcile_quota_counters(pg_temp.ver()) r),
  3, 'a TEST session''s commit event is excluded by default (E §14.1''s default, shared with '
     'field_stats and the export)');

SELECT is((SELECT r.reconciled_committed
             FROM runtime.reconcile_quota_counters(pg_temp.ver(), true) r),
  4, 'and included only when asked for');

-- ---------------------------------------------------------------------------
-- 6. A leaked in_flight is floored at the live holds
-- ---------------------------------------------------------------------------
RESET ROLE;
UPDATE runtime.quota_counters SET in_flight = 99 WHERE cell_id = pg_temp.qid('qc', 'a');

SELECT is((SELECT r.in_flight_floor FROM runtime.reconcile_quota_counters(pg_temp.ver()) r),
  0, 'with no live holds the floor is zero');

SELECT is((SELECT in_flight FROM runtime.quota_counters WHERE cell_id = pg_temp.qid('qc', 'a')),
  0, 'and the leaked in_flight is corrected — unlike `committed`, a leak here blocks the cell '
     'forever, so this is the one value reconciliation does fix');

SELECT * FROM finish();
ROLLBACK;
