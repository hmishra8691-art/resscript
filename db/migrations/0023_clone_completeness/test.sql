-- 0023_clone_completeness — tests.
--
-- Two things, and the second is what stops this recurring.
--
--   1. THE SIX TABLES SURVIVE A CLONE. Seeded with real quota, code-asset and theme rows, cloned,
--      and counted on the other side. Before this migration every one of those counts was zero and
--      nothing said so — `content.clone_version` enumerates its tables by name, and ADR-002 makes
--      cloning the only way to edit a published survey, so "publish, then click Edit" produced a
--      draft with no sample plan, no scripts and no theme.
--
--   2. `ops.content_tables_not_cloned()` IS EMPTY. Catalog-driven, so a seventh table added without
--      a clone branch fails here whoever adds it. The count map in 0007/0008 already caught a
--      MIS-cloned table; it could never catch a FORGOTTEN one, because a map that gains no key
--      still equals the old expectation. That is the exact hole three migrations fell through.

BEGIN;
SELECT plan(18);

GRANT USAGE ON SCHEMA public TO authoring, runtime_writer, analytics_reader, runtime_rpc_owner;

-- `test_seed_content` rather than `test_seed_two_orgs` alone, because it provides
-- `ver_a_clone_target`: app.survey_versions has a `sv_one_draft` unique constraint, so a test
-- cannot simply mint a second draft for the same survey to clone into. That constraint is the
-- reason the seed carries a dedicated target at all.
-- Seeded in two steps, and BOTH maps merged, for two reasons each of which cost a run:
--
--   * `test_seed_content` returns only its OWN keys, not its argument's, so `->> 'org_a'` on its
--     result is NULL — which reaches an app.ulid cast as a domain violation rather than as a
--     readable "missing key".
--   * `test_seed_two_orgs()` INSERTS, so calling it twice inside one expression to merge the two
--     maps duplicates the organizations. It is called once and its result carried forward.
SELECT set_config('rs.orgs', ops.test_seed_two_orgs()::text, true);
SELECT set_config('rs.ids',
  (current_setting('rs.orgs')::jsonb
     || ops.test_seed_content(current_setting('rs.orgs')::jsonb))::text, true);
CREATE FUNCTION pg_temp.tid(k text) RETURNS text LANGUAGE sql STABLE AS
$$ SELECT current_setting('rs.ids', true)::jsonb ->> k $$;

CREATE FUNCTION pg_temp.act_as(p_user uuid, p_org text, p_role text DEFAULT 'authoring')
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', p_user, 'role', p_role,
                      'app_metadata', json_build_object('active_org_id', p_org))::text, true);
  EXECUTE format('SET LOCAL ROLE %I', p_role);
END $$;

-- 0016's 'V' terminator: zero-padding alone is not injective.
CREATE FUNCTION pg_temp.cid(p_prefix text, p_tag text) RETURNS app.ulid LANGUAGE sql IMMUTABLE AS
$$ SELECT (p_prefix || '_0' || rpad(translate(upper(p_tag), 'ILOU', '110V') || 'V', 25, '0'))::app.ulid $$;

/* ---------------------------------------------------------------- *
 * 1. The catalog check
 * ---------------------------------------------------------------- */

SELECT has_function('ops', 'content_tables_not_cloned',
  'ops.content_tables_not_cloned() exists');

SELECT is_empty($$ SELECT table_name FROM ops.content_tables_not_cloned() $$,
  'EVERY version-scoped content table is copied by content.clone_version. This is the assertion '
  'the count map in 0007/0008 could not make: an equality on that map catches a MIS-cloned table '
  'and never a FORGOTTEN one, because a map that gains no key still equals the old expectation — '
  'which is how 0016, 0019 and 0021 each added a table that was silently dropped on every clone');

-- The check must be able to FAIL, or it is decoration. Proven by asking it about a table it
-- cannot know: a temporary content table with a survey_version_id and no clone branch.
CREATE TABLE content.fixture_uncloned (survey_version_id app.ulid NOT NULL, x integer);
SELECT is(
  (SELECT count(*)::int FROM ops.content_tables_not_cloned()
    WHERE table_name = 'content.fixture_uncloned'), 1,
  'and the check FAILS for a version-scoped table with no clone branch — asserted because a '
  'catalog check that cannot report anything is worse than none: it reads as protection');
DROP TABLE content.fixture_uncloned;

SELECT is(
  (SELECT count(*)::int FROM ops.content_tables_not_cloned()), 0,
  'clean again once it is gone');

-- content.reserved_variable_names has no survey_version_id, so it is a registry and correctly not
-- cloned. Pinned so a future reader does not "fix" it.
SELECT is_empty($$
  SELECT table_name FROM ops.content_tables_not_cloned()
   WHERE table_name = 'content.reserved_variable_names'
$$, 'a content table with NO survey_version_id is a registry and is correctly not cloned — the '
   'check keys on the column, not on a name list');

SELECT ok(
  NOT has_function_privilege('public', 'ops.content_tables_not_cloned()', 'EXECUTE'),
  'not executable by PUBLIC (0006''s standing rule)');
-- And NOT by authoring either. The first version of this migration granted it and three standing
-- assertions — in 0003, 0006 and 0010 — refused: "authoring holds EXECUTE on NO function in schema
-- ops". A CI check has no caller in the authoring plane.
SELECT ok(
  NOT has_function_privilege('authoring', 'ops.content_tables_not_cloned()', 'EXECUTE'),
  'and not by authoring — the plane boundary was not widened for a CI check');

/* ---------------------------------------------------------------- *
 * 2. The six tables actually survive a clone
 * ---------------------------------------------------------------- */

SELECT has_function('content', 'clone_version_core',
  '0008''s body moved to content.clone_version_core, so the eight working branches were not '
  'retyped to add six');

-- Seeded as superuser onto org A's DRAFT: the point here is the clone, and re-proving that each
-- table accepts an insert is 0016/0019/0021's job.
RESET ROLE;
SELECT set_config('rs.src', pg_temp.tid('ver_a_content_draft'), true);
SELECT set_config('rs.org', pg_temp.tid('org_a'), true);

INSERT INTO content.variables
  (survey_version_id, id, org_id, name, kind, vtype, export_column, sort_key)
VALUES (current_setting('rs.src')::app.ulid, pg_temp.cid('var', 'gen'),
        current_setting('rs.org')::app.ulid, 'QCLONE', 'hidden', 'number', 'QCLONE', 900);

INSERT INTO content.quota_dimensions
  (survey_version_id, id, org_id, ref, variable_id, sort_key)
VALUES (current_setting('rs.src')::app.ulid, pg_temp.cid('qd', 'gen'),
        current_setting('rs.org')::app.ulid, 'GENDER', pg_temp.cid('var', 'gen'), 1);

INSERT INTO content.quota_buckets
  (survey_version_id, id, org_id, dimension_id, ref, match, sort_key)
VALUES (current_setting('rs.src')::app.ulid, pg_temp.cid('qb', 'm'),
        current_setting('rs.org')::app.ulid, pg_temp.cid('qd', 'gen'), 'M', '{}'::jsonb, 1);

INSERT INTO content.quota_plans
  (survey_version_id, id, org_id, ref, plan_type, dimension_ids, count_at, reservation_ttl_s,
   on_store_unavailable, counter_scope, overflow, sort_key)
VALUES (current_setting('rs.src')::app.ulid, pg_temp.cid('qp', 'main'),
        current_setting('rs.org')::app.ulid, 'MAIN', 'marginal',
        ARRAY[pg_temp.cid('qd', 'gen')], 'reservation', 5400, 'fail_closed', 'survey',
        'SCREENOUT', 1);

INSERT INTO content.quota_cells
  (survey_version_id, id, org_id, plan_id, cell_key, target, mode)
VALUES (current_setting('rs.src')::app.ulid, pg_temp.cid('qc', 'm'),
        current_setting('rs.org')::app.ulid, pg_temp.cid('qp', 'main'), ARRAY['M'], 100, 'hard');

INSERT INTO content.code_assets
  (id, survey_version_id, org_id, kind, ref, source, runs_on, scope, hooks)
VALUES (pg_temp.cid('ast', 's1'), current_setting('rs.src')::app.ulid,
        current_setting('rs.org')::app.ulid, 'script', 'S_A', 'survey.log("x");', 'client',
        'survey', ARRAY['onPageLoad']);

INSERT INTO content.version_theme
  (survey_version_id, org_id, theme_id, theme_name, tokens_snapshot, compiled_css_sha256)
VALUES (current_setting('rs.src')::app.ulid, current_setting('rs.org')::app.ulid, NULL, 'Base',
        '{"color-brand":"#123456"}'::jsonb, repeat('ab', 32));

-- A fresh empty draft to clone into.
SELECT set_config('rs.counts',
  content.clone_version(current_setting('rs.src')::app.ulid, pg_temp.tid('ver_a_clone_target')::app.ulid)::text,
  true);

-- The count map reports each of the six.
SELECT is((current_setting('rs.counts')::jsonb ->> 'quota_dimensions'), '1',
  'the clone reports quota_dimensions — zero and silent before 0023');
SELECT is((current_setting('rs.counts')::jsonb ->> 'quota_buckets'), '1',
  'and quota_buckets');
SELECT is((current_setting('rs.counts')::jsonb ->> 'quota_plans'), '1',
  'and quota_plans');
SELECT is((current_setting('rs.counts')::jsonb ->> 'quota_cells'), '1',
  'and quota_cells — a draft cloned without these has no sample plan at all');
SELECT is((current_setting('rs.counts')::jsonb ->> 'code_assets'), '1',
  'and code_assets — a draft cloned without these has lost the author''s scripts');
SELECT is((current_setting('rs.counts')::jsonb ->> 'version_theme'), '1',
  'and version_theme — a draft cloned without it renders as the platform default, so the client '
  'sees their branding vanish on the edit they asked for');

-- And the rows are really there, not merely counted.
SELECT is(
  (SELECT count(*)::int FROM content.quota_cells
    WHERE survey_version_id = pg_temp.tid('ver_a_clone_target')::app.ulid), 1,
  'the quota cell exists in the clone');
SELECT is(
  (SELECT target FROM content.quota_cells WHERE survey_version_id = pg_temp.tid('ver_a_clone_target')::app.ulid),
  100, 'with its target intact');

-- sha256 is GENERATED ALWAYS, so it is recomputed rather than copied — which is the point of
-- generating it, and a clone whose hash disagreed with its own source would be a CSP that blocks
-- the script it was meant to allow.
SELECT is(
  (SELECT sha256 FROM content.code_assets WHERE survey_version_id = pg_temp.tid('ver_a_clone_target')::app.ulid),
  content.source_sha256('survey.log("x");'),
  'the code asset''s GENERATED sha256 is recomputed in the clone and matches its source');

-- The theme snapshot is COPIED, not re-resolved. 0021's header: re-resolving consults a parent
-- theme that may have changed, which answers a different question than the one that was approved.
SELECT is(
  (SELECT tokens_snapshot->>'color-brand' FROM content.version_theme
    WHERE survey_version_id = pg_temp.tid('ver_a_clone_target')::app.ulid),
  '#123456',
  'the theme SNAPSHOT is copied rather than re-resolved — a clone starts life looking exactly '
  'like what it was cloned from');

SELECT * FROM finish();
ROLLBACK;
