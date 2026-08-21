-- 0004_tenancy/test.sql — pgTAP. The P1-01 cross-tenant isolation suite.
--
-- ADR-009: "every migration ships with a test that asserts org A cannot read org B's rows
-- through the authoring role. This runs in CI. Tenant isolation is not a thing you assert
-- once in a design doc." This is that test, in the shape Deliverable B §12.1 specifies.
--
-- P1-01's acceptance criteria, one assertion each:
--   * a user in org A sees exactly org A's projects
--   * editing the JWT's active_org_id to org B yields ZERO ROWS from every table, not an
--     error — an error is an oracle, it confirms the org exists
--   * an `owner` cannot be created by invitation (rejected by constraint)
--   * runtime_writer cannot SELECT from any app.* or content.* table
--   * both catalog assertions empty
BEGIN;
SELECT plan(121);

-- pgTAP lives in schema `public`, which migration 0001 hardened with
-- REVOKE ALL ON SCHEMA public FROM PUBLIC. This suite runs most of its assertions as
-- `authoring`, so it needs the assertion functions to be visible under that role. Granted
-- INSIDE the test transaction, which is rolled back: the hardening is not weakened for
-- any other session, and production never sees this grant because pgTAP is installed by
-- the test runner rather than by a migration.
GRANT USAGE ON SCHEMA public TO authoring, runtime_writer, analytics_reader;

-- ---------------------------------------------------------------------------
-- Fixture and impersonation
-- ---------------------------------------------------------------------------
-- Seed first, as the migration runner, before any impersonation exists.
SELECT set_config('rs.ids', ops.test_seed_two_orgs()::text, true);

-- The ids are published through a GUC rather than a temp table because a temp table
-- created by the migration runner is not readable by `authoring`, and the whole suite runs
-- as `authoring`.
CREATE FUNCTION pg_temp.tid(k text) RETURNS text LANGUAGE sql STABLE AS
$$ SELECT current_setting('rs.ids', true)::jsonb ->> k $$;

-- Impersonate a caller exactly as PostgREST does: JWT claims in the request GUC plus
-- SET LOCAL ROLE. Anything that passes this helper is reachable by a real HTTP caller;
-- anything that needs RESET ROLE is not.
CREATE FUNCTION pg_temp.act_as(p_user uuid, p_org text, p_role text DEFAULT 'authoring')
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', p_user, 'role', p_role,
                      'app_metadata', json_build_object('active_org_id', p_org))::text,
    true);
  EXECUTE format('SET LOCAL ROLE %I', p_role);
END $$;

-- Catalog-walking cross-tenant probes. Defined here, as the migration runner,
-- because migration 0001 revoked TEMPORARY on the database from PUBLIC: `authoring`
-- cannot create objects in pg_temp, which is itself a property worth having.
CREATE FUNCTION pg_temp.cross_tenant_reads()
RETURNS TABLE (tbl text, rows_visible int) LANGUAGE plpgsql AS $fn$
DECLARE r record; v_n int; v_org text := current_setting('rs.ids')::jsonb ->> 'org_b';
BEGIN
  FOR r IN SELECT c.relname FROM pg_class c
             JOIN pg_namespace n ON n.oid = c.relnamespace
             JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'org_id'
                                AND a.attnum > 0 AND NOT a.attisdropped
            WHERE n.nspname = 'app' AND c.relkind IN ('r','p') AND NOT c.relispartition
            ORDER BY 1
  LOOP
    BEGIN
      EXECUTE format('SELECT count(*)::int FROM app.%I WHERE org_id = %L', r.relname, v_org)
        INTO v_n;
    EXCEPTION WHEN insufficient_privilege THEN
      v_n := 0;   -- denied outright by GRANT is at least as safe as filtered to nothing
    END;
    tbl := 'app.' || r.relname; rows_visible := v_n; RETURN NEXT;
  END LOOP;
END $fn$;
CREATE FUNCTION pg_temp.cross_tenant_deletes()
RETURNS TABLE (tbl text, rows_deleted int) LANGUAGE plpgsql AS $fn$
DECLARE r record; v_n int; v_org text := current_setting('rs.ids')::jsonb ->> 'org_b';
BEGIN
  FOR r IN SELECT c.relname FROM pg_class c
             JOIN pg_namespace n ON n.oid = c.relnamespace
             JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'org_id'
                                AND a.attnum > 0 AND NOT a.attisdropped
            WHERE n.nspname = 'app' AND c.relkind IN ('r','p') AND NOT c.relispartition
            ORDER BY 1
  LOOP
    BEGIN
      EXECUTE format('WITH d AS (DELETE FROM app.%I WHERE org_id = %L RETURNING 1) '
                     'SELECT count(*)::int FROM d', r.relname, v_org) INTO v_n;
    EXCEPTION WHEN insufficient_privilege THEN
      v_n := 0;
    END;
    tbl := 'app.' || r.relname; rows_deleted := v_n; RETURN NEXT;
  END LOOP;
END $fn$;

SELECT has_function('ops', 'test_seed_two_orgs',
  'ops.test_seed_two_orgs() exists (roadmap M0.2 fixture)');
-- pg_temp resolves to pg_temp_<n> in the catalog, so this is checked by regprocedure
-- lookup rather than has_function(schema, name).
SELECT isnt(to_regprocedure('pg_temp.act_as(uuid,text,text)'), NULL,
  'pg_temp.act_as(user, org, role) impersonation helper exists (B §12.1)');

-- ---------------------------------------------------------------------------
-- Tables, columns and the K §3 two-axis requirement
-- ---------------------------------------------------------------------------
SELECT has_table('app', 'organizations',     'app.organizations exists');
SELECT has_table('app', 'org_members',       'app.org_members exists');
SELECT has_table('app', 'invitations',       'app.invitations exists');
SELECT has_table('app', 'projects',          'app.projects exists');
SELECT has_table('app', 'surveys',           'app.surveys exists');
SELECT has_table('app', 'survey_versions',   'app.survey_versions exists');
SELECT has_table('app', 'capability_grants', 'app.capability_grants exists');
SELECT has_table('app', 'audit_log',         'app.audit_log exists');

SELECT has_column('app', 'survey_versions', 'status',
  'survey_versions.status exists (K §3 workflow axis)');
SELECT has_column('app', 'survey_versions', 'compile_state',
  'survey_versions.compile_state is a SEPARATE column (K §3), not folded into status');
SELECT has_column('app', 'org_members', 'project_ids',
  'org_members.project_ids exists for project-scoped roles (B §1)');
SELECT has_index('app', 'survey_versions', 'sv_one_production',
  'sv_one_production partial unique index exists (at most one live version per survey)');
SELECT has_index('app', 'survey_versions', 'sv_one_draft',   'sv_one_draft exists');
SELECT has_index('app', 'survey_versions', 'sv_one_staging', 'sv_one_staging exists');
SELECT has_trigger('app', 'survey_versions', 'version_guard',
  'tg_version_guard is attached to app.survey_versions');
SELECT has_trigger('app', 'org_members', 'org_has_owner',
  'the deferred "at least one owner" constraint trigger is attached');
SELECT is(
  (SELECT tgdeferrable AND tginitdeferred FROM pg_trigger
    WHERE tgrelid = 'app.org_members'::regclass AND tgname = 'org_has_owner'),
  true,
  'org_has_owner is DEFERRABLE INITIALLY DEFERRED, which is what makes ownership '
  'TRANSFER expressible in one transaction (B §1)');
SELECT is(
  (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'app' AND c.relname LIKE 'audit\_log\_2%'
      AND c.relispartition) > 0,
  true, 'app.audit_log has monthly partitions (B §10)');

-- Partitions get their own RLS: policies are not inherited for direct access, so an
-- unprotected partition is a way to read another tenant's audit trail by name.
SELECT is_empty($$
  SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'app' AND c.relkind IN ('r','p')
     AND c.relname LIKE 'audit\_log\_2%'
     AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity)
$$, 'every audit_log partition has RLS ENABLEd and FORCEd');

-- ---------------------------------------------------------------------------
-- RLS helpers exist and fail closed
-- ---------------------------------------------------------------------------
SELECT has_function('app', 'current_org',      'app.current_org() exists');
SELECT has_function('app', 'current_user_id',  'app.current_user_id() exists');
SELECT has_function('app', 'has_role',         'app.has_role() exists');
SELECT has_function('app', 'can_see_project',  'app.can_see_project() exists');
SELECT has_function('app', 'has_capability',   'app.has_capability() exists');
SELECT is_definer('app', 'has_role', ARRAY['app.org_role','app.ulid'],
  'has_role is SECURITY DEFINER, which is what stops a policy on org_members recursing '
  'through a function that reads org_members (B §1.1)');

SELECT set_config('request.jwt.claims', '', true);
SELECT is(app.has_role('viewer'), false, 'has_role() is false with no claims at all');
SELECT is(app.can_see_project(pg_temp.tid('prj_a')::app.ulid), false,
  'can_see_project() is false with no claims at all');
SELECT is(app.has_capability('pii_access'), false,
  'has_capability() is false with no claims at all');
SELECT set_config('request.jwt.claims', '{ this is not json', true);
SELECT is(app.has_role('viewer'), false,
  'has_role() returns false — never raises — for malformed claims');

-- ---------------------------------------------------------------------------
-- Org A, authenticated normally
-- ---------------------------------------------------------------------------
SELECT pg_temp.act_as(pg_temp.tid('user_a')::uuid, pg_temp.tid('org_a'));

SELECT is(current_user::text, 'authoring'::text,
  'the suite runs as the authoring role');
SELECT is(app.current_org()::text, pg_temp.tid('org_a')::text,
  'current_org() reads active_org_id from the JWT, not from a request parameter');
SELECT ok(app.has_role('owner'), 'user A is an owner of org A');

SELECT results_eq($$ SELECT count(*)::int FROM app.projects $$, ARRAY[2],
  'a user in org A sees exactly org A''s projects (P1-01 acceptance)');
SELECT results_eq($$ SELECT count(*)::int FROM app.surveys $$, ARRAY[1],
  'org A sees exactly its own survey');
SELECT results_eq($$ SELECT count(*)::int FROM app.survey_versions $$, ARRAY[2],
  'org A sees exactly its own two versions (one frozen, one draft)');
SELECT results_eq($$ SELECT count(*)::int FROM app.organizations $$, ARRAY[1],
  'org A sees exactly one organization row: its own');

-- ---------------------------------------------------------------------------
-- A cannot READ B, in every tenant table
-- ---------------------------------------------------------------------------
SELECT is_empty($$ SELECT 1 FROM app.organizations WHERE slug = 'org-b' $$,
  'A cannot read B''s organization');
SELECT is_empty($$ SELECT 1 FROM app.org_members
                    WHERE org_id = current_setting('rs.ids')::jsonb ->> 'org_b' $$,
  'A cannot read B''s memberships');
SELECT is_empty($$ SELECT 1 FROM app.invitations
                    WHERE org_id = current_setting('rs.ids')::jsonb ->> 'org_b' $$,
  'A cannot read B''s invitations');
SELECT is_empty($$ SELECT 1 FROM app.projects
                    WHERE org_id = current_setting('rs.ids')::jsonb ->> 'org_b' $$,
  'A cannot read B''s projects');
SELECT is_empty($$ SELECT 1 FROM app.surveys
                    WHERE org_id = current_setting('rs.ids')::jsonb ->> 'org_b' $$,
  'A cannot read B''s surveys');
SELECT is_empty($$ SELECT 1 FROM app.survey_versions
                    WHERE org_id = current_setting('rs.ids')::jsonb ->> 'org_b' $$,
  'A cannot read B''s survey versions');
SELECT is_empty($$ SELECT 1 FROM app.capability_grants
                    WHERE org_id = current_setting('rs.ids')::jsonb ->> 'org_b' $$,
  'A cannot read B''s capability grants');
SELECT is_empty($$ SELECT 1 FROM app.audit_log
                    WHERE org_id = current_setting('rs.ids')::jsonb ->> 'org_b' $$,
  'A cannot read B''s audit log');

-- ---------------------------------------------------------------------------
-- A cannot WRITE B. INSERT raises 42501; UPDATE and DELETE silently affect zero rows.
-- Both behaviours are correct and the difference is worth pinning down, because a caller
-- that treats "0 rows" as success will corrupt nothing but will report a lie.
-- ---------------------------------------------------------------------------
SELECT throws_ok($$
  INSERT INTO app.projects (org_id, ref, name, created_by)
  VALUES (current_setting('rs.ids')::jsonb ->> 'org_b', 'PWNED', 'pwned',
          (current_setting('rs.ids')::jsonb ->> 'user_a')::uuid)
$$, '42501', NULL, 'A cannot INSERT into B''s projects');
SELECT throws_ok($$
  INSERT INTO app.surveys (org_id, project_id, ref, name, created_by)
  VALUES (current_setting('rs.ids')::jsonb ->> 'org_b',
          current_setting('rs.ids')::jsonb ->> 'prj_b', 'PWNED', 'pwned',
          (current_setting('rs.ids')::jsonb ->> 'user_a')::uuid)
$$, '42501', NULL, 'A cannot INSERT into B''s surveys');
SELECT throws_ok($$
  INSERT INTO app.org_members (org_id, user_id, role)
  VALUES (current_setting('rs.ids')::jsonb ->> 'org_b',
          (current_setting('rs.ids')::jsonb ->> 'user_a')::uuid, 'admin')
$$, '42501', NULL, 'A cannot make itself a member of B');
SELECT throws_ok($$
  INSERT INTO app.audit_log (org_id, action, actor_kind)
  VALUES (current_setting('rs.ids')::jsonb ->> 'org_a', 'forged.event', 'user')
$$, '42501', NULL,
  'nobody can INSERT into the audit log directly, not even into their OWN org: writes go '
  'through app.write_audit_event (B §12)');

SELECT results_eq($$
  WITH u AS (UPDATE app.surveys SET name = 'pwned'
              WHERE org_id = current_setting('rs.ids')::jsonb ->> 'org_b' RETURNING 1)
  SELECT count(*)::int FROM u
$$, ARRAY[0], 'A cannot UPDATE B''s surveys (0 rows, not an error)');
SELECT results_eq($$
  WITH u AS (UPDATE app.projects SET name = 'pwned'
              WHERE org_id = current_setting('rs.ids')::jsonb ->> 'org_b' RETURNING 1)
  SELECT count(*)::int FROM u
$$, ARRAY[0], 'A cannot UPDATE B''s projects');
SELECT results_eq($$
  WITH u AS (UPDATE app.organizations SET name = 'pwned' WHERE slug = 'org-b' RETURNING 1)
  SELECT count(*)::int FROM u
$$, ARRAY[0], 'A cannot UPDATE B''s organization');
SELECT results_eq($$
  WITH u AS (UPDATE app.survey_versions SET notes = 'pwned'
              WHERE org_id = current_setting('rs.ids')::jsonb ->> 'org_b' RETURNING 1)
  SELECT count(*)::int FROM u
$$, ARRAY[0], 'A cannot UPDATE B''s survey versions');
SELECT results_eq($$
  WITH d AS (DELETE FROM app.projects
              WHERE org_id = current_setting('rs.ids')::jsonb ->> 'org_b' RETURNING 1)
  SELECT count(*)::int FROM d
$$, ARRAY[0], 'A cannot DELETE B''s projects');
SELECT results_eq($$
  WITH d AS (DELETE FROM app.org_members
              WHERE org_id = current_setting('rs.ids')::jsonb ->> 'org_b' RETURNING 1)
  SELECT count(*)::int FROM d
$$, ARRAY[0], 'A cannot DELETE B''s memberships');
SELECT throws_ok($$
  DELETE FROM app.audit_log WHERE org_id = current_setting('rs.ids')::jsonb ->> 'org_b'
$$, '42501', NULL,
  'nobody can DELETE from the audit log: an actor who can erase the record can erase '
  'themselves');

-- The enumerated assertions above name specific tables, which means a table added in
-- migration 0147 is not covered by them. These two walk pg_catalog instead: EVERY table in
-- schema `app` that carries an org_id, whatever it is called and whenever it was added.
-- ADR-009's "tenant isolation is not a thing you assert once" applies to the test as much
-- as to the schema.
SELECT is_empty($$
  SELECT tbl || ' leaked ' || rows_visible || ' row(s)'
    FROM pg_temp.cross_tenant_reads() WHERE rows_visible <> 0
$$, 'org A reads ZERO of org B''s rows from every org_id-bearing table in schema app, '
    'enumerated from pg_catalog rather than by hand');

SELECT is_empty($$
  SELECT tbl || ' deleted ' || rows_deleted || ' row(s)'
    FROM pg_temp.cross_tenant_deletes() WHERE rows_deleted <> 0
$$, 'org A deletes ZERO of org B''s rows from every org_id-bearing table in schema app '
    '(app.organizations keys on `id` rather than org_id and is asserted separately above)');

-- ---------------------------------------------------------------------------
-- Forging active_org_id — the P1-01 headline
-- ---------------------------------------------------------------------------
SELECT pg_temp.act_as(pg_temp.tid('user_a')::uuid, pg_temp.tid('org_b'));
SELECT is(app.current_org()::text, pg_temp.tid('org_b')::text,
  'the forged claim IS read: the guarantee is not that forging is prevented');
SELECT ok(NOT app.has_role('client'),
  'has_role() is false because no app.org_members row backs the forged claim');
SELECT is_empty($$ SELECT 1 FROM app.organizations $$,
  'forging active_org_id to org B returns ZERO ROWS from organizations, not an error');
SELECT is_empty($$ SELECT 1 FROM app.projects $$,
  'forging active_org_id returns zero rows from projects (P1-01 acceptance)');
SELECT is_empty($$ SELECT 1 FROM app.surveys $$,
  'forging active_org_id returns zero rows from surveys');
SELECT is_empty($$ SELECT 1 FROM app.survey_versions $$,
  'forging active_org_id returns zero rows from survey_versions');
SELECT is_empty($$ SELECT 1 FROM app.invitations $$,
  'forging active_org_id returns zero rows from invitations');
SELECT is_empty($$ SELECT 1 FROM app.audit_log $$,
  'forging active_org_id returns zero rows from audit_log');
SELECT is_empty($$ SELECT 1 FROM app.capability_grants
                    WHERE user_id <> (current_setting('rs.ids')::jsonb ->> 'user_a')::uuid $$,
  'forging active_org_id returns zero rows from capability_grants');

-- A user with no membership anywhere is the same case with the claim honestly stated.
SELECT pg_temp.act_as(pg_temp.tid('user_c')::uuid, pg_temp.tid('org_a'));
SELECT is_empty($$ SELECT 1 FROM app.projects $$,
  'a user who belongs to no org sees nothing, without an error');

-- ---------------------------------------------------------------------------
-- Project scoping inside one org (B §1, K §1)
-- ---------------------------------------------------------------------------
SELECT pg_temp.act_as(pg_temp.tid('user_a2')::uuid, pg_temp.tid('org_a'));
SELECT results_eq($$ SELECT count(*)::int FROM app.projects $$, ARRAY[1],
  'a reviewer scoped to one project sees ONE of org A''s two projects');
SELECT ok(app.can_see_project(pg_temp.tid('prj_a')::app.ulid),
  'can_see_project() is true for the project they are staffed on');
SELECT ok(NOT app.can_see_project(pg_temp.tid('prj_a2')::app.ulid),
  'can_see_project() is false for the sibling project in the same org — this is the '
  'predicate that keeps a freelancer off the rest of the client list');
SELECT ok(NOT app.has_role('programmer'),
  'a reviewer does not reach the programmer floor');
SELECT results_eq($$
  WITH u AS (UPDATE app.surveys SET name = 'reviewer edit' RETURNING 1)
  SELECT count(*)::int FROM u
$$, ARRAY[0], 'a reviewer cannot edit a survey (0 rows: the write policy floor is programmer)');

-- ---------------------------------------------------------------------------
-- Deliverable K §1: the two capabilities that do not nest
-- ---------------------------------------------------------------------------
SELECT ok(app.has_capability('pii_access', pg_temp.tid('prj_a')::app.ulid),
  'user A2 has the pii_access grant on project A, and org A''s settings permit PII exports');
SELECT ok(NOT app.has_capability('pii_access', pg_temp.tid('prj_a2')::app.ulid),
  'the pii_access grant is per-project: it does not extend to project A2');
SELECT ok(NOT app.has_capability('custom_code'),
  'no custom_code grant means no custom_code capability');

SELECT pg_temp.act_as(pg_temp.tid('user_a')::uuid, pg_temp.tid('org_a'));
SELECT ok(app.has_role('owner') AND NOT app.has_capability('pii_access',
                                        pg_temp.tid('prj_a')::app.ulid),
  'the OWNER of org A — who outranks everyone — does NOT have pii_access, because K §1 '
  'says this capability does not nest and must never be inherited by rank');

-- The CI grep K §1 asks for, run against every policy in the live database rather than
-- only the ones written in this migration.
SELECT is_empty($$
  SELECT schemaname || '.' || tablename || '.' || policyname
    FROM pg_policies
   WHERE (coalesce(qual, '') || ' ' || coalesce(with_check, '')) ~ '(pii_access|custom_code)'
     AND (coalesce(qual, '') || ' ' || coalesce(with_check, '')) ~ 'has_role'
$$, 'no policy governing pii_access or custom_code calls app.has_role() (K §1: '
    '"has_role() is forbidden from appearing in a policy that governs either. CI greps '
    'for it.")');
SELECT is_empty($$
  SELECT 1 WHERE pg_get_functiondef('app.has_capability(text,app.ulid)'::regprocedure)
                 ~ 'has_role'
$$, 'app.has_capability() itself contains no has_role() call');

-- ---------------------------------------------------------------------------
-- ADR-009's negative capability: runtime_writer
-- ---------------------------------------------------------------------------
RESET ROLE;
SELECT set_config('request.jwt.claims', '', true);

-- Catalog form: future-proof, covers tables that do not exist yet.
SELECT is_empty($$
  SELECT n.nspname || '.' || c.relname || ':' || a.privilege_type
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    CROSS JOIN LATERAL aclexplode(c.relacl) a
   WHERE n.nspname IN ('app','content')
     AND c.relkind IN ('r','p','v','m')
     AND c.relacl IS NOT NULL
     AND a.grantee = 'runtime_writer'::regrole
$$, 'runtime_writer holds NO privilege on any table in app or content (ADR-009)');
SELECT is_empty($$
  SELECT n.nspname || '.' || c.relname || ':' || a.privilege_type
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    CROSS JOIN LATERAL aclexplode(c.relacl) a
   WHERE n.nspname IN ('app','content')
     AND c.relacl IS NOT NULL
     AND a.grantee = 'analytics_reader'::regrole
$$, 'analytics_reader holds no privilege on app or content either: B §2 gives it SELECT '
    'on the generated export tables and nothing else');

SET LOCAL ROLE runtime_writer;
SELECT throws_ok($$ SELECT 1 FROM app.surveys LIMIT 1 $$, '42501', NULL,
  'runtime_writer cannot SELECT from app.surveys');
SELECT throws_ok($$ SELECT 1 FROM app.survey_versions LIMIT 1 $$, '42501', NULL,
  'runtime_writer cannot SELECT from app.survey_versions');
SELECT throws_ok($$ SELECT 1 FROM app.organizations LIMIT 1 $$, '42501', NULL,
  'runtime_writer cannot SELECT from app.organizations');
SELECT throws_ok($$ SELECT 1 FROM app.audit_log LIMIT 1 $$, '42501', NULL,
  'runtime_writer cannot SELECT from app.audit_log');
SELECT throws_ok($$ CREATE TABLE content.pwned (id int) $$, '42501', NULL,
  'runtime_writer cannot even reach schema content');
SELECT lives_ok($$ SELECT * FROM runtime.resolve_token(repeat('a', 26)) $$,
  'runtime_writer CAN execute the named RPCs — its entire capability surface');
SELECT is_empty($$ SELECT * FROM runtime.resolve_token(repeat('a', 26)) $$,
  'and an unknown token resolves to NO ROWS rather than an error. This assertion was written '
  'against the P1-01 placeholder and is maintained here per db/README.md: 0009 replaced the '
  'body with one that reads runtime.survey_tokens, the signature is unchanged, so the '
  'privilege assertions stay here and the behaviour asserted is now the real thing — zero '
  'rows for a token nobody issued, because an error would be an oracle');
SELECT lives_ok($$ SELECT runtime.load_session('ses_0A000000000000000000000000') $$,
  'runtime_writer can execute runtime.load_session');

RESET ROLE;
SELECT is(has_function_privilege('runtime_writer', 'runtime.resolve_token(text)', 'EXECUTE'),
  true, 'runtime_writer holds EXECUTE on runtime.resolve_token');
SELECT is(has_function_privilege('authoring', 'runtime.resolve_token(text)', 'EXECUTE'),
  false, 'authoring does NOT hold EXECUTE on the runtime RPCs: the plane boundary cuts '
         'both ways');

-- No runtime RPC may take an org_id argument, because that is how a cross-tenant request
-- would be phrased (B §2).
SELECT is_empty($$
  SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'runtime'
     AND EXISTS (SELECT 1 FROM unnest(coalesce(p.proargnames, '{}')) an
                  WHERE an ~ 'org')
$$, 'no runtime RPC accepts an org id: org is derived from the token or session inside '
    'the definer function (B §2)');

-- ---------------------------------------------------------------------------
-- Invitations: an owner cannot be created by invitation (P1-01 acceptance)
-- ---------------------------------------------------------------------------
SELECT throws_ok($$
  INSERT INTO app.invitations (org_id, email, role, token_hash, invited_by, expires_at)
  VALUES (current_setting('rs.ids')::jsonb ->> 'org_a', 'takeover@example.test', 'owner',
          app.hash_invitation_token('t'),
          (current_setting('rs.ids')::jsonb ->> 'user_a')::uuid, now() + interval '1 day')
$$, '23514', NULL,
  'an owner cannot be created by invitation: the insert is rejected by constraint '
  '(P1-01 acceptance, B §1 "one cheap CHECK removes a whole class of takeover-by-invite '
  'bugs")');
SELECT throws_ok($$
  INSERT INTO app.invitations (org_id, email, role, token_hash, invited_by, expires_at)
  VALUES (current_setting('rs.ids')::jsonb ->> 'org_a', 'x@example.test', 'analyst',
          'not-32-bytes'::bytea,
          (current_setting('rs.ids')::jsonb ->> 'user_a')::uuid, now() + interval '1 day')
$$, '23514', NULL,
  'a token_hash that is not exactly 32 bytes is rejected: anything else in that column is '
  'a plaintext token, a truncation, or a different algorithm');
SELECT is(octet_length(app.hash_invitation_token('hello')), 32,
  'app.hash_invitation_token produces a 32-byte sha256');
SELECT isnt(app.hash_invitation_token('hello')::text, 'hello',
  'app.hash_invitation_token does not return the plaintext');
SELECT throws_ok($$
  INSERT INTO app.org_members (org_id, user_id, role, project_ids)
  VALUES (current_setting('rs.ids')::jsonb ->> 'org_a',
          (current_setting('rs.ids')::jsonb ->> 'user_c')::uuid, 'client', '{}')
$$, '23514', NULL,
  'a client member must be scoped to explicit projects (K §1): an org-wide client would '
  'be the opposite of what the role is for');

-- ---------------------------------------------------------------------------
-- The "at least one owner" invariant
-- ---------------------------------------------------------------------------
-- The trigger is DEFERRED, so it fires at commit. SET CONSTRAINTS ALL IMMEDIATE forces it
-- inside a subtransaction so the assertion can observe the exception without committing.
CREATE FUNCTION pg_temp.try_remove_last_owner() RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM app.org_members
   WHERE org_id = (current_setting('rs.ids')::jsonb ->> 'org_a')::app.ulid
     AND role = 'owner';
  SET CONSTRAINTS ALL IMMEDIATE;
  RETURN 'no error';
EXCEPTION WHEN others THEN
  RETURN SQLERRM;
END $$;
SELECT matches(pg_temp.try_remove_last_owner(), 'must retain at least one owner',
  'the deferred trigger rejects removing the LAST owner of an org');

CREATE FUNCTION pg_temp.try_demote_last_owner() RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  UPDATE app.org_members SET role = 'viewer'
   WHERE org_id = (current_setting('rs.ids')::jsonb ->> 'org_a')::app.ulid
     AND role = 'owner';
  SET CONSTRAINTS ALL IMMEDIATE;
  RETURN 'no error';
EXCEPTION WHEN others THEN
  RETURN SQLERRM;
END $$;
SELECT matches(pg_temp.try_demote_last_owner(), 'must retain at least one owner',
  'the deferred trigger rejects DEMOTING the last owner, not just deleting them');

CREATE FUNCTION pg_temp.try_transfer_ownership() RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  -- Promote first, demote second — and the reverse order must work too, which is exactly
  -- what DEFERRED buys and an immediate CHECK would forbid.
  UPDATE app.org_members SET role = 'owner'
   WHERE org_id = (current_setting('rs.ids')::jsonb ->> 'org_a')::app.ulid
     AND user_id = (current_setting('rs.ids')::jsonb ->> 'user_a2')::uuid;
  UPDATE app.org_members SET role = 'admin'
   WHERE org_id = (current_setting('rs.ids')::jsonb ->> 'org_a')::app.ulid
     AND user_id = (current_setting('rs.ids')::jsonb ->> 'user_a')::uuid;
  SET CONSTRAINTS ALL IMMEDIATE;
  RETURN 'no error';
EXCEPTION WHEN others THEN
  RETURN SQLERRM;
END $$;
SELECT is(pg_temp.try_transfer_ownership(), 'no error'::text,
  'ownership TRANSFER inside one transaction is allowed: this is why the invariant is a '
  'deferred constraint trigger and not a CHECK (B §1)');

-- ---------------------------------------------------------------------------
-- tg_version_guard (ADR-002)
-- ---------------------------------------------------------------------------
SELECT throws_ok($$
  UPDATE app.survey_versions SET schema_version = 99
   WHERE id = current_setting('rs.ids')::jsonb ->> 'ver_a_frozen'
$$, '23514', NULL,
  'tg_version_guard rejects mutation of a non-draft (frozen) version: ADR-002 makes the '
  'version the unit of immutability');
SELECT throws_ok($$
  UPDATE app.survey_versions SET version_no = 77
   WHERE id = current_setting('rs.ids')::jsonb ->> 'ver_a_frozen'
$$, '23514', NULL, 'tg_version_guard seals version_no on a frozen version');
SELECT throws_ok($$
  UPDATE app.survey_versions SET status = 'draft'
   WHERE id = current_setting('rs.ids')::jsonb ->> 'ver_a_frozen'
$$, '23514', NULL,
  'production -> draft is an illegal transition and says so, rather than updating zero rows');
SELECT lives_ok($$
  UPDATE app.survey_versions
     SET artifact_hash = repeat('b', 64)
   WHERE id = current_setting('rs.ids')::jsonb ->> 'ver_a_frozen'
$$, 'repointing artifact_hash on a frozen version IS allowed: that is precisely what '
    'publish and rollback are (01 §7)');
SELECT lives_ok($$
  UPDATE app.survey_versions SET status = 'archived'
   WHERE id = current_setting('rs.ids')::jsonb ->> 'ver_a_frozen'
$$, 'production -> archived is legal');
SELECT lives_ok($$
  UPDATE app.survey_versions SET status = 'production'
   WHERE id = current_setting('rs.ids')::jsonb ->> 'ver_a_frozen'
$$, 'archived -> production is legal, because that is rollback');
SELECT results_eq($$
  SELECT revision > 1 FROM app.survey_versions
   WHERE id = current_setting('rs.ids')::jsonb ->> 'ver_a_frozen'
$$, ARRAY[true],
  'tg_version_guard increments revision on every UPDATE, so optimistic locking cannot be '
  'forgotten by a caller (01 §3.1)');
SELECT throws_ok($$
  UPDATE app.survey_versions SET status = 'production'
   WHERE id = current_setting('rs.ids')::jsonb ->> 'ver_a_draft'
$$, '23514', NULL,
  'a draft cannot jump straight to production, and a draft has no compiled artifact '
  'anyway (K §3)');
SELECT throws_ok($$
  INSERT INTO app.survey_versions (org_id, survey_id, version_no, status, compile_state,
                                   schema_version, created_by)
  VALUES (current_setting('rs.ids')::jsonb ->> 'org_a',
          current_setting('rs.ids')::jsonb ->> 'svy_a', 9, 'production', 'none', 1,
          (current_setting('rs.ids')::jsonb ->> 'user_a')::uuid)
$$, '23514', NULL,
  'a version cannot enter production without compile_state = ''compiled'' (K §3): a live '
  'status with no usable artifact serves respondents an error page');
SELECT throws_ok($$
  INSERT INTO app.survey_versions (org_id, survey_id, version_no, status, compile_state,
                                   schema_version, created_by)
  VALUES (current_setting('rs.ids')::jsonb ->> 'org_a',
          current_setting('rs.ids')::jsonb ->> 'svy_a', 10, 'draft', 'none', 1,
          (current_setting('rs.ids')::jsonb ->> 'user_a')::uuid)
$$, '23505', NULL, 'sv_one_draft allows only one editable draft per survey');

-- ---------------------------------------------------------------------------
-- Composite FK: the denormalized org_id cannot lie
-- ---------------------------------------------------------------------------
SELECT throws_ok($$
  INSERT INTO app.surveys (org_id, project_id, ref, name, created_by)
  VALUES (current_setting('rs.ids')::jsonb ->> 'org_a',
          current_setting('rs.ids')::jsonb ->> 'prj_b', 'XORG', 'cross-org survey',
          (current_setting('rs.ids')::jsonb ->> 'user_a')::uuid)
$$, '23503', NULL,
  'the composite FK (org_id, project_id) blocks attaching a survey to ANOTHER org''s '
  'project while carrying its own org_id — without it every RLS policy would agree that '
  'the row is fine (B §3)');

-- ---------------------------------------------------------------------------
-- Deliverable K §1 role ranks, asserted again in the suite that consumes them
-- ---------------------------------------------------------------------------
SELECT results_eq($$
  SELECT v::text, app.role_rank(v)
    FROM unnest(enum_range(NULL::app.org_role)) v
   ORDER BY app.role_rank(v) DESC
$$, $$ VALUES ('owner',70), ('admin',60), ('project_manager',50), ('programmer',40),
               ('analyst',30), ('reviewer',20), ('viewer',10), ('client',5) $$,
  'role_rank ordering matches Deliverable K §1 exactly, all eight values');

-- ---------------------------------------------------------------------------
-- Idempotent enqueue, asserted in the P1-01 suite as well
-- ---------------------------------------------------------------------------
SELECT is(
  ops.enqueue_job('compile', '{}', 'p1-01-idem'),
  ops.enqueue_job('compile', '{}', 'p1-01-idem'),
  'ops.enqueue_job with a repeated idempotency key returns one id');
SELECT results_eq(
  $$ SELECT count(*)::int FROM ops.jobs WHERE idempotency_key = 'p1-01-idem' $$, ARRAY[1],
  'ops.enqueue_job with a repeated idempotency key creates one row');

-- ---------------------------------------------------------------------------
-- Policy shape and the structural guards
-- ---------------------------------------------------------------------------
-- FOR ALL policies are banned by convention: a single policy covering reads and writes is
-- how a read predicate silently becomes a write predicate.
SELECT is_empty($$
  SELECT schemaname || '.' || tablename || '.' || policyname
    FROM pg_policies WHERE schemaname IN ('app','content','billing','export') AND cmd = 'ALL'
$$, 'no tenant table uses a FOR ALL policy: commands get separate policies');

-- Every write policy must carry a WITH CHECK. USING alone governs which rows you may
-- touch, not what they may become, and omitting the second half is the classic RLS hole.
SELECT is_empty($$
  SELECT schemaname || '.' || tablename || '.' || policyname
    FROM pg_policies
   WHERE schemaname IN ('app','content','billing','export')
     AND cmd IN ('INSERT','UPDATE') AND with_check IS NULL
$$, 'every INSERT and UPDATE policy has a WITH CHECK clause');

-- Every tenant-table policy must mention the org. A policy that forgets it is a
-- cross-tenant read that happens to pass every test written before it.
SELECT is_empty($$
  SELECT schemaname || '.' || tablename || '.' || policyname
    FROM pg_policies
   WHERE schemaname IN ('app','content','billing','export')
     AND tablename <> 'capability_grants'
     AND (coalesce(qual, '') || ' ' || coalesce(with_check, '')) NOT LIKE '%current_org%'
$$, 'every tenant-table policy constrains org_id against app.current_org()');

SELECT policies_are('app', 'survey_versions',
  ARRAY['sv_select','sv_insert','sv_update','sv_delete'],
  'app.survey_versions has exactly one policy per command');

SELECT is_empty($$ SELECT ops.tables_without_rls() $$,
  'ops.tables_without_rls() returns empty after the first eight tenant tables (B §12.1)');
SELECT is_empty($$ SELECT ops.content_tables_without_draft_trigger() $$,
  'ops.content_tables_without_draft_trigger() returns empty');

SELECT * FROM finish();
ROLLBACK;
