-- 0022_adaptive_ttl — tests.
--
-- What matters here is that the measurement is ROBUST, because a TTL derived from a bad median has
-- two bad failure modes and both are live today: too short and a slow respondent's reservation
-- vanishes and the cell overfills; too long and abandons hold cells for hours.
--
--   * the MEDIAN, not the mean — a respondent who left the tab open over lunch must not move it;
--   * TEST sessions excluded — a programmer clicking through in 40 seconds must not pull it down
--     and expire real respondents mid-survey;
--   * other versions' and other orgs' sessions excluded;
--   * the COUNT returned alongside, so the >= 50 policy lives in the runtime rather than here.

BEGIN;
SELECT plan(12);

GRANT USAGE ON SCHEMA public TO authoring, runtime_writer, analytics_reader, runtime_rpc_owner;

SELECT set_config('rs.ids', ops.test_seed_two_orgs()::text, true);
CREATE FUNCTION pg_temp.tid(k text) RETURNS text LANGUAGE sql STABLE AS
$$ SELECT current_setting('rs.ids', true)::jsonb ->> k $$;

CREATE FUNCTION pg_temp.sid(p_tag text) RETURNS app.ulid LANGUAGE sql IMMUTABLE AS
$$ SELECT ('ses_0' || rpad(translate(upper(p_tag), 'ILOU', '110V') || 'V', 25, '0'))::app.ulid $$;

-- Sessions seeded directly as superuser: the point of this file is the measurement, and re-proving
-- that runtime.start_session works is 0011's job.
CREATE FUNCTION pg_temp.seed_session(
  p_tag text, p_version text, p_duration integer, p_disposition text, p_test boolean
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO runtime.sessions
    (id, survey_version_id, org_id, is_test, status, disposition, random_seed, artifact_hash,
     language, duration_s, finished_at)
  SELECT pg_temp.sid(p_tag), v.id, v.org_id, p_test,
         CASE WHEN p_disposition = 'COMPLETE' THEN 'completed' ELSE 'terminated' END::runtime.session_status,
         p_disposition::runtime.disposition, repeat('deadbeef', 4), v.artifact_hash,
         'en', p_duration, now()
    FROM app.survey_versions v WHERE v.id = p_version::app.ulid;
END $$;

/* ---------------------------------------------------------------- *
 * Structure
 * ---------------------------------------------------------------- */

SELECT has_function('runtime', 'measured_loi', 'runtime.measured_loi exists');
SELECT has_index('runtime', 'sessions', 'sessions_loi_idx',
  'and its access path is indexed, partially');
SELECT ok(
  NOT has_function_privilege('public', 'runtime.measured_loi(app.ulid)', 'EXECUTE'),
  'not executable by PUBLIC (0006''s standing rule)');
SELECT ok(
  has_function_privilege('runtime_writer', 'runtime.measured_loi(app.ulid)', 'EXECUTE'),
  'the runtime can read it — one more function signature, not a table grant (ADR-009)');

-- B §2, asserted structurally: this is the check that caught a real cross-tenant write vector in
-- 0017, where every quota function had taken a p_org_id.
SELECT ok(
  pg_get_function_arguments(
    (SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'runtime' AND p.proname = 'measured_loi')) NOT LIKE '%org%',
  'it takes NO org parameter — the version id is the only key');

/* ---------------------------------------------------------------- *
 * The measurement
 * ---------------------------------------------------------------- */

SELECT is((SELECT completes FROM runtime.measured_loi(pg_temp.tid('ver_a_frozen')::app.ulid)), 0,
  'no completes yet');
SELECT ok(
  (SELECT median_s IS NULL FROM runtime.measured_loi(pg_temp.tid('ver_a_frozen')::app.ulid)),
  'and the median is NULL, not zero — "nothing measured" and "measured zero" are different facts, '
  'and a caller that saw 0 would compute a TTL of 0');

SELECT pg_temp.seed_session('c1', pg_temp.tid('ver_a_frozen'), 600, 'COMPLETE', false);
SELECT pg_temp.seed_session('c2', pg_temp.tid('ver_a_frozen'), 900, 'COMPLETE', false);
SELECT pg_temp.seed_session('c3', pg_temp.tid('ver_a_frozen'), 1200, 'COMPLETE', false);

SELECT is((SELECT completes FROM runtime.measured_loi(pg_temp.tid('ver_a_frozen')::app.ulid)), 3,
  'three completes');
SELECT is((SELECT median_s FROM runtime.measured_loi(pg_temp.tid('ver_a_frozen')::app.ulid)), 900,
  'and the median of 600/900/1200 is 900');

-- THE HEADLINE: an idle browser must not move it.
SELECT pg_temp.seed_session('lunch', pg_temp.tid('ver_a_frozen'), 14400, 'COMPLETE', false);
SELECT is((SELECT median_s FROM runtime.measured_loi(pg_temp.tid('ver_a_frozen')::app.ulid)), 1050,
  'a four-hour outlier moves the MEDIAN of four values to 1050 — where the MEAN would be 4275, '
  'setting a TTL that covers an idle browser rather than a slow respondent');

-- A programmer's test run must not pull it down.
SELECT pg_temp.seed_session('t1', pg_temp.tid('ver_a_frozen'), 40, 'COMPLETE', true);
SELECT pg_temp.seed_session('t2', pg_temp.tid('ver_a_frozen'), 45, 'COMPLETE', true);
SELECT is((SELECT median_s FROM runtime.measured_loi(pg_temp.tid('ver_a_frozen')::app.ulid)), 1050,
  'test sessions are excluded — ten 40-second setup runs would otherwise set a TTL that expires '
  'real respondents'' reservations mid-survey');

-- A screenout is not a completion time.
SELECT pg_temp.seed_session('s1', pg_temp.tid('ver_a_frozen'), 30, 'SCREENOUT', false);
SELECT is((SELECT completes FROM runtime.measured_loi(pg_temp.tid('ver_a_frozen')::app.ulid)), 4,
  'a SCREENOUT is not counted: somebody who left after two questions took no time to finish, and '
  'a screener-heavy survey would otherwise measure its screenouts');

SELECT * FROM finish();
ROLLBACK;
