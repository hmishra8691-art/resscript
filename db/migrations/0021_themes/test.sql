-- 0021_themes — tests.
--
-- The properties worth asserting are the ones that decide whether a client's approved appearance
-- stays approved, plus the ones that stop a token map becoming a CSS injection vector:
--
--   * THE SNAPSHOT IS INDEPENDENT OF THE THEME. Editing a theme must not change what a published
--     version renders. This is the whole reason content.version_theme exists rather than a second
--     pointer, and it is asserted by editing the theme and reading the snapshot back.
--   * THE SNAPSHOT OUTLIVES THE THEME. A theme deleted a year after a wave shipped must not take
--     the record of that wave's appearance with it.
--   * INHERITANCE CANNOT CYCLE, at any depth. A CHECK sees only self-parenthood; A→B→A needs a walk,
--     and without it the compiler's resolveTokens recurses forever on data one UPDATE can create.
--   * THE TOKEN MAP IS FLAT AND STRING-VALUED. The database guarantees the shape; the compiler owns
--     the vocabulary and the values, because whether "red;}*{display:none}" is a colour is a CSS
--     question.
--   * READ AT reviewer, WRITE AT admin, and the version pin at programmer. Three different bars for
--     three different questions.

BEGIN;
SELECT plan(35);

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

-- 0016's 'V' terminator: zero-padding alone is not injective, so 't1' and 't10' would collide.
CREATE FUNCTION pg_temp.thid(p_tag text) RETURNS app.ulid LANGUAGE sql IMMUTABLE AS
$$ SELECT ('thm_0' || rpad(translate(upper(p_tag), 'ILOU', '110V') || 'V', 25, '0'))::app.ulid $$;

SELECT set_config('rs.sha', repeat('ab', 32), true);

-- ---------------------------------------------------------------------------
-- 1. Structure
-- ---------------------------------------------------------------------------
SELECT has_table('app', 'themes', 'app.themes exists');
SELECT has_table('content', 'version_theme', 'content.version_theme exists');
SELECT has_column('content', 'version_theme', 'tokens_snapshot',
  'the version pin snapshots RESOLVED tokens, not a pointer');
SELECT has_column('content', 'version_theme', 'compiled_css_sha256',
  'and the hash of the CSS compiled from exactly those tokens');

-- The reference 0004 could not declare, because app.themes did not exist for seventeen migrations.
SELECT ok(
  EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'surveys_theme_fk' AND convalidated),
  'app.surveys.theme_id now has a VALIDATED foreign key — the pin has dangled since 0004');

SELECT ok(
  EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'content' AND c.relname = 'version_theme'
           AND t.tgname = 'version_theme_draft_only'),
  'ADR-002''s draft-only trigger is on the version pin');

SELECT ok(
  (SELECT relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'app' AND c.relname = 'themes'),
  'RLS is FORCED on app.themes');

SELECT ok(
  NOT has_function_privilege('public', 'content.is_token_map(jsonb)', 'EXECUTE'),
  'the shape predicate is not executable by PUBLIC (0006''s standing rule)');
SELECT ok(
  has_function_privilege('authoring', 'content.is_token_map(jsonb)', 'EXECUTE'),
  'but authoring CAN execute it — a CHECK evaluates with the WRITER''s privileges, which 0019 had '
  'to learn from an insert failing with "permission denied for function"');

-- ---------------------------------------------------------------------------
-- 2. The token map's shape
-- ---------------------------------------------------------------------------
SELECT ok(content.is_token_map('{"color-bg":"#fff"}'::jsonb), 'a flat string map is a token map');
SELECT ok(content.is_token_map('{}'::jsonb), 'and so is an empty one — a theme may inherit everything');
SELECT ok(NOT content.is_token_map('[]'::jsonb), 'an array is not');
SELECT ok(NOT content.is_token_map('"x"'::jsonb), 'nor a bare scalar');
SELECT ok(NOT content.is_token_map('{"a":{"b":"c"}}'::jsonb),
  'nor a NESTED object — a structure the compiler would have to defend against rather than reject');
SELECT ok(NOT content.is_token_map('{"a":1}'::jsonb), 'nor a numeric value');
SELECT ok(NOT content.is_token_map('{"a":null}'::jsonb), 'nor a null value');

-- ---------------------------------------------------------------------------
-- 3. Themes, roles and inheritance
-- ---------------------------------------------------------------------------
SELECT pg_temp.act_as(pg_temp.tid('user_a')::uuid, pg_temp.tid('org_a'));

INSERT INTO app.themes (id, org_id, name, tokens, is_default)
VALUES (pg_temp.thid('base'), pg_temp.tid('org_a')::app.ulid, 'Base',
        '{"color-brand":"#111111","radius":"2px"}'::jsonb, true);
INSERT INTO app.themes (id, org_id, name, parent_theme_id, tokens)
VALUES (pg_temp.thid('child'), pg_temp.tid('org_a')::app.ulid, 'Child',
        pg_temp.thid('base'), '{"color-brand":"#222222"}'::jsonb);

SELECT is((SELECT count(*)::int FROM app.themes), 2, 'an owner can create themes and inherit');

SELECT throws_ok(
  format($ins$INSERT INTO app.themes (id, org_id, name, is_default)
          VALUES (%L, %L, 'Second default', true)$ins$,
    pg_temp.thid('dup'), pg_temp.tid('org_a')),
  '23505', NULL,
  'a SECOND default is refused — two defaults is a state where "which theme does a new survey '
  'get" has no answer, and a uniqueness rule the database enforces cannot be raced');

SELECT throws_ok(
  format($ins$INSERT INTO app.themes (id, org_id, name, tokens)
          VALUES (%L, %L, 'Bad', '{"color-brand":{"nested":"x"}}'::jsonb)$ins$,
    pg_temp.thid('bad'), pg_temp.tid('org_a')),
  '23514', NULL,
  'a nested token map is unstorable');

SELECT throws_ok(
  format($ins$INSERT INTO app.themes (id, org_id, name) VALUES (%L, %L, '   ')$ins$,
    pg_temp.thid('blank'), pg_temp.tid('org_a')),
  '23514', NULL,
  'a whitespace name is refused');

SELECT throws_ok(
  format($ins$INSERT INTO app.themes (id, org_id, name) VALUES (%L, %L, 'Base')$ins$,
    pg_temp.thid('dupname'), pg_temp.tid('org_a')),
  '23505', NULL,
  'two themes cannot share a name within an org');

-- Cycles. The CHECK catches self-parenthood; the trigger catches the rest.
SELECT throws_ok(
  format('UPDATE app.themes SET parent_theme_id = %L WHERE id = %L',
    pg_temp.thid('base'), pg_temp.thid('base')),
  '23514', NULL,
  'a theme cannot be its own parent');

SELECT throws_ok(
  format('UPDATE app.themes SET parent_theme_id = %L WHERE id = %L',
    pg_temp.thid('child'), pg_temp.thid('base')),
  '23514', NULL,
  'and A->B->A is refused by the trigger — a CHECK cannot walk the chain, and without the walk '
  'the compiler''s resolveTokens recurses forever on data one UPDATE can create');

-- Deleting a parent is RESTRICTed, not cascaded.
SELECT throws_ok(
  format('DELETE FROM app.themes WHERE id = %L', pg_temp.thid('base')),
  '23503', NULL,
  'deleting a base brand theme is refused while a theme derives from it — CASCADE here would '
  'silently delete every derived theme');

-- Role floors.
SELECT pg_temp.act_as(pg_temp.tid('user_a2')::uuid, pg_temp.tid('org_a'));
SELECT is((SELECT count(*)::int FROM app.themes), 2,
  'a reviewer CAN read themes — they cannot approve a survey whose appearance is invisible');
SELECT throws_ok(
  format($ins$INSERT INTO app.themes (id, org_id, name) VALUES (%L, %L, 'Reviewer')$ins$,
    pg_temp.thid('rev'), pg_temp.tid('org_a')),
  '42501', NULL,
  'but cannot write one');

SELECT pg_temp.act_as(pg_temp.tid('user_b')::uuid, pg_temp.tid('org_b'));
SELECT is((SELECT count(*)::int FROM app.themes), 0, 'org B sees none of org A''s themes');

-- ---------------------------------------------------------------------------
-- 4. The snapshot, which is the point of the migration
-- ---------------------------------------------------------------------------
SELECT pg_temp.act_as(pg_temp.tid('user_a')::uuid, pg_temp.tid('org_a'));

INSERT INTO content.version_theme
  (survey_version_id, org_id, theme_id, theme_name, tokens_snapshot, compiled_css_sha256)
VALUES (pg_temp.tid('ver_a_draft')::app.ulid, pg_temp.tid('org_a')::app.ulid,
        pg_temp.thid('child'), 'Child',
        -- RESOLVED: the child's brand over the base's radius, already merged.
        '{"color-brand":"#222222","radius":"2px"}'::jsonb, current_setting('rs.sha'));

SELECT is((SELECT tokens_snapshot->>'radius' FROM content.version_theme), '2px',
  'the snapshot holds the RESOLVED tokens — inherited values already merged in');

-- THE HEADLINE. Edit the theme; the snapshot must not move.
UPDATE app.themes SET tokens = '{"color-brand":"#999999"}'::jsonb WHERE id = pg_temp.thid('child');
SELECT is((SELECT tokens_snapshot->>'color-brand' FROM content.version_theme), '#222222',
  'editing the THEME does not change the SNAPSHOT — which is the whole reason this table exists '
  'rather than a second pointer: a client approves an appearance, and one that changes underneath '
  'them is a support ticket that starts "this is not what I signed off"');

-- And it outlives the theme entirely.
DELETE FROM app.themes WHERE id = pg_temp.thid('child');
SELECT is((SELECT count(*)::int FROM content.version_theme), 1,
  'deleting the theme does NOT delete the snapshot — a theme removed a year after a wave shipped '
  'must not take the record of that wave''s appearance with it');
SELECT is((SELECT theme_name FROM content.version_theme), 'Child',
  'and the name survives as provenance, which is why theme_id has no foreign key');

SELECT throws_ok(
  format($ins$UPDATE content.version_theme SET compiled_css_sha256 = 'nothex'
          WHERE survey_version_id = %L$ins$, pg_temp.tid('ver_a_draft')),
  '23514', NULL,
  'a malformed css hash is refused — an unverifiable snapshot cannot answer "is this artifact '
  'still what we think it is"');

-- ADR-002, both layers, against the frozen version.
SELECT throws_ok(
  format($ins$INSERT INTO content.version_theme
          (survey_version_id, org_id, tokens_snapshot, compiled_css_sha256)
          VALUES (%L, %L, '{}'::jsonb, %L)$ins$,
    pg_temp.tid('ver_a_frozen'), pg_temp.tid('org_a'), current_setting('rs.sha')),
  '23514', NULL,
  'a theme cannot be pinned onto a FROZEN version — content.tg_draft_only raises with the reason '
  '("clone a new draft to edit") rather than RLS silently reporting zero rows');

-- ---------------------------------------------------------------------------
-- 5. Posture
-- ---------------------------------------------------------------------------
RESET ROLE;
SELECT set_config('request.jwt.claims', '', true);
SELECT ok(NOT has_table_privilege('runtime_writer', 'app.themes', 'SELECT'),
  'runtime_writer cannot read themes — the runtime reads the compiled stylesheet out of the '
  'artifact (ADR-001), never the authoring tables, which is what makes a mid-field theme edit '
  'unable to change what a respondent sees');
SELECT ok(NOT has_table_privilege('runtime_writer', 'content.version_theme', 'SELECT'),
  'nor the version pin, for the same reason');

SELECT * FROM finish();
ROLLBACK;
