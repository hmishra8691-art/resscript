-- 0006_revoke_public_execute/test.sql — pgTAP.
--
-- The assertion this file exists for is one line: ops.functions_executable_by_public() is
-- empty. Everything else proves that line means something — that the assertion can fail,
-- that closing PUBLIC EXECUTE did not break the two things that depend on it (column
-- defaults and triggers), and that the roles which are supposed to reach a function still
-- can.
BEGIN;
SELECT plan(27);

-- ---------------------------------------------------------------------------
-- The assertion
-- ---------------------------------------------------------------------------
SELECT has_function('ops', 'functions_executable_by_public',
  'ops.functions_executable_by_public() exists');
SELECT is_empty($$ SELECT ops.functions_executable_by_public() $$,
  'no function in app/content/runtime/export/billing/ops is executable by PUBLIC');

-- It has to be able to fail, and it has to catch the proacl IS NULL case specifically —
-- that is the one that looks like an absence of grants rather than the presence of one,
-- and the one that made 0001''s ALTER DEFAULT PRIVILEGES line silently useless.
CREATE FUNCTION app.__public_canary() RETURNS int LANGUAGE sql AS 'SELECT 1';
SELECT results_eq($$ SELECT ops.functions_executable_by_public() $$,
  ARRAY['app.__public_canary()'],
  'a newly created function is PUBLIC-executable by default, and the assertion NAMES it — '
  'default privileges do not close this, so every migration must REVOKE explicitly');
REVOKE EXECUTE ON FUNCTION app.__public_canary() FROM PUBLIC;
SELECT is_empty($$ SELECT ops.functions_executable_by_public() $$,
  'an explicit REVOKE clears the assertion');
-- And an explicit grant back to PUBLIC is caught too, not just the implicit default.
GRANT EXECUTE ON FUNCTION app.__public_canary() TO PUBLIC;
SELECT results_eq($$ SELECT ops.functions_executable_by_public() $$,
  ARRAY['app.__public_canary()'],
  'an explicit GRANT TO PUBLIC is caught as well as the implicit default');
DROP FUNCTION app.__public_canary();

-- ---------------------------------------------------------------------------
-- The SECURITY DEFINER functions that mattered most
-- ---------------------------------------------------------------------------
-- These write rows outside RLS. They were one GRANT USAGE away from being an
-- arbitrary-write primitive for any authenticated user.
SELECT is(has_function_privilege('authoring', 'ops.test_seed_two_orgs()', 'EXECUTE'), false,
  'authoring cannot execute ops.test_seed_two_orgs(), a SECURITY DEFINER function that '
  'inserts tenant rows outside RLS');
SELECT is(has_function_privilege('authoring', 'app.tg_org_has_owner()', 'EXECUTE'), false,
  'authoring cannot execute the SECURITY DEFINER constraint-trigger function directly');
SELECT is(has_function_privilege('authoring',
  'ops.enqueue_job(text,jsonb,text,app.ulid,app.ulid,app.ulid,integer,integer)', 'EXECUTE'),
  false, 'authoring cannot execute ops.enqueue_job');
-- content.rebalance_siblings: maintained by 0007_content_model.
--
-- 0006 asserted that `authoring` cannot execute it. That was correct then and is wrong now,
-- and the reason is worth keeping rather than deleting: 0006's own §3 comment said
-- "content.frac_key_at and content.rebalance_siblings are deliberately left ungranted. They
-- have no consumer until content.nodes exists; P1-03 grants them to `authoring` in the
-- migration that gives them something to order." P1-03 is 0007, and it does — because
-- SECURITY INVOKER is transitive: content.move_node runs its whole body with the CALLER's
-- privileges, so the caller needs EXECUTE on next_sort_key, frac_key_at and
-- rebalance_siblings or every drag fails with `42501 permission denied for function
-- next_sort_key`, which is indistinguishable at a glance from an RLS denial and is not one.
--
-- What 0006 was actually protecting still holds and is asserted below and in 0007: the grant
-- goes to `authoring` BY NAME, PUBLIC still cannot execute anything, and a direct rebalance
-- is bounded by RLS because its UPDATE is the caller's — rebalancing another tenant's
-- sibling set, or a frozen version's, affects zero rows.
SELECT is(has_function_privilege('authoring', 'content.rebalance_siblings(app.ulid,app.ulid)',
  'EXECUTE'), true,
  'authoring CAN execute content.rebalance_siblings, granted by name in 0007 — it is reached '
  'transitively from content.move_node, which is SECURITY INVOKER (0006 §3 predicted this '
  'grant and named the migration that would make it)');
SELECT is_empty($$
  SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'content'
     AND (p.proacl IS NULL
          OR EXISTS (SELECT 1 FROM aclexplode(p.proacl) a
                      WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'))
$$, 'and granting it to `authoring` by name is not the same as leaving it open: nothing in '
    'schema content is executable by PUBLIC');
SELECT is(has_function_privilege('runtime_writer', 'ops.claim_job(text[],text)', 'EXECUTE'),
  false, 'runtime_writer cannot execute the queue RPCs either');

SELECT is_empty($$
  SELECT p.proname || '(' || pg_get_function_arguments(p.oid) || ')'
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'ops' AND has_function_privilege('authoring', p.oid, 'EXECUTE')
$$, 'authoring holds EXECUTE on NO function in schema ops');
SELECT is_empty($$
  SELECT p.proname || '(' || pg_get_function_arguments(p.oid) || ')'
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname IN ('app','content','runtime','export','billing','ops')
     AND has_function_privilege('runtime_writer', p.oid, 'EXECUTE')
     AND NOT (n.nspname = 'runtime')
$$, 'runtime_writer holds EXECUTE only on functions in schema runtime — its entire '
    'capability surface (ADR-009)');

-- ---------------------------------------------------------------------------
-- What must still be reachable
-- ---------------------------------------------------------------------------
SELECT is(has_function_privilege('authoring', 'app.gen_ulid(text)', 'EXECUTE'), true,
  'authoring CAN execute app.gen_ulid: it is the DEFAULT expression on eight primary keys, '
  'and a column default is evaluated with the inserting user''s privileges');
SELECT is(has_function_privilege('authoring', 'app.has_role(app.org_role,app.ulid)',
  'EXECUTE'), true, 'the RLS helpers are still reachable, or every policy denies');
SELECT is(has_function_privilege('authoring', 'app.can_see_project(app.ulid)', 'EXECUTE'),
  true, 'app.can_see_project is still reachable');
SELECT is(has_function_privilege('authoring', 'app.get_job(app.ulid)', 'EXECUTE'), true,
  'the studio''s job reader is still reachable');
SELECT is(has_function_privilege('authoring', 'app.resolve_invitation(bytea)', 'EXECUTE'),
  true, 'the invitation reader is still reachable');
SELECT is(has_function_privilege('runtime_writer', 'runtime.resolve_token(text)', 'EXECUTE'),
  true, 'runtime_writer keeps EXECUTE on its RPCs');
SELECT is(has_function_privilege('runtime_writer', 'runtime.load_session(app.ulid)',
  'EXECUTE'), true, 'runtime_writer keeps EXECUTE on load_session');

-- ---------------------------------------------------------------------------
-- The two things a sweep like this actually breaks
-- ---------------------------------------------------------------------------
SELECT set_config('rs.ids', ops.test_seed_two_orgs()::text, true);
CREATE FUNCTION pg_temp.tid(k text) RETURNS text LANGUAGE sql STABLE AS
$$ SELECT current_setting('rs.ids', true)::jsonb ->> k $$;
CREATE FUNCTION pg_temp.act_as(p_user uuid, p_org text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', p_user, 'role', 'authoring',
                      'app_metadata', json_build_object('active_org_id', p_org))::text,
    true);
  EXECUTE 'SET LOCAL ROLE authoring';
END $$;
GRANT USAGE ON SCHEMA public TO authoring;   -- pgTAP visibility; rolled back with the txn

SELECT pg_temp.act_as(pg_temp.tid('user_a')::uuid, pg_temp.tid('org_a'));

-- 1. A column DEFAULT calling app.gen_ulid, evaluated as authoring.
SELECT lives_ok($$
  INSERT INTO app.projects (org_id, ref, name, created_by)
  VALUES (current_setting('rs.ids')::jsonb ->> 'org_a', 'GENULID', 'default-generated id',
          (current_setting('rs.ids')::jsonb ->> 'user_a')::uuid)
$$, 'an authoring INSERT whose primary key DEFAULT calls app.gen_ulid still works');
SELECT isnt_empty($$
  SELECT 1 FROM app.projects WHERE ref = 'GENULID' AND id LIKE 'prj\_%'
$$, 'and the generated id has the expected prefix, so the default really ran');

-- 2. A BEFORE UPDATE trigger whose function PUBLIC can no longer execute.
SELECT results_eq($$
  WITH u AS (UPDATE app.projects SET name = 'touched' WHERE ref = 'GENULID' RETURNING 1)
  SELECT count(*)::int FROM u
$$, ARRAY[1],
  'app.tg_touch_updated_at still fires after its PUBLIC EXECUTE was revoked: PostgreSQL '
  'checks EXECUTE on a trigger function at CREATE TRIGGER time, not at fire time');

-- 3. A failing INSERT must still fail for its own reason, not with a privilege error from
--    a denied DEFAULT expression. That substitution is the nasty part of getting this
--    wrong: 42501 from "permission denied for function gen_ulid" is indistinguishable at a
--    glance from 42501 "new row violates row-level security policy", so a broken default
--    would keep every RLS assertion in the suite green while breaking every write.
SELECT throws_ok($$
  INSERT INTO app.projects (org_id, ref, name, created_by)
  VALUES (current_setting('rs.ids')::jsonb ->> 'org_a', '1bad', 'illegal ref',
          (current_setting('rs.ids')::jsonb ->> 'user_a')::uuid)
$$, '23514', NULL,
  'a bad value still reports the app.ref domain violation (23514) rather than a privilege '
  'error from the primary key''s DEFAULT expression');
SELECT throws_ok($$
  INSERT INTO app.invitations (org_id, email, role, token_hash, invited_by, expires_at)
  VALUES (current_setting('rs.ids')::jsonb ->> 'org_a', 'takeover@example.test', 'owner',
          app.hash_invitation_token('t'),
          (current_setting('rs.ids')::jsonb ->> 'user_a')::uuid, now() + interval '1 day')
$$, '42501', NULL,
  'an owner invitation attempted as `authoring` is stopped by the invitations_insert '
  'policy''s WITH CHECK (42501) BEFORE the table CHECK can fire — the 23514 that 0004''s '
  'suite asserts comes from the same insert run as the table owner, with RLS bypassed. '
  'Two independent guards on the same takeover-by-invite path, and it is worth knowing '
  'which one answers first');

RESET ROLE;
SELECT set_config('request.jwt.claims', '', true);

-- ---------------------------------------------------------------------------
-- Structural guards still clear
-- ---------------------------------------------------------------------------
SELECT is_empty($$ SELECT ops.tables_without_rls() $$, '0006 added no table without RLS');
SELECT is_empty($$ SELECT ops.content_tables_without_draft_trigger() $$,
  '0006 added no content table without the draft trigger');

SELECT * FROM finish();
ROLLBACK;
