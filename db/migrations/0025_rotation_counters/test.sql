-- 0025_rotation_counters — tests.
--
-- The one property that matters is MONOTONICITY, because the failure it prevents is invisible: a
-- counter that moves backwards re-issues a block of tickets that were already handed out, and the
-- symptom is a rotation that is quietly no longer even. Nothing raises, nothing logs.
--
-- The rest is posture: every reader and writer goes through a definer function, so `runtime_writer`
-- keeps a capability surface of FUNCTION SIGNATURES (ADR-009 risk R3) rather than gaining a table.

BEGIN;
SELECT plan(16);

GRANT USAGE ON SCHEMA public TO authoring, runtime_writer, analytics_reader, runtime_rpc_owner;

SELECT set_config('rs.ids', ops.test_seed_two_orgs()::text, true);
CREATE FUNCTION pg_temp.tid(k text) RETURNS text LANGUAGE sql STABLE AS
$$ SELECT current_setting('rs.ids', true)::jsonb ->> k $$;

SELECT set_config('rs.ver', pg_temp.tid('ver_a_frozen'), true);

/* ---------------------------------------------------------------- *
 * Structure and posture
 * ---------------------------------------------------------------- */

SELECT has_table('runtime', 'rotation_counters', 'runtime.rotation_counters exists');
SELECT has_function('runtime', 'flush_rotation_counters', 'the write-behind flush exists');
SELECT has_function('runtime', 'rotation_seed_from_db', 'and the rebuild read');

SELECT ok(
  (SELECT relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'runtime' AND c.relname = 'rotation_counters'),
  'RLS is FORCED');

-- ADR-009 risk R3: runtime_writer's whole surface is function signatures.
SELECT ok(
  NOT has_table_privilege('runtime_writer', 'runtime.rotation_counters', 'SELECT')
  AND NOT has_table_privilege('runtime_writer', 'runtime.rotation_counters', 'INSERT'),
  'runtime_writer holds NO privilege on the table — every path is a definer function, which is the '
  'posture 0011''s standing assertion enforces and that 0020 had to learn by having an INSERT grant '
  'refused');
SELECT ok(
  has_function_privilege('runtime_writer', 'runtime.flush_rotation_counters(jsonb)', 'EXECUTE'),
  'but it can execute the flush');
SELECT ok(
  NOT has_function_privilege('public', 'runtime.flush_rotation_counters(jsonb)', 'EXECUTE'),
  'and PUBLIC cannot (0006''s standing rule)');

-- B §2, structurally.
SELECT ok(
  pg_get_function_arguments(
    (SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'runtime' AND p.proname = 'flush_rotation_counters')) NOT LIKE '%org%',
  'the flush takes NO org parameter — each row carries its own version id (B §2)');

/* ---------------------------------------------------------------- *
 * Monotonicity — the property whose failure is silent
 * ---------------------------------------------------------------- */

SELECT is(
  runtime.flush_rotation_counters(
    format('[{"v":%s,"k":"q1.options","i":40}]', to_jsonb(current_setting('rs.ver')))::jsonb),
  1, 'a first flush inserts');
SELECT is(
  (SELECT issued FROM runtime.rotation_counters WHERE counter_key = 'q1.options'), 40::bigint,
  'with the issued count');

-- A LATER batch advances it.
SELECT runtime.flush_rotation_counters(
  format('[{"v":%s,"k":"q1.options","i":95}]', to_jsonb(current_setting('rs.ver')))::jsonb);
SELECT is(
  (SELECT issued FROM runtime.rotation_counters WHERE counter_key = 'q1.options'), 95::bigint,
  'a later batch advances the counter');

-- THE HEADLINE: a STALE batch must not move it backwards.
SELECT runtime.flush_rotation_counters(
  format('[{"v":%s,"k":"q1.options","i":12}]', to_jsonb(current_setting('rs.ver')))::jsonb);
SELECT is(
  (SELECT issued FROM runtime.rotation_counters WHERE counter_key = 'q1.options'), 95::bigint,
  'a STALE batch does NOT move the counter backwards. GREATEST rather than assignment, because an '
  'overwrite would re-issue a block of tickets already handed out — and the symptom is a rotation '
  'that is quietly no longer even, with nothing raised and nothing logged. 0016 needed a '
  'redis_epoch to guard the same hazard; a monotonic counter needs none because the value IS the '
  'epoch');

-- Replaying the same batch is a no-op, which is what makes the drain safe to retry.
SELECT runtime.flush_rotation_counters(
  format('[{"v":%s,"k":"q1.options","i":95}]', to_jsonb(current_setting('rs.ver')))::jsonb);
SELECT is(
  (SELECT issued FROM runtime.rotation_counters WHERE counter_key = 'q1.options'), 95::bigint,
  'and replaying the same batch changes nothing — idempotent, so a drain retry is free');

/* ---------------------------------------------------------------- *
 * Shape and the rebuild read
 * ---------------------------------------------------------------- */

SELECT throws_ok(
  $$ SELECT runtime.flush_rotation_counters('{"not":"an array"}'::jsonb) $$,
  '22023', NULL, 'a non-array payload is refused by name rather than silently flushing nothing');

SELECT throws_ok(
  format($ins$INSERT INTO runtime.rotation_counters (survey_version_id, counter_key, issued)
         VALUES (%L, 'x', -1)$ins$, current_setting('rs.ver')),
  '23514', NULL, 'a negative issued count is unstorable');

SELECT is(
  (SELECT issued FROM runtime.rotation_seed_from_db(current_setting('rs.ver')::app.ulid)
    WHERE counter_key = 'q1.options'),
  95::bigint,
  'the rebuild read returns the RECORDED value, not that plus a safety margin — a margin would '
  'skip tickets, and a rotation with gaps is no longer even');

SELECT * FROM finish();
ROLLBACK;
