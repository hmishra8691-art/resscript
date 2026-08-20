-- 0006_revoke_public_execute — close PUBLIC EXECUTE, and add the catalog assertion that
-- keeps it closed.
--
-- Found while repairing 0003's test.sql after 0005 re-signed the job RPCs. The old
-- assertion named one signature:
--
--   has_function_privilege('authoring', 'ops.enqueue_job(…,integer,uuid)', 'EXECUTE') = false
--
-- Rewritten signature-free — "authoring holds EXECUTE on NO function in schema ops" — it
-- failed, naming nine functions. The cause:
--
--   ALTER DEFAULT PRIVILEGES IN SCHEMA app, content, runtime, export, billing, ops
--     REVOKE ALL ON FUNCTIONS FROM PUBLIC;      -- migration 0001
--
-- IS A NO-OP. On PostgreSQL 16 that statement stores no pg_default_acl row at all (verified:
-- `SELECT * FROM pg_default_acl` shows entries for TABLES, from the GRANT statements beside
-- it, and nothing for FUNCTIONS), and a function created afterwards still has proacl = NULL,
-- which means the built-in default — EXECUTE TO PUBLIC. Adding a GRANT first so there is a
-- row to revoke from does not help either: the stored default ACL is simply not applied to
-- new functions. So the line in 0001 was decorative, and every function created in these
-- six schemas since has been executable by PUBLIC.
--
-- What that actually exposed. Reachability needs USAGE on the schema as well as EXECUTE on
-- the function, and `authoring` has no USAGE on ops, so the ops functions were not callable
-- today. But `authoring` DOES have USAGE on app and content, which left
-- content.frac_key_at, content.rebalance_siblings and app.gen_ulid callable by every
-- authenticated user; and the ops list included two SECURITY DEFINER functions that write
-- rows outside RLS — ops.test_seed_two_orgs and app.tg_org_has_owner — one GRANT USAGE away
-- from being an arbitrary-write primitive. "One GRANT away" is not a security property.
--
-- The fix is therefore not a better default: it is an explicit sweep plus a catalog
-- assertion, exactly the shape ops.tables_without_rls() has. A convention that the next
-- migration must remember to REVOKE would be forgotten by migration 0147; an assertion
-- that fails CI and names the function will not be.
SET lock_timeout = '3s';
SET statement_timeout = '60s';

-- ---------------------------------------------------------------------------
-- 1. The catalog assertion
-- ---------------------------------------------------------------------------
CREATE FUNCTION ops.functions_executable_by_public() RETURNS SETOF text
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT pg_catalog.format('%s.%s(%s)', n.nspname, p.proname,
                           pg_catalog.pg_get_function_identity_arguments(p.oid))
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname IN ('app', 'content', 'runtime', 'export', 'billing', 'ops')
     -- proacl IS NULL means "built-in default", and for a FUNCTION the built-in default
     -- includes EXECUTE TO PUBLIC. This is the case that is easy to miss, because nothing
     -- in the catalog looks like a grant.
     AND (p.proacl IS NULL
          OR EXISTS (SELECT 1 FROM pg_catalog.aclexplode(p.proacl) a
                      WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'))
   ORDER BY 1
$$;
COMMENT ON FUNCTION ops.functions_executable_by_public() IS
  'Third catalog assertion, sibling to ops.tables_without_rls() and '
  'ops.content_tables_without_draft_trigger(): returns every function in the six owned '
  'schemas that PUBLIC may execute. Asserted empty by 0006''s test.sql. There is '
  'deliberately NO exemption table — unlike RLS, where billing.plans is genuinely global, '
  'nothing in these schemas should ever be callable by PUBLIC. If a function needs to be '
  'reachable, GRANT it to the named role that needs it, which is a decision a reviewer can '
  'see. Detects the proacl IS NULL case specifically, because that is the one that looks '
  'like an absence of grants rather than the presence of one, and it is why '
  '"ALTER DEFAULT PRIVILEGES … REVOKE ALL ON FUNCTIONS FROM PUBLIC" in 0001 silently '
  'protected nothing.';

-- ---------------------------------------------------------------------------
-- 2. The sweep
-- ---------------------------------------------------------------------------
-- Driven from the catalog rather than a hand-written list, so it cannot be out of date
-- with respect to what 0001-0005 actually created.
DO $$
DECLARE
  r record;
  v_n int := 0;
BEGIN
  FOR r IN
    SELECT format('%I.%I(%s)', n.nspname, p.proname,
                  pg_get_function_identity_arguments(p.oid)) AS sig
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname IN ('app', 'content', 'runtime', 'export', 'billing', 'ops')
     ORDER BY 1
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', r.sig);
    v_n := v_n + 1;
  END LOOP;
  RAISE NOTICE '0006: revoked PUBLIC EXECUTE on % function(s)', v_n;
END $$;

-- ---------------------------------------------------------------------------
-- 3. Re-grant what the sweep legitimately broke
-- ---------------------------------------------------------------------------
-- app.gen_ulid is the DEFAULT expression on the primary key of app.organizations,
-- app.projects, app.surveys, app.survey_versions, app.invitations, app.capability_grants,
-- app.audit_log and ops.jobs. A column DEFAULT is evaluated with the INSERTING user's
-- privileges — unlike a trigger function, whose EXECUTE is checked at CREATE TRIGGER time
-- and never again — so without this grant every authoring INSERT fails with
-- "permission denied for function gen_ulid" BEFORE any constraint or policy is evaluated.
-- That failure mode is nasty precisely because it masks the error the caller expected: the
-- P1-01 suite's "an owner cannot be created by invitation" assertion would have started
-- reporting 42501 instead of the 23514 that proves the CHECK fired.
GRANT EXECUTE ON FUNCTION app.gen_ulid(text) TO authoring;

-- Nothing else needs re-granting today, and that is worth stating rather than leaving
-- implicit:
--   * Trigger functions (app.tg_touch_updated_at, app.tg_version_guard,
--     app.tg_org_has_owner, content.tg_draft_only) keep firing: PostgreSQL checks EXECUTE
--     on a trigger function when the trigger is created, not when it fires. Verified.
--   * content.frac_key_at and content.rebalance_siblings are deliberately left ungranted.
--     They have no consumer until content.nodes exists; P1-03 grants them to `authoring`
--     in the migration that gives them something to order.
--   * The ops job RPCs stay ungranted. apps/worker connects as the service role that owns
--     the queue, and the studio reads job state through app.get_job (0005), which is in a
--     schema authoring can actually reach.
--   * app.* helpers already carried explicit REVOKE + GRANT pairs from 0001/0002/0004, so
--     the sweep was a no-op for them. That is the pattern every new function should follow.

-- ---------------------------------------------------------------------------
-- 4. What 0001 should have said
-- ---------------------------------------------------------------------------
-- 0001's ALTER DEFAULT PRIVILEGES line is left in place rather than corrected: it is
-- already applied everywhere, migrations are immutable once applied (Deliverable B §14),
-- and editing it would trip the migration CLI's checksum guard for every environment that
-- has run it. It is harmless — merely ineffective. The correct mechanism is this
-- migration's assertion, and db/README.md records the trap under "PUBLIC EXECUTE is not
-- closed by default privileges" so the next person to write
-- `ALTER DEFAULT PRIVILEGES … ON FUNCTIONS` knows it buys nothing.
