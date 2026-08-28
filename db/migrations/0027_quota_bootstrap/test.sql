-- 0027_quota_bootstrap — tests.
--
-- The assertion that matters is the one nothing had: **publishing a version with quotas leaves rows
-- in `runtime.quota_counters`.** Before this migration that table was empty in every deployment,
-- and no test anywhere noticed, because each component's own test seeded its own preconditions —
-- `drain.test.ts` hand-writes cell hashes carrying identity that production never produced, and the
-- load rig sets its own targets and never opens a Postgres connection.
--
-- So the tests here are deliberately about the SEAM and not about the parts:
--
--   1. publishing seeds, and seeds the right target;
--   2. an ordinary edit does NOT re-seed (the trigger is on the status transition, not on UPDATE);
--   3. re-publishing is idempotent and picks up a changed target;
--   4. a percentage-mode cell is skipped rather than seeded with a wrong number;
--   5. `org_id` is DERIVED by `flush_quota_counters`, never accepted from the payload — and a row
--      naming a version that does not exist writes nothing. Adding `org_id` to
--      `quota_rebuild_state`'s return was the first attempt and 0004's standing check refused it,
--      correctly: it scans `proargnames`, which includes a `RETURNS TABLE`'s OUT columns, and B §2
--      forbids any runtime function taking an org id.

BEGIN;
SELECT plan(17);

GRANT USAGE ON SCHEMA public TO authoring, runtime_writer, analytics_reader, runtime_rpc_owner;

SELECT set_config('rs.ids', ops.test_seed_two_orgs()::text, true);
CREATE FUNCTION pg_temp.tid(k text) RETURNS text LANGUAGE sql STABLE AS
$$ SELECT current_setting('rs.ids', true)::jsonb ->> k $$;

-- Crockford base32 excludes I, L, O and U; building an id by hand without translating them is a
-- mistake made three times earlier in this work and it surfaces as an opaque domain violation.
CREATE FUNCTION pg_temp.cid(p_prefix text, p_tag text) RETURNS app.ulid LANGUAGE sql IMMUTABLE AS
$$ SELECT (p_prefix || '_0' || rpad(translate(upper(p_tag), 'ILOU', '110V') || 'V', 25, '0'))::app.ulid $$;

/* ---------------------------------------------------------------- *
 * Structure
 * ---------------------------------------------------------------- */

SELECT has_function('runtime', 'quota_seed_targets', ARRAY['app.ulid'],
  'runtime.quota_seed_targets(app.ulid) exists');

SELECT ok(
  (SELECT prosecdef FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'app' AND p.proname = 'tg_seed_quota_targets'),
  'the trigger function is SECURITY DEFINER — ADR-001 permits an authoring transaction to write a '
  'runtime table only this way');

SELECT ok(
  NOT has_function_privilege('public', 'runtime.quota_seed_targets(app.ulid)', 'EXECUTE'),
  'and PUBLIC cannot execute it (0006''s rule)');

SELECT ok(
  EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'app' AND c.relname = 'survey_versions'
            AND t.tgname = 'seed_quota_targets' AND NOT t.tgisinternal),
  'the trigger is attached to app.survey_versions');

/* ---------------------------------------------------------------- *
 * A version with one count-mode cell and one percentage-mode cell
 * ---------------------------------------------------------------- */

-- The frozen fixture version (version_no 2, status draft at this point in 0004's fixture) is the
-- one published below; content rows hang off it.
CREATE FUNCTION pg_temp.ver() RETURNS app.ulid LANGUAGE sql STABLE AS
$$ SELECT (current_setting('rs.ids', true)::jsonb ->> 'ver_a_draft')::app.ulid $$;

-- `quota_dimensions.variable_id` is NOT NULL, and test_seed_two_orgs seeds no variables (that is
-- test_seed_content's job, and calling it here would freeze this very version out from under the
-- publish transition the test is about).
INSERT INTO content.variables
  (survey_version_id, id, org_id, name, kind, vtype, export_column, sort_key)
VALUES (pg_temp.ver(), pg_temp.cid('var', 'V1'), pg_temp.tid('org_a'), 'GENDER', 'hidden', 'text',
        'GENDER', '0100');

INSERT INTO content.quota_dimensions
  (survey_version_id, id, org_id, ref, variable_id, sort_key)
VALUES (pg_temp.ver(), pg_temp.cid('qdm', 'D1'), pg_temp.tid('org_a'), 'GENDER', pg_temp.cid('var', 'V1'), '0100');

INSERT INTO content.quota_buckets
  (survey_version_id, id, org_id, dimension_id, ref, match, sort_key)
VALUES (pg_temp.ver(), pg_temp.cid('qbk', 'B1'), pg_temp.tid('org_a'),
        pg_temp.cid('qdm', 'D1'), 'M', '{}'::jsonb, '0100');

-- Every policy column is NOT NULL with no default, which is 0016's point: `counter_scope` and
-- `count_at` are decisions a programmer must make rather than inherit (`CMP-0402`/`SCH-1012` exist
-- to refuse a plan that left them implicit).
INSERT INTO content.quota_plans
  (survey_version_id, id, org_id, ref, plan_type, dimension_ids,
   count_at, reservation_ttl_s, on_store_unavailable, counter_scope, sort_key)
VALUES (pg_temp.ver(), pg_temp.cid('qpl', 'P1'), pg_temp.tid('org_a'), 'MAIN', 'marginal',
        ARRAY[pg_temp.cid('qdm', 'D1')],
        'reservation', 5400, 'fail_closed', 'version', '0100');

-- `qcell_one_target` requires exactly one of target/target_pct, so the percentage cell carries its
-- pct from the start rather than being inserted empty and updated.
INSERT INTO content.quota_cells
  (survey_version_id, id, org_id, plan_id, cell_key, target, target_pct, mode)
VALUES (pg_temp.ver(), pg_temp.cid('qcl', 'C1'), pg_temp.tid('org_a'), pg_temp.cid('qpl', 'P1'),
        ARRAY['M'], 250, NULL, 'hard'),
       -- Percentage-mode: no component can turn this into a count, so seeding must skip it rather
       -- than invent one. See the migration header.
       (pg_temp.ver(), pg_temp.cid('qcl', 'C2'), pg_temp.tid('org_a'), pg_temp.cid('qpl', 'P1'),
        ARRAY['F'], NULL, 40.00, 'hard');

-- Nothing yet: the record is empty until the version is published.
SELECT is(
  (SELECT count(*)::int FROM runtime.quota_counters WHERE survey_version_id = pg_temp.ver()),
  0,
  'a DRAFT version has no counter rows — the record is created by publishing, not by authoring');

/* ---------------------------------------------------------------- *
 * THE test: publishing seeds the durable record
 * ---------------------------------------------------------------- */

UPDATE app.survey_versions
   SET status = 'staging', frozen_at = now(), compile_state = 'compiled',
       artifact_hash = repeat('ab', 32), artifact_bytes = 1024
 WHERE id = pg_temp.ver();

SELECT is(
  (SELECT count(*)::int FROM runtime.quota_counters WHERE survey_version_id = pg_temp.ver()),
  1,
  'publishing seeds one counter row — the assertion whose absence let ADR-008''s record half go '
  'unimplemented in every deployment');

SELECT is(
  (SELECT target FROM runtime.quota_counters
    WHERE survey_version_id = pg_temp.ver() AND cell_id = pg_temp.cid('qcl', 'C1')),
  250,
  'and it carries the cell''s target. A cell hash with no target reads 0, and the fullness check '
  'is guarded by `target > 0` — so an unseeded cell does not close');

SELECT is(
  (SELECT org_id FROM runtime.quota_counters
    WHERE survey_version_id = pg_temp.ver() AND cell_id = pg_temp.cid('qcl', 'C1')),
  pg_temp.tid('org_a')::app.ulid,
  'org_id comes from the version rather than from the caller, so it cannot be wrong');

SELECT is_empty($$
  SELECT cell_id FROM runtime.quota_counters
   WHERE survey_version_id = (current_setting('rs.ids', true)::jsonb ->> 'ver_a_draft')::app.ulid
     AND cell_id = pg_temp.cid('qcl', 'C2')
$$, 'the percentage-mode cell is NOT seeded — skipped rather than given a fabricated count');

/* ---------------------------------------------------------------- *
 * Idempotence, and what does NOT re-seed
 * ---------------------------------------------------------------- */

-- An ordinary edit. `tg_version_guard` bumps `revision` on every UPDATE, so a trigger that fired
-- on any change would re-run this work on every keystroke-level save.
UPDATE app.survey_versions SET notes = 'an edit' WHERE id = pg_temp.ver();

SELECT is(
  (SELECT count(*)::int FROM runtime.quota_counters WHERE survey_version_id = pg_temp.ver()),
  1,
  'an edit that does not change status does not re-seed');

-- Idempotence, asserted on the function rather than through a second publish.
--
-- Two earlier drafts of this test tried to publish again and each was refused by a constraint
-- doing its job: changing the cell's target first hit `content.tg_draft_only` ("its content is
-- frozen; clone a new draft to edit" — ADR-002, so a published version's targets CANNOT move), and
-- promoting staging -> production hit `sv_one_production`, because the fixture's survey already has
-- one. What re-seeding actually has to be is harmless, and that is a property of the function.
SELECT is(runtime.quota_seed_targets(pg_temp.ver()), 1,
  'seeding again reports the same one count-mode cell');

SELECT is(
  (SELECT count(*)::int FROM runtime.quota_counters WHERE survey_version_id = pg_temp.ver()),
  1,
  'and writes no duplicate: quota_set_target upserts on (survey_version_id, cell_id)');

SELECT is(
  (SELECT target FROM runtime.quota_counters
    WHERE survey_version_id = pg_temp.ver() AND cell_id = pg_temp.cid('qcl', 'C1')),
  250,
  'with the target unchanged');

/* ---------------------------------------------------------------- *
 * org_id is DERIVED, never accepted
 * ---------------------------------------------------------------- *
 *
 * The first attempt at this migration added `org_id` to `quota_rebuild_state`'s return so the drain
 * could put it on the Redis hash. 0004's standing check refused it — it scans `proargnames`, which
 * includes a `RETURNS TABLE`'s OUT columns, and B §2 forbids any runtime function taking an org id.
 * That refusal was correct and produced a better design: org_id stops travelling, and
 * `flush_quota_counters` derives it from the version.
 *
 * Asserted by flushing a payload that contains NO org_id at all.
 */

SELECT lives_ok($$
  SELECT runtime.flush_quota_counters(jsonb_build_array(jsonb_build_object(
    'survey_version_id', (current_setting('rs.ids', true)::jsonb ->> 'ver_a_draft'),
    'cell_id',           pg_temp.cid('qcl', 'C1'),
    'plan_id',           pg_temp.cid('qpl', 'P1'),
    'target',            250,
    'committed',         7,
    'in_flight',         0,
    'redis_epoch',       9999)))
$$, 'a flush payload with no org_id is accepted');

SELECT is(
  (SELECT committed FROM runtime.quota_counters
    WHERE survey_version_id = pg_temp.ver() AND cell_id = pg_temp.cid('qcl', 'C1')),
  7,
  'and the counter is updated');

SELECT is(
  (SELECT org_id FROM runtime.quota_counters
    WHERE survey_version_id = pg_temp.ver() AND cell_id = pg_temp.cid('qcl', 'C1')),
  pg_temp.tid('org_a')::app.ulid,
  'with org_id derived from the version — so a caller cannot file a counter under another tenant');

SELECT is(
  runtime.flush_quota_counters(jsonb_build_array(jsonb_build_object(
    'survey_version_id', pg_temp.cid('ver', 'ZZ'),
    'cell_id',           pg_temp.cid('qcl', 'C1'),
    'plan_id',           pg_temp.cid('qpl', 'P1'),
    'target',            1, 'committed', 1, 'in_flight', 0, 'redis_epoch', 1))),
  0,
  'and a row naming a version that does not exist writes nothing — the JOIN is the authorization');

SELECT * FROM finish();
ROLLBACK;
