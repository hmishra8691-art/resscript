-- 0015_write_audit_event_authz/test.sql — pgTAP.
--
-- What this file has to prove:
--   * app.write_audit_event still exists with the same signature, is SECURITY DEFINER;
--   * `authoring` now holds EXECUTE — the grant 0004 never issued, and the reason every
--     create/update/delete route 500'd against a real (non-superuser) Postgres role;
--   * a member of an org can write an audit event FOR THAT ORG, and the row lands correctly;
--   * a member of org A cannot write an audit event claiming org B — the forgery this
--     migration's new guard exists to close — by name (42501), not silently;
--   * a caller with no membership anywhere cannot write an audit event for org A either.
BEGIN;
SELECT plan(7);

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

-- ---------------------------------------------------------------------------
-- 1. Structure and posture
-- ---------------------------------------------------------------------------
SELECT has_function('app', 'write_audit_event',
  ARRAY['app.ulid', 'text', 'text', 'uuid', 'text', 'app.ulid', 'app.ulid', 'app.ulid',
        'app.ulid', 'text', 'jsonb', 'text'],
  'app.write_audit_event(...) still exists with its original signature');
SELECT ok((SELECT p.prosecdef FROM pg_proc p
            WHERE p.oid = ('app.write_audit_event(app.ulid, text, text, uuid, text, app.ulid,'
              || ' app.ulid, app.ulid, app.ulid, text, jsonb, text)')::regprocedure),
  'write_audit_event is SECURITY DEFINER — app.audit_log has no INSERT policy at all');
SELECT ok(has_function_privilege('authoring',
  'app.write_audit_event(app.ulid, text, text, uuid, text, app.ulid, app.ulid, app.ulid,'
    || ' app.ulid, text, jsonb, text)', 'EXECUTE'),
  'authoring now holds EXECUTE — the grant 0004 never issued, so every audit-writing '
  'route 500''d against a real (non-superuser) Postgres role until this migration');

-- ---------------------------------------------------------------------------
-- 2. A member can write an audit event for THEIR OWN org
-- ---------------------------------------------------------------------------
SELECT pg_temp.act_as(pg_temp.tid('user_a')::uuid, pg_temp.tid('org_a'));
SELECT lives_ok(
  format('SELECT app.write_audit_event(%L, %L)', pg_temp.tid('org_a'), 'test.event'),
  'org A''s owner can write an audit event for org A — the overwhelmingly common case '
  '(every create/update/delete route in the API catalogue)');

RESET ROLE;
SELECT set_config('request.jwt.claims', '', true);
SELECT is((SELECT count(*)::int FROM app.audit_log
            WHERE org_id = pg_temp.tid('org_a')::app.ulid AND action = 'test.event'),
  1, 'and the row actually landed in app.audit_log, scoped to org A');

-- ---------------------------------------------------------------------------
-- 3. Nobody can forge an audit event for an org they do not belong to
-- ---------------------------------------------------------------------------
SELECT pg_temp.act_as(pg_temp.tid('user_a')::uuid, pg_temp.tid('org_a'));
SELECT throws_ok(
  format('SELECT app.write_audit_event(%L, %L)', pg_temp.tid('org_b'), 'forged.event'),
  '42501', NULL,
  'org A''s owner cannot claim to write an audit event for org B — the forgery this '
  'migration''s membership guard exists to close, named by error rather than silently '
  'accepted');

SELECT pg_temp.act_as(pg_temp.tid('user_c')::uuid, pg_temp.tid('org_a'));
SELECT throws_ok(
  format('SELECT app.write_audit_event(%L, %L)', pg_temp.tid('org_a'), 'forged.event2'),
  '42501', NULL,
  'a caller with no membership anywhere cannot write an audit event for org A either');

SELECT * FROM finish();
ROLLBACK;
