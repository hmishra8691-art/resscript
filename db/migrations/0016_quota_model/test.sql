-- 0016_quota_model/test.sql — pgTAP.
--
-- What this file has to prove:
--   * the four content tables and runtime.quota_counters exist, are FORCE-RLS, and are reachable
--     by the roles the matrix says and by nobody else;
--   * `qplan_marginal_one_dim` refuses a marginal plan over two dimensions — 03 §8's distinction,
--     asserted by SQLSTATE rather than by hope;
--   * `qcell_one_target` refuses both-or-neither targets;
--   * flush_quota_counters is MONOTONIC: a late flush carrying a lower redis_epoch is dropped,
--     not applied. This is the property write-behind correctness rests on, and it is the one a
--     unit test in TypeScript cannot check because it lives in the ON CONFLICT clause;
--   * app.quota_dashboard enforces the analyst floor FIRST and answers another org's version with
--     P0002 — 0004's existence-oracle rule, the same as field_stats;
--   * drift reads NULL before a reconciliation and the exact delta after one.
BEGIN;
SELECT plan(42);

GRANT USAGE ON SCHEMA public TO authoring, runtime_writer, analytics_reader, runtime_rpc_owner;

SELECT set_config('rs.ids', ops.test_seed_two_orgs()::text, true);
CREATE FUNCTION pg_temp.tid(k text) RETURNS text LANGUAGE sql STABLE AS
$$ SELECT current_setting('rs.ids', true)::jsonb ->> k $$;

-- Impersonate a caller exactly as PostgREST does (0004's helper): claims GUC + SET LOCAL ROLE.
CREATE FUNCTION pg_temp.act_as(p_user uuid, p_org text, p_role text DEFAULT 'authoring')
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', p_user, 'role', p_role,
                      'app_metadata', json_build_object('active_org_id', p_org))::text,
    true);
  EXECUTE format('SET LOCAL ROLE %I', p_role);
END $$;

-- A legible id from a legible tag.
--
-- The tag is folded through Crockford base32's OWN aliasing rules rather than the caller being
-- asked to avoid I/L/O/U — I and L decode as 1, O decodes as 0, and U is excluded outright (the
-- alphabet drops it to avoid accidental obscenity), so V is the nearest safe substitute. Doing
-- this in the helper rather than in every call site is the difference between a fixture that
-- reads (`qid('qp','plan')`) and one that fails at runtime because a reviewer had to remember
-- four forbidden letters. The first draft of this file did not, and every id built from `main`,
-- `both` and `nopol` violated the domain.
CREATE FUNCTION pg_temp.qid(p_prefix text, p_tag text) RETURNS app.ulid LANGUAGE sql IMMUTABLE AS
$$ SELECT (p_prefix || '_0'
           || rpad(translate(upper(p_tag), 'ILOU', '110V'), 25, '0'))::app.ulid $$;

-- ---------------------------------------------------------------------------
-- 1. Structure
-- ---------------------------------------------------------------------------
SELECT has_table('content', 'quota_dimensions', 'content.quota_dimensions exists');
SELECT has_table('content', 'quota_buckets', 'content.quota_buckets exists');
SELECT has_table('content', 'quota_plans', 'content.quota_plans exists');
SELECT has_table('content', 'quota_cells', 'content.quota_cells exists');
SELECT has_table('runtime', 'quota_counters', 'runtime.quota_counters exists');

SELECT has_column('content', 'quota_cells', 'cell_key', 'quota_cells.cell_key exists (B §5)');
SELECT col_type_is('content', 'quota_cells', 'cell_key', 'text[]',
  'cell_key is text[] — what the counter key interpolates and an operator reads');
SELECT has_column('runtime', 'quota_counters', 'redis_epoch',
  'quota_counters.redis_epoch exists — the monotonic guard write-behind rests on');
SELECT has_column('runtime', 'quota_counters', 'reconciled_committed',
  'quota_counters.reconciled_committed exists (P2-08)');

SELECT has_index('runtime', 'quota_counters', 'quota_counters_drift_idx',
  'the partial drift index exists, so "which cells are drifting" is an index-only scan');

-- Every new table FORCE-RLS. ENABLE alone is bypassed by the owner, and the migration runner IS
-- the owner — which is why ops.tables_without_rls() checks FORCE and so does this.
SELECT ok((SELECT c.relforcerowsecurity FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'content' AND c.relname = 'quota_plans'),
  'content.quota_plans is FORCE row level security');
SELECT ok((SELECT c.relforcerowsecurity FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'runtime' AND c.relname = 'quota_counters'),
  'runtime.quota_counters is FORCE row level security');

-- ---------------------------------------------------------------------------
-- 2. The constraints that encode 03 §8
-- ---------------------------------------------------------------------------
-- The seed carries orgs, projects, surveys and versions but no VARIABLES, so the two a
-- dimension needs are created here. Seeded as superuser: the point of this file is the quota
-- objects, and re-proving that content.variables accepts an insert is 0007's job.
RESET ROLE;
-- `hidden`, not `response`: a response variable needs a source question
-- (`vars_response_has_source`) and this fixture has no questions — but more to the point, a
-- vendor-supplied parameter IS the most common real quota dimension after gender and age, so the
-- hidden kind is the honest fixture rather than a convenience. The enum one carries a domain,
-- which `vars_enum_domain` requires.
INSERT INTO content.variables
  (survey_version_id, id, org_id, name, kind, vtype, enum_domain, export_column, sort_key)
VALUES
  (pg_temp.tid('ver_a_draft')::app.ulid, pg_temp.qid('var', 'gender'),
   pg_temp.tid('org_a')::app.ulid, 'S2', 'hidden', 'enum',
   '[{"code":1,"label_key":"s2.m"},{"code":2,"label_key":"s2.f"}]'::jsonb, 'S2', 1);
INSERT INTO content.variables
  (survey_version_id, id, org_id, name, kind, vtype, export_column, sort_key)
VALUES
  (pg_temp.tid('ver_a_draft')::app.ulid, pg_temp.qid('var', 'age'),
   pg_temp.tid('org_a')::app.ulid, 'AGE', 'hidden', 'number', 'AGE', 2);

INSERT INTO content.quota_dimensions
  (survey_version_id, id, org_id, ref, variable_id, sort_key)
VALUES
  (pg_temp.tid('ver_a_draft')::app.ulid, pg_temp.qid('qd', 'gender'),
   pg_temp.tid('org_a')::app.ulid, 'GENDER', pg_temp.qid('var', 'gender'), 1),
  (pg_temp.tid('ver_a_draft')::app.ulid, pg_temp.qid('qd', 'age'),
   pg_temp.tid('org_a')::app.ulid, 'AGE_BAND', pg_temp.qid('var', 'age'), 2);

SELECT is((SELECT count(*)::int FROM content.quota_dimensions
            WHERE survey_version_id = pg_temp.tid('ver_a_draft')::app.ulid),
  2, 'both dimensions insert and are scoped to their version');

-- A dimension whose variable belongs to ANOTHER version is refused by the composite FK: without
-- it the gate would evaluate a bucket against a value the respondent's survey never collects.
SELECT throws_ok(
  format($ins$INSERT INTO content.quota_dimensions
    (survey_version_id, id, org_id, ref, variable_id, sort_key)
   VALUES (%L, %L, %L, 'CROSS', %L, 9)$ins$,
    pg_temp.tid('ver_b_draft'), pg_temp.qid('qd', 'cross'), pg_temp.tid('org_b'),
    pg_temp.qid('var', 'gender')),
  '23503', NULL,
  'a dimension cannot name a variable from another version — the composite FK refuses it');

-- A bucket carries the AST that decides membership, and must be an object.
SELECT lives_ok(
  format($ins$INSERT INTO content.quota_buckets
    (survey_version_id, id, org_id, dimension_id, ref, match, sort_key)
   VALUES (%L, %L, %L, %L, 'M', '{"op":"==","args":[]}'::jsonb, 1)$ins$,
    pg_temp.tid('ver_a_draft'), pg_temp.qid('qb', 'm'), pg_temp.tid('org_a'),
    pg_temp.qid('qd', 'gender')),
  'a bucket with an object match inserts');

SELECT throws_ok(
  format($ins$INSERT INTO content.quota_buckets
    (survey_version_id, id, org_id, dimension_id, ref, match, sort_key)
   VALUES (%L, %L, %L, %L, 'BAD', '"a string"'::jsonb, 2)$ins$,
    pg_temp.tid('ver_a_draft'), pg_temp.qid('qb', 'bad'), pg_temp.tid('org_a'),
    pg_temp.qid('qd', 'gender')),
  '23514', NULL,
  'qbucket_match_object refuses a non-object match — an AST is an object, and a bare string '
  'would reach the engine as an unparseable condition');

-- An interlocked plan over two dimensions is fine.
SELECT lives_ok(
  format($ins$INSERT INTO content.quota_plans
    (survey_version_id, id, org_id, ref, plan_type, dimension_ids, count_at,
     reservation_ttl_s, on_store_unavailable, counter_scope, sort_key)
   VALUES (%L, %L, %L, 'MAIN', 'interlocked', ARRAY[%L,%L]::app.ulid[], 'reservation',
           5400, 'fail_closed', 'survey', 1)$ins$,
    pg_temp.tid('ver_a_draft'), pg_temp.qid('qp', 'plan'), pg_temp.tid('org_a'),
    pg_temp.qid('qd', 'gender'), pg_temp.qid('qd', 'age')),
  'an interlocked plan over two dimensions is accepted');

-- A MARGINAL plan over two dimensions is not one plan; it is two.
SELECT throws_ok(
  format($ins$INSERT INTO content.quota_plans
    (survey_version_id, id, org_id, ref, plan_type, dimension_ids, count_at,
     reservation_ttl_s, on_store_unavailable, counter_scope, sort_key)
   VALUES (%L, %L, %L, 'BAD', 'marginal', ARRAY[%L,%L]::app.ulid[], 'reservation',
           5400, 'fail_closed', 'survey', 2)$ins$,
    pg_temp.tid('ver_a_draft'), pg_temp.qid('qp', 'bad'), pg_temp.tid('org_a'),
    pg_temp.qid('qd', 'gender'), pg_temp.qid('qd', 'age')),
  '23514', NULL,
  'qplan_marginal_one_dim refuses a marginal plan over two dimensions (03 §8: it is two plans)');

-- A marginal plan over ONE dimension is exactly what marginal means.
SELECT lives_ok(
  format($ins$INSERT INTO content.quota_plans
    (survey_version_id, id, org_id, ref, plan_type, dimension_ids, count_at,
     reservation_ttl_s, on_store_unavailable, counter_scope, sort_key)
   VALUES (%L, %L, %L, 'MARG', 'marginal', ARRAY[%L]::app.ulid[], 'reservation',
           5400, 'fail_open', 'version', 3)$ins$,
    pg_temp.tid('ver_a_draft'), pg_temp.qid('qp', 'marg'), pg_temp.tid('org_a'),
    pg_temp.qid('qd', 'gender')),
  'a marginal plan over one dimension is accepted');

-- Exactly one of target / target_pct.
SELECT throws_ok(
  format($ins$INSERT INTO content.quota_cells
    (survey_version_id, id, org_id, plan_id, cell_key, target, target_pct, mode)
   VALUES (%L, %L, %L, %L, ARRAY['M'], 100, 50.0, 'hard')$ins$,
    pg_temp.tid('ver_a_draft'), pg_temp.qid('qc', 'both'), pg_temp.tid('org_a'),
    pg_temp.qid('qp', 'plan')),
  '23514', NULL, 'qcell_one_target refuses a cell carrying BOTH a count and a percentage');

SELECT throws_ok(
  format($ins$INSERT INTO content.quota_cells
    (survey_version_id, id, org_id, plan_id, cell_key, mode)
   VALUES (%L, %L, %L, %L, ARRAY['M'], 'hard')$ins$,
    pg_temp.tid('ver_a_draft'), pg_temp.qid('qc', 'none'), pg_temp.tid('org_a'),
    pg_temp.qid('qp', 'plan')),
  '23514', NULL,
  'and refuses a cell carrying NEITHER — a cell that can never be full reads as a bug');

SELECT lives_ok(
  format($ins$INSERT INTO content.quota_cells
    (survey_version_id, id, org_id, plan_id, cell_key, target, mode)
   VALUES (%L, %L, %L, %L, ARRAY['M','18_24'], 100, 'hard')$ins$,
    pg_temp.tid('ver_a_draft'), pg_temp.qid('qc', 'm1824'), pg_temp.tid('org_a'),
    pg_temp.qid('qp', 'plan')),
  'a cell with one target inserts');

-- The policy columns have NO default, which is ADR-008's "no safe default" made unbypassable.
SELECT throws_ok(
  format($ins$INSERT INTO content.quota_plans
    (survey_version_id, id, org_id, ref, plan_type, dimension_ids, count_at,
     reservation_ttl_s, counter_scope, sort_key)
   VALUES (%L, %L, %L, 'NOPOL', 'interlocked', ARRAY[%L]::app.ulid[], 'reservation',
           5400, 'survey', 4)$ins$,
    pg_temp.tid('ver_a_draft'), pg_temp.qid('qp', 'nopolicy'), pg_temp.tid('org_a'),
    pg_temp.qid('qd', 'gender')),
  '23502', NULL,
  'a plan with no on_store_unavailable is refused by NOT NULL: ADR-008 has no safe default, so '
  'the row cannot omit the choice');

-- ---------------------------------------------------------------------------
-- 3. flush_quota_counters is monotonic — the property write-behind rests on
-- ---------------------------------------------------------------------------
SELECT is(runtime.flush_quota_counters(json_build_array(
    json_build_object(
      'survey_version_id', pg_temp.tid('ver_a_draft'),
      'cell_id', pg_temp.qid('qc', 'm1824'), 'plan_id', pg_temp.qid('qp', 'plan'),
      'org_id', pg_temp.tid('org_a'), 'target', 100,
      'committed', 10, 'in_flight', 3, 'redis_epoch', 5))::jsonb),
  1, 'a first flush inserts the counter');

SELECT is((SELECT committed FROM runtime.quota_counters
            WHERE cell_id = pg_temp.qid('qc', 'm1824')), 10, 'and it lands');

SELECT is(runtime.flush_quota_counters(json_build_array(
    json_build_object(
      'survey_version_id', pg_temp.tid('ver_a_draft'),
      'cell_id', pg_temp.qid('qc', 'm1824'), 'plan_id', pg_temp.qid('qp', 'plan'),
      'org_id', pg_temp.tid('org_a'), 'target', 100,
      'committed', 25, 'in_flight', 1, 'redis_epoch', 9))::jsonb),
  1, 'a newer epoch updates');

SELECT is((SELECT committed FROM runtime.quota_counters
            WHERE cell_id = pg_temp.qid('qc', 'm1824')), 25, 'and it moves forward');

-- THE test. A late flush carrying a lower epoch must be DROPPED, not applied: write-behind is
-- asynchronous and can arrive out of order, and a counter that rewinds is a counter that
-- over-admits.
SELECT is(runtime.flush_quota_counters(json_build_array(
    json_build_object(
      'survey_version_id', pg_temp.tid('ver_a_draft'),
      'cell_id', pg_temp.qid('qc', 'm1824'), 'plan_id', pg_temp.qid('qp', 'plan'),
      'org_id', pg_temp.tid('org_a'), 'target', 100,
      'committed', 11, 'in_flight', 9, 'redis_epoch', 6))::jsonb),
  0, 'a STALE epoch updates nothing — the guard reports zero rows written');

SELECT is((SELECT committed FROM runtime.quota_counters
            WHERE cell_id = pg_temp.qid('qc', 'm1824')), 25,
  'and the durable record did NOT go backwards (B §5.1''s whole reason for redis_epoch)');

SELECT is(runtime.flush_quota_counters(json_build_array(
    json_build_object(
      'survey_version_id', pg_temp.tid('ver_a_draft'),
      'cell_id', pg_temp.qid('qc', 'm1824'), 'plan_id', pg_temp.qid('qp', 'plan'),
      'org_id', pg_temp.tid('org_a'), 'target', 100,
      'committed', 25, 'in_flight', 0, 'redis_epoch', 9))::jsonb),
  0, 'an EQUAL epoch is also dropped — the guard is strictly greater, so a replayed drain is a '
     'no-op rather than a rewrite');

SELECT throws_ok(
  $$SELECT runtime.flush_quota_counters('{"not":"an array"}'::jsonb)$$,
  '22023', NULL, 'a non-array payload is refused by name rather than silently writing nothing');

-- ---------------------------------------------------------------------------
-- 4. app.quota_dashboard — floor first, then tenancy, then the numbers
-- ---------------------------------------------------------------------------
SELECT pg_temp.act_as(pg_temp.tid('user_a')::uuid, pg_temp.tid('org_a'));
SELECT is((SELECT count(*)::int FROM app.quota_dashboard(
             pg_temp.tid('ver_a_draft')::app.ulid)),
  1, 'the dashboard returns the org''s own counters');

SELECT is((SELECT d.committed FROM app.quota_dashboard(
             pg_temp.tid('ver_a_draft')::app.ulid) d),
  25, 'with the committed count from the durable record');

SELECT is((SELECT d.cell_key FROM app.quota_dashboard(
             pg_temp.tid('ver_a_draft')::app.ulid) d),
  ARRAY['M','18_24'], 'and the cell key joined from content, so a dashboard row is readable');

SELECT ok((SELECT d.drift IS NULL FROM app.quota_dashboard(
             pg_temp.tid('ver_a_draft')::app.ulid) d),
  'drift is NULL before any reconciliation has run — which is NOT the same as zero drift, and '
  'must not render as agreement');

RESET ROLE;
UPDATE runtime.quota_counters
   SET reconciled_committed = 18, reconciled_at = now()
 WHERE cell_id = pg_temp.qid('qc', 'm1824');

SELECT pg_temp.act_as(pg_temp.tid('user_a')::uuid, pg_temp.tid('org_a'));
SELECT is((SELECT d.drift FROM app.quota_dashboard(
             pg_temp.tid('ver_a_draft')::app.ulid) d),
  7, 'after a reconciliation drift is the exact delta (25 committed - 18 recomputed)');

-- Floor FIRST, so a caller with no standing learns nothing about whether the version exists.
SELECT pg_temp.act_as(pg_temp.tid('user_a2')::uuid, pg_temp.tid('org_a'));
SELECT throws_ok(
  format('SELECT count(*) FROM app.quota_dashboard(%L)', pg_temp.tid('ver_a_draft')),
  '42501', NULL, 'a reviewer cannot read quota counters — floor first, by name (security §7.1)');

SELECT pg_temp.act_as(pg_temp.tid('user_b')::uuid, pg_temp.tid('org_b'));
SELECT throws_ok(
  format('SELECT count(*) FROM app.quota_dashboard(%L)', pg_temp.tid('ver_a_draft')),
  'P0002', NULL,
  'another org''s version reads as NOT FOUND — indistinguishable from a version that never '
  'existed (0004''s existence-oracle rule)');

-- ---------------------------------------------------------------------------
-- 5. Posture (ADR-001)
-- ---------------------------------------------------------------------------
RESET ROLE;
SELECT set_config('request.jwt.claims', '', true);
SELECT ok(NOT has_table_privilege('authoring', 'runtime.quota_counters', 'SELECT'),
  'authoring cannot read runtime.quota_counters directly — the plane boundary holds, and '
  'app.quota_dashboard is the only way across');
SELECT ok(has_function_privilege('authoring',
  'app.quota_dashboard(app.ulid, boolean)', 'EXECUTE'),
  'authoring holds EXECUTE on the dashboard read');
SELECT ok(has_function_privilege('runtime_writer',
  'runtime.flush_quota_counters(jsonb)', 'EXECUTE'),
  'runtime_writer holds EXECUTE on the write-behind flush');
SELECT ok(NOT has_function_privilege('authoring',
  'runtime.flush_quota_counters(jsonb)', 'EXECUTE'),
  'authoring does NOT — the control plane never writes a counter');

SELECT * FROM finish();
ROLLBACK;
