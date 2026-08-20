-- 0001_bootstrap/test.sql — pgTAP.
--
-- Roadmap M0.2 requires the DB §12.1 skeleton to exist BEFORE the first tenant table:
-- the two catalog assertions (tables_without_rls, content_tables_without_draft_trigger)
-- asserted empty, and the impersonation helper. This file owns the catalog assertions and
-- the primitives; 0004 owns the cross-tenant suite.
--
-- Everything runs inside one transaction that is rolled back, so a test run leaves no
-- trace and can be repeated against the same database without a reset.
BEGIN;
SELECT plan(73);

-- ---------------------------------------------------------------------------
-- Schemas and the deny-by-default baseline
-- ---------------------------------------------------------------------------
SELECT has_schema('app',     'schema app exists');
SELECT has_schema('content', 'schema content exists');
SELECT has_schema('runtime', 'schema runtime exists');
SELECT has_schema('export',  'schema export exists');
SELECT has_schema('billing', 'schema billing exists');
SELECT has_schema('ops',     'schema ops exists');

-- grantee 0 in an ACL is the PUBLIC pseudo-role. B §2's REVOKE ALL ON SCHEMA public
-- FROM PUBLIC is the baseline every SECURITY DEFINER function in the codebase leans on.
SELECT is(
  (SELECT count(*)::int FROM pg_namespace n, aclexplode(n.nspacl) a
    WHERE n.nspname = 'public' AND a.grantee = 0),
  0, 'PUBLIC holds no privilege on schema public (B §2)');

SELECT is(has_schema_privilege('authoring', 'ops', 'USAGE'), false,
  'authoring cannot reach schema ops (B §0: ops is service-role only)');
SELECT is(has_schema_privilege('runtime_writer', 'content', 'USAGE'), false,
  'runtime_writer cannot reach schema content (ADR-009)');

-- ---------------------------------------------------------------------------
-- Roles (ADR-009)
-- ---------------------------------------------------------------------------
SELECT has_role('authoring',         'role authoring exists');
SELECT has_role('runtime_writer',    'role runtime_writer exists');
SELECT has_role('analytics_reader',  'role analytics_reader exists');
SELECT has_role('runtime_rpc_owner', 'role runtime_rpc_owner exists');

-- BYPASSRLS on any of these would make every policy in the codebase decorative.
SELECT is_empty($$
  SELECT rolname FROM pg_roles
   WHERE rolname IN ('authoring','runtime_writer','analytics_reader','runtime_rpc_owner')
     AND (rolbypassrls OR rolsuper)
$$, 'no application role has BYPASSRLS or SUPERUSER');

-- ---------------------------------------------------------------------------
-- Domains
-- ---------------------------------------------------------------------------
SELECT has_domain('app', 'ulid',            'domain app.ulid exists');
SELECT has_domain('app', 'ref',             'domain app.ref exists');
SELECT has_domain('app', 'sha256',          'domain app.sha256 exists');
SELECT has_domain('content', 'sort_key',    'domain content.sort_key exists');
SELECT has_domain('runtime', 'survey_token','domain runtime.survey_token exists');

SELECT lives_ok($$ SELECT ('svy_0' || repeat('A', 25))::app.ulid $$,
  'app.ulid accepts a well-formed prefixed ULID');
SELECT throws_ok($$ SELECT ('svy_' || repeat('A', 26))::app.ulid $$, '23514', NULL,
  'app.ulid rejects a timestamp high char outside 0-7');
SELECT throws_ok($$ SELECT ('svy_0I' || repeat('A', 24))::app.ulid $$, '23514', NULL,
  'app.ulid rejects I, which Crockford base32 excludes to stop transcription errors');
SELECT throws_ok($$ SELECT ('SVY_0' || repeat('A', 25))::app.ulid $$, '23514', NULL,
  'app.ulid rejects an uppercase prefix');

SELECT lives_ok($$ SELECT 'Q12_grid_1'::app.ref $$, 'app.ref accepts a survey handle');
SELECT throws_ok($$ SELECT '1Q'::app.ref $$, '23514', NULL,
  'app.ref rejects a leading digit (illegal identifier in SPSS/R/Stata)');

SELECT lives_ok($$ SELECT repeat('a', 64)::app.sha256 $$, 'app.sha256 accepts 64 hex chars');
SELECT throws_ok($$ SELECT repeat('A', 64)::app.sha256 $$, '23514', NULL,
  'app.sha256 rejects uppercase: two spellings of one hash defeats content addressing');

-- Deliverable K §5. Every one of these rejections is a routing bug that would have put
-- respondents into the wrong study.
SELECT lives_ok($$ SELECT ('a' || repeat('b3z', 8) || 'c')::runtime.survey_token $$,
  'runtime.survey_token accepts 26 lowercase base-36 chars (K §5)');
SELECT throws_ok($$ SELECT ('A' || repeat('b3z', 8) || 'c')::runtime.survey_token $$,
  '23514', NULL,
  'runtime.survey_token rejects uppercase: DNS labels are case-insensitive (K §5)');
SELECT throws_ok($$ SELECT repeat('a', 22)::runtime.survey_token $$, '23514', NULL,
  'runtime.survey_token rejects B §3.2''s 22-char form; K §5 requires 26');
SELECT throws_ok($$ SELECT repeat('7', 26)::runtime.survey_token $$, '23514', NULL,
  'runtime.survey_token rejects an all-digit label (K §5 DNS constraint)');

-- COLLATE "C" on content.sort_key is what makes fractional ordering total and stable.
SELECT is(
  (SELECT c.collname FROM pg_type t JOIN pg_collation c ON c.oid = t.typcollation
    WHERE t.typname = 'sort_key'
      AND t.typnamespace = 'content'::regnamespace),
  'C', 'content.sort_key is COLLATE "C" so byte order is total (B §4.6)');

-- ---------------------------------------------------------------------------
-- Migration bookkeeping
-- ---------------------------------------------------------------------------
SELECT has_table('ops', 'schema_migrations', 'ops.schema_migrations exists');
SELECT isnt_empty($$ SELECT 1 FROM ops.schema_migrations WHERE name = '0001_bootstrap' $$,
  '0001_bootstrap recorded itself with a checksum');
SELECT has_table('ops', 'rls_exemptions', 'ops.rls_exemptions exists');
SELECT throws_ok($$
  INSERT INTO ops.rls_exemptions (table_name, reason) VALUES ('app.foo', 'meh')
$$, '23514', NULL,
  'an RLS exemption needs a real reason, not a one-word commit (B §12.1)');
SELECT throws_ok($$
  INSERT INTO ops.rls_exemptions (table_name, reason)
  VALUES ('foo', 'unqualified table names would exempt the wrong table later')
$$, '23514', NULL, 'ops.rls_exemptions requires a schema-qualified table name');

-- ---------------------------------------------------------------------------
-- The two catalog assertions that hold the line (B §12.1, ADR-009)
-- ---------------------------------------------------------------------------
SELECT has_function('ops', 'tables_without_rls', 'ops.tables_without_rls() exists');
SELECT is_empty($$ SELECT ops.tables_without_rls() $$,
  'every tenant table has RLS ENABLEd and FORCEd (B §12.1)');
SELECT has_function('ops', 'content_tables_without_draft_trigger',
  'ops.content_tables_without_draft_trigger() exists');
SELECT is_empty($$ SELECT ops.content_tables_without_draft_trigger() $$,
  'every content table carries content.tg_draft_only (ADR-002)');
SELECT has_function('content', 'tg_draft_only',
  'content.tg_draft_only() exists before the first content table');

-- The assertion is only worth anything if it can actually fail. Prove it by creating an
-- unprotected table inside this transaction — the same shape as the lint fixture, checked
-- from the catalog side rather than the SQL-text side.
CREATE TABLE app.__rls_canary (id int PRIMARY KEY);
SELECT results_eq(
  $$ SELECT ops.tables_without_rls() $$, ARRAY['app.__rls_canary'],
  'ops.tables_without_rls() NAMES an unprotected table rather than merely counting it');
ALTER TABLE app.__rls_canary ENABLE ROW LEVEL SECURITY;
SELECT results_eq($$ SELECT ops.tables_without_rls() $$, ARRAY['app.__rls_canary'],
  'ENABLE alone is not enough: FORCE is required or the owner is exempt');
ALTER TABLE app.__rls_canary FORCE ROW LEVEL SECURITY;
SELECT is_empty($$ SELECT ops.tables_without_rls() $$,
  'ENABLE + FORCE clears the assertion');
DROP TABLE app.__rls_canary;

-- ---------------------------------------------------------------------------
-- Fractional ordering (B §4.6)
-- ---------------------------------------------------------------------------
SELECT is(content.frac_key_at(NULL::content.sort_key, NULL::content.sort_key)::text, 'V',
  'frac_key_at with no bounds returns the midpoint of the alphabet');
SELECT is(content.frac_key_at('a1'::content.sort_key, 'a2'::content.sort_key)::text, 'a1V',
  'frac_key_at(''a1'',''a2'') = ''a1V'', exactly B §4.6''s worked example');
SELECT ok(content.frac_key_at('a1'::content.sort_key, 'a2'::content.sort_key) > 'a1'
      AND content.frac_key_at('a1'::content.sort_key, 'a2'::content.sort_key) < 'a2',
  'frac_key_at lands strictly between its bounds');
SELECT ok(content.frac_key_at('zz'::content.sort_key, NULL::content.sort_key) > 'zz',
  'frac_key_at appends above the largest key without an upper bound');
SELECT throws_ok($$ SELECT content.frac_key_at('b'::content.sort_key, 'a'::content.sort_key) $$,
  '22023', NULL, 'frac_key_at rejects inverted bounds');
SELECT throws_ok($$ SELECT content.frac_key_at(NULL::content.sort_key, '0'::content.sort_key) $$,
  '22023', NULL,
  'frac_key_at refuses when no key can exist below an all-zeros bound, and says to rebalance');

-- The pathological drag sequence from B §4.6: 200 inserts at the same point. Ordering must
-- hold and key growth must stay bounded, because this is the case that decides whether
-- rebalancing is a nightly job or a per-edit cost.
CREATE FUNCTION pg_temp.frac_stress(p_n int)
RETURNS TABLE (ordered boolean, max_len int) LANGUAGE plpgsql AS $$
DECLARE
  v_lo content.sort_key := 'a'::content.sort_key;
  v_hi content.sort_key := 'b'::content.sort_key;
  v_new content.sort_key;
  v_ok boolean := true;
  v_max int := 1;
  i int;
BEGIN
  FOR i IN 1..p_n LOOP
    v_new := content.frac_key_at(v_lo, v_hi);
    IF NOT (v_new > v_lo AND v_new < v_hi) THEN v_ok := false; END IF;
    v_max := greatest(v_max, length(v_new));
    v_hi := v_new;               -- always insert immediately after the low bound
  END LOOP;
  RETURN QUERY SELECT v_ok, v_max;
END $$;
SELECT ok((SELECT ordered FROM pg_temp.frac_stress(200)),
  '200 adjacent inserts preserve strict ordering at every step');
SELECT ok((SELECT max_len FROM pg_temp.frac_stress(200)) <= 64,
  '200 adjacent inserts stay inside content.sort_key''s 64-char domain');

SELECT is(content.frac_key_at(1)::text, '0001',
  'dense frac_key_at(1) is fixed-width and never all-zeros');
SELECT ok(content.frac_key_at(1) < content.frac_key_at(62)
      AND content.frac_key_at(62) < content.frac_key_at(3843),
  'dense fixed-width keys sort in numeric order');
SELECT throws_ok($$ SELECT content.frac_key_at(0) $$, '22023', NULL,
  'dense frac_key_at rejects position 0');

-- content.rebalance_siblings(): maintained by 0007_content_model.
--
-- This file used to assert that the function raises `undefined_table` (42P01) until
-- content.nodes lands in P1-03, which was the only behaviour it could have while the table
-- did not exist. 0007 creates content.nodes AND redefines the function — its original body
-- combined FOR UPDATE with row_number(), which PostgreSQL rejects at execution time, so the
-- to_regclass guard had been masking a body that could never have run. Both halves of that
-- change land here, per db/README.md's rule that a later migration redefining an earlier
-- one's objects must maintain the earlier tests:
--
--   * the `has_function` SIGNATURE assertion MOVED to 0007's test.sql, which is the
--     migration that currently defines this signature ("move signature assertions, do not
--     duplicate them" — two files asserting one signature means one of them is stale the
--     next time it changes, and you will not know which);
--   * the BEHAVIOUR that 0001 still owns is the boundary case below. The interesting
--     behaviour — 200 adjacent inserts, order preserved, keys back under 16 characters — is
--     asserted in 0007, with a table to assert it against.
SELECT is(content.rebalance_siblings('ver_0A000000000000000000000000'::app.ulid, NULL), 0,
  'rebalance_siblings returns 0 for a version with no rows rather than raising: a nightly '
  'job over dirty parents must tolerate a parent whose children have since been deleted');

-- ---------------------------------------------------------------------------
-- ULIDs and partition maintenance
-- ---------------------------------------------------------------------------
SELECT matches(app.gen_ulid('svy')::text, '^svy_[0-7][0-9A-HJKMNP-TV-Z]{25}$',
  'gen_ulid produces a domain-valid prefixed ULID');
SELECT is((SELECT count(DISTINCT app.gen_ulid('svy'))::int FROM generate_series(1, 200)),
  200, 'gen_ulid produces 200 distinct ids in a tight loop');
-- B §0's claim that "ULID lexicographic order is creation order" is the reason we pay 30
-- bytes per id instead of 16. Asserted through a plpgsql helper because the evaluation
-- order of two function calls in one SELECT list is not defined, so `gen_ulid() < gen_ulid()`
-- would be a coin flip dressed up as a test.
CREATE FUNCTION pg_temp.ulid_order_ok() RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE a app.ulid; b app.ulid;
BEGIN
  a := app.gen_ulid('svy');
  PERFORM pg_sleep(0.05);
  b := app.gen_ulid('svy');
  RETURN a < b;
END $$;
SELECT ok(pg_temp.ulid_order_ok(),
  'gen_ulid sorts in creation order across a clock tick (B §0)');
SELECT throws_ok($$ SELECT app.gen_ulid('Survey') $$, '22023', NULL,
  'gen_ulid rejects a prefix that would violate the app.ulid domain');

SELECT has_function('ops', 'ensure_event_partitions',
  'ops.ensure_event_partitions() exists');
SELECT lives_ok($$ SELECT ops.ensure_event_partitions(2) $$,
  'ensure_event_partitions is a no-op while no partitioned parent exists');
SELECT lives_ok($$ SELECT ops.ensure_event_partitions(2) $$,
  'ensure_event_partitions is idempotent (it runs on a schedule, twice a month)');
SELECT throws_ok($$ SELECT ops.ensure_event_partitions(999) $$, '22023', NULL,
  'ensure_event_partitions refuses an absurd horizon rather than creating 999 months of DDL');

-- ---------------------------------------------------------------------------
-- JWT claim readers must fail CLOSED, never raise (B §1.1)
-- ---------------------------------------------------------------------------
SELECT is(app.current_org(), NULL, 'current_org() is NULL with no claims set');
SELECT is(app.current_user_id(), NULL, 'current_user_id() is NULL with no claims set');

SELECT set_config('request.jwt.claims', 'this is not json', true);
SELECT is(app.jwt_claims(), NULL, 'jwt_claims() returns NULL for malformed claims');
SELECT is(app.current_org(), NULL, 'current_org() survives malformed claims');
SELECT is(app.current_user_id(), NULL, 'current_user_id() survives malformed claims');

SELECT set_config('request.jwt.claims',
  '{"sub":"not-a-uuid","app_metadata":{"active_org_id":"not-a-ulid"}}', true);
SELECT is(app.current_user_id(), NULL, 'current_user_id() returns NULL for a non-uuid sub');
SELECT is(app.current_org(), NULL,
  'current_org() returns NULL for an active_org_id that is not an app.ulid');
SELECT set_config('request.jwt.claims', '', true);

-- ---------------------------------------------------------------------------
-- Structural: every SECURITY DEFINER function pins its search_path
-- ---------------------------------------------------------------------------
-- A definer function with an unpinned search_path is a privilege-escalation primitive:
-- the caller controls which schema an unqualified name resolves in. This assertion is
-- worth more than any individual policy test because it keeps holding as functions are
-- added.
SELECT is_empty($$
  SELECT n.nspname || '.' || p.proname
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname IN ('app','content','runtime','export','billing','ops')
     AND p.prosecdef
     AND NOT EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig, '{}')) c
                      WHERE c LIKE 'search\_path=%')
$$, 'every SECURITY DEFINER function pins search_path');

SELECT * FROM finish();
ROLLBACK;
