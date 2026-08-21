-- 0009_artifacts/test.sql — pgTAP. The token that keeps two surveys off one origin, the
-- publish transaction, and the five-second rollback.
--
-- What this file has to prove:
--   * THE R8 REGRESSION, which is the most important thing here: the token domain accepts
--     Deliverable K §5's 26-character lowercase base-36 and REJECTS an uppercase token, a
--     22-character token (B §3.2's superseded length), a non-base-36 character and an
--     all-digits label — and the generator only ever produces values the domain accepts. The
--     failure this prevents is not a 404: ADR-005 puts the token in a hostname, DNS labels are
--     case-insensitive, so under a mixed-case alphabet two rows here share one origin and a
--     respondent following a vendor link is served another survey's artifact;
--   * the domain's CHECK is asserted from the CATALOG as well as behaviourally, so widening
--     the alphabet with ALTER DOMAIN fails by name rather than silently;
--   * runtime.survey_tokens has RLS enabled AND forced — asserted from pg_class directly,
--     because ops.tables_without_rls() scans app/content/billing/export and cannot see schema
--     runtime — and exactly one policy, for exactly one role;
--   * publish writes the token row and the version's artifact_hash TOGETHER, and a failed
--     publish leaves NEITHER, with the previously live version still production (K §3,
--     Deliverable A §7);
--   * K §1's two floors: publish-to-production is project_manager, publish-to-staging is
--     programmer, and a reviewer is neither;
--   * rollback moves production to the intended version, leaves exactly ONE production row,
--     and the row that refuses a second one is app.sv_one_production — and the bytes it
--     serves are byte-identical to what was live before, because no version's artifact_hash
--     was ever rewritten (ADR-002);
--   * the runtime path: runtime.resolve_token resolves a live token to an artifact hash, and
--     returns ZERO ROWS for the uppercase spelling of that same token;
--   * ADR-009's negative capability is unchanged — runtime_writer cannot SELECT content.nodes,
--     cannot SELECT this new table, holds EXECUTE on no function in schema app, and gained no
--     table grant anywhere;
--   * cross-tenant: org A cannot publish, roll back or read org B's tokens, and a forged
--     active_org_id yields zero rows from the read path rather than an error.
--
-- A note on the isolation assertions' SHAPE, because it differs from every earlier suite and
-- the difference is deliberate. Elsewhere cross-tenant reads are "zero rows, not an error",
-- because the table is reachable and RLS filters it. This table is NOT reachable from
-- `authoring` at all — schema runtime carries no USAGE for it (0001, ADR-001's plane
-- boundary) — so the direct assertions below are `42501 DENIED`, which is strictly stronger
-- than filtered-to-zero. The "zero rows rather than an error" property then belongs to
-- app.survey_tokens_for_version, the definer function that IS the control plane's read path,
-- and it is asserted there against both a forged active_org_id and another org's version.
BEGIN;
SELECT plan(99);

-- pgTAP lives in schema `public`, hardened by 0001's REVOKE ALL ... FROM PUBLIC. Granted
-- inside this transaction, which is rolled back, exactly as 0004's, 0007's and 0008's suites
-- do. runtime_rpc_owner is on the list because one assertion reads this table AS the RPC
-- owner, to prove the policy holds and not merely the function body's WHERE clause.
GRANT USAGE ON SCHEMA public TO authoring, runtime_writer, analytics_reader, runtime_rpc_owner;

SELECT set_config('rs.ids', ops.test_seed_two_orgs()::text, true);

CREATE FUNCTION pg_temp.tid(k text) RETURNS text LANGUAGE sql STABLE AS
$$ SELECT current_setting('rs.ids', true)::jsonb ->> k $$;

CREATE FUNCTION pg_temp.act_as(p_user uuid, p_org text, p_role text DEFAULT 'authoring')
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', p_user, 'role', p_role,
                      'app_metadata', json_build_object('active_org_id', p_org))::text,
    true);
  EXECUTE format('SET LOCAL ROLE %I', p_role);
END $$;

-- Version ids built here rather than through ops.test_ulid, for the reason 0008's pg_temp.rid
-- gives: `authoring` has no USAGE on schema ops (ADR-009 — the studio role cannot reach the
-- job queue or the fixtures), and most of the statements below run as `authoring`. Same
-- construction, same readable shape: vid('B3') is always ver_0B30000000000000000000000.
CREATE FUNCTION pg_temp.vid(p_tag text) RETURNS app.ulid LANGUAGE sql IMMUTABLE AS
$$ SELECT ('ver_0' || rpad(upper(p_tag), 25, '0'))::app.ulid $$;

-- The hash ops.test_seed_two_orgs() gave org A's production version, captured BEFORE anything
-- in this file publishes over it. The rollback assertion at the end compares against this
-- value: "the runtime serves byte-identical bytes to what was live before" is exactly the
-- claim that this string, read out of the token row after a rollback, is the same string.
SELECT set_config('rs.hash_a1',
  (SELECT artifact_hash FROM app.survey_versions
    WHERE id = pg_temp.tid('ver_a_frozen')::app.ulid), true);
SELECT set_config('rs.hash_v2',
  'aaaa1111bbbb2222cccc3333dddd4444eeee5555ffff6666aaaa7777bbbb8888', true);
SELECT set_config('rs.hash_v3',
  '0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f', true);

-- ---------------------------------------------------------------------------
-- 1. Shape (B §3.2, §13)
-- ---------------------------------------------------------------------------
SELECT has_table('runtime', 'survey_tokens',
  'runtime.survey_tokens exists (B §3.2): the one thing the runtime reads from Postgres, as '
  'its own denormalized table rather than a join across app.surveys and app.survey_versions');
SELECT col_is_pk('runtime', 'survey_tokens', 'token',
  'the TOKEN is the primary key (B §13: "3.3 #1 token -> artifact, WHERE token = $1"), so '
  'the respondent-entry hot path is a single-row lookup on a unique index');
SELECT col_type_is('runtime', 'survey_tokens', 'token', 'runtime.survey_token',
  'and its type is the DOMAIN, not text: the alphabet is enforced by the column rather than '
  'by whichever writer remembered it (Deliverable K §5)');
SELECT col_not_null('runtime', 'survey_tokens', 'artifact_hash',
  'artifact_hash is NOT NULL — a narrowing of B §3.2, where it is nullable. This column IS '
  'the answer to "which bytes does this URL serve"; a row that cannot answer it is a 500 for '
  'a respondent a panel vendor has already counted as an entrant');
SELECT col_not_null('runtime', 'survey_tokens', 'org_id',
  'org_id is NOT NULL on every row (ADR-009), even in the schema whose reader has no org');
SELECT col_default_is('runtime', 'survey_tokens', 'is_test', 'false',
  'is_test defaults to false, the SAFE direction: a token written without it collects real '
  'data rather than silently marking a live study''s responses as test');
SELECT hasnt_column('runtime', 'survey_tokens', 'quota_policy',
  'B §3.2''s quota_policy is deliberately NOT here yet: nothing in P1-08 writes or reads it, '
  'and a column nothing writes is the table equivalent of a grant with no consumer. It '
  'arrives with P1-12, which is also when the artifact starts carrying the plan it mirrors');
SELECT has_index('runtime', 'survey_tokens', 'tokens_live_key',
  'at most one LIVE token per (survey, is_test): this is the index that makes republishing '
  'repoint a URL instead of minting a new one, which K §5 requires because rotating tokens '
  'after links are in the field breaks live vendor links irrecoverably');
SELECT has_index('runtime', 'survey_tokens', 'survey_tokens_version_idx',
  'B §3.2''s index on survey_version_id — "which URLs point at the version I am about to '
  'archive"');
SELECT has_trigger('runtime', 'survey_tokens', 'tokens_touch',
  'updated_at is maintained by trigger: during an incident it is the difference between a '
  'rollback that took effect and a rollback that returned success');
SELECT fk_ok('runtime', 'survey_tokens', ARRAY['org_id', 'survey_version_id'],
             'app', 'survey_versions', ARRAY['org_id', 'id'],
  'the composite FK (org_id, survey_version_id) is what keeps the denormalized org_id honest '
  '(ADR-009), exactly as on every other table here');

SELECT is_empty($$
  SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'runtime' AND c.relname = 'survey_tokens'
     AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity)
$$, 'runtime.survey_tokens has RLS ENABLED and FORCED — asserted from pg_class directly, '
    'because ops.tables_without_rls() scans app/content/billing/export (B §12''s list) and '
    'therefore cannot see schema runtime at all. The guard that has caught every other table '
    'is blind to this one, which is why this assertion is spelled out rather than delegated');
SELECT policies_are('runtime', 'survey_tokens', ARRAY['tokens_rpc_read'],
  'exactly ONE policy, for SELECT, for runtime_rpc_owner. Every other command has no policy '
  'at all, which is a deliberate deny: writes happen only inside app.publish_version and '
  'app.rollback_version, the same asymmetry 0004 used to make app.write_audit_event the only '
  'writer of app.audit_log');
SELECT policy_cmd_is('runtime', 'survey_tokens', 'tokens_rpc_read', 'SELECT',
  'and it is a SELECT policy specifically, never FOR ALL — a read predicate that doubles as a '
  'write predicate is a hole nobody reviews');

SELECT has_function('app', 'publish_version',
  ARRAY['app.ulid', 'app.sha256', 'bigint', 'app.version_status', 'jsonb', 'jsonb', 'text'],
  'app.publish_version exists with the signature this migration defines');
SELECT is_definer('app', 'publish_version',
  ARRAY['app.ulid', 'app.sha256', 'bigint', 'app.version_status', 'jsonb', 'jsonb', 'text'],
  'and it is SECURITY DEFINER: it writes a table in schema runtime, which the calling role '
  'cannot reach, and that crossing is the whole reason publish is a function rather than DML');
SELECT has_function('app', 'rollback_version', ARRAY['app.ulid', 'text'],
  'app.rollback_version exists');
SELECT has_function('app', 'survey_tokens_for_version', ARRAY['app.ulid'],
  'app.survey_tokens_for_version exists — H §2.7''s GET /v1/versions/{id}/tokens, and the '
  'studio''s only way to learn a survey''s public URL');
SELECT has_function('runtime', 'gen_survey_token', ARRAY[]::text[],
  'runtime.gen_survey_token exists: the ONE place a token is minted');
SELECT has_function('runtime', 'upsert_survey_token', ARRAY['app.ulid', 'boolean'],
  'runtime.upsert_survey_token exists: the ONE place the token table is written');
SELECT volatility_is('runtime', 'resolve_token', ARRAY['text'], 'stable',
  'runtime.resolve_token is STABLE (0004 created it as a placeholder; this migration replaced '
  'the body and the signature is unchanged, so 0004 keeps its privilege assertions)');
SELECT is_empty($$
  SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'runtime' AND p.proname = 'resolve_token'
     AND NOT ('statement_timeout=3s' = ANY (coalesce(p.proconfig, '{}')))
$$, 'and it still pins statement_timeout = 3s (B §2). An edge caller must fail fast rather '
    'than hold a connection open while the control plane is having a bad day');

-- ---------------------------------------------------------------------------
-- 2. THE R8 REGRESSION: the token alphabet
-- ---------------------------------------------------------------------------
-- Deliverable K §5 vs B §3.2. Everything in this block is one assertion: a token is a DNS
-- label, DNS labels are case-insensitive, so a mixed-case or shorter alphabet is a
-- cross-survey confusion bug rather than a style preference.
SELECT lives_ok($$ SELECT 'abcdefghij0123456789klmnop'::runtime.survey_token $$,
  'a 26-character LOWERCASE base-36 token is accepted (Deliverable K §5, and '
  'SURVEY_TOKEN_PATTERN in packages/schema/src/registries.ts)');
SELECT throws_ok($$ SELECT 'aBcdefghij0123456789klmnop'::runtime.survey_token $$,
  '23514', NULL,
  'AN UPPERCASE CHARACTER IS REJECTED. This is the assertion this migration exists for: '
  'ADR-005 serves every survey from <token>.run.<domain>, DNS labels are case-INSENSITIVE, so '
  'aB... and Ab... would be two distinct rows in this table resolving to ONE origin. The '
  'failure mode is a respondent following a vendor link into survey A and being served '
  'survey B''s artifact, with survey B''s quotas, invisible until an analyst finds the wrong '
  'completes in the wrong study (roadmap risk R8)');
SELECT throws_ok($$ SELECT 'abcdefghij0123456789kl'::runtime.survey_token $$, '23514', NULL,
  'a 22-CHARACTER token is rejected. 22 is B §3.2''s length, chosen for base-62; 22 '
  'characters of base-36 is ~113 bits, below the 128-bit floor that choice was aiming for, '
  'and this token is an unauthenticated bearer capability — guessing one is entering a live '
  'survey. K §5''s 26 characters give ~134 bits and still fit a 63-octet DNS label');
SELECT throws_ok($$ SELECT 'abcdefghij0123456789klmno-'::runtime.survey_token $$,
  '23514', NULL,
  'a non-base-36 character is rejected, even one DNS itself would allow (a hyphen): the '
  'alphabet is 0-9a-z and nothing else, so the database''s idea of a token and the '
  'generator''s cannot diverge by one punctuation mark');
SELECT throws_ok($$ SELECT '01234567890123456789012345'::runtime.survey_token $$,
  '23514', NULL,
  'an ALL-DIGITS token is rejected by the domain''s second CHECK: an all-digits label can be '
  'read as an IPv4-ish hostname component by resolvers and proxies (Deliverable K §5''s DNS '
  'constraints). runtime.gen_survey_token redraws rather than emitting one');
SELECT throws_like($$
  INSERT INTO runtime.survey_tokens
    (token, org_id, survey_id, survey_version_id, artifact_hash, status)
  VALUES ('ABCDEFGHIJ0123456789KLMNOP',
          current_setting('rs.ids')::jsonb ->> 'org_a',
          current_setting('rs.ids')::jsonb ->> 'svy_a',
          current_setting('rs.ids')::jsonb ->> 'ver_a_frozen',
          current_setting('rs.hash_a1'), 'production')
$$, '%survey_token%',
  'and the COLUMN carries the domain, not just the type name: an uppercase token cannot be '
  'inserted even by the table owner, who bypasses RLS entirely. The alphabet is not a '
  'convention the writers agree to keep');

-- The catalog form of the same guarantee. Behavioural assertions catch a bad value; this one
-- catches a future ALTER DOMAIN that widens the alphabet, which would make every behavioural
-- assertion above pass for the wrong reason.
SELECT is(
  (SELECT pg_get_constraintdef(oid) FROM pg_constraint
    WHERE contypid = 'runtime.survey_token'::regtype AND conname = 'survey_token_check'),
  'CHECK ((VALUE ~ ''^[0-9a-z]{26}$''::text))',
  'the domain''s CHECK is EXACTLY SURVEY_TOKEN_PATTERN from '
  'packages/schema/src/registries.ts, character for character. Three copies of one pattern '
  'exist on purpose (this domain, that constant, and the runtime''s hostname assertion) '
  'because they live in three languages; this is the assertion that stops them drifting, and '
  'it fails by name if somebody widens the alphabet back to B §3.2''s base-62');

SELECT is(
  (SELECT count(DISTINCT t)::int FROM
     (SELECT runtime.gen_survey_token() AS t FROM generate_series(1, 40)) g),
  40,
  '40 generated tokens are 40 distinct tokens: ~134 bits from pgcrypto''s gen_random_bytes, '
  'never derived from the survey id (K §5). Not a birthday-paradox test — it is a test that '
  'the generator is drawing entropy at all, which is what a hard-coded or seeded generator '
  'would fail');
SELECT is_empty($$
  SELECT t FROM (SELECT runtime.gen_survey_token()::text AS t FROM generate_series(1, 40)) g
   WHERE t !~ '^[0-9a-z]{26}$' OR t ~ '^[0-9]+$'
$$, 'and every one of them satisfies the domain the column enforces, including the '
    'all-digits exclusion. The generator uses rejection sampling rather than modulo (256 is '
    'not a multiple of 36, so `byte % 36` alone would make the first four letters ~14% more '
    'likely), and this is the assertion that would fail if it were replaced by a modulo');

-- ---------------------------------------------------------------------------
-- 3. Publish (P1-08, K §3)
-- ---------------------------------------------------------------------------
SELECT pg_temp.act_as(pg_temp.tid('user_a')::uuid, pg_temp.tid('org_a'));

SELECT throws_ok($$ SELECT 1 FROM runtime.survey_tokens LIMIT 1 $$, '42501', NULL,
  '`authoring` cannot read runtime.survey_tokens AT ALL — DENIED, not filtered to zero rows. '
  'It holds no USAGE on schema runtime (0001) and this migration grants none: ADR-001''s '
  'plane boundary is a GRANT list, and the studio''s read path is the definer function '
  'asserted in §7');

SELECT lives_ok($$
  SELECT set_config('rs.tok_test',
    app.publish_version(
      (current_setting('rs.ids')::jsonb ->> 'ver_a_draft')::app.ulid,
      current_setting('rs.hash_v2')::app.sha256,
      4096, 'staging',
      '[{"code":"CMP-0701","severity":"warning","path":"/questions/0"}]'::jsonb,
      '["CMP-0701:qst_a1"]'::jsonb) ->> 'token', true)
$$, 'publishing a draft to STAGING succeeds for an org-wide owner: one call records the '
    'artifact, flips compile_state, moves status and writes the token row');
SELECT matches(current_setting('rs.tok_test'), '^[0-9a-z]{26}$',
  'and the token it returned is a legal K §5 token — the value that will appear in a '
  'hostname');
SELECT results_eq($$
  SELECT status::text, compile_state::text, artifact_hash::text, artifact_bytes
    FROM app.survey_versions
   WHERE id = current_setting('rs.ids')::jsonb ->> 'ver_a_draft'
$$, $$ VALUES ('staging', 'compiled',
               current_setting('rs.hash_v2'), 4096::bigint) $$,
  'the version now carries the artifact and the compile state IN THE SAME ROW as the live '
  'status, which is what makes 0004''s sv_live_needs_compiled ("a version may only enter '
  'staging or production with compile_state = ''compiled''", K §3) satisfiable by one UPDATE');
SELECT is(
  (SELECT compile_diagnostics -> 0 ->> 'code' FROM app.survey_versions
    WHERE id = pg_temp.tid('ver_a_draft')::app.ulid),
  'CMP-0701',
  'the compile diagnostics are recorded on the VERSION, not left on the ops.jobs row that '
  'produced them: the job is retained for a while and the version forever, and "why can I '
  'not publish this" outlives any queue');
SELECT is(
  (SELECT acknowledged_warnings -> 0 FROM app.survey_versions
    WHERE id = pg_temp.tid('ver_a_draft')::app.ulid),
  '"CMP-0701:qst_a1"'::jsonb,
  'and 03 §17''s warning acknowledgement is recorded in the SAME statement that freezes the '
  'version — which is when the sign-off actually happens, and after which '
  'app.tg_version_guard seals the column so "who signed off on shipping this" is evidence');

SELECT lives_ok($$
  SELECT set_config('rs.tok_live',
    app.publish_version(
      (current_setting('rs.ids')::jsonb ->> 'ver_a_draft')::app.ulid,
      current_setting('rs.hash_v2')::app.sha256, 4096, 'production') ->> 'token', true)
$$, 'and the same version then publishes to PRODUCTION (staging -> production is the '
    'transition app.tg_version_guard permits; draft -> production is not, and §4 asserts it)');
SELECT isnt(current_setting('rs.tok_live'), current_setting('rs.tok_test'),
  'the live URL and the review URL are DIFFERENT tokens for the same version. That is what '
  'tokens_live_key''s (survey, is_test) key means, and it is what makes a soft launch '
  'expressible: the review link keeps marking its sessions is_test while pointing at a '
  'version that is now in production');
SELECT is(
  (SELECT count(*)::int FROM app.survey_versions
    WHERE survey_id = pg_temp.tid('svy_a')::app.ulid AND status = 'production'),
  1,
  'EXACTLY ONE production version for the survey: publishing archived the incumbent in the '
  'same transaction, so "which version are respondents seeing" stays a single row (K §3, '
  'app.sv_one_production)');
SELECT is(
  (SELECT status::text FROM app.survey_versions
    WHERE id = pg_temp.tid('ver_a_frozen')::app.ulid),
  'archived',
  'and the version that WAS live is archived rather than deleted — which is precisely what '
  'makes it a rollback target with its own untouched artifact_hash');

RESET ROLE;
SELECT results_eq($$
  SELECT is_test, survey_version_id::text, artifact_hash::text, status::text
    FROM runtime.survey_tokens
   WHERE survey_id = current_setting('rs.ids')::jsonb ->> 'svy_a'
   ORDER BY is_test
$$, $$ VALUES (false, current_setting('rs.ids')::jsonb ->> 'ver_a_draft',
               current_setting('rs.hash_v2'), 'production'),
              (true,  current_setting('rs.ids')::jsonb ->> 'ver_a_draft',
               current_setting('rs.hash_v2'), 'production') $$,
  'both token rows point at the published version and BOTH read status = ''production'': '
  'status is denormalized from the version (B §3.2), so the upsert resyncs every live token '
  'of the survey in the same transaction. Without that, the review link would still claim '
  '''staging'' after the version behind it went live');
SELECT is(
  (SELECT count(*)::int FROM runtime.survey_tokens
    WHERE survey_id = pg_temp.tid('svy_a')::app.ulid),
  2, 'two token rows for the survey and no more: publish REPOINTS, it does not accumulate');

SELECT pg_temp.act_as(pg_temp.tid('user_a')::uuid, pg_temp.tid('org_a'));
SELECT is(
  (SELECT app.publish_version(
     pg_temp.tid('ver_a_draft')::app.ulid,
     current_setting('rs.hash_v3')::app.sha256, 5120, 'production') ->> 'token'),
  current_setting('rs.tok_live'),
  'REPUBLISHING RETURNS THE SAME TOKEN. A recompile of a production version does not change '
  'status; it repoints artifact_hash (K §3). If it minted a new token instead, every vendor '
  'link already in the field would 404 — K §5: "rotating tokens after links are in the field '
  'means breaking live vendor links, which is not recoverable"');
RESET ROLE;
SELECT is(
  (SELECT artifact_hash::text FROM runtime.survey_tokens
    WHERE survey_id = pg_temp.tid('svy_a')::app.ulid AND NOT is_test),
  current_setting('rs.hash_v3'),
  'and the token now serves the NEW bytes at the same URL, which is the whole content-'
  'addressing story: the URL is stable, the hash it points at is not (ADR-002)');

-- --- K §1's two floors -----------------------------------------------------
SELECT pg_temp.act_as(pg_temp.tid('user_a2')::uuid, pg_temp.tid('org_a'));
SELECT throws_ok($$
  SELECT app.publish_version(
    (current_setting('rs.ids')::jsonb ->> 'ver_a_draft')::app.ulid,
    current_setting('rs.hash_v2')::app.sha256, 4096, 'production')
$$, '42501', NULL,
  'a REVIEWER cannot publish to production. K §1 puts publish on project_manager (rank 50); '
  'a reviewer is 20, and a review link over a frozen version — which is what this user has — '
  'is a read capability, not a release one');
SELECT throws_ok($$
  SELECT app.publish_version(
    (current_setting('rs.ids')::jsonb ->> 'ver_a_draft')::app.ulid,
    current_setting('rs.hash_v2')::app.sha256, 4096, 'staging')
$$, '42501', NULL,
  'nor to staging, which K §1 puts on programmer (40)');

-- --- cross-tenant and forged claims ---------------------------------------
SELECT pg_temp.act_as(pg_temp.tid('user_a')::uuid, pg_temp.tid('org_a'));
SELECT throws_ok($$
  SELECT app.publish_version(
    (current_setting('rs.ids')::jsonb ->> 'ver_b_draft')::app.ulid,
    current_setting('rs.hash_v2')::app.sha256, 4096, 'production')
$$, '42501', NULL,
  'org A''s owner cannot publish org B''s version. Note the message says only "is not '
  'publishable by this caller": ONE error for "no such version", "not your org" and "not '
  'permitted", because distinguishing them is an existence oracle across tenants');
SELECT pg_temp.act_as(pg_temp.tid('user_a')::uuid, pg_temp.tid('org_b'));
SELECT throws_ok($$
  SELECT app.publish_version(
    (current_setting('rs.ids')::jsonb ->> 'ver_b_draft')::app.ulid,
    current_setting('rs.hash_v2')::app.sha256, 4096, 'production')
$$, '42501', NULL,
  'and FORGING active_org_id to org B does not help: app.has_role() reads app.org_members and '
  'there is no membership row, so the org predicate and the role predicate both fail '
  '(ADR-009, P1-01 acceptance)');

SELECT pg_temp.act_as(pg_temp.tid('user_a')::uuid, pg_temp.tid('org_a'));
SELECT throws_ok($$
  SELECT app.publish_version(
    (current_setting('rs.ids')::jsonb ->> 'ver_a_draft')::app.ulid,
    current_setting('rs.hash_v2')::app.sha256, 4096, 'draft')
$$, '22023', NULL,
  'publishing to ''draft'' is refused: draft and review are authoring states, and a publish '
  'target that is not a live status is a caller bug, not a lifecycle move');
SELECT throws_ok($$
  SELECT app.publish_version(
    (current_setting('rs.ids')::jsonb ->> 'ver_a_draft')::app.ulid,
    current_setting('rs.hash_v2')::app.sha256, 4096, 'archived')
$$, '22023', NULL,
  'and neither is ''archived'': reaching archived is app.rollback_version''s job or a '
  'retirement, never a publish');

-- ---------------------------------------------------------------------------
-- 4. A failed publish leaves NEITHER the token nor the hash (K §3, A §7)
-- ---------------------------------------------------------------------------
-- Org B is pristine here, which is what makes the assertions non-vacuous: its draft has no
-- artifact and its survey has no token row at all.
SELECT pg_temp.act_as(pg_temp.tid('user_b')::uuid, pg_temp.tid('org_b'));
SELECT throws_ok($$
  SELECT app.publish_version(
    (current_setting('rs.ids')::jsonb ->> 'ver_b_draft')::app.ulid,
    current_setting('rs.hash_v2')::app.sha256, 4096, 'production')
$$, '23514', NULL,
  'publishing a DRAFT straight to production raises: app.tg_version_guard permits '
  'draft -> staging and staging -> production and not the shortcut, so the review gate cannot '
  'be skipped by passing a different argument');
SELECT results_eq($$
  SELECT status::text, compile_state::text, artifact_hash
    FROM app.survey_versions
   WHERE id = current_setting('rs.ids')::jsonb ->> 'ver_b_draft'
$$, $$ VALUES ('draft', 'none', NULL::app.sha256) $$,
  'and the failed publish left NOTHING on the version — not the artifact hash, not the '
  'compile state — even though the function had already written both before the status UPDATE '
  'raised. One function call is one statement, so it rolls back as a unit');
RESET ROLE;   -- the token table is unreachable from `authoring`; this read is the owner's
SELECT is(
  (SELECT count(*)::int FROM runtime.survey_tokens
    WHERE survey_id = pg_temp.tid('svy_b')::app.ulid),
  0, 'no token row was created either: the URL and the hash move together or not at all');
SELECT is(
  (SELECT status::text FROM app.survey_versions
    WHERE id = pg_temp.tid('ver_b_frozen')::app.ulid),
  'production',
  'and the version that was live is STILL LIVE — the incumbent''s demotion rolled back with '
  'everything else. This is K §3''s guarantee in one assertion: "a failed publish always '
  'leaves the previously live artifact serving" (Deliverable A §7)');

SELECT pg_temp.act_as(pg_temp.tid('user_b')::uuid, pg_temp.tid('org_b'));
SELECT throws_like($$
  SELECT app.publish_version(
    (current_setting('rs.ids')::jsonb ->> 'ver_b_draft')::app.ulid,
    current_setting('rs.hash_v2')::app.sha256, 4096, 'staging', 'null'::jsonb)
$$, '%sv_diagnostics_is_array%',
  'a jsonb scalar `null` for compile_diagnostics is rejected by name. It satisfies NOT NULL '
  'and is exactly as unrenderable, and the code that would hit it is the publish dialog — '
  'the screen a user is looking at while trying to ship (the argument 0008 makes for '
  'content.logic_rules.condition)');
SELECT is(
  (SELECT artifact_hash FROM app.survey_versions
    WHERE id = pg_temp.tid('ver_b_draft')::app.ulid),
  NULL, 'and that publish left nothing behind either');

-- --- the floors, from the other side: a programmer may publish to staging --
SELECT pg_temp.act_as(pg_temp.tid('user_b2')::uuid, pg_temp.tid('org_b'));
SELECT lives_ok($$
  SELECT app.publish_version(
    (current_setting('rs.ids')::jsonb ->> 'ver_b_draft')::app.ulid,
    current_setting('rs.hash_v2')::app.sha256, 2048, 'staging')
$$, 'a PROGRAMMER scoped to one project publishes that project''s survey to STAGING — K §1: '
    '"full survey authoring including custom code; publish to staging"');
SELECT throws_ok($$
  SELECT app.publish_version(
    (current_setting('rs.ids')::jsonb ->> 'ver_b_draft')::app.ulid,
    current_setting('rs.hash_v2')::app.sha256, 2048, 'production')
$$, '42501', NULL,
  'and the SAME caller cannot publish the SAME version to production. That difference is why '
  'publish is a function: 0004''s sv_update policy sees an UPDATE and not an intent, so it '
  'cannot express "programmer to staging, project_manager to production" — the function has '
  'the intent in its argument list');

-- ---------------------------------------------------------------------------
-- 5. Rollback (B §3.1, P1-08 acceptance)
-- ---------------------------------------------------------------------------
SELECT pg_temp.act_as(pg_temp.tid('user_a')::uuid, pg_temp.tid('org_a'));
SELECT is(
  (SELECT app.rollback_version(pg_temp.tid('ver_a_frozen')::app.ulid) ->> 'token'),
  current_setting('rs.tok_live'),
  'ROLLBACK repoints the SAME token: the public URL does not change, because the URL is what '
  'is printed on a vendor contract and the artifact behind it is what was wrong');
SELECT results_eq($$
  SELECT id::text FROM app.survey_versions
   WHERE survey_id = current_setting('rs.ids')::jsonb ->> 'svy_a' AND status = 'production'
$$, $$ VALUES (current_setting('rs.ids')::jsonb ->> 'ver_a_frozen') $$,
  'production is now the rolled-back-to version, and it is the ONLY production row: demote '
  'then promote, in that order, in one transaction, so "at most one production version" is '
  'never observably violated');
SELECT is(
  (SELECT status::text FROM app.survey_versions
    WHERE id = pg_temp.tid('ver_a_draft')::app.ulid),
  'archived', 'and the version that was live is archived, which makes rolling FORWARD again '
              'the same call with the other id');
RESET ROLE;
SELECT is(
  (SELECT artifact_hash::text FROM runtime.survey_tokens
    WHERE survey_id = pg_temp.tid('svy_a')::app.ulid AND NOT is_test),
  current_setting('rs.hash_a1'),
  'THE ACCEPTANCE CRITERION: the live token now serves BYTE-IDENTICAL bytes to what was live '
  'before, verified by hash comparison — this string was captured from the seed before '
  'anything in this file published over it. Nothing in app.rollback_version rewrites a '
  'version''s artifact_hash; the archived version still names the artifact it named while it '
  'was live, and ADR-002 addresses artifacts by the sha256 of their own content, so '
  '"identical bytes" follows from the hash never having been touched rather than from a '
  'backup');
SELECT is(
  (SELECT status::text FROM runtime.survey_tokens
    WHERE survey_id = pg_temp.tid('svy_a')::app.ulid AND is_test),
  'archived',
  'and the REVIEW link''s denormalized status resynced to ''archived'' in the same '
  'transaction: it still points at the version that was just demoted, and a review link that '
  'claims to be production is how somebody QAs the wrong artifact');

SELECT throws_like($$
  UPDATE app.survey_versions SET status = 'production'
   WHERE id = current_setting('rs.ids')::jsonb ->> 'ver_a_draft'
$$, '%sv_one_production%',
  'and THE INDEX is what refuses a second production version — app.sv_one_production, a '
  'partial unique index, named in the error. Asserted as the OWNER, who bypasses RLS: the '
  'invariant is not a policy, not a trigger and not a convention inside '
  'app.rollback_version, which is exactly why that function demotes before it promotes');

SELECT pg_temp.act_as(pg_temp.tid('user_a')::uuid, pg_temp.tid('org_a'));
SELECT performs_ok($$
  SELECT app.rollback_version(
    (current_setting('rs.ids')::jsonb ->> 'ver_a_draft')::app.ulid)
$$, 5000,
  'rolling FORWARD again completes in under 5 seconds (P1-08''s acceptance criterion says '
  '"under 5 seconds"), and needs no separate code path: undoing a rollback is the same '
  'function with the other version id');
SELECT results_eq($$
  SELECT id::text FROM app.survey_versions
   WHERE survey_id = current_setting('rs.ids')::jsonb ->> 'svy_a' AND status = 'production'
$$, $$ VALUES (current_setting('rs.ids')::jsonb ->> 'ver_a_draft') $$,
  'and production is back on the newer version, still exactly one row');

SELECT throws_like($$
  SELECT app.rollback_version(
    (current_setting('rs.ids')::jsonb ->> 'ver_a_draft')::app.ulid)
$$, '%not archived%',
  'rolling back to the version that is ALREADY production is refused: rollback is '
  'archived -> production, and promoting anything else is a publish, which has a different '
  'floor and writes an artifact');
SELECT throws_ok($$
  SELECT app.rollback_version(
    (current_setting('rs.ids')::jsonb ->> 'ver_b_frozen')::app.ulid)
$$, '42501', NULL,
  'and org A cannot roll back org B''s survey — same single message, same reason');
SELECT pg_temp.act_as(pg_temp.tid('user_a2')::uuid, pg_temp.tid('org_a'));
SELECT throws_ok($$
  SELECT app.rollback_version(
    (current_setting('rs.ids')::jsonb ->> 'ver_a_frozen')::app.ulid)
$$, '42501', NULL,
  'nor may a reviewer roll back: rollback changes what respondents are seeing, so K §1 puts '
  'it on project_manager alongside publish');

-- A version that was never compiled cannot be rolled back TO, even though it is archived and
-- app.tg_version_guard would happily permit the transition.
RESET ROLE;
INSERT INTO app.survey_versions
  (id, org_id, survey_id, version_no, status, compile_state, schema_version, created_by)
VALUES (ops.test_ulid('ver', 'B3'), pg_temp.tid('org_b')::app.ulid,
        pg_temp.tid('svy_b')::app.ulid, 3, 'draft', 'none', 1,
        pg_temp.tid('user_b')::uuid);
UPDATE app.survey_versions SET status = 'review' WHERE id = ops.test_ulid('ver', 'B3');
UPDATE app.survey_versions SET status = 'archived' WHERE id = ops.test_ulid('ver', 'B3');
SELECT pg_temp.act_as(pg_temp.tid('user_b')::uuid, pg_temp.tid('org_b'));
SELECT throws_like($$
  SELECT app.rollback_version(pg_temp.vid('B3'))
$$, '%no usable artifact%',
  'an archived version with compile_state = ''none'' is refused as a rollback target. '
  '0004''s two CHECKs would each pass alone — sv_live_needs_compiled reads compile_state, '
  'sv_compiled_needs_artifact reads the hash — and only together do they mean "there are '
  'bytes to serve", so the check is restated here where the error can name the rollback');

RESET ROLE;
UPDATE app.survey_versions SET status = 'archived'
 WHERE id = pg_temp.tid('ver_b_frozen')::app.ulid;
SELECT pg_temp.act_as(pg_temp.tid('user_b')::uuid, pg_temp.tid('org_b'));
SELECT throws_like($$
  SELECT app.rollback_version(
    (current_setting('rs.ids')::jsonb ->> 'ver_b_frozen')::app.ulid)
$$, '%no production version%',
  'and a survey with nothing live has nothing to roll back FROM: that is a publish, and '
  'saying so is better than promoting a version and leaving the caller to wonder which of '
  'the two operations happened');

-- ---------------------------------------------------------------------------
-- 6. The runtime path (B §2, ADR-009, risk R3)
-- ---------------------------------------------------------------------------
RESET ROLE;
SET LOCAL ROLE runtime_writer;
SELECT results_eq($$
  SELECT survey_version_id::text, artifact_hash::text, is_test, status::text
    FROM runtime.resolve_token(current_setting('rs.tok_live'))
$$, $$ VALUES (current_setting('rs.ids')::jsonb ->> 'ver_a_draft',
               current_setting('rs.hash_v3'), false, 'production') $$,
  'THE RUNTIME PATH, end to end: 01 §3.3 step 1 resolves a public token to an artifact hash, '
  'and returns those four columns and NOTHING ELSE — no org, no survey name, no project, '
  'because every extra column is a cross-tenant leak waiting for a bug (B §2). This is the '
  'placeholder 0004 created for P1-08, now reading a real table');
SELECT is_empty($$ SELECT * FROM runtime.resolve_token(upper(current_setting('rs.tok_live'))) $$,
  'THE UPPERCASE SPELLING OF A REAL TOKEN RESOLVES TO NOTHING. resolve_token does not '
  'lower(), trim() or normalize: adding case folding would reintroduce exactly the collision '
  'the lowercase alphabet exists to prevent (R8) — one origin, two rows, and now the database '
  'agreeing to serve both. Deliverable G §3.1 requires the runtime to assert hostname-label '
  '== path-token byte-for-byte and 404 on mismatch; this is the database half of that');
SELECT is_empty($$ SELECT * FROM runtime.resolve_token('zzzzzzzzzzzzzzzzzzzzzzzzzz') $$,
  'an unknown but well-formed token resolves to zero rows rather than an error — the same '
  'reason P1-01 insists a forged active_org_id yields zero rows: an error is an oracle');
SELECT is_empty($$ SELECT * FROM runtime.resolve_token('not a token') $$,
  'and a malformed one is rejected by the regex pre-check before any index lookup, which is '
  'what stops a respondent-supplied hostname label from costing a query');
SELECT is_empty($$ SELECT * FROM runtime.resolve_token(NULL) $$,
  'NULL resolves to nothing rather than raising: this function is on the anonymous path and '
  'must have no failure mode that a request can trigger');
SELECT throws_ok($$ SELECT 1 FROM content.nodes LIMIT 1 $$, '42501', NULL,
  'runtime_writer STILL cannot SELECT from content.nodes — the CI test ADR-001 asks for by '
  'name, restated on the migration that gave the runtime its first real table to read');
SELECT throws_ok($$ SELECT 1 FROM runtime.survey_tokens LIMIT 1 $$, '42501', NULL,
  'and it cannot read runtime.survey_tokens either, in its own schema. That is risk R3 held '
  'at the line: a leaked edge credential can resolve tokens one at a time — which it can '
  'already do with a URL — and cannot ENUMERATE them');
SELECT throws_ok($$
  SELECT app.publish_version(
    (current_setting('rs.ids')::jsonb ->> 'ver_a_draft')::app.ulid,
    current_setting('rs.hash_v2')::app.sha256, 1, 'production')
$$, '42501', NULL,
  'nor may it publish: the plane boundary cuts both ways, and the data plane holds EXECUTE on '
  'no function in schema app at all (asserted from the catalog in §7)');

RESET ROLE;
UPDATE runtime.survey_tokens SET revoked_at = now()
 WHERE survey_id = pg_temp.tid('svy_a')::app.ulid AND is_test;
SELECT set_config('rs.tok_revoked',
  (SELECT token::text FROM runtime.survey_tokens
    WHERE survey_id = pg_temp.tid('svy_a')::app.ulid AND is_test), true);
SET LOCAL ROLE runtime_writer;
SELECT is_empty($$ SELECT * FROM runtime.resolve_token(current_setting('rs.tok_revoked')) $$,
  'a REVOKED token resolves to nothing while its row remains in the table: "this link is '
  'dead" and "this link was never issued" are different answers six months later, and only '
  'one of them is explainable to a support desk');
RESET ROLE;
SET LOCAL ROLE runtime_rpc_owner;
SELECT is_empty($$
  SELECT token::text FROM runtime.survey_tokens WHERE revoked_at IS NOT NULL
$$, 'and the revoked row is invisible to runtime_rpc_owner through the POLICY, not merely '
    'through resolve_token''s WHERE clause — so deleting that predicate from the function '
    'body would still not resurrect a revoked link');
SELECT isnt_empty($$
  SELECT token::text FROM runtime.survey_tokens WHERE revoked_at IS NULL
$$, 'while the live rows are readable: the RPC owner holds SELECT and one policy, which is '
    'the entire read surface of the data plane in this schema');

-- --- the control plane's read path (H §2.7) --------------------------------
RESET ROLE;
SELECT pg_temp.act_as(pg_temp.tid('user_a')::uuid, pg_temp.tid('org_a'));
SELECT results_eq($$
  SELECT token, is_test FROM app.survey_tokens_for_version(
    (current_setting('rs.ids')::jsonb ->> 'ver_a_draft')::app.ulid)
   ORDER BY is_test
$$, $$ VALUES (current_setting('rs.tok_live'), false),
              (current_setting('rs.tok_revoked'), true) $$,
  'H §2.7''s GET /v1/versions/{id}/tokens: the studio learns its survey''s public URLs '
  'through a definer function, because `authoring` cannot reach schema runtime. The REVOKED '
  'token is included on purpose — an empty list and "that link is dead" are different '
  'answers');
SELECT pg_temp.act_as(pg_temp.tid('user_a2')::uuid, pg_temp.tid('org_a'));
SELECT is_empty($$
  SELECT token FROM app.survey_tokens_for_version(
    (current_setting('rs.ids')::jsonb ->> 'ver_a_draft')::app.ulid)
$$, 'a reviewer gets ZERO ROWS rather than an error: H §2.7 puts this endpoint at PM+, and a '
    'public survey URL is a live entry point, not review material');
SELECT pg_temp.act_as(pg_temp.tid('user_a')::uuid, pg_temp.tid('org_a'));
SELECT is_empty($$
  SELECT token FROM app.survey_tokens_for_version(
    (current_setting('rs.ids')::jsonb ->> 'ver_b_draft')::app.ulid)
$$, 'org A asking for org B''s version gets ZERO ROWS, not an error — the org_id comparison '
    'happens INSIDE the definer, against app.current_org()');
SELECT pg_temp.act_as(pg_temp.tid('user_a')::uuid, pg_temp.tid('org_b'));
SELECT is_empty($$
  SELECT token FROM app.survey_tokens_for_version(
    (current_setting('rs.ids')::jsonb ->> 'ver_b_draft')::app.ulid)
$$, 'and a FORGED active_org_id yields zero rows rather than an error (ADR-009, P1-01 '
    'acceptance): app.has_role() reads app.org_members, finds no membership row, and returns '
    'false instead of raising, so a cross-tenant probe cannot even confirm the version exists');

-- ---------------------------------------------------------------------------
-- 7. The standing guards, after everything above has finished mutating
-- ---------------------------------------------------------------------------
RESET ROLE;
SELECT is_empty($$ SELECT ops.tables_without_rls() $$,
  'ops.tables_without_rls() is still empty. Note it says nothing about this migration''s '
  'table: it scans app/content/billing/export, and runtime.survey_tokens is asserted '
  'directly in §1 for exactly that reason');
SELECT is_empty($$ SELECT ops.content_tables_without_draft_trigger() $$,
  'ops.content_tables_without_draft_trigger() is still empty. runtime.survey_tokens carries a '
  'survey_version_id and deliberately has NO draft trigger: that trigger refuses any write '
  'whose version is not a draft, and every row in this table is written at the moment its '
  'version stops being one. Attaching it would make publishing impossible');
SELECT is_empty($$ SELECT ops.functions_executable_by_public() $$,
  'and nothing in the six schemas is executable by PUBLIC — five new functions, five explicit '
  'REVOKEs, because ALTER DEFAULT PRIVILEGES does not close PUBLIC EXECUTE (0006)');
SELECT is_empty($$
  SELECT n.nspname || '.' || p.proname
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname IN ('app','content','runtime','export','billing','ops')
     AND p.prosecdef
     AND NOT EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig, '{}')) c
                      WHERE c LIKE 'search\_path=%')
$$, 'every SECURITY DEFINER function still pins search_path: an unpinned one is a '
    'privilege-escalation primitive, because the caller controls which schema an unqualified '
    'name resolves in');

SELECT is_empty($$
  SELECT n.nspname || '.' || c.relname || ':' || a.privilege_type
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    CROSS JOIN LATERAL aclexplode(c.relacl) a
   WHERE n.nspname IN ('app','content','runtime')
     AND c.relkind IN ('r','p','v','m')
     AND c.relacl IS NOT NULL
     AND a.grantee = 'runtime_writer'::regrole
$$, 'runtime_writer holds NO privilege on any table in app, content OR runtime — 0004''s '
    'catalog assertion widened by one schema, because this is the migration that put a table '
    'the runtime cares about in it. Its capability surface is still two function signatures '
    '(risk R3)');
SELECT is_empty($$
  SELECT n.nspname || '.' || c.relname || ':' || a.privilege_type
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    CROSS JOIN LATERAL aclexplode(c.relacl) a
   WHERE n.nspname IN ('app','content','runtime')
     AND c.relacl IS NOT NULL
     AND a.grantee IN ('analytics_reader'::regrole, 'authoring'::regrole)
     AND c.relname = 'survey_tokens'
$$, 'and neither analytics_reader nor authoring holds anything on runtime.survey_tokens: the '
    'exports plane has no business in the token table and the control plane reaches it only '
    'through app.survey_tokens_for_version');
SELECT table_privs_are('runtime', 'survey_tokens', 'runtime_rpc_owner', ARRAY['SELECT'],
  'runtime_rpc_owner holds SELECT and ONLY SELECT. It owns the RPC, not the table: ownership '
  'follows the WRITER (the control-plane definer functions), so the runtime''s read is one '
  'line of ACL and one line of policy — both visible in the catalog and both revocable — '
  'rather than an ownership that cannot be narrowed');

SELECT is_empty($$
  SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   CROSS JOIN LATERAL aclexplode(p.proacl) a
   WHERE n.nspname = 'runtime'
     AND p.proname IN ('gen_survey_token', 'upsert_survey_token')
     AND a.grantee <> p.proowner
$$, 'the token MINT and the token WRITER are executable by no role at all — reachable only '
    'from app.publish_version and app.rollback_version. That is what makes the table''s total '
    'absence of write policies a guarantee rather than a gap, and it is what keeps "every '
    'token came out of one CSPRNG through one alphabet" (R8) greppable');
SELECT is_empty($$
  SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'app'
     AND has_function_privilege('runtime_writer', p.oid, 'EXECUTE')
$$, 'runtime_writer holds EXECUTE on NO function in schema app. Phrased over the catalog '
    'rather than against app.publish_version''s signature, per db/README.md: "re-signing the '
    'function silently changed what that line tested"');
SELECT is(
  has_function_privilege('authoring',
    'app.publish_version(app.ulid,app.sha256,bigint,app.version_status,jsonb,jsonb,text)',
    'EXECUTE'),
  true, 'while `authoring` — the role a real HTTP caller has — holds EXECUTE on '
        'app.publish_version, which is the only way it can write anything in schema runtime');
SELECT is(
  has_function_privilege('authoring', 'app.rollback_version(app.ulid,text)', 'EXECUTE'),
  true, 'and on app.rollback_version');

SELECT is_empty($$
  SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'runtime'
     AND EXISTS (SELECT 1 FROM unnest(coalesce(p.proargnames, '{}')) an
                  WHERE an ~ 'org')
$$, 'STILL no function in schema runtime accepts an org id (B §2), including the two this '
    'migration added: runtime.upsert_survey_token takes a version id and DERIVES org_id, '
    'survey_id, artifact_hash and status from the version row. A parameter for org_id would '
    'be a way to write a token into another tenant');

SELECT * FROM finish();
ROLLBACK;
