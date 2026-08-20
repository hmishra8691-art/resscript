-- 0001_bootstrap — the deny-by-default baseline every later migration inherits.
--
-- Deliverable B §0 (ground rules), §2 (roles and grants), §12 (RLS catalog assertions),
-- §14 (migration practice); roadmap M0.2. Nothing in Phase 1 is safe to start before this
-- migration exists, because the two catalog assertions at the bottom of this file are what
-- make "a new table without RLS cannot merge" true. Written once, they hold the line for
-- every migration after 0147 that nobody reviews carefully.
--
-- Migration header, mandated by Deliverable B §14 and enforced by
-- tools/ci/lint-migrations.mjs: an ALTER TABLE waiting behind a long read drags an
-- ACCESS EXCLUSIVE lock queue with it and stalls the runtime. Failing fast and retrying
-- is strictly better than blocking.
SET lock_timeout = '3s';
SET statement_timeout = '120s';

-- ---------------------------------------------------------------------------
-- 1. Extensions
-- ---------------------------------------------------------------------------
-- pgcrypto: gen_random_bytes for ULID/token generation and sha256 for invitation tokens.
-- citext:   case-insensitive email on app.invitations (B §1).
-- pg_trgm:  audit_action_trgm_idx (B §10).
-- Deliberately NOT required: pg_cron (scheduling is registered below only if present) and
-- pgmq (the queue in 0003 is plain SQL). See db/README.md.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ---------------------------------------------------------------------------
-- 2. Deny-by-default baseline
-- ---------------------------------------------------------------------------
-- B §2. `public` is world-writable out of the box, which means any authenticated role can
-- create a table there and — worse — shadow a function on an unpinned search_path. Every
-- SECURITY DEFINER function in this codebase pins `search_path = ''`, and this REVOKE is
-- the belt to that braces.
REVOKE ALL ON SCHEMA public FROM PUBLIC;
-- CONNECT and TEMP on the database are also PUBLIC by default; TEMP in particular lets a
-- caller create a temp table that shadows a schema-qualified name on an unpinned
-- search_path.
DO $$
BEGIN
  EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC', current_database());
END $$;

-- ---------------------------------------------------------------------------
-- 3. Supabase-compatible auth shim
-- ---------------------------------------------------------------------------
-- Deliverable B references auth.users(id) and auth.uid(); Supabase provides both. We do
-- not depend on the Supabase CLI (there is no vendor lock-in in the migration path), so
-- this block creates the same shapes only when they are absent. On a Supabase project it
-- is a no-op; on a bare PostgreSQL 16 it is what makes the tenancy FKs resolvable.
CREATE SCHEMA IF NOT EXISTS auth;
COMMENT ON SCHEMA auth IS
  'Identity. Provided by Supabase Auth in hosted environments; created here as a compatible '
  'shim so that migrations run against a bare PostgreSQL (CI, local dev) without the '
  'Supabase CLI. See db/README.md "The auth shim".';

CREATE TABLE IF NOT EXISTS auth.users (
  id         uuid PRIMARY KEY,
  email      text,
  created_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE auth.users IS
  'Shim for Supabase auth.users. Only `id` is load-bearing: app.org_members.user_id and '
  'every audit actor column reference it (Deliverable B §1).';

-- auth.uid() is created in section 7b, once app.current_user_id() exists for it to
-- delegate to.

-- ---------------------------------------------------------------------------
-- 4. Schemas (B §0)
-- ---------------------------------------------------------------------------
-- The split is what makes the ADR-009 grants expressible in one line each: `authoring`
-- gets app+content, `runtime_writer` gets EXECUTE in runtime and nothing else,
-- `analytics_reader` gets SELECT in export. A single schema would force per-table grants
-- and the first forgotten one is a cross-plane read.
CREATE SCHEMA app;
CREATE SCHEMA content;
CREATE SCHEMA runtime;
CREATE SCHEMA export;
CREATE SCHEMA billing;
CREATE SCHEMA ops;

COMMENT ON SCHEMA app IS
  'Control plane: tenancy, projects, surveys, versions, audit, keys (B §0). RLS forced on '
  'every table; reachable by the `authoring` role only.';
COMMENT ON SCHEMA content IS
  'Version-scoped authoring model (B §4). Every table is scoped to a survey_version_id, '
  'never a survey_id (ADR-002: versions are the unit of immutability), and every table '
  'carries the tg_draft_only trigger.';
COMMENT ON SCHEMA runtime IS
  'Data plane: tokens, sessions, events, documents, and the write RPCs. Owned by '
  'runtime_rpc_owner. runtime_writer holds EXECUTE on a handful of SECURITY DEFINER '
  'functions here and no table privilege anywhere (ADR-009).';
COMMENT ON SCHEMA export IS
  'Generated flat export tables, one per survey version (B §11). RLS forced; the generator '
  'emits the policy in the same transaction as the CREATE TABLE.';
COMMENT ON SCHEMA billing IS
  'Plans, features, subscriptions, usage counters (B §10.1). Read-only to authoring; '
  'usage is reporting only — there is deliberately no hard cutoff column (01 §5).';
COMMENT ON SCHEMA ops IS
  'Operational bookkeeping: migrations, jobs, partition maintenance, RLS exemptions. '
  'Service-role only; not granted to authoring, runtime_writer or analytics_reader.';

-- ---------------------------------------------------------------------------
-- 5. Roles (ADR-009, B §2)
-- ---------------------------------------------------------------------------
-- Three distinct database roles plus the owner of the runtime RPCs. NOINHERIT so that
-- `SET ROLE` is the only way to acquire them and privileges never leak through
-- membership. NOBYPASSRLS is the default and is load-bearing: a role with BYPASSRLS makes
-- every policy in this schema decorative.
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['authoring','runtime_writer','analytics_reader',
                           'runtime_rpc_owner','analytics_owner']
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN NOINHERIT NOBYPASSRLS', r);
    END IF;
    -- Idempotent even when the role pre-existed from a previous `reset` (roles are
    -- cluster-global and survive DROP DATABASE).
    EXECUTE format('ALTER ROLE %I NOINHERIT NOBYPASSRLS', r);
  END LOOP;
END $$;

COMMENT ON ROLE authoring IS
  'ADR-009: the RLS-enforced control-plane role. Supabase''s `authenticated` maps here. '
  'Every table it can reach has FORCE ROW LEVEL SECURITY, so a missing policy denies.';
COMMENT ON ROLE runtime_writer IS
  'ADR-009: the data-plane role. Zero table privileges anywhere, by design — the runtime '
  'is the only component exposed to millions of anonymous users and is deployed where its '
  'credential is furthest from our control. Its entire capability surface is EXECUTE on a '
  'few SECURITY DEFINER RPCs in schema runtime, none of which takes an org_id argument.';
COMMENT ON ROLE analytics_reader IS
  'ADR-009: read-only on the generated flat export tables (B §11), which are themselves '
  'RLS-forced. No privilege on app or content.';
COMMENT ON ROLE runtime_rpc_owner IS
  'Owns schema runtime and the SECURITY DEFINER write RPCs, so "definer" means "this role" '
  'rather than "superuser". NOLOGIN: nothing ever connects as it.';
COMMENT ON ROLE analytics_owner IS
  'Owns schema export and the per-version generated tables (B §2), so default privileges '
  'for analytics_reader can be attached to a single role.';

ALTER SCHEMA runtime OWNER TO runtime_rpc_owner;
ALTER SCHEMA export  OWNER TO analytics_owner;

-- B §2: revoke the implicit PUBLIC grant on future objects before any object exists.
ALTER DEFAULT PRIVILEGES IN SCHEMA app, content, runtime, export, billing, ops
  REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA app, content, runtime, export, billing, ops
  REVOKE ALL ON SEQUENCES FROM PUBLIC;
-- Functions are EXECUTE-to-PUBLIC by default, which is the single most commonly
-- overlooked hole in a Postgres authorization model. Deny it globally; every EXECUTE in
-- this codebase is granted by name.
ALTER DEFAULT PRIVILEGES IN SCHEMA app, content, runtime, export, billing, ops
  REVOKE ALL ON FUNCTIONS FROM PUBLIC;

-- Schema-level reachability. Note `authoring` gets USAGE on app/content/billing only;
-- runtime_writer gets USAGE on app purely so the app.ulid / app.sha256 domains in the RPC
-- signatures resolve, and holds no table privilege there (asserted in 0004's test.sql).
GRANT USAGE ON SCHEMA app, content, billing TO authoring;
GRANT USAGE ON SCHEMA runtime TO runtime_writer;
GRANT USAGE ON SCHEMA app TO runtime_writer;
GRANT USAGE ON SCHEMA export TO analytics_reader;
GRANT USAGE ON SCHEMA app TO analytics_reader;

-- Future tables created by the migration runner in app/content are reachable by
-- authoring; RLS is what actually decides the rows (B §2). This is exactly why the
-- catalog assertion below exists: default privileges make forgetting RLS dangerous.
ALTER DEFAULT PRIVILEGES IN SCHEMA app, content
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO authoring;
ALTER DEFAULT PRIVILEGES IN SCHEMA billing GRANT SELECT ON TABLES TO authoring;
ALTER DEFAULT PRIVILEGES FOR ROLE analytics_owner IN SCHEMA export
  GRANT SELECT ON TABLES TO analytics_reader;

-- ---------------------------------------------------------------------------
-- 6. Domains (B §0, Deliverable K §5)
-- ---------------------------------------------------------------------------
CREATE DOMAIN app.ulid AS text
  CHECK (VALUE ~ '^[a-z]{2,5}_[0-7][0-9A-HJKMNP-TV-Z]{25}$');
COMMENT ON DOMAIN app.ulid IS
  'Prefixed ULID, e.g. qst_01H8XG.... 26 Crockford base32 characters (I/L/O/U excluded so '
  'a support ticket cannot be mistranscribed) after a 2-5 letter kind prefix. B §0: we pay '
  '30 bytes over uuid''s 16 because every id in a log line, a JSONB AST or a support ticket '
  'is then self-describing, and ULID lexicographic order is creation order. The leading '
  '[0-7] is the high bit of the 48-bit millisecond timestamp and stays 0 until year 10889.';

CREATE DOMAIN app.ref AS text
  CHECK (VALUE ~ '^[A-Za-z][A-Za-z0-9_]{0,63}$');
COMMENT ON DOMAIN app.ref IS
  'The survey programmer''s handle for an object (Q1, S7a, brand_grid). B §0 / 03 §1: refs '
  'are mutable and are what derived variable names are built from; ids are immutable. '
  'Constrained to a legal identifier in SPSS, R, Stata and a CSV header, because that is '
  'where it ends up.';

CREATE DOMAIN app.sha256 AS text
  CHECK (VALUE ~ '^[0-9a-f]{64}$');
COMMENT ON DOMAIN app.sha256 IS
  'Lowercase hex sha256. ADR-002: compiled artifacts are content-addressed, so an artifact '
  'can be missing but never silently wrong. Lowercase-only because two spellings of the '
  'same hash would defeat the point of addressing by it.';

CREATE DOMAIN content.sort_key AS text COLLATE "C"
  CHECK (VALUE ~ '^[0-9A-Za-z]{1,64}$');
COMMENT ON DOMAIN content.sort_key IS
  'Base-62 fractional ordering key (B §4.6). COLLATE "C" is load-bearing, not cosmetic: '
  'under any linguistic collation ''A'' and ''a'' may sort together or invert, and the '
  'entire premise of a fractional index is that byte order is total and stable. Reordering '
  'a 60-option list is then one UPDATE on one row instead of 60.';

CREATE DOMAIN runtime.survey_token AS text
  CHECK (VALUE ~ '^[0-9a-z]{26}$')
  -- Deliverable K §5 DNS constraints: the token is a hostname label
  -- (<token>.run.<domain>, ADR-005), so it must not be readable as an IPv4-ish label and
  -- must fit in 63 octets. 26 chars satisfies the length bound by construction.
  CHECK (VALUE !~ '^[0-9]+$');
COMMENT ON DOMAIN runtime.survey_token IS
  'Deliverable K §5 (canonical, overriding B §3.2''s ^[0-9A-Za-z]{22}$): 26 characters of '
  'LOWERCASE base-36, ~134 bits from a CSPRNG, never derived from the survey id. Lowercase '
  'is the whole point: ADR-005 puts this token in the hostname, DNS labels are '
  'case-insensitive, so aB... and Ab... would be the same origin but distinct rows and two '
  'live surveys could collide — routing respondents into the wrong study. K: "this must be '
  'fixed before the first token is issued", because rotating tokens after links are in the '
  'field breaks live vendor links irrecoverably.';

-- ---------------------------------------------------------------------------
-- 7. Shared helpers
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.tg_touch_updated_at() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END $$;
COMMENT ON FUNCTION app.tg_touch_updated_at() IS
  'B §0. clock_timestamp() rather than now(): two updates in one transaction must produce '
  'two distinct updated_at values or "last write wins" reconciliation cannot order them.';

CREATE FUNCTION app.gen_ulid(p_prefix text) RETURNS app.ulid
LANGUAGE plpgsql VOLATILE SET search_path = '' AS $$
DECLARE
  k_alphabet constant text := '0123456789ABCDEFGHJKMNPQRSTVWXYZ';  -- Crockford base32
  v_ms   bigint := floor(extract(epoch from clock_timestamp()) * 1000)::bigint;
  v_ts   text := '';
  v_rand text := '';
  v_bytes bytea := public.gen_random_bytes(10);   -- 80 bits of CSPRNG entropy
  v_chunk bigint;
  i int;
  j int;
BEGIN
  IF p_prefix !~ '^[a-z]{2,5}$' THEN
    RAISE EXCEPTION 'ulid prefix % must be 2-5 lowercase letters', p_prefix
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- 48-bit millisecond timestamp -> 10 base32 characters, most significant first, so
  -- lexicographic order equals creation order.
  FOR i IN 1..10 LOOP
    v_ts  := substr(k_alphabet, (v_ms % 32)::int + 1, 1) || v_ts;
    v_ms  := v_ms / 32;
  END LOOP;
  -- 80 random bits -> 16 base32 characters, taken as two 40-bit chunks.
  FOR i IN 0..1 LOOP
    v_chunk := 0;
    FOR j IN 0..4 LOOP
      v_chunk := v_chunk * 256 + get_byte(v_bytes, i * 5 + j);
    END LOOP;
    FOR j IN 1..8 LOOP
      v_rand  := substr(k_alphabet, (v_chunk % 32)::int + 1, 1) || v_rand;
      v_chunk := v_chunk / 32;
    END LOOP;
  END LOOP;
  RETURN (p_prefix || '_' || v_ts || v_rand)::app.ulid;
END $$;
COMMENT ON FUNCTION app.gen_ulid(text) IS
  'Generates a prefixed ULID in the app.ulid domain. Entropy comes from '
  'pgcrypto.gen_random_bytes, not random(): ids appear in URLs and support tickets, and a '
  'guessable id is an enumeration primitive. Server-side generation exists so that SECURITY '
  'DEFINER functions (ops.enqueue_job, app.create_organization) can mint ids without a '
  'round trip; the application also mints them client-side (P1-02).';

-- ---------------------------------------------------------------------------
-- 7b. JWT claim readers (B §1.1)
-- ---------------------------------------------------------------------------
-- These three live in 0001 rather than with the rest of the RLS helpers in 0004 because
-- they read nothing but the request GUC — they have no table dependency — and the
-- Supabase-compatible auth.uid() shim below needs app.current_user_id() to exist before
-- its body will validate. app.has_role(), app.can_see_project(), app.can_see_survey() and
-- app.has_capability() arrive in 0004 with the tables they read.

CREATE FUNCTION app.jwt_claims() RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path = '' AS $$
BEGIN
  RETURN nullif(current_setting('request.jwt.claims', true), '')::jsonb;
EXCEPTION WHEN others THEN
  -- A caller who can set the GUC can set it to garbage. Every helper below is a policy
  -- predicate, and a policy that raises turns a "you see nothing" into a 500 on every
  -- query in the system. Malformed claims must degrade to "no claims", i.e. no access.
  RETURN NULL;
END $$;
COMMENT ON FUNCTION app.jwt_claims() IS
  'B §1.1. Parses request.jwt.claims defensively. The exception handler is the whole point: '
  'unset OR malformed claims both yield NULL, so every predicate built on this fails closed '
  'to "no rows" instead of raising. STABLE so the planner evaluates it once per query, and '
  'search_path pinned to '''' so a caller cannot shadow anything it touches.';

CREATE FUNCTION app.current_user_id() RETURNS uuid
LANGUAGE plpgsql STABLE SET search_path = '' AS $$
BEGIN
  RETURN nullif(app.jwt_claims() ->> 'sub', '')::uuid;
EXCEPTION WHEN others THEN
  RETURN NULL;   -- a non-uuid `sub` is a forged token, not an error condition
END $$;
COMMENT ON FUNCTION app.current_user_id() IS
  'The authenticated user, from the JWT `sub` claim. Returns NULL when unauthenticated or '
  'when the claim is not a uuid; NULL never equals anything, so predicates using it deny.';

CREATE FUNCTION app.current_org() RETURNS app.ulid
LANGUAGE plpgsql STABLE SET search_path = '' AS $$
BEGIN
  RETURN nullif(app.jwt_claims() -> 'app_metadata' ->> 'active_org_id', '')::app.ulid;
EXCEPTION WHEN others THEN
  RETURN NULL;   -- a malformed active_org_id must not raise inside a policy
END $$;
COMMENT ON FUNCTION app.current_org() IS
  'B §1.1, ADR-009. The active org comes from the JWT''s app_metadata, never from a request '
  'parameter: studio switches orgs by re-minting the token, so there is no ?org_id= to '
  'forge. Forging the claim itself gains nothing, because every policy pairs '
  'org_id = current_org() with a membership check (app.has_role), so a claim without a '
  'matching app.org_members row returns zero rows rather than an error — asserted in '
  '0004''s test.sql.';

REVOKE EXECUTE ON FUNCTION app.jwt_claims(), app.current_user_id(), app.current_org()
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.jwt_claims(), app.current_user_id(), app.current_org()
  TO authoring, analytics_reader;

DO $$
BEGIN
  -- Never clobber Supabase's own auth.uid(): it reads the same claim but is maintained by
  -- the platform. On a bare PostgreSQL this shim is what makes Deliverable B's
  -- auth.uid() references resolvable.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'auth' AND p.proname = 'uid' AND p.pronargs = 0
  ) THEN
    EXECUTE $fn$
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE SET search_path = '' AS
      $body$ SELECT app.current_user_id() $body$
    $fn$;
    EXECUTE $c$ COMMENT ON FUNCTION auth.uid() IS
      'Shim delegating to app.current_user_id(). Policies in this codebase call '
      'app.current_user_id() directly so they behave identically with and without Supabase.' $c$;
    EXECUTE 'GRANT USAGE ON SCHEMA auth TO authoring, analytics_reader';
    EXECUTE 'GRANT EXECUTE ON FUNCTION auth.uid() TO authoring, analytics_reader';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 8. Migration bookkeeping
-- ---------------------------------------------------------------------------
CREATE TABLE ops.schema_migrations (
  name        text PRIMARY KEY,
  checksum    app.sha256 NOT NULL,
  applied_at  timestamptz NOT NULL DEFAULT now(),
  applied_by  text NOT NULL DEFAULT current_user,
  duration_ms integer
);
COMMENT ON TABLE ops.schema_migrations IS
  'B §14. One row per applied migration directory. `checksum` is sha256(up.sql): the CLI '
  'refuses to proceed when an already-applied file has changed on disk, which is the only '
  'mechanical difference between "forward-only" and "someone edited 0002 and now staging '
  'and production disagree about the schema".';
COMMENT ON COLUMN ops.schema_migrations.checksum IS
  'sha256 of up.sql at the moment it was applied. A mismatch is a hard error, not a warning.';
COMMENT ON COLUMN ops.schema_migrations.duration_ms IS
  'Wall-clock apply time. Recorded so that "which migration is slow enough to need '
  'CREATE INDEX CONCURRENTLY next time" is a query rather than a memory.';

-- ---------------------------------------------------------------------------
-- 9. RLS / draft-trigger catalog assertions (B §12.1)
-- ---------------------------------------------------------------------------
CREATE TABLE ops.rls_exemptions (
  table_name           text PRIMARY KEY,   -- qualified: schema.table
  reason               text NOT NULL,
  exempt_rls           boolean NOT NULL DEFAULT true,
  exempt_draft_trigger boolean NOT NULL DEFAULT false,
  created_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rls_exemptions_qualified CHECK (table_name ~ '^[a-z_]+\.[a-z_0-9]+$'),
  CONSTRAINT rls_exemptions_reason_nonempty CHECK (length(btrim(reason)) > 8)
);
COMMENT ON TABLE ops.rls_exemptions IS
  'B §12.1. The escape hatch for genuinely global tables. `reason` is NOT NULL with a '
  'length CHECK so that adding an exemption is a code-review conversation rather than a '
  'one-word commit. Stores QUALIFIED names (schema.table) — B §12.1''s sketch compares bare '
  'relnames, which would let an exemption for billing.plans silently exempt an app.plans '
  'added three years later.';
COMMENT ON COLUMN ops.rls_exemptions.exempt_draft_trigger IS
  'Separate axis from RLS: content.reserved_variable_names (P1-03) is global reference data '
  'that needs no draft trigger but still needs RLS.';

INSERT INTO ops.rls_exemptions (table_name, reason, exempt_rls) VALUES
  ('billing.plans',
   'Global plan catalogue, identical for every tenant and readable by all of them; there is '
   'no org_id to filter on. B §12.1.', true),
  ('billing.plan_features',
   'Global plan/feature matrix, same reasoning as billing.plans. B §12.1.', true);

CREATE FUNCTION ops.tables_without_rls() RETURNS SETOF text
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT format('%s.%s', n.nspname, c.relname)
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE c.relkind IN ('r', 'p')
     AND n.nspname IN ('app', 'content', 'billing', 'export')
     AND NOT EXISTS (
       SELECT 1 FROM ops.rls_exemptions e
        WHERE e.table_name = format('%s.%s', n.nspname, c.relname) AND e.exempt_rls)
     AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity)
   ORDER BY 1
$$;
COMMENT ON FUNCTION ops.tables_without_rls() IS
  'B §12.1, ADR-009. Returns every table in app/content/billing/export that lacks ENABLE or '
  'FORCE ROW LEVEL SECURITY. Asserted empty by every migration''s test.sql. This is what '
  'actually holds the line: a hand-written per-table isolation test for migration 0147 would '
  'simply never be written, whereas this one fails CI on its own. FORCE matters separately '
  'from ENABLE because without it the table owner — which every migration runs as — is '
  'exempt from its own policies, so the isolation suite would pass while production leaks. '
  'Partitions are included deliberately: a partition''s own RLS is what governs direct '
  'access to it, and policies are not inherited from the parent.';

CREATE FUNCTION ops.content_tables_without_draft_trigger() RETURNS SETOF text
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT format('content.%s', c.relname)
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE c.relkind IN ('r', 'p')
     AND n.nspname = 'content'
     AND NOT c.relispartition
     AND NOT EXISTS (
       SELECT 1 FROM ops.rls_exemptions e
        WHERE e.table_name = format('content.%s', c.relname) AND e.exempt_draft_trigger)
     AND NOT EXISTS (
       SELECT 1
         FROM pg_trigger t
         JOIN pg_proc p ON p.oid = t.tgfoid
         JOIN pg_namespace pn ON pn.oid = p.pronamespace
        WHERE t.tgrelid = c.oid
          AND NOT t.tgisinternal
          AND pn.nspname = 'content'
          AND p.proname = 'tg_draft_only')
   ORDER BY 1
$$;
COMMENT ON FUNCTION ops.content_tables_without_draft_trigger() IS
  'B §12.1 sibling of ops.tables_without_rls(). ADR-002 makes the version the unit of '
  'immutability, and content rows are version-scoped; a content table without '
  'content.tg_draft_only is a table through which a published survey can be edited under '
  'live respondents. Asserted empty by every migration''s test.sql.';

CREATE FUNCTION content.tg_draft_only() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  v_version app.ulid;
  v_status  text;
BEGIN
  v_version := COALESCE(
    (to_jsonb(NEW) ->> 'survey_version_id'),
    (to_jsonb(OLD) ->> 'survey_version_id'))::app.ulid;
  IF v_version IS NULL THEN
    RAISE EXCEPTION 'content.tg_draft_only attached to %.% which has no survey_version_id',
      TG_TABLE_SCHEMA, TG_TABLE_NAME
      USING ERRCODE = 'feature_not_supported';
  END IF;
  SELECT v.status::text INTO v_status FROM app.survey_versions v WHERE v.id = v_version;
  IF v_status IS NULL THEN
    RAISE EXCEPTION 'survey_version % does not exist', v_version
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF v_status <> 'draft' THEN
    RAISE EXCEPTION 'survey_version % is % and its content is frozen; clone a new draft to edit',
      v_version, v_status
      USING ERRCODE = 'check_violation',
            HINT = 'ADR-002: publishing freezes a version. Editing clones a new draft.';
  END IF;
  RETURN CASE TG_OP WHEN 'DELETE' THEN OLD ELSE NEW END;
END $$;
COMMENT ON FUNCTION content.tg_draft_only() IS
  'ADR-002 / B §4 in executable form: content rows may only be written while their owning '
  'survey_version is a draft. Generic over the table via to_jsonb(NEW), so P1-03 attaches '
  'the same function to nodes, question_items, question_cells, variables, i18n_strings and '
  'the rest without writing seven near-identical triggers. Defined here in 0001, before the '
  'first content table exists, so that ops.content_tables_without_draft_trigger() has '
  'something to look for and the invariant cannot be introduced late. The equivalent '
  'predicate also appears in the RLS policy (B §12) so an editor bug surfaces as '
  '"0 rows updated" rather than an exception mid-transaction.';

-- ---------------------------------------------------------------------------
-- 10. Fractional ordering (B §4.6)
-- ---------------------------------------------------------------------------
CREATE FUNCTION content.frac_key_at(p_before content.sort_key, p_after content.sort_key)
RETURNS content.sort_key
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE
  k_alphabet constant text := '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  v_a text := COALESCE(p_before, '');
  v_b text := COALESCE(p_after,  '');
  v_common int := 0;
  v_da int;
  v_db int;
  v_mid int;
BEGIN
  IF v_b <> '' AND v_a >= v_b THEN
    RAISE EXCEPTION 'frac_key_at: before (%) must sort strictly before after (%)', v_a, v_b
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF v_b <> '' AND v_b ~ '^0+$' THEN
    -- No key can exist between '' and a string of only zeros, because '00' > '0'.
    -- Callers must never issue such a key; rebalance instead.
    RAISE EXCEPTION 'frac_key_at: no key exists below %; rebalance the sibling set', v_b
      USING ERRCODE = 'invalid_parameter_value',
            HINT = 'call content.rebalance_siblings(version, parent)';
  END IF;

  -- Strip the common prefix and recurse on the remainder. Keeps keys short: the whole
  -- point of B §4.6 is that a drag is one UPDATE of one short string.
  WHILE v_common < length(v_a) AND v_common < length(v_b)
        AND substr(v_a, v_common + 1, 1) = substr(v_b, v_common + 1, 1) LOOP
    v_common := v_common + 1;
  END LOOP;
  IF v_common > 0 THEN
    RETURN (substr(v_a, 1, v_common)
            || content.frac_key_at(NULLIF(substr(v_a, v_common + 1), '')::content.sort_key,
                                   NULLIF(substr(v_b, v_common + 1), '')::content.sort_key)
           )::content.sort_key;
  END IF;

  -- -1 encodes "below every digit" (no lower bound); 62 encodes "above every digit".
  v_da := CASE WHEN v_a = '' THEN -1 ELSE strpos(k_alphabet, substr(v_a, 1, 1)) - 1 END;
  v_db := CASE WHEN v_b = '' THEN 62 ELSE strpos(k_alphabet, substr(v_b, 1, 1)) - 1 END;

  IF v_db - v_da >= 2 THEN
    -- Round up so that frac_key_at('a1','a2') = 'a1V', matching B §4.6's worked example.
    v_mid := (v_da + v_db + 1) / 2;
    IF v_mid = 0 THEN
      -- A key must never END in the smallest digit: nothing can be inserted below '…0',
      -- because '…00' sorts ABOVE '…0' (a prefix is always smaller). Emitting '0V'
      -- instead of '0' keeps a digit of headroom underneath and is why the pathological
      -- "always insert immediately after the same sibling" drag sequence converges
      -- instead of hitting a wall.
      RETURN ('0' || content.frac_key_at(NULL::content.sort_key,
                                         NULL::content.sort_key))::content.sort_key;
    END IF;
    RETURN substr(k_alphabet, v_mid + 1, 1)::content.sort_key;
  END IF;

  -- Adjacent digits: keep this digit and go one character deeper.
  IF v_da >= 0 THEN
    RETURN (substr(k_alphabet, v_da + 1, 1)
            || content.frac_key_at(NULLIF(substr(v_a, 2), '')::content.sort_key,
                                   NULL::content.sort_key)
           )::content.sort_key;
  END IF;
  RETURN (substr(k_alphabet, v_db + 1, 1)
          || content.frac_key_at(NULL::content.sort_key,
                                 NULLIF(substr(v_b, 2), '')::content.sort_key)
         )::content.sort_key;
END $$;
COMMENT ON FUNCTION content.frac_key_at(content.sort_key, content.sort_key) IS
  'B §4.6. Returns a base-62 key strictly between two siblings; NULL bound means '
  '"no bound". frac_key_at(''a1'',''a2'') = ''a1V''. Why fractional rather than an integer '
  'position: dragging one option to the top of a 60-option list costs 60 UPDATEs, 60 audit '
  'rows and a guaranteed write-write conflict with a colleague editing an unrelated '
  'sibling, whereas this is one column on one row. Reordering is the most common structural '
  'edit in a survey editor. The cost is key growth (~1 char per adjacent insert), paid '
  'lazily by content.rebalance_siblings(). Comparison relies on content.sort_key''s '
  'COLLATE "C".';

CREATE FUNCTION content.frac_key_at(p_n integer, p_width integer DEFAULT 4)
RETURNS content.sort_key
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE
  k_alphabet constant text := '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  v_n int := p_n;
  v_out text := '';
  i int;
BEGIN
  IF p_n < 1 THEN
    RAISE EXCEPTION 'frac_key_at: dense position must be >= 1 (got %)', p_n
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_n >= power(62, p_width)::bigint THEN
    RAISE EXCEPTION 'frac_key_at: position % does not fit in % base-62 characters', p_n, p_width
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  FOR i IN 1..p_width LOOP
    v_out := substr(k_alphabet, (v_n % 62) + 1, 1) || v_out;
    v_n := v_n / 62;
  END LOOP;
  RETURN v_out::content.sort_key;
END $$;
COMMENT ON FUNCTION content.frac_key_at(integer, integer) IS
  'Dense, FIXED-WIDTH base-62 key for position n (1-based). Used only by '
  'content.rebalance_siblings: fixed width is what makes lexicographic order equal numeric '
  'order, and starting at 1 guarantees no key is all-zeros (which would leave no room to '
  'insert before it). B §4.6 calls this as frac_key_at(row_number()).';

CREATE FUNCTION content.rebalance_siblings(p_version app.ulid, p_parent app.ulid)
RETURNS integer
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  v_count int;
  v_width int;
BEGIN
  IF to_regclass('content.nodes') IS NULL THEN
    RAISE EXCEPTION 'content.nodes does not exist yet; rebalancing activates in P1-03'
      USING ERRCODE = 'undefined_table';
  END IF;
  SELECT count(*) INTO v_count
    FROM content.nodes
   WHERE survey_version_id = p_version AND parent_id IS NOT DISTINCT FROM p_parent;
  IF v_count = 0 THEN RETURN 0; END IF;
  -- One extra character of headroom so the set can grow without an immediate re-rebalance.
  v_width := greatest(4, ceil(ln(greatest(v_count, 2)::numeric) / ln(62::numeric))::int + 1);

  WITH ordered AS (
    SELECT id, row_number() OVER (ORDER BY sort_key, id) AS rn
      FROM content.nodes
     WHERE survey_version_id = p_version AND parent_id IS NOT DISTINCT FROM p_parent
     FOR UPDATE)
  UPDATE content.nodes n
     SET sort_key = content.frac_key_at(o.rn::int, v_width)
    FROM ordered o
   WHERE n.survey_version_id = p_version AND n.id = o.id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END $$;
COMMENT ON FUNCTION content.rebalance_siblings(app.ulid, app.ulid) IS
  'B §4.6. Rewrites one sibling set to short dense keys. Called when max(length(sort_key)) '
  'for a parent exceeds 16 and by a nightly job over dirty parents: O(siblings) writes '
  'amortized over thousands of edits instead of paid on every one. Version-scoped because '
  'content rows are scoped to a survey_version_id, never a survey_id (B §0 ground rule 3) — '
  'rebalancing across versions would rewrite a frozen version''s keys. Signature is '
  '(version, parent), not (parent) alone, for the same reason. Raises undefined_table until '
  'content.nodes lands in P1-03; declared here so the ordering contract has exactly one '
  'implementation from the start.';

-- ---------------------------------------------------------------------------
-- 11. Partition maintenance (B §8.1, §10)
-- ---------------------------------------------------------------------------
CREATE FUNCTION ops.ensure_event_partitions(p_months_ahead integer DEFAULT 3)
RETURNS integer
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  v_month  date;
  v_parent text;
  v_child  text;
  v_made   int := 0;
  i int;
  j int;
BEGIN
  IF p_months_ahead < 0 OR p_months_ahead > 36 THEN
    RAISE EXCEPTION 'ensure_event_partitions: months_ahead must be 0..36 (got %)', p_months_ahead
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  FOR i IN 0..p_months_ahead LOOP
    v_month := (date_trunc('month', now())::date + (i || ' months')::interval)::date;

    -- runtime.response_events: RANGE(created_at) monthly, sub-partitioned HASH by
    -- survey_version_id into 8 (B §8.1). Skipped until P1-08 creates the parent.
    IF to_regclass('runtime.response_events') IS NOT NULL THEN
      v_parent := format('response_events_%s', to_char(v_month, 'YYYYMM'));
      EXECUTE format(
        'CREATE TABLE IF NOT EXISTS runtime.%I PARTITION OF runtime.response_events '
        'FOR VALUES FROM (%L) TO (%L) PARTITION BY HASH (survey_version_id)',
        v_parent, v_month, (v_month + interval '1 month')::date);
      EXECUTE format('ALTER TABLE runtime.%I OWNER TO runtime_rpc_owner', v_parent);
      FOR j IN 0..7 LOOP
        v_child := v_parent || '_h' || j;
        EXECUTE format(
          'CREATE TABLE IF NOT EXISTS runtime.%I PARTITION OF runtime.%I '
          'FOR VALUES WITH (MODULUS 8, REMAINDER %s)', v_child, v_parent, j);
        EXECUTE format('ALTER TABLE runtime.%I OWNER TO runtime_rpc_owner', v_child);
      END LOOP;
      v_made := v_made + 1;
    END IF;

    -- app.audit_log: RANGE(created_at) monthly, 24 months online (B §10).
    IF to_regclass('app.audit_log') IS NOT NULL THEN
      v_child := format('audit_log_%s', to_char(v_month, 'YYYYMM'));
      EXECUTE format(
        'CREATE TABLE IF NOT EXISTS app.%I PARTITION OF app.audit_log '
        'FOR VALUES FROM (%L) TO (%L)',
        v_child, v_month, (v_month + interval '1 month')::date);
      -- A partition's own RLS is what governs direct access to it: policies are NOT
      -- inherited from the parent, so a partition left unprotected is a way to read
      -- another tenant's audit trail by naming the child table. Enabling RLS with no
      -- policy of its own denies all direct access, while queries routed through
      -- app.audit_log continue to use the parent's policies.
      EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY', v_child);
      EXECUTE format('ALTER TABLE app.%I FORCE ROW LEVEL SECURITY', v_child);
      v_made := v_made + 1;
    END IF;
  END LOOP;
  RETURN v_made;
END $$;
COMMENT ON FUNCTION ops.ensure_event_partitions(integer) IS
  'B §8.1. Idempotently premakes monthly partitions for runtime.response_events (with its '
  '8-way hash sub-partitions) and app.audit_log, skipping either parent until the migration '
  'that creates it has run. Never called lazily at insert time: a respondent''s submit must '
  'not depend on DDL succeeding. Scheduled below via pg_cron where available. Returns the '
  'number of parent months touched.';

DO $$
BEGIN
  -- pg_cron is present on Supabase and absent on a bare PostgreSQL. The schedule is
  -- registered where possible and the absence is a NOTICE rather than a failed migration,
  -- so CI does not require an extension it cannot install. db/README.md records the
  -- external scheduler fallback.
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.schedule('ensure-event-partitions', '0 3 1,15 * *',
                          $c$SELECT ops.ensure_event_partitions(3)$c$);
  ELSE
    RAISE NOTICE 'pg_cron not installed: schedule ops.ensure_event_partitions(3) externally '
                 '(see db/README.md "Partition maintenance")';
  END IF;
END $$;

-- Baseline: no partitioned parents exist yet, so this is a no-op that proves the function
-- is callable. 0004 creates app.audit_log and calls it again.
SELECT ops.ensure_event_partitions(3);
