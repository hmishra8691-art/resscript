-- 0013_field_stats/test.sql — pgTAP. The field dashboard's counter.
--
-- What this file has to prove:
--   * app.field_stats exists, is SECURITY DEFINER (the only legal bridge into schema
--     runtime, ADR-001), and counts one version's sessions grouped by disposition;
--   * is_test rows are EXCLUDED by default and included only by flag — the P1-11 acceptance
--     line ("excluded from the default response count shown in studio"), asserted on the
--     grouped count so a filter that dropped the wrong axis cannot pass;
--   * a session still in flight (disposition IS NULL) is returned as IN_PROGRESS — K §2's
--     name for the state — so the studio never renders "null";
--   * the floor is analyst, checked FIRST and by name (42501), and another org's version is
--     P0002 — indistinguishable from a version that never existed (0004's oracle rule);
--   * posture: authoring holds EXECUTE, the runtime and analytics planes do not.
BEGIN;
SELECT plan(14);

GRANT USAGE ON SCHEMA public TO authoring, runtime_writer, analytics_reader, runtime_rpc_owner;

SELECT set_config('rs.ids', ops.test_seed_two_orgs()::text, true);
CREATE FUNCTION pg_temp.tid(k text) RETURNS text LANGUAGE sql STABLE AS
$$ SELECT current_setting('rs.ids', true)::jsonb ->> k $$;

-- Impersonate a caller exactly as PostgREST does (0004's helper): claims GUC + SET LOCAL
-- ROLE. Anything that passes this is reachable by a real HTTP caller.
CREATE FUNCTION pg_temp.act_as(p_user uuid, p_org text, p_role text DEFAULT 'authoring')
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', p_user, 'role', p_role,
                      'app_metadata', json_build_object('active_org_id', p_org))::text,
    true);
  EXECUTE format('SET LOCAL ROLE %I', p_role);
END $$;

-- Crockford-safe tags only (no i/l/o/u): the app.ulid domain rejects those characters.
CREATE FUNCTION pg_temp.sid(p_tag text) RETURNS app.ulid LANGUAGE sql IMMUTABLE AS
$$ SELECT ('ses_0' || rpad(upper(p_tag), 25, '0'))::app.ulid $$;

-- ---------------------------------------------------------------------------
-- 1. Structure
-- ---------------------------------------------------------------------------
SELECT has_function('app', 'field_stats', ARRAY['app.ulid', 'boolean'],
  'app.field_stats(version, include_test) exists');
SELECT ok((SELECT p.prosecdef FROM pg_proc p
            WHERE p.oid = 'app.field_stats(app.ulid, boolean)'::regprocedure),
  'field_stats is SECURITY DEFINER — authoring has no other path into schema runtime '
  '(ADR-001), and the function re-checks the caller itself');

-- ---------------------------------------------------------------------------
-- 2. The counts, both axes of the is_test default
-- ---------------------------------------------------------------------------
-- Seeded as superuser: session rows are the runtime RPCs' job (0011, tested there). Five
-- sessions on org A's draft: two COMPLETE (one of them a TEST session), one SCREENOUT, one
-- QUOTA_FULL, one still in flight (disposition NULL). The draft version is used because
-- sessions carry no status-derived FK to versions — the read path is testable without
-- publish machinery, exactly as 0012's suite does for response_documents.
RESET ROLE;
INSERT INTO runtime.sessions
  (id, survey_version_id, org_id, is_test, status, disposition, random_seed, artifact_hash,
   language)
VALUES
  (pg_temp.sid('a1'), pg_temp.tid('ver_a_draft')::app.ulid, pg_temp.tid('org_a')::app.ulid,
   false, 'completed',  'COMPLETE',
   repeat('a', 32), repeat('0', 64), 'en'),
  (pg_temp.sid('a2'), pg_temp.tid('ver_a_draft')::app.ulid, pg_temp.tid('org_a')::app.ulid,
   true,  'completed',  'COMPLETE',
   repeat('b', 32), repeat('0', 64), 'en'),
  (pg_temp.sid('a3'), pg_temp.tid('ver_a_draft')::app.ulid, pg_temp.tid('org_a')::app.ulid,
   false, 'terminated', 'SCREENOUT',
   repeat('c', 32), repeat('0', 64), 'en'),
  (pg_temp.sid('a4'), pg_temp.tid('ver_a_draft')::app.ulid, pg_temp.tid('org_a')::app.ulid,
   false, 'terminated', 'QUOTA_FULL',
   repeat('d', 32), repeat('0', 64), 'en'),
  (pg_temp.sid('a5'), pg_temp.tid('ver_a_draft')::app.ulid, pg_temp.tid('org_a')::app.ulid,
   false, 'active',     NULL,
   repeat('e', 32), repeat('0', 64), 'en');

SELECT pg_temp.act_as(pg_temp.tid('user_a')::uuid, pg_temp.tid('org_a'));
SELECT is((SELECT sum(f.sessions) FROM app.field_stats(
             pg_temp.tid('ver_a_draft')::app.ulid) f),
  4::numeric, 'test sessions are EXCLUDED from the default count — the P1-11 acceptance line');
SELECT is((SELECT f.sessions FROM app.field_stats(
             pg_temp.tid('ver_a_draft')::app.ulid) f WHERE f.disposition = 'COMPLETE'),
  1::bigint, 'and the exclusion lands on the grouped row, not just the total');
SELECT is((SELECT f.sessions FROM app.field_stats(
             pg_temp.tid('ver_a_draft')::app.ulid, true) f WHERE f.disposition = 'COMPLETE'),
  2::bigint, 'include_test = true brings the test complete back');
SELECT is((SELECT sum(f.sessions) FROM app.field_stats(
             pg_temp.tid('ver_a_draft')::app.ulid, true) f),
  5::numeric, 'and the total agrees');
SELECT is((SELECT f.sessions FROM app.field_stats(
             pg_temp.tid('ver_a_draft')::app.ulid) f WHERE f.disposition = 'IN_PROGRESS'),
  1::bigint,
  'a session with no disposition yet is returned as IN_PROGRESS — K 2''s name, never null');
SELECT is((SELECT array_agg(f.disposition) FROM app.field_stats(
             pg_temp.tid('ver_a_draft')::app.ulid) f),
  ARRAY['COMPLETE', 'IN_PROGRESS', 'QUOTA_FULL', 'SCREENOUT'],
  'groups come back in disposition order — a stable render order for the table');

-- ---------------------------------------------------------------------------
-- 3. Floor and tenancy, each by its own error
-- ---------------------------------------------------------------------------
SELECT pg_temp.act_as(pg_temp.tid('user_a2')::uuid, pg_temp.tid('org_a'));
SELECT throws_ok(
  format('SELECT count(*) FROM app.field_stats(%L)', pg_temp.tid('ver_a_draft')),
  '42501', NULL, 'a reviewer cannot read field stats — floor first, by name (ANL+, 7.1)');

SELECT pg_temp.act_as(pg_temp.tid('user_b')::uuid, pg_temp.tid('org_b'));
SELECT throws_ok(
  format('SELECT count(*) FROM app.field_stats(%L)', pg_temp.tid('ver_a_draft')),
  'P0002', NULL,
  'another org''s version reads as NOT FOUND — indistinguishable from a version that '
  'never existed (0004''s existence-oracle rule)');
SELECT is((SELECT count(*) FROM app.field_stats(pg_temp.tid('ver_b_draft')::app.ulid)),
  0::bigint, 'org B counts its own (empty) version cleanly — zero rows, not an error');

-- ---------------------------------------------------------------------------
-- 4. Posture (ADR-001)
-- ---------------------------------------------------------------------------
RESET ROLE;
SELECT set_config('request.jwt.claims', '', true);
SELECT ok(has_function_privilege('authoring',
  'app.field_stats(app.ulid, boolean)', 'EXECUTE'),
  'authoring holds EXECUTE on field_stats — the studio''s dashboard read');
SELECT ok(NOT has_function_privilege('runtime_writer',
  'app.field_stats(app.ulid, boolean)', 'EXECUTE'),
  'runtime_writer does NOT — the respondent plane never reads the dashboard');
SELECT ok(NOT has_function_privilege('analytics_reader',
  'app.field_stats(app.ulid, boolean)', 'EXECUTE'),
  'analytics_reader does NOT — its plane is schema export (B 11), not app');

SELECT * FROM finish();
ROLLBACK;
