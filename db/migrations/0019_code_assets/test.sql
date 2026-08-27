-- 0019_code_assets — tests.
--
-- What is worth asserting here is what the table makes IMPOSSIBLE. The columns are unremarkable;
-- the value is in the constraints, and each one below corresponds to a specific way a code asset
-- could otherwise be stored in a state a later reader would act on wrongly:
--
--   * a script with no `runs_on` — ADR-005's "vulnerability, not a mistake";
--   * a stylesheet WITH a `runs_on` — a security model attached to something that never executes;
--   * a supplied `sha256` that disagrees with the source — a CSP that blocks or over-permits;
--   * a sanitizer report with no analyzer version — an archive that reads as current;
--   * a write to a frozen version — ADR-002, both layers.

BEGIN;
SELECT plan(36);

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

-- A legible id from a legible tag. The 'V' terminator and the translate() are 0016's, for the
-- reasons stated there: zero-padding alone is not injective, and Crockford base32 aliases I/L/O.
CREATE FUNCTION pg_temp.aid(p_tag text) RETURNS app.ulid LANGUAGE sql IMMUTABLE AS
$$ SELECT ('ast_0' || rpad(translate(upper(p_tag), 'ILOU', '110V') || 'V', 25, '0'))::app.ulid $$;

/* ---------------------------------------------------------------- *
 * 0. The precondition content.source_sha256 depends on
 * ---------------------------------------------------------------- */

-- `source_sha256` claims IMMUTABLE over a STABLE `convert_to`, and that claim is sound only
-- because the encoding argument is a literal and a database's encoding is fixed at creation. This
-- is the check that the literal matches reality. If it ever fails, every stored hash and every
-- index built on one is suspect — which is precisely why it is asserted rather than assumed.
SELECT is(
  (SELECT pg_encoding_to_char(encoding)::text FROM pg_database WHERE datname = current_database()),
  'UTF8'::text,
  'the database is UTF8, which is what makes content.source_sha256''s IMMUTABLE claim true rather '
  'than a lie to the planner');

SELECT is(
  content.source_sha256('survey.setValue("A", 1);'),
  encode(sha256(convert_to('survey.setValue("A", 1);', 'UTF8')), 'hex'),
  'and it computes the same digest the compiler does');

-- The regression 0006's standing check caught on this migration's first run: a function created
-- after ALTER DEFAULT PRIVILEGES is still world-executable, so each needs an explicit REVOKE.
-- Asserted here as well as there, so the next person to add a function to this file sees it fail
-- in the file they are editing.
SELECT ok(
  NOT has_function_privilege('public', 'content.source_sha256(text)', 'EXECUTE')
  AND NOT has_function_privilege('public', 'content.array_is_distinct(text[])', 'EXECUTE'),
  'neither new function is executable by PUBLIC');

/* ---------------------------------------------------------------- *
 * 1. Structure
 * ---------------------------------------------------------------- */

SELECT has_table('content', 'code_assets', 'content.code_assets exists');
SELECT has_column('content', 'code_assets', 'sanitizer_report',
  'the sanitizer verdict is stored, not only logged');
SELECT col_type_is('content', 'code_assets', 'sanitizer_report', 'jsonb',
  'the report is jsonb, so a reader can index it by key');

SELECT col_hasnt_default('content', 'code_assets', 'runs_on',
  'runs_on has NO default: a default picks one of two security models for an author who did not '
  'say which they meant');

SELECT has_type('content', 'script_target', 'the client/server registry is an ENUM in content');
SELECT has_type('content', 'code_asset_kind', 'the three code kinds are one discriminated registry');

SELECT has_index('content', 'code_assets', 'code_assets_unanalyzed_idx',
  'the sanitizer backlog is indexed, partially');

SELECT ok(
  (SELECT relforcerowsecurity FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'content' AND c.relname = 'code_assets'),
  'RLS is FORCED, so the owner is not exempt');

SELECT ok(
  EXISTS (SELECT 1 FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'content' AND c.relname = 'code_assets'
     AND t.tgname = 'code_assets_draft_only'),
  'ADR-002''s draft-only trigger is present — the layer that catches a writer RLS does not');

-- The grant that must NOT exist. ADR-001: the runtime reads code from the pinned artifact, never
-- from the authoring tables, which is what makes a mid-field edit unable to change what a
-- respondent executes.
SELECT ok(
  NOT has_table_privilege('runtime_writer', 'content.code_assets', 'SELECT'),
  'runtime_writer cannot read content.code_assets — the plane boundary holds for code too');

/* ---------------------------------------------------------------- *
 * 2. sha256 is generated, and cannot be wrong
 * ---------------------------------------------------------------- */

SELECT pg_temp.act_as(pg_temp.tid('user_a')::uuid, pg_temp.tid('org_a'));

INSERT INTO content.code_assets
  (id, survey_version_id, org_id, kind, ref, source, runs_on, scope, hooks)
VALUES (pg_temp.aid('sa'), pg_temp.tid('ver_a_draft')::app.ulid,
        pg_temp.tid('org_a')::app.ulid, 'script', 'S_A', 'survey.setValue("A", 1);',
        'client', 'survey', ARRAY['onPageLoad']);

SELECT is(
  (SELECT sha256 FROM content.code_assets WHERE ref = 'S_A' AND kind = 'script'),
  content.source_sha256('survey.setValue("A", 1);'),
  'sha256 is the digest of the stored bytes');

SELECT throws_ok(
  $$ UPDATE content.code_assets SET sha256 = 'deadbeef' WHERE ref = 'S_A' $$,
  '428C9', NULL,
  'a supplied sha256 is refused outright — a hash a writer promises is a hash that can be wrong');

-- And it follows the source, so an edit cannot leave a stale hash behind.
UPDATE content.code_assets SET source = 'survey.setValue("A", 2);'
 WHERE ref = 'S_A' AND kind = 'script';
SELECT is(
  (SELECT sha256 FROM content.code_assets WHERE ref = 'S_A' AND kind = 'script'),
  content.source_sha256('survey.setValue("A", 2);'),
  'the hash follows the source, so an edit cannot leave a CSP pointing at bytes that are gone');

/* ---------------------------------------------------------------- *
 * 3. The per-kind shape constraints
 * ---------------------------------------------------------------- */

SELECT throws_ok(
  format($ins$INSERT INTO content.code_assets
              (id, survey_version_id, org_id, kind, ref, source, scope)
            VALUES (%L, %L, %L, 'script', 'S_NO_TARGET', 'x', 'survey')$ins$,
    pg_temp.aid('nt'), pg_temp.tid('ver_a_draft'), pg_temp.tid('org_a')),
  '23514', NULL,
  'a script with no runs_on is unstorable — ADR-005''s "vulnerability, not a mistake"');

SELECT throws_ok(
  format($ins$INSERT INTO content.code_assets
              (id, survey_version_id, org_id, kind, ref, source, runs_on)
            VALUES (%L, %L, %L, 'css', 'C_A', 'body{}', 'server')$ins$,
    pg_temp.aid('ca'), pg_temp.tid('ver_a_draft'), pg_temp.tid('org_a')),
  '23514', NULL,
  'a stylesheet with runs_on is unstorable too — the biconditional catches BOTH mistakes, not '
  'only the missing half');

SELECT throws_ok(
  format($ins$INSERT INTO content.code_assets
              (id, survey_version_id, org_id, kind, ref, source, hooks)
            VALUES (%L, %L, %L, 'html_template', 'T_A', '<p></p>', ARRAY['onPageLoad'])$ins$,
    pg_temp.aid('ta'), pg_temp.tid('ver_a_draft'), pg_temp.tid('org_a')),
  '23514', NULL,
  'a template cannot carry hooks — it has no execution to hook into');

SELECT throws_ok(
  format($ins$INSERT INTO content.code_assets
              (id, survey_version_id, org_id, kind, ref, source, runs_on, scope, hooks)
            VALUES (%L, %L, %L, 'script', 'S_BAD', 'x', 'client', 'survey',
                    ARRAY['onWhenever'])$ins$,
    pg_temp.aid('sb'), pg_temp.tid('ver_a_draft'), pg_temp.tid('org_a')),
  '23514', NULL,
  'a hook outside SCRIPT_HOOKS is refused');

SELECT throws_ok(
  format($ins$INSERT INTO content.code_assets
              (id, survey_version_id, org_id, kind, ref, source, runs_on, scope, hooks)
            VALUES (%L, %L, %L, 'script', 'S_DUP', 'x', 'client', 'survey',
                    ARRAY['onAnswer', 'onAnswer'])$ins$,
    pg_temp.aid('sd'), pg_temp.tid('ver_a_draft'), pg_temp.tid('org_a')),
  '23514', NULL,
  'a duplicated hook is refused: onAnswer twice is not twice as often, it makes the hook '
  'runner''s behaviour depend on iteration order');

-- A script with NO hooks is storable, and that is deliberate: it never runs, which CMP-0501
-- reports at publish where the author can act on it, rather than being a corrupt row.
INSERT INTO content.code_assets
  (id, survey_version_id, org_id, kind, ref, source, runs_on, scope)
VALUES (pg_temp.aid('snh'), pg_temp.tid('ver_a_draft')::app.ulid,
        pg_temp.tid('org_a')::app.ulid, 'script', 'S_NO_HOOKS', 'x', 'server', 'question');
SELECT is(
  (SELECT cardinality(hooks) FROM content.code_assets WHERE ref = 'S_NO_HOOKS'), 0,
  'a hookless script IS storable — it is a publish diagnostic, not a corrupt row');

/* ---------------------------------------------------------------- *
 * 4. The sanitizer report
 * ---------------------------------------------------------------- */

SELECT throws_ok(
  $$ UPDATE content.code_assets
       SET sanitizer_report = '{"verdict":"pass"}'::jsonb, analyzed_at = now()
     WHERE ref = 'S_A' AND kind = 'script' $$,
  '23514', NULL,
  'a report with no analyzer_version is refused — it could not be told apart from a current one, '
  'which is what turns an archive into a false authority');

SELECT throws_ok(
  $$ UPDATE content.code_assets SET sanitizer_report = '{"analyzer_version":"1"}'::jsonb
     WHERE ref = 'S_A' AND kind = 'script' $$,
  '23514', NULL,
  'a verdict with no analyzed_at is refused — "as of when" is the whole value of an archived '
  'report');

SELECT throws_ok(
  $$ UPDATE content.code_assets SET sanitizer_report = '[]'::jsonb, analyzed_at = now()
     WHERE ref = 'S_A' AND kind = 'script' $$,
  '23514', NULL,
  'a report that is not an object is refused; every reader indexes it by key');

-- A FAILING report stores fine. There is no CHECK requiring a passing verdict, and that is the
-- point: a failing report is exactly the row an author needs to read.
UPDATE content.code_assets
   SET sanitizer_report = jsonb_build_object(
         'analyzer_version', '0.1.0',
         'verdict', 'fail',
         'findings', jsonb_build_array(jsonb_build_object('code', 'CMP-0500', 'tag', 'iframe'))),
       analyzed_at = now()
 WHERE ref = 'S_A' AND kind = 'script';
SELECT is(
  (SELECT sanitizer_report->>'verdict' FROM content.code_assets
    WHERE ref = 'S_A' AND kind = 'script'),
  'fail',
  'a FAILING verdict is storable — the table archives what the sanitizer found, it does not '
  'gate on it');
SELECT isnt(
  (SELECT analyzed_at FROM content.code_assets WHERE ref = 'S_A' AND kind = 'script'), NULL,
  'and it is stamped with when');

/* ---------------------------------------------------------------- *
 * 5. Refs
 * ---------------------------------------------------------------- */

SELECT throws_ok(
  format($ins$INSERT INTO content.code_assets
              (id, survey_version_id, org_id, kind, ref, source, runs_on, scope)
            VALUES (%L, %L, %L, 'script', 'S_A', 'y', 'client', 'survey')$ins$,
    pg_temp.aid('sa2'), pg_temp.tid('ver_a_draft'), pg_temp.tid('org_a')),
  '23505', NULL,
  'two scripts cannot share a ref within a version — the ref is how the manifest and the CSP '
  'name this asset');

-- ...but the same ref in a different KIND is fine: a script HEADER and a template HEADER are
-- different things an author named the same way, and forcing them apart is a rule with no reason.
INSERT INTO content.code_assets (id, survey_version_id, org_id, kind, ref, source)
VALUES (pg_temp.aid('tsa'), pg_temp.tid('ver_a_draft')::app.ulid,
        pg_temp.tid('org_a')::app.ulid, 'html_template', 'S_A', '<p></p>');
SELECT is(
  (SELECT count(*)::int FROM content.code_assets WHERE ref = 'S_A'), 2,
  'the same ref in two kinds is allowed — they are different namespaces');

SELECT throws_ok(
  format($ins$INSERT INTO content.code_assets (id, survey_version_id, org_id, kind, ref, source)
            VALUES (%L, %L, %L, 'css', '   ', 'body{}')$ins$,
    pg_temp.aid('cws'), pg_temp.tid('ver_a_draft'), pg_temp.tid('org_a')),
  '23514', NULL,
  'a whitespace ref is refused');

/* ---------------------------------------------------------------- *
 * 6. Tenancy and the draft boundary
 * ---------------------------------------------------------------- */

SELECT pg_temp.act_as(pg_temp.tid('user_b')::uuid, pg_temp.tid('org_b'));
SELECT is(
  (SELECT count(*)::int FROM content.code_assets), 0,
  'org B sees none of org A''s code assets');

-- user_a2 is org A's reviewer (rank 20). Reviewer reads, programmer writes.
SELECT pg_temp.act_as(pg_temp.tid('user_a2')::uuid, pg_temp.tid('org_a'));
SELECT is(
  (SELECT count(*)::int FROM content.code_assets WHERE ref = 'S_A'), 2,
  'a reviewer CAN read code — they cannot approve a survey whose scripts are invisible to them');

SELECT throws_ok(
  format($ins$INSERT INTO content.code_assets
              (id, survey_version_id, org_id, kind, ref, source, runs_on, scope)
            VALUES (%L, %L, %L, 'script', 'S_REVIEWER', 'x', 'client', 'survey')$ins$,
    pg_temp.aid('srv'), pg_temp.tid('ver_a_draft'), pg_temp.tid('org_a')),
  '42501', NULL,
  'but a reviewer cannot WRITE code — custom JS is the highest-privilege thing an author can '
  'add, so the bar is the survey-logic bar, not the copy-editing one');

-- ADR-002, both layers, against the FROZEN version the seed provides.
SELECT pg_temp.act_as(pg_temp.tid('user_a')::uuid, pg_temp.tid('org_a'));
SELECT throws_ok(
  format($ins$INSERT INTO content.code_assets
              (id, survey_version_id, org_id, kind, ref, source, runs_on, scope)
            VALUES (%L, %L, %L, 'script', 'S_FROZEN', 'x', 'client', 'survey')$ins$,
    pg_temp.aid('sfz'), pg_temp.tid('ver_a_frozen'), pg_temp.tid('org_a')),
  '23514', NULL,
  'a script cannot be added to a frozen version — a wave in field cannot have code appear '
  'underneath it. 23514 (content.tg_draft_only''s own RAISE) and not 42501: the draft-only TRIGGER '
  'fires before RLS''s WITH CHECK, so the error names the actual reason — "clone a new draft to '
  'edit" — instead of a bare permission denial the author cannot act on. That is ADR-002''s second '
  'layer earning its place rather than duplicating the first');

/* ---------------------------------------------------------------- *
 * 7. Posture
 * ---------------------------------------------------------------- */

RESET ROLE;
SELECT set_config('request.jwt.claims', '', true);
SELECT ok(has_table_privilege('authoring', 'content.code_assets', 'INSERT'),
  'authoring holds the grant; RLS is what narrows it to programmer-and-up on a draft');

-- Both helpers must be executable by `authoring` even though neither is called from application
-- code, because a CHECK constraint's expression runs with the WRITER''s privileges — not the
-- table''s and not its owner''s. Revoking from PUBLIC without this grant does not make the
-- constraint owner-only; it makes every insert fail with "permission denied for function".
SELECT ok(
  has_function_privilege('authoring', 'content.array_is_distinct(text[])', 'EXECUTE')
  AND has_function_privilege('authoring', 'content.source_sha256(text)', 'EXECUTE'),
  'authoring can execute both helpers — a CHECK runs as the writer, so the REVOKE from PUBLIC '
  'needs a matching GRANT or no row can be inserted at all');

SELECT * FROM finish();
ROLLBACK;
