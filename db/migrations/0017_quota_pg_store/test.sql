-- 0017_quota_pg_store/test.sql — pgTAP.
--
-- The Postgres store is P2-06's correctness BASELINE, so this file tests the properties the
-- Redis implementation will be diffed against — not the plumbing.
--
-- What it has to prove:
--   * ALL-OR-NONE across an interlock: with one of three cells full, the other two are UNTOUCHED.
--     This is the roadmap's own P2-07 test ("asserting zero mutation to the other two") applied to
--     the baseline, and it is the property a partial reservation would violate invisibly;
--   * every full hard cell is reported, not just the first — the QA panel needs all of them;
--   * a SOFT full cell passes and is flagged, rather than blocking;
--   * an expired hold stops counting without any sweeper running, because expiry is a predicate;
--   * commit is idempotent: a replayed finalize converts nothing;
--   * a cell with no target BLOCKS rather than filling forever (§0's fail-safe direction);
--   * test mode (`quota_evaluate`) issues no mutation at all — counters byte-identical before and
--     after, which is E §14.1's requirement and P2-08's acceptance line.
BEGIN;
SELECT plan(26);

GRANT USAGE ON SCHEMA public TO authoring, runtime_writer, analytics_reader, runtime_rpc_owner;

SELECT set_config('rs.ids', ops.test_seed_two_orgs()::text, true);
CREATE FUNCTION pg_temp.tid(k text) RETURNS text LANGUAGE sql STABLE AS
$$ SELECT current_setting('rs.ids', true)::jsonb ->> k $$;

-- Crockford aliasing in the helper, not in the caller — see 0016's note.
CREATE FUNCTION pg_temp.qid(p_prefix text, p_tag text) RETURNS app.ulid LANGUAGE sql IMMUTABLE AS
-- The 'V' is a TERMINATOR, not decoration, and it is the difference between this fixture working
-- and lying to you. Zero-padding alone is not injective: rpad('S1',25,'0') and rpad('S10',25,'0')
-- are the SAME string, so sessions `s1` and `s10` would share an id — and in 0017's suite that
-- made s10's reservation silently EXTEND s1's hold through the holds table's ON CONFLICT, so the
-- "reservable again after expiry" assertion passed for the wrong reason and the sweep found
-- nothing to reclaim. A non-'0' terminator makes the tag's length part of the id.
--
-- The translate() is Crockford base32's own aliasing (I/L decode as 1, O as 0; U is excluded from
-- the alphabet, so V is the nearest safe substitute), applied here rather than asking every call
-- site to remember four forbidden letters.
$$ SELECT (p_prefix || '_0'
           || rpad(translate(upper(p_tag), 'ILOU', '110V') || 'V', 25, '0'))::app.ulid $$;

CREATE FUNCTION pg_temp.ver() RETURNS app.ulid LANGUAGE sql STABLE AS
$$ SELECT pg_temp.tid('ver_a_draft')::app.ulid $$;
CREATE FUNCTION pg_temp.org() RETURNS app.ulid LANGUAGE sql STABLE AS
$$ SELECT pg_temp.tid('org_a')::app.ulid $$;

/* A 3-way interlock: one plan, three cells, each with target 1 so "full" is one respondent. */
CREATE FUNCTION pg_temp.setup() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO content.variables
    (survey_version_id, id, org_id, name, kind, vtype, export_column, sort_key)
  VALUES (pg_temp.ver(), pg_temp.qid('var', 'gender'), pg_temp.org(),
          'S2', 'hidden', 'text', 'S2', 1);
  INSERT INTO content.quota_dimensions
    (survey_version_id, id, org_id, ref, variable_id, sort_key)
  VALUES (pg_temp.ver(), pg_temp.qid('qd', 'gender'), pg_temp.org(),
          'GENDER', pg_temp.qid('var', 'gender'), 1);
  INSERT INTO content.quota_plans
    (survey_version_id, id, org_id, ref, plan_type, dimension_ids, count_at,
     reservation_ttl_s, on_store_unavailable, counter_scope, sort_key)
  VALUES (pg_temp.ver(), pg_temp.qid('qp', 'plan'), pg_temp.org(), 'MAIN', 'interlocked',
          ARRAY[pg_temp.qid('qd', 'gender')]::app.ulid[], 'reservation', 5400,
          'fail_closed', 'version', 1);
  INSERT INTO content.quota_cells
    (survey_version_id, id, org_id, plan_id, cell_key, target, mode)
  VALUES
    (pg_temp.ver(), pg_temp.qid('qc', 'a'), pg_temp.org(), pg_temp.qid('qp', 'plan'),
     ARRAY['A'], 1, 'hard'),
    (pg_temp.ver(), pg_temp.qid('qc', 'b'), pg_temp.org(), pg_temp.qid('qp', 'plan'),
     ARRAY['B'], 1, 'hard'),
    (pg_temp.ver(), pg_temp.qid('qc', 'c'), pg_temp.org(), pg_temp.qid('qp', 'plan'),
     ARRAY['C'], 1, 'hard'),
    (pg_temp.ver(), pg_temp.qid('qc', 'sft'), pg_temp.org(), pg_temp.qid('qp', 'plan'),
     ARRAY['SOFT'], 1, 'soft'),
    (pg_temp.ver(), pg_temp.qid('qc', 'ntgt'), pg_temp.org(), pg_temp.qid('qp', 'plan'),
     ARRAY['NOTARGET'], 1, 'hard');

  PERFORM runtime.quota_set_target(pg_temp.ver(), pg_temp.qid('qp', 'plan'), 'A', 1);
  PERFORM runtime.quota_set_target(pg_temp.ver(), pg_temp.qid('qp', 'plan'), 'B', 1);
  PERFORM runtime.quota_set_target(pg_temp.ver(), pg_temp.qid('qp', 'plan'), 'C', 1);
  PERFORM runtime.quota_set_target(pg_temp.ver(), pg_temp.qid('qp', 'plan'), 'SOFT', 1);
  -- NOTARGET deliberately gets no set_target call.
END $$;

CREATE FUNCTION pg_temp.k(p_cell text) RETURNS text LANGUAGE sql STABLE AS
$$ SELECT 'q:' || pg_temp.ver() || ':' || pg_temp.qid('qp', 'plan') || ':' || p_cell $$;

CREATE FUNCTION pg_temp.sid(p_tag text) RETURNS app.ulid LANGUAGE sql IMMUTABLE AS
$$ SELECT pg_temp.qid('ses', p_tag) $$;

SELECT pg_temp.setup();

-- ---------------------------------------------------------------------------
-- 1. Structure
-- ---------------------------------------------------------------------------
SELECT has_table('runtime', 'quota_holds', 'runtime.quota_holds exists');
SELECT ok((SELECT c.relforcerowsecurity FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'runtime' AND c.relname = 'quota_holds'),
  'runtime.quota_holds is FORCE row level security');
SELECT has_function('runtime', 'quota_reserve',
  ARRAY['app.ulid','app.ulid','text[]','text[]','integer'],
  'runtime.quota_reserve exists — and takes NO org id, which 0004''s and 0009''s catalog scans '
  'both assert for every function in schema runtime (B §2): a caller-supplied org id is a '
  'cross-tenant write vector, so the org is derived from the version row inside the definer');

-- ---------------------------------------------------------------------------
-- 2. A plain reservation, and the derived in_flight
-- ---------------------------------------------------------------------------
SELECT ok((SELECT r.ok FROM runtime.quota_reserve(
    pg_temp.ver(), pg_temp.sid('s1'),
    ARRAY[pg_temp.k('A')], ARRAY['hard'], 300) r),
  'a reservation on an empty cell succeeds');

SELECT is((SELECT s.in_flight FROM runtime.quota_read_cell(
             pg_temp.ver(), pg_temp.qid('qp', 'plan'), 'A') s),
  1, 'in_flight is DERIVED from the live hold, so it cannot drift from what justifies it');

SELECT is((SELECT s.committed FROM runtime.quota_read_cell(
             pg_temp.ver(), pg_temp.qid('qp', 'plan'), 'A') s),
  0, 'and committed is still zero — a reservation is not a complete');

-- A second respondent on the now-full cell A.
SELECT ok(NOT (SELECT r.ok FROM runtime.quota_reserve(
    pg_temp.ver(), pg_temp.sid('s2'),
    ARRAY[pg_temp.k('A')], ARRAY['hard'], 300) r),
  'a second reservation on a target-1 cell is refused (committed + in_flight >= target)');

-- ---------------------------------------------------------------------------
-- 3. ALL-OR-NONE — the property this whole file exists for
-- ---------------------------------------------------------------------------
-- A 3-way interlock where A is already full. B and C must be UNTOUCHED: a partial reservation
-- silently skews the achieved sample and is invisible until the data is delivered.
SELECT ok(NOT (SELECT r.ok FROM runtime.quota_reserve(
    pg_temp.ver(), pg_temp.sid('s3'),
    ARRAY[pg_temp.k('A'), pg_temp.k('B'), pg_temp.k('C')],
    ARRAY['hard','hard','hard'], 300) r),
  'a 3-way interlock with one full cell is refused');

SELECT is((SELECT s.in_flight FROM runtime.quota_read_cell(
             pg_temp.ver(), pg_temp.qid('qp', 'plan'), 'B') s),
  0, 'cell B took NOTHING — all-or-none across the interlock (E §10)');

SELECT is((SELECT s.in_flight FROM runtime.quota_read_cell(
             pg_temp.ver(), pg_temp.qid('qp', 'plan'), 'C') s),
  0, 'and neither did cell C — zero mutation, not a rolled-back one');

SELECT is((SELECT count(*)::int FROM runtime.quota_holds
            WHERE session_id = pg_temp.sid('s3')),
  0, 'and the refused session holds no rows at all');

-- Every full hard cell is reported, not just the first one hit.
SELECT ok((SELECT r.ok FROM runtime.quota_reserve(
    pg_temp.ver(), pg_temp.sid('s4'),
    ARRAY[pg_temp.k('B')], ARRAY['hard'], 300) r),
  'B is reservable on its own, so the interlock above failed only because of A');

SELECT is((SELECT array_length(r.blocked, 1) FROM runtime.quota_reserve(
    pg_temp.ver(), pg_temp.sid('s5'),
    ARRAY[pg_temp.k('A'), pg_temp.k('B')], ARRAY['hard','hard'], 300) r),
  2, 'BOTH full hard cells are reported, not just the first — the QA panel needs every one');

-- ---------------------------------------------------------------------------
-- 4. Soft cells pass and are flagged
-- ---------------------------------------------------------------------------
SELECT ok((SELECT r.ok FROM runtime.quota_reserve(
    pg_temp.ver(), pg_temp.sid('s6'),
    ARRAY[pg_temp.k('SOFT')], ARRAY['soft'], 300) r),
  'a soft cell takes its first respondent');

SELECT ok((SELECT r.ok FROM runtime.quota_reserve(
    pg_temp.ver(), pg_temp.sid('s7'),
    ARRAY[pg_temp.k('SOFT')], ARRAY['soft'], 300) r),
  'and a FULL soft cell still passes — "soft" means keep counting, not keep blocking');

SELECT is((SELECT r.soft_full FROM runtime.quota_reserve(
    pg_temp.ver(), pg_temp.sid('s8'),
    ARRAY[pg_temp.k('SOFT')], ARRAY['soft'], 300) r),
  ARRAY[pg_temp.k('SOFT')], 'reporting the overshoot by cell, so the dashboard can show it');

-- ---------------------------------------------------------------------------
-- 5. A cell with no target BLOCKS
-- ---------------------------------------------------------------------------
SELECT ok(NOT (SELECT r.ok FROM runtime.quota_reserve(
    pg_temp.ver(), pg_temp.sid('s9'),
    ARRAY[pg_temp.k('NOTARGET')], ARRAY['hard'], 300) r),
  'a cell whose target was never set BLOCKS rather than filling forever — the fail-safe '
  'direction, because an unknown target is not an unlimited one');

-- ---------------------------------------------------------------------------
-- 6. Expiry is a predicate, so no sweeper is needed for correctness
-- ---------------------------------------------------------------------------
-- s1 holds A. Backdate its expiry and the cell is free again with no sweep run at all.
RESET ROLE;
UPDATE runtime.quota_holds SET held_until = clock_timestamp() - interval '1 second'
 WHERE session_id = pg_temp.sid('s1');

SELECT is((SELECT s.in_flight FROM runtime.quota_read_cell(
             pg_temp.ver(), pg_temp.qid('qp', 'plan'), 'A') s),
  0, 'an EXPIRED hold stops counting immediately — expiry is a predicate, not a job');

SELECT ok((SELECT r.ok FROM runtime.quota_reserve(
    pg_temp.ver(), pg_temp.sid('s10'),
    ARRAY[pg_temp.k('A')], ARRAY['hard'], 300) r),
  'so the cell is reservable again without any sweeper having run');

SELECT is(runtime.quota_sweep(pg_temp.ver(), clock_timestamp()), 1,
  'the sweep still reclaims the expired row, which is what keeps the table from growing');

-- ---------------------------------------------------------------------------
-- 7. Commit is idempotent
-- ---------------------------------------------------------------------------
SELECT is(runtime.quota_commit(pg_temp.ver(), pg_temp.sid('s10')), 1,
  'completing converts the held reservation');

SELECT is((SELECT s.committed FROM runtime.quota_read_cell(
             pg_temp.ver(), pg_temp.qid('qp', 'plan'), 'A') s),
  1, 'committed moved to 1');

SELECT is(runtime.quota_commit(pg_temp.ver(), pg_temp.sid('s10')), 0,
  'a REPLAYED finalize converts nothing — idempotent by construction (E §10.3)');

SELECT is((SELECT s.committed FROM runtime.quota_read_cell(
             pg_temp.ver(), pg_temp.qid('qp', 'plan'), 'A') s),
  1, 'and committed did not double-count');

-- ---------------------------------------------------------------------------
-- 8. Test mode mutates NOTHING (E §14.1, P2-08's acceptance line)
-- ---------------------------------------------------------------------------
CREATE TEMP TABLE before_state AS
  SELECT survey_version_id, cell_id, committed, in_flight FROM runtime.quota_counters;

SELECT ok(NOT (SELECT r.ok FROM runtime.quota_evaluate(
    pg_temp.ver(), ARRAY[pg_temp.k('A')], ARRAY['hard']) r),
  'a test session on a full cell gets would_be_full');

SELECT is((SELECT count(*)::int FROM runtime.quota_counters qc
            JOIN before_state b USING (survey_version_id, cell_id)
           WHERE qc.committed <> b.committed OR qc.in_flight <> b.in_flight),
  0, 'and the counters are byte-identical afterwards — E §14.1: a test session issues NO '
     'mutation, and reserve-then-release is the named wrong answer');

SELECT * FROM finish();
ROLLBACK;
