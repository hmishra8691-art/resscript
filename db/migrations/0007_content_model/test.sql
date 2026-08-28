-- 0007_content_model/test.sql — pgTAP. The P1-03 content-model suite.
--
-- What this file has to prove, from P1-03's "Tests" and "Accept" rows and ADR-002/ADR-009:
--   * writing to a FROZEN version's content updates zero rows through the policy, and RAISES
--     from content.tg_draft_only when attempted as the owner (two layers, two behaviours);
--   * ops.tables_without_rls(), ops.content_tables_without_draft_trigger() and
--     ops.functions_executable_by_public() are all still empty now that seven content tables
--     and eleven content functions exist;
--   * moving one option to the top of a 60-option list updates EXACTLY ONE ROW;
--   * after 200 adjacent inserts, content.rebalance_siblings() preserves order and drops the
--     longest key below 16 characters;
--   * cloning a frozen version produces a draft whose node ids are IDENTICAL and whose
--     reference columns are unchanged;
--   * org A reads ZERO of org B's content rows, and forging active_org_id yields zero rows
--     rather than an error;
--   * the vars_derived_expr carve-out ACCEPTS a structurally derived variable (a multi-select's
--     set<enum> view: a source, no expression) while still rejecting an authored derived
--     variable with neither. This is the assertion that stops Deliverable B §4.3's
--     unsatisfiable form being reintroduced by a later migration.
--
-- Everything that can be run through the `authoring` role IS, via pg_temp.act_as, because
-- that is the only role a real HTTP caller has. A test that exercises content.move_node as
-- the migration runner passes with any grant set at all — including the one this migration
-- shipped with before its first run, which was missing EXECUTE on the four functions
-- move_node calls (see 0007 §14). Assertions that need the owner say RESET ROLE and say why.
BEGIN;
SELECT plan(161);

-- pgTAP lives in schema `public`, hardened by 0001's REVOKE ALL ... FROM PUBLIC. Granted
-- inside this transaction, which is rolled back, exactly as 0004's suite does.
GRANT USAGE ON SCHEMA public TO authoring, runtime_writer, analytics_reader;

-- ---------------------------------------------------------------------------
-- Fixture and impersonation
-- ---------------------------------------------------------------------------
-- 0004's two orgs, then 0007's content on top. ops.test_seed_content() returns the ids it
-- added and they are merged into the same GUC, so pg_temp.tid() reads one map.
SELECT set_config('rs.ids', ops.test_seed_two_orgs()::text, true);
SELECT set_config('rs.ids',
  (current_setting('rs.ids')::jsonb
   || ops.test_seed_content(current_setting('rs.ids')::jsonb))::text, true);

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

-- The catalog-walking probes, in the shape 0004 uses for schema `app`. Enumerated from
-- pg_catalog rather than by hand, so a content table added in migration 0147 is covered by
-- this file without anybody editing it.
CREATE FUNCTION pg_temp.content_cross_tenant_reads()
RETURNS TABLE (tbl text, rows_visible int) LANGUAGE plpgsql AS $fn$
DECLARE r record; v_n int; v_org text := current_setting('rs.ids')::jsonb ->> 'org_b';
BEGIN
  FOR r IN SELECT c.relname FROM pg_class c
             JOIN pg_namespace n ON n.oid = c.relnamespace
             JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'org_id'
                                AND a.attnum > 0 AND NOT a.attisdropped
            WHERE n.nspname = 'content' AND c.relkind IN ('r','p','v')
              AND NOT c.relispartition
            ORDER BY 1
  LOOP
    BEGIN
      EXECUTE format('SELECT count(*)::int FROM content.%I WHERE org_id = %L',
                     r.relname, v_org) INTO v_n;
    EXCEPTION WHEN insufficient_privilege THEN
      v_n := 0;   -- denied by GRANT is at least as safe as filtered to nothing
    END;
    tbl := 'content.' || r.relname; rows_visible := v_n; RETURN NEXT;
  END LOOP;
END $fn$;

CREATE FUNCTION pg_temp.content_cross_tenant_writes()
RETURNS TABLE (tbl text, rows_written int) LANGUAGE plpgsql AS $fn$
DECLARE r record; v_n int; v_org text := current_setting('rs.ids')::jsonb ->> 'org_b';
BEGIN
  FOR r IN SELECT c.relname FROM pg_class c
             JOIN pg_namespace n ON n.oid = c.relnamespace
             JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'org_id'
                                AND a.attnum > 0 AND NOT a.attisdropped
            WHERE n.nspname = 'content' AND c.relkind IN ('r','p')
              AND NOT c.relispartition
            ORDER BY 1
  LOOP
    BEGIN
      -- UPDATE rather than DELETE: a DELETE that cascades would be a destructive probe, and
      -- 0 rows updated is the same evidence. org_id is set to itself so the statement is
      -- legal on every table whatever its columns are.
      EXECUTE format('WITH u AS (UPDATE content.%I SET org_id = org_id WHERE org_id = %L '
                     'RETURNING 1) SELECT count(*)::int FROM u', r.relname, v_org) INTO v_n;
    EXCEPTION
      WHEN insufficient_privilege THEN v_n := 0;
      -- content.tg_draft_only fires BEFORE the policy is consulted and raises when it cannot
      -- see the owning version — which, cross-tenant, it cannot. A raise is a stricter denial
      -- than zero rows, and it names no other tenant's data.
      WHEN check_violation OR foreign_key_violation THEN v_n := 0;
    END;
    tbl := 'content.' || r.relname; rows_written := v_n; RETURN NEXT;
  END LOOP;
END $fn$;

-- 200 inserts at the SAME point in one sibling set: B §4.6's pathological drag sequence, run
-- against the real table rather than against frac_key_at alone (which 0001 already covers).
CREATE FUNCTION pg_temp.adjacent_inserts(p_version text, p_parent text, p_after text,
                                         p_org text, p_n int)
RETURNS int LANGUAGE plpgsql AS $$
DECLARE i int; v_key content.sort_key;
BEGIN
  FOR i IN 1..p_n LOOP
    v_key := content.next_sort_key(p_version::app.ulid, p_parent::app.ulid,
                                   p_after::app.ulid, NULL);
    INSERT INTO content.nodes (survey_version_id, id, org_id, node_kind, parent_id,
                               sort_key, label_key)
    VALUES (p_version::app.ulid, app.gen_ulid('txt'), p_org::app.ulid, 'text',
            p_parent::app.ulid, v_key, 'txt.' || i);
  END LOOP;
  RETURN p_n;
END $$;

CREATE FUNCTION pg_temp.sibling_ids(p_version text, p_parent text) RETURNS app.ulid[]
LANGUAGE sql AS $$
  SELECT array_agg(n.id ORDER BY n.sort_key, n.id) FROM content.nodes n
   WHERE n.survey_version_id = p_version::app.ulid AND n.parent_id = p_parent::app.ulid
$$;

CREATE FUNCTION pg_temp.max_key_len(p_version text, p_parent text) RETURNS int
LANGUAGE sql AS $$
  SELECT max(length(n.sort_key))::int FROM content.nodes n
   WHERE n.survey_version_id = p_version::app.ulid AND n.parent_id = p_parent::app.ulid
$$;

-- ---------------------------------------------------------------------------
-- 1. Structure (B §4, §6)
-- ---------------------------------------------------------------------------
SELECT has_table('content', 'nodes',                   'content.nodes exists');
SELECT has_table('content', 'question_items',          'content.question_items exists');
SELECT has_table('content', 'question_cells',          'content.question_cells exists');
SELECT has_table('content', 'variables',               'content.variables exists');
SELECT has_table('content', 'languages',               'content.languages exists');
SELECT has_table('content', 'i18n_strings',            'content.i18n_strings exists');
SELECT has_table('content', 'reserved_variable_names', 'content.reserved_variable_names exists');
SELECT has_view('content', 'questions', 'content.questions readability view exists (B §4.1)');
SELECT has_view('content', 'pages',     'content.pages readability view exists');
SELECT has_view('content', 'blocks',    'content.blocks readability view exists');

-- B §4.1: ONE node table with a discriminator, not three.
SELECT is_empty($$
  SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'content' AND c.relkind = 'r'
     AND c.relname IN ('blocks', 'pages', 'questions', 'text_nodes')
$$, 'blocks/pages/questions are VIEWS over one content.nodes table, not tables of their own '
    '(B §4.1: three tables would make every rule and flow target a polymorphic reference '
    'with no FK)');

-- B §0 ground rule 3, as a catalog assertion rather than a per-table has_column: every
-- content table is scoped to a survey_version_id, never a survey_id. Stated this way it also
-- covers content tables that do not exist yet.
SELECT is_empty($$
  SELECT format('content.%s', c.relname)
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'content' AND c.relkind IN ('r','p') AND NOT c.relispartition
     AND NOT EXISTS (SELECT 1 FROM pg_attribute a
                      WHERE a.attrelid = c.oid AND a.attname = 'survey_version_id'
                        AND a.attnum > 0 AND NOT a.attisdropped)
     AND NOT EXISTS (SELECT 1 FROM ops.rls_exemptions e
                      WHERE e.table_name = format('content.%s', c.relname)
                        AND e.exempt_draft_trigger)
$$, 'every content table is scoped to survey_version_id and not survey_id (B §0 ground rule '
    '3), except the one global reference table that carries an explicit ops.rls_exemptions '
    'row saying so');

SELECT is_empty($$
  SELECT format('content.%s', c.relname)
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'content' AND c.relkind IN ('r','p') AND NOT c.relispartition
     AND c.relname <> 'reserved_variable_names'
     AND NOT EXISTS (SELECT 1 FROM pg_attribute a
                      WHERE a.attrelid = c.oid AND a.attname = 'org_id'
                        AND a.attnum > 0 AND NOT a.attisdropped)
$$, 'ADR-009: org_id on every content row, so an RLS predicate is one column comparison and '
    'not a three-table join in every plan');

-- No column DEFAULT on any content id. A generated default would be a loaded gun pointed at
-- the one structural guarantee this migration exists to provide (ids stable across versions,
-- so a clone is a flat INSERT ... SELECT), and it would replace the stable id TypeScript
-- derives from a question's declared parts with a fresh random one on every recompute.
SELECT col_hasnt_default('content', 'nodes', 'id',
  'content.nodes.id has NO default: a clone must reuse the source id verbatim (B §4.1)');
SELECT col_hasnt_default('content', 'question_items', 'id',
  'content.question_items.id has no default either — and a single one could not be right, '
  'since the prefix differs for options, rows and columns');
SELECT col_hasnt_default('content', 'variables', 'id',
  'content.variables.id has no default: P1-02''s variableSignature() is what keeps a '
  'variable id stable across a recompute, and a server-side random id would defeat it');

SELECT has_index('content', 'nodes', 'nodes_ref_key',
  'nodes_ref_key: C §3''s survey-wide ref uniqueness as one partial unique index');
SELECT has_index('content', 'nodes', 'nodes_sibling_order_key', 'sibling order index exists');
SELECT index_is_unique('content', 'nodes', 'nodes_sibling_order_key',
  'sibling order is UNIQUE, so ORDER BY sort_key is total');
SELECT has_index('content', 'nodes', 'nodes_tree_idx', 'the tree-load index exists (B §13)');
SELECT has_index('content', 'question_items', 'qitems_code_key',
  'qitems_code_key: two options of one question cannot share an exported code (C §5.1)');
SELECT has_index('content', 'question_items', 'qitems_order_key',
  'item display order is indexed separately from code');
SELECT has_index('content', 'variables', 'variables_export_col_key',
  'variables_export_col_key exists — the index that keeps a client''s column layout stable '
  '(B §4.3, ADR-007)');
SELECT has_index('content', 'variables', 'variables_name_key', 'variable names unique per version');
SELECT has_index('content', 'languages', 'languages_one_base', 'exactly one base language');

SELECT has_trigger('content', 'nodes', 'nodes_draft_only',
  'content.tg_draft_only is attached to content.nodes (ADR-002)');
SELECT has_trigger('content', 'variables', 'variables_reserved_name',
  'B §4.3''s reserved-namespace trigger is attached to content.variables (a CHECK cannot '
  'read another table)');
SELECT has_trigger('content', 'nodes', 'nodes_touch', 'updated_at is maintained by trigger');

SELECT has_function('app', 'can_see_version',  'app.can_see_version() exists');
SELECT has_function('app', 'version_is_draft', 'app.version_is_draft() exists');
SELECT is_definer('app', 'can_see_version', ARRAY['app.ulid'],
  'app.can_see_version is SECURITY DEFINER: evaluating app.survey_versions'' own policies '
  'inside another table''s policy would make the effective predicate depend on evaluation '
  'order');
SELECT is_definer('app', 'version_is_draft', ARRAY['app.ulid'],
  'app.version_is_draft is SECURITY DEFINER for the same reason');
SELECT has_function('content', 'next_sort_key',       'content.next_sort_key() exists');
SELECT has_function('content', 'move_node',           'content.move_node() exists');
SELECT has_function('content', 'next_item_sort_key',  'content.next_item_sort_key() exists');
SELECT has_function('content', 'move_question_item',  'content.move_question_item() exists');
SELECT has_function('content', 'rebalance_items',     'content.rebalance_items() exists');
SELECT has_function('content', 'tree_rows',           'content.tree_rows() exists');
SELECT has_function('content', 'clone_version',       'content.clone_version() exists');
-- Signature assertion MOVED here from 0001/test.sql, because 0007 §10a is what currently
-- defines this signature (db/README.md: "move signature assertions, do not duplicate them").
SELECT has_function('content', 'rebalance_siblings', ARRAY['app.ulid','app.ulid'],
  'content.rebalance_siblings(app.ulid, app.ulid) is defined by THIS migration now: 0001 '
  'declared it against a table that did not exist and 0007 §10a redefines the body');

-- WITH (security_invoker = true) on the views is load-bearing and invisible to
-- ops.tables_without_rls(), which walks relkind IN ('r','p'). A view is 'v', and a view is
-- SECURITY DEFINER by default — so without this reloption each of these three would be a
-- complete cross-tenant read of content.nodes for anyone holding SELECT on the view.
SELECT is_empty($$
  SELECT format('content.%s', c.relname)
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'content' AND c.relkind = 'v'
     AND NOT COALESCE(c.reloptions, '{}') @> ARRAY['security_invoker=true']
$$, 'every view in schema content sets security_invoker=true, so RLS is the CALLER''s and '
    'not the view owner''s — the one RLS hole ops.tables_without_rls() structurally cannot '
    'see');

SELECT enum_has_labels('content', 'node_kind', ARRAY['block','page','question','text'],
  'content.node_kind is B §4.1''s four-way discriminator');
SELECT enum_has_labels('content', 'item_kind', ARRAY['option','row','column'],
  'content.item_kind: rows and columns have the same shape as options (C §5.1)');
SELECT enum_has_labels('content', 'var_kind',
  ARRAY['response','hidden','derived','system','quota','design'],
  'content.var_kind is C §4''s six kinds, including `design` — omitting design variables '
  'makes MaxDiff/conjoint data unanalysable');
SELECT enum_has_labels('content', 'var_type',
  ARRAY['enum','boolean','number','text','date','set','object'],
  'content.var_type is C §4''s seven data types, independent of question type');
SELECT enum_has_labels('content', 'string_state',
  ARRAY['missing','machine','translated','reviewed'],
  'content.string_state: a JSONB bundle per language cannot say "reviewed" (B §6)');

-- ---------------------------------------------------------------------------
-- 2. The three catalog assertions, and the policy shape guards
-- ---------------------------------------------------------------------------
SELECT is_empty($$ SELECT ops.tables_without_rls() $$,
  'ops.tables_without_rls() is still empty with seven content tables added (ADR-009)');
SELECT is_empty($$ SELECT ops.content_tables_without_draft_trigger() $$,
  'ops.content_tables_without_draft_trigger() is still empty: every content table carries '
  'tg_draft_only except the one with an explicit exemption row');
SELECT is_empty($$ SELECT ops.functions_executable_by_public() $$,
  'ops.functions_executable_by_public() is still empty with eleven functions added (0006: '
  '"ALTER DEFAULT PRIVILEGES ... REVOKE ALL ON FUNCTIONS" is a no-op, so each one needs an '
  'explicit REVOKE)');

SELECT results_eq($$
  SELECT count(*)::int FROM ops.content_tables_without_draft_trigger()
$$, ARRAY[0], 'and the draft-trigger assertion is not vacuous: it returns a count, from a '
              'schema that now has tables in it');

SELECT policies_are('content', 'nodes',
  ARRAY['nodes_select','nodes_insert','nodes_update','nodes_delete'],
  'content.nodes has exactly one policy per command — never FOR ALL, so a read predicate '
  'cannot become a write predicate by accident (B §12)');
SELECT policies_are('content', 'variables',
  ARRAY['variables_select','variables_insert','variables_update','variables_delete'],
  'content.variables has exactly one policy per command');

SELECT is_empty($$
  SELECT tablename || '.' || policyname FROM pg_policies
   WHERE schemaname = 'content' AND cmd = 'ALL'
$$, 'no content table uses a FOR ALL policy, even though B §12''s own sketch writes '
    'nodes_write that way');
SELECT is_empty($$
  SELECT tablename || '.' || policyname FROM pg_policies
   WHERE schemaname = 'content' AND cmd IN ('INSERT','UPDATE') AND with_check IS NULL
$$, 'every content INSERT/UPDATE policy has a WITH CHECK: USING says which rows you may '
    'touch, WITH CHECK says what they may become');
SELECT is_empty($$
  SELECT tablename || '.' || policyname FROM pg_policies
   WHERE schemaname = 'content'
     AND cmd IN ('INSERT','UPDATE','DELETE')
     AND (coalesce(qual,'') || ' ' || coalesce(with_check,'')) NOT LIKE '%version_is_draft%'
$$, 'ADR-002 in the policy layer: every content WRITE policy calls app.version_is_draft(), '
    'so an editor bug against a published survey is "0 rows updated" rather than an '
    'exception thrown halfway through a transaction');
SELECT is_empty($$
  SELECT tablename || '.' || policyname FROM pg_policies
   WHERE schemaname = 'content' AND roles::text <> '{authoring}'
$$, 'every content policy targets `authoring` and nothing else: the runtime and the '
    'analytics reader are excluded by GRANT, and a policy naming them would be the first '
    'step to a plane-boundary crossing');

-- ---------------------------------------------------------------------------
-- 3. Isolation (ADR-009). Org A, authenticated normally.
-- ---------------------------------------------------------------------------
SELECT pg_temp.act_as(pg_temp.tid('user_a')::uuid, pg_temp.tid('org_a'));

SELECT results_eq($$ SELECT count(*)::int FROM content.nodes $$, ARRAY[8],
  'org A sees exactly its own 8 nodes: 4 in the frozen version and the same 4 in the draft');
SELECT results_eq($$ SELECT count(*)::int FROM content.question_items $$, ARRAY[122],
  'org A sees its own 122 question items (60 options + one matrix row, x 2 versions)');
SELECT results_eq($$ SELECT count(*)::int FROM content.question_cells $$, ARRAY[2],
  'and its 2 mixed-matrix cell overrides');
SELECT results_eq($$ SELECT count(*)::int FROM content.variables $$, ARRAY[8],
  'org A sees its own 8 variables');
SELECT results_eq($$ SELECT count(*)::int FROM content.languages $$, ARRAY[4],
  'org A sees its own 4 language rows');
SELECT results_eq($$ SELECT count(*)::int FROM content.i18n_strings $$, ARRAY[4],
  'org A sees its own 4 i18n strings');
SELECT results_eq($$ SELECT count(*)::int FROM content.questions $$, ARRAY[4],
  'the content.questions view returns org A''s 4 questions and no more');

SELECT is_empty($$ SELECT 1 FROM content.nodes
                    WHERE org_id = current_setting('rs.ids')::jsonb ->> 'org_b' $$,
  'A cannot read B''s nodes');
SELECT is_empty($$ SELECT 1 FROM content.question_items
                    WHERE org_id = current_setting('rs.ids')::jsonb ->> 'org_b' $$,
  'A cannot read B''s question items');
SELECT is_empty($$ SELECT 1 FROM content.variables
                    WHERE org_id = current_setting('rs.ids')::jsonb ->> 'org_b' $$,
  'A cannot read B''s variables — the export contract of another tenant''s survey');
SELECT is_empty($$ SELECT 1 FROM content.i18n_strings
                    WHERE org_id = current_setting('rs.ids')::jsonb ->> 'org_b' $$,
  'A cannot read B''s translations');
SELECT is_empty($$ SELECT 1 FROM content.languages
                    WHERE org_id = current_setting('rs.ids')::jsonb ->> 'org_b' $$,
  'A cannot read B''s languages');
SELECT is_empty($$ SELECT 1 FROM content.questions
                    WHERE org_id = current_setting('rs.ids')::jsonb ->> 'org_b' $$,
  'A cannot read B''s questions through the readability VIEW either (security_invoker)');
SELECT is_empty($$ SELECT 1 FROM content.pages
                    WHERE org_id = current_setting('rs.ids')::jsonb ->> 'org_b' $$,
  'A cannot read B''s pages through the view');
SELECT is_empty($$ SELECT 1 FROM content.blocks
                    WHERE org_id = current_setting('rs.ids')::jsonb ->> 'org_b' $$,
  'A cannot read B''s blocks through the view');
SELECT is_empty($$
  SELECT * FROM content.tree_rows(
    (current_setting('rs.ids')::jsonb ->> 'ver_b_content_draft')::app.ulid)
$$, 'content.tree_rows() over ANOTHER TENANT''S version returns zero rows rather than their '
    'questionnaire outline: the CTE is SECURITY INVOKER, so RLS is the caller''s');

SELECT is_empty($$
  SELECT tbl || ' leaked ' || rows_visible || ' row(s)'
    FROM pg_temp.content_cross_tenant_reads() WHERE rows_visible <> 0
$$, 'org A reads ZERO of org B''s rows from every org_id-bearing table AND VIEW in schema '
    'content, enumerated from pg_catalog rather than by hand');
SELECT is_empty($$
  SELECT tbl || ' wrote ' || rows_written || ' row(s)'
    FROM pg_temp.content_cross_tenant_writes() WHERE rows_written <> 0
$$, 'org A writes ZERO of org B''s rows in every org_id-bearing content table, enumerated '
    'from pg_catalog');

SELECT throws_ok($$
  INSERT INTO content.nodes (survey_version_id, id, org_id, node_kind, sort_key, ref)
  VALUES ((current_setting('rs.ids')::jsonb ->> 'ver_b_content_draft')::app.ulid,
          'blk_0XX00000000000000000000000',
          (current_setting('rs.ids')::jsonb ->> 'org_b')::app.ulid, 'block', '9000', 'PWNED')
$$, '23503', NULL,
  'A cannot insert a node into B''s draft version. The error is a foreign-key violation '
  'raised by content.tg_draft_only, which reads app.survey_versions AS THE CALLER and '
  'therefore cannot see the version at all — so the message is "does not exist", which is '
  'what a cross-tenant probe should hear, and never "is frozen", which would confirm it');

-- Forging active_org_id — the ADR-009 headline, restated for content.
SELECT pg_temp.act_as(pg_temp.tid('user_a')::uuid, pg_temp.tid('org_b'));
SELECT ok(NOT app.has_role('client'),
  'the forged org claim is read, but no app.org_members row backs it');
SELECT is_empty($$ SELECT 1 FROM content.nodes $$,
  'forging active_org_id to org B returns ZERO ROWS from content.nodes, not an error — an '
  'error would be an oracle confirming the org exists');
SELECT is_empty($$ SELECT 1 FROM content.question_items $$,
  'forging active_org_id returns zero rows from content.question_items');
SELECT is_empty($$ SELECT 1 FROM content.variables $$,
  'forging active_org_id returns zero rows from content.variables');
SELECT is_empty($$ SELECT 1 FROM content.i18n_strings $$,
  'forging active_org_id returns zero rows from content.i18n_strings');
SELECT is_empty($$ SELECT 1 FROM content.questions $$,
  'forging active_org_id returns zero rows from the views');
SELECT is(app.can_see_version(pg_temp.tid('ver_b_content_draft')::app.ulid), false,
  'app.can_see_version() is false for another tenant''s version under a forged claim, and '
  'returns false rather than raising');

-- A user who belongs to nothing.
SELECT pg_temp.act_as(pg_temp.tid('user_c')::uuid, pg_temp.tid('org_a'));
SELECT is_empty($$ SELECT 1 FROM content.nodes $$,
  'a user who belongs to no org sees no content, without an error');

-- Project scoping inside one org (K §1): can_see_version resolves version -> survey ->
-- project and defers to app.can_see_project, so a freelancer staffed on one project cannot
-- read the content of another project's survey.
SELECT pg_temp.act_as(pg_temp.tid('user_a2')::uuid, pg_temp.tid('org_a'));
SELECT ok(app.can_see_version(pg_temp.tid('ver_a_content_draft')::app.ulid),
  'a reviewer staffed on project A can see project A''s survey version');
SELECT results_eq($$ SELECT count(*)::int FROM content.nodes $$, ARRAY[8],
  'and therefore reads its content: a review link over a FROZEN version is the product '
  'feature the SELECT policies exist for (B §12)');
SELECT results_eq($$
  WITH u AS (UPDATE content.nodes SET label_key = 'reviewer edit'
              WHERE survey_version_id = current_setting('rs.ids')::jsonb ->> 'ver_a_content_draft'
              RETURNING 1) SELECT count(*)::int FROM u
$$, ARRAY[0], 'a reviewer cannot edit a node even in a DRAFT: the write floor is programmer '
              '(0 rows, not an error)');
SELECT results_eq($$
  WITH u AS (UPDATE content.i18n_strings SET value = 'Trinken Sie Kaffee?',
                                             state = 'translated'
              WHERE survey_version_id = current_setting('rs.ids')::jsonb ->> 'ver_a_content_draft'
                AND lang = 'de' RETURNING 1) SELECT count(*)::int FROM u
$$, ARRAY[1], 'a reviewer CAN write translations: C §16''s translation workflow belongs to '
              'translators and reviewers, and making them ask a programmer to paste German '
              'strings is how translations end up in a spreadsheet nobody reimports');

-- ADR-009's negative capability, for the tables that just appeared.
RESET ROLE;
SELECT set_config('request.jwt.claims', '', true);
SELECT is_empty($$
  SELECT n.nspname || '.' || c.relname || ':' || a.privilege_type
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    CROSS JOIN LATERAL aclexplode(c.relacl) a
   WHERE n.nspname = 'content' AND c.relkind IN ('r','p','v','m') AND c.relacl IS NOT NULL
     AND a.grantee IN ('runtime_writer'::regrole, 'analytics_reader'::regrole)
$$, 'neither runtime_writer nor analytics_reader holds ANY privilege on ANY table or view in '
    'schema content (ADR-009: the riskiest query surface in the system has no ability to '
    'read tenant data at all)');
SELECT is_empty($$
  SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'content'
     AND has_function_privilege('runtime_writer', p.oid, 'EXECUTE')
$$, 'runtime_writer holds EXECUTE on no function in schema content either: phrased over '
    'pg_proc rather than per signature, so re-signing a function cannot silently change '
    'what this asserts (db/README.md corollary 2)');

SET LOCAL ROLE runtime_writer;
SELECT throws_ok($$ SELECT 1 FROM content.nodes LIMIT 1 $$, '42501', NULL,
  'runtime_writer cannot read content.nodes — it has no USAGE on the schema at all');
SELECT throws_ok($$ SELECT 1 FROM content.questions LIMIT 1 $$, '42501', NULL,
  'runtime_writer cannot read the readability views either');
SELECT throws_ok($$ SELECT 1 FROM content.variables LIMIT 1 $$, '42501', NULL,
  'runtime_writer cannot read content.variables');
RESET ROLE;
SET LOCAL ROLE analytics_reader;
SELECT throws_ok($$ SELECT 1 FROM content.nodes LIMIT 1 $$, '42501', NULL,
  'analytics_reader cannot read content either: B §2 gives it SELECT on the generated flat '
  'export tables and nothing else');
RESET ROLE;

-- ---------------------------------------------------------------------------
-- 4. The reserved namespace (K §6)
-- ---------------------------------------------------------------------------
SELECT pg_temp.act_as(pg_temp.tid('user_a')::uuid, pg_temp.tid('org_a'));
SELECT results_eq($$ SELECT count(*)::int FROM content.reserved_variable_names $$, ARRAY[29],
  'all 29 of Deliverable K §6''s reserved system variable names are seeded');
SELECT is_empty($$
  SELECT k.name FROM (VALUES ('respondent_id'),('session_id'),('survey_id'),
    ('survey_version_id'),('artifact_hash'),('random_seed'),('language'),('country'),
    ('region'),('device'),('os_class'),('browser_class'),('user_agent_class'),('ip_hash'),
    ('referrer'),('entry_url'),('source'),('vendor_ref'),('started_at'),('last_activity_at'),
    ('completed_at'),('duration_s'),('page_count'),('disposition'),('is_test'),
    ('quality_score'),('speeder_flag'),('straightliner_flag'),('duplicate_flag')) k(name)
   WHERE NOT EXISTS (SELECT 1 FROM content.reserved_variable_names r WHERE r.name = k.name)
$$, 'and they are K §6''s list exactly, name by name, rather than 29 of something');
SELECT throws_ok($$
  INSERT INTO content.reserved_variable_names (name, reason)
  VALUES ('my_own_name', 'a reason long enough to pass the check')
$$, '42501', NULL,
  'the reserved list is read-only to authoring: K §6 says adding a name is a breaking change '
  'for every survey already using it, so the write path is a migration and not an API call');

SELECT pg_temp.act_as(pg_temp.tid('user_c')::uuid, NULL);
SELECT is_empty($$ SELECT 1 FROM content.reserved_variable_names $$,
  'a session with no active org reads nothing even from the global reference table: the '
  'policy is app.current_org() IS NOT NULL rather than `true`, which keeps 0004''s "every '
  'policy mentions current_org" assertion free of a second exception');

-- ---------------------------------------------------------------------------
-- 5. content.variables — the CHECK constraints, in both directions
-- ---------------------------------------------------------------------------
SELECT pg_temp.act_as(pg_temp.tid('user_a')::uuid, pg_temp.tid('org_a'));

-- THE CARVE-OUT. This is the assertion that stops B §4.3's unsatisfiable
-- CHECK ((kind = 'derived') = (expression IS NOT NULL)) being reintroduced.
SELECT lives_ok($$
  INSERT INTO content.variables (survey_version_id, id, org_id, name, kind, vtype,
                                 source_question_id, source_part, enum_domain,
                                 export_column, sort_key, persist)
  VALUES ((current_setting('rs.ids')::jsonb ->> 'ver_a_content_draft')::app.ulid,
          'var_0AZ10000000000000000000000',
          (current_setting('rs.ids')::jsonb ->> 'org_a')::app.ulid,
          'S2_SET_VIEW', 'derived', 'set',
          (current_setting('rs.ids')::jsonb ->> 'q2_a')::app.ulid,
          '{"kind":"set_view"}', '[{"code":1,"label_key":"x"}]', 'S2_SET_VIEW', '9100', false)
$$, 'a STRUCTURALLY derived variable — a multi-select''s set<enum> view over its boolean '
    'fan-out, with a source and NO expression — is ACCEPTED. B §4.3''s '
    '((kind = ''derived'') = (expression IS NOT NULL)) would reject it, and the logic AST '
    'has no operator that collects the true members of a fan-out, so there is no expression '
    'to author: the compiler synthesizes it. 0005 §4 recorded this; without the carve-out '
    'the FIRST multi-select save fails');
SELECT results_eq($$
  SELECT count(*)::int FROM content.variables
   WHERE kind = 'derived' AND expression IS NULL AND source_question_id IS NOT NULL
$$, ARRAY[3], 'and the fixture itself carries structurally derived variables in both '
              'versions, so the carve-out is exercised by every later suite too');
SELECT throws_ok($$
  INSERT INTO content.variables (survey_version_id, id, org_id, name, kind, vtype,
                                 enum_domain, export_column, sort_key)
  VALUES ((current_setting('rs.ids')::jsonb ->> 'ver_a_content_draft')::app.ulid,
          'var_0AZ20000000000000000000000',
          (current_setting('rs.ids')::jsonb ->> 'org_a')::app.ulid,
          'ORPHAN_BAND', 'derived', 'enum', '[]', 'ORPHAN_BAND', '9200')
$$, '23514', NULL,
  'but an AUTHORED derived variable — no source AND no expression — is still rejected. The '
  'carve-out widens the constraint by exactly one discriminator and not into a no-op');
SELECT throws_ok($$
  INSERT INTO content.variables (survey_version_id, id, org_id, name, kind, vtype,
                                 expression, export_column, sort_key)
  VALUES ((current_setting('rs.ids')::jsonb ->> 'ver_a_content_draft')::app.ulid,
          'var_0AZ30000000000000000000000',
          (current_setting('rs.ids')::jsonb ->> 'org_a')::app.ulid,
          'NOT_DERIVED', 'hidden', 'text', '{"lit":1}', 'NOT_DERIVED', '9300')
$$, '23514', NULL,
  'an expression on a NON-derived variable is rejected: a value nobody evaluates is worse '
  'than an error (vars_expr_only_derived — the direction of B §4.3 that still holds '
  'unconditionally)');
SELECT throws_ok($$
  INSERT INTO content.variables (survey_version_id, id, org_id, name, kind, vtype,
                                 export_column, sort_key)
  VALUES ((current_setting('rs.ids')::jsonb ->> 'ver_a_content_draft')::app.ulid,
          'var_0AZ40000000000000000000000',
          (current_setting('rs.ids')::jsonb ->> 'org_a')::app.ulid,
          'NO_SOURCE', 'response', 'text', 'NO_SOURCE', '9400')
$$, '23514', NULL,
  'a `response` variable with no source is rejected: C §4 says a response variable is BY '
  'DEFINITION produced by a question, and one without a source is an orphan export column');
SELECT throws_ok($$
  INSERT INTO content.variables (survey_version_id, id, org_id, name, kind, vtype,
                                 source_question_id, export_column, sort_key)
  VALUES ((current_setting('rs.ids')::jsonb ->> 'ver_a_content_draft')::app.ulid,
          'var_0AZ50000000000000000000000',
          (current_setting('rs.ids')::jsonb ->> 'org_a')::app.ulid,
          'NO_DOMAIN', 'response', 'enum',
          (current_setting('rs.ids')::jsonb ->> 'q1_a')::app.ulid, 'NO_DOMAIN', '9500')
$$, '23514', NULL,
  'an enum variable with no enum_domain is rejected: the export needs the ordered code/label '
  'list to emit a labelled column at all');
SELECT throws_ok($$
  INSERT INTO content.variables (survey_version_id, id, org_id, name, kind, vtype,
                                 source_question_id, export_column, sort_key, persist)
  VALUES ((current_setting('rs.ids')::jsonb ->> 'ver_a_content_draft')::app.ulid,
          'var_0AZ60000000000000000000000',
          (current_setting('rs.ids')::jsonb ->> 'org_a')::app.ulid,
          'TRANSIENT', 'response', 'text',
          (current_setting('rs.ids')::jsonb ->> 'q1_a')::app.ulid, 'TRANSIENT', '9600', false)
$$, '23514', NULL,
  'persist = false is only legal for derived and system variables (vars_transient): a '
  'response the respondent gave and nobody stored is data loss with a constraint available '
  'to prevent it');
SELECT throws_ok($$
  INSERT INTO content.variables (survey_version_id, id, org_id, name, kind, vtype,
                                 export_column, sort_key)
  VALUES ((current_setting('rs.ids')::jsonb ->> 'ver_a_content_draft')::app.ulid,
          'var_0AZ70000000000000000000000',
          (current_setting('rs.ids')::jsonb ->> 'org_a')::app.ulid,
          'COLLIDER', 'hidden', 'text', 's1', '9700')
$$, '23505', NULL,
  'two variables cannot claim the same export column, case-insensitively (`s1` vs the '
  'seeded `S1`). This is the index B §11''s flat-table generator relies on to quote_ident() '
  'straight from this table with no run-time collision handling');
SELECT throws_ok($$
  INSERT INTO content.variables (survey_version_id, id, org_id, name, kind, vtype,
                                 export_column, sort_key)
  VALUES ((current_setting('rs.ids')::jsonb ->> 'ver_a_content_draft')::app.ulid,
          'var_0AZ80000000000000000000000',
          (current_setting('rs.ids')::jsonb ->> 'org_a')::app.ulid,
          'country', 'hidden', 'text', 'MY_COUNTRY', '9800')
$$, '23514', NULL,
  'a user variable cannot shadow K §6''s reserved system namespace (the trigger B §4.3 asks '
  'for, because a CHECK cannot read another table)');
SELECT throws_ok($$
  INSERT INTO content.variables (survey_version_id, id, org_id, name, kind, vtype,
                                 export_column, sort_key)
  VALUES ((current_setting('rs.ids')::jsonb ->> 'ver_a_content_draft')::app.ulid,
          'var_0AZ90000000000000000000000',
          (current_setting('rs.ids')::jsonb ->> 'org_a')::app.ulid,
          'MY_DEVICE', 'hidden', 'text', 'device', '9900')
$$, '23514', NULL,
  'and neither can its EXPORT COLUMN: a variable named MY_DEVICE exporting as `device` '
  'collides in the generated flat table exactly as badly as one named `device`');
SELECT lives_ok($$
  INSERT INTO content.variables (survey_version_id, id, org_id, name, kind, vtype,
                                 export_column, sort_key)
  VALUES ((current_setting('rs.ids')::jsonb ->> 'ver_a_content_draft')::app.ulid,
          'var_0AZA0000000000000000000000',
          (current_setting('rs.ids')::jsonb ->> 'org_a')::app.ulid,
          'country', 'system', 'text', 'SYS_COUNTRY', '9A00')
$$, 'a `system` variable MAY occupy a reserved name — that is what the namespace is for. The '
    'trigger exempts kind = ''system'' rather than banning the name outright');

-- ---------------------------------------------------------------------------
-- 6. Ordering: one row per drag, and rebalancing (B §4.6, P1-03 acceptance)
-- ---------------------------------------------------------------------------
-- Every call here runs as `authoring`. content.move_node is SECURITY INVOKER and calls
-- content.next_sort_key, which calls content.frac_key_at, which the rebalance path calls
-- too; EXECUTE on all of them is checked against the CALLER at call time. Run as the
-- migration runner this section would pass with none of those grants in place.
SELECT is(content.move_question_item(
            pg_temp.tid('ver_a_content_draft')::app.ulid,
            pg_temp.tid('opt_a_last')::app.ulid, NULL), 1,
  'moving the LAST of 60 options to the top updates EXACTLY ONE ROW (B §4.6). With integer '
  'positions this is 60 UPDATEs, 60 audit rows, 60 rows of WAL and a guaranteed write-write '
  'conflict with a colleague editing an unrelated sibling — which is P1-03''s acceptance '
  'criterion, and the whole argument for a fractional key');
SELECT results_eq($$
  SELECT id::text FROM content.question_items
   WHERE survey_version_id = current_setting('rs.ids')::jsonb ->> 'ver_a_content_draft'
     AND item_kind = 'option'
   ORDER BY sort_key, id LIMIT 1
$$, ARRAY[(SELECT pg_temp.tid('opt_a_last'))],
  'and it really is first in display order afterwards');
SELECT results_eq($$
  SELECT code FROM content.question_items
   WHERE id = current_setting('rs.ids')::jsonb ->> 'opt_a_last'
     AND survey_version_id = current_setting('rs.ids')::jsonb ->> 'ver_a_content_draft'
$$, ARRAY[60],
  'while its `code` is untouched at 60. C §5.1 calls confusing code with display order "a '
  'classic data disaster"; here they are two columns with two different constraints, so '
  'randomizing or dragging display order cannot change what lands in the data file');
SELECT is(content.move_node(
            pg_temp.tid('ver_a_content_draft')::app.ulid,
            pg_temp.tid('pg_a')::app.ulid,
            pg_temp.tid('blk_a')::app.ulid, NULL), 1,
  'reparent-and-reorder of a page is also ONE row');
SELECT throws_ok($$
  SELECT content.move_node(
    (current_setting('rs.ids')::jsonb ->> 'ver_a_content_draft')::app.ulid,
    (current_setting('rs.ids')::jsonb ->> 'blk_a')::app.ulid,
    (current_setting('rs.ids')::jsonb ->> 'pg_a')::app.ulid, NULL)
$$, '23514', NULL,
  'a node cannot be moved into its OWN SUBTREE. No FK can express this, and the recursive '
  'tree read would simply never terminate, so move_node checks it once for every caller');
SELECT throws_ok($$
  SELECT content.move_node(
    (current_setting('rs.ids')::jsonb ->> 'ver_a_content_draft')::app.ulid,
    (current_setting('rs.ids')::jsonb ->> 'q1_a')::app.ulid,
    (current_setting('rs.ids')::jsonb ->> 'blk_a')::app.ulid, NULL)
$$, '23514', NULL,
  'and C §5''s nesting is enforced: a block holds blocks and pages, a page holds questions '
  'and text, so a question cannot be dropped directly into a block');

-- B §4.6's pathological sequence: 200 inserts at the same point.
SELECT is(pg_temp.adjacent_inserts(pg_temp.tid('ver_a_content_draft'), pg_temp.tid('pg_a'),
                                   pg_temp.tid('q1_a'), pg_temp.tid('org_a'), 200), 200,
  '200 nodes inserted at the SAME point in one sibling set, each through '
  'content.next_sort_key as `authoring`');
SELECT ok(pg_temp.max_key_len(pg_temp.tid('ver_a_content_draft'), pg_temp.tid('pg_a')) > 16,
  'key growth is real and this is the case that pays for it: the longest sort_key in that '
  'sibling set is now over 16 characters (~1 char per adjacent insert, B §4.6)');
SELECT set_config('rs.order_before',
  pg_temp.sibling_ids(pg_temp.tid('ver_a_content_draft'), pg_temp.tid('pg_a'))::text, true);
SELECT is(content.rebalance_siblings(pg_temp.tid('ver_a_content_draft')::app.ulid,
                                     pg_temp.tid('pg_a')::app.ulid), 202,
  'content.rebalance_siblings() rewrites all 202 siblings in one statement — and it RUNS: '
  '0001''s body combined FOR UPDATE with row_number(), which PostgreSQL rejects at execution '
  'time, so before 0007 §10a this call raised feature_not_supported and every drag on a '
  'heavily-edited list failed with it');
SELECT ok(pg_temp.max_key_len(pg_temp.tid('ver_a_content_draft'), pg_temp.tid('pg_a')) < 16,
  'and the longest key drops back under 16 characters: O(siblings) writes amortized over '
  'thousands of edits instead of paid on every one');
SELECT is(pg_temp.sibling_ids(pg_temp.tid('ver_a_content_draft'),
                              pg_temp.tid('pg_a'))::text,
          current_setting('rs.order_before'),
  'with the ORDER COMPLETELY PRESERVED. A rebalance that reorders a questionnaire is worse '
  'than long keys');

SELECT throws_ok($$
  INSERT INTO content.nodes (survey_version_id, id, org_id, node_kind, sort_key, ref)
  VALUES ((current_setting('rs.ids')::jsonb ->> 'ver_a_content_draft')::app.ulid,
          'blk_0AR20000000000000000000000',
          (current_setting('rs.ids')::jsonb ->> 'org_a')::app.ulid, 'block', '0100', 'ROOT2')
$$, '23505', NULL,
  'two ROOT blocks cannot share a sort_key. parent_id is NULL for roots, so under the '
  'default NULLS DISTINCT this collision would be allowed and root ordering would be the '
  'one sibling set whose order was not total — hence NULLS NOT DISTINCT on '
  'nodes_sibling_order_key, a deliberate deviation from B §4.6''s plain UNIQUE');

-- ---------------------------------------------------------------------------
-- 7. The tree load (B §13, UI §3.3)
-- ---------------------------------------------------------------------------
SELECT results_eq($$
  SELECT id::text, node_kind::text, depth, ordinal::int, item_count::int, child_count::int
    FROM content.tree_rows(
      (current_setting('rs.ids')::jsonb ->> 'ver_a_content_frozen')::app.ulid)
$$, $$ VALUES
  ((SELECT pg_temp.tid('blk_a')), 'block',    1, 1, 0, 1),
  ((SELECT pg_temp.tid('pg_a')),  'page',     2, 2, 0, 2),
  ((SELECT pg_temp.tid('q1_a')),  'question', 3, 3, 1, 0),
  ((SELECT pg_temp.tid('q2_a')),  'question', 3, 4, 60, 0) $$,
  'content.tree_rows() returns the tree in DOCUMENT ORDER from one recursive CTE, with '
  'depth, a dense ordinal, and the counts the tree renders — 60 options on Q2 without a '
  'second query. Not N+1 per level, which at 2,000 questions across 30 blocks is 30+ '
  'queries for one screen (UI §3.3)');
SELECT results_eq($$
  SELECT emit_count FROM content.tree_rows(
    (current_setting('rs.ids')::jsonb ->> 'ver_a_content_frozen')::app.ulid)
   WHERE id = current_setting('rs.ids')::jsonb ->> 'q1_a'
$$, ARRAY[1], 'and the emitted-variable count comes from nodes.emits, so "which columns does '
              'Q7 produce" needs no compiler run (C §5)');

-- Soft delete is the editor's undo buffer: the node leaves the tree, keeps its id, and
-- releases its ref immediately.
SELECT results_eq($$
  WITH u AS (UPDATE content.nodes SET deleted_at = now()
              WHERE survey_version_id = current_setting('rs.ids')::jsonb ->> 'ver_a_content_draft'
                AND id = current_setting('rs.ids')::jsonb ->> 'q1_a' RETURNING 1)
  SELECT count(*)::int FROM u
$$, ARRAY[1], 'soft-deleting a question is one UPDATE');
SELECT is_empty($$
  SELECT 1 FROM content.tree_rows(
    (current_setting('rs.ids')::jsonb ->> 'ver_a_content_draft')::app.ulid)
   WHERE id = current_setting('rs.ids')::jsonb ->> 'q1_a'
$$, 'a soft-deleted node disappears from the tree while its id stays alive, so every AST '
    'that referenced it is still valid when the user hits undo (UI §5.4)');
SELECT lives_ok($$
  INSERT INTO content.nodes (survey_version_id, id, org_id, node_kind, parent_id, sort_key,
                             ref, question_type, required, label_key)
  VALUES ((current_setting('rs.ids')::jsonb ->> 'ver_a_content_draft')::app.ulid,
          'qst_0ANEW000000000000000000000',
          (current_setting('rs.ids')::jsonb ->> 'org_a')::app.ulid, 'question',
          (current_setting('rs.ids')::jsonb ->> 'pg_a')::app.ulid, 'ZZ01', 'S1',
          'single_select', true, 'q.new.label')
$$, 'and its ref is released immediately: delete Q7, add a new Q7. nodes_ref_key is partial '
    'on deleted_at precisely so the undo buffer cannot block a rename');
SELECT throws_ok($$
  INSERT INTO content.nodes (survey_version_id, id, org_id, node_kind, parent_id, sort_key,
                             ref, question_type, required, label_key)
  VALUES ((current_setting('rs.ids')::jsonb ->> 'ver_a_content_draft')::app.ulid,
          'qst_0ANEW200000000000000000000',
          (current_setting('rs.ids')::jsonb ->> 'org_a')::app.ulid, 'question',
          (current_setting('rs.ids')::jsonb ->> 'pg_a')::app.ulid, 'ZZ02', 's2',
          'single_select', true, 'q.new2.label')
$$, '23505', NULL,
  'but a LIVE ref cannot be duplicated, case-insensitively (`s2` vs the seeded `S2`): a ref '
  'ends up as a CSV header and an SPSS variable name, where Q7 and q7 are one column');

-- Kind-shape: the price of one node table is nullable columns, and this is what stops that
-- price becoming "a question with no question_type".
SELECT throws_ok($$
  INSERT INTO content.nodes (survey_version_id, id, org_id, node_kind, parent_id, sort_key,
                             ref, required)
  VALUES ((current_setting('rs.ids')::jsonb ->> 'ver_a_content_draft')::app.ulid,
          'qst_0ABAD000000000000000000000',
          (current_setting('rs.ids')::jsonb ->> 'org_a')::app.ulid, 'question',
          (current_setting('rs.ids')::jsonb ->> 'pg_a')::app.ulid, 'ZZ03', 'QBAD', true)
$$, '23514', NULL, 'a question with no question_type is rejected (nodes_kind_shape)');
SELECT throws_ok($$
  INSERT INTO content.nodes (survey_version_id, id, org_id, node_kind, parent_id, sort_key,
                             ref)
  VALUES ((current_setting('rs.ids')::jsonb ->> 'ver_a_content_draft')::app.ulid,
          'pg_0ABAD0000000000000000000000',
          (current_setting('rs.ids')::jsonb ->> 'org_a')::app.ulid, 'page', NULL, 'ZZ04',
          'PBAD')
$$, '23514', NULL,
  'a ROOT page is rejected: C §5 makes blocks the only legal root, because a root page has '
  'no block for block-level randomization or a loop to attach to');

-- ---------------------------------------------------------------------------
-- 8. Items and cells (B §4.2, C §5.1, C §5.2)
-- ---------------------------------------------------------------------------
-- MAINTAINED IN 0010, per db/README.md's rule for a later migration that changes an earlier
-- one's objects. The ids below used to read row_… and col_…, matching 0007's claim that
-- content.question_items.id carries a kind-dependent prefix; 0010 §4 withdrew that claim —
-- Deliverable C §5.1 gives options, rows and columns ONE shape and one `opt_` prefix, which is
-- what packages/schema has always branded them, and the divergence made every matrix question
-- unpublishable — and added qitems_id_prefix. Only the literal strings changed: every assertion
-- here is about ref and code uniqueness being scoped by item_kind, and item_kind is still the
-- column that carries the kind. The prefix rule itself is asserted in 0010's test.sql, which is
-- where the constraint now lives.
SELECT lives_ok($$
  INSERT INTO content.question_items (survey_version_id, id, org_id, question_id, item_kind,
                                      ref, code, sort_key)
  VALUES ((current_setting('rs.ids')::jsonb ->> 'ver_a_content_draft')::app.ulid,
          'opt_0AZ10000000000000000000000',
          (current_setting('rs.ids')::jsonb ->> 'org_a')::app.ulid,
          (current_setting('rs.ids')::jsonb ->> 'q2_a')::app.ulid, 'row', 'r1', 1, '0100'),
         ((current_setting('rs.ids')::jsonb ->> 'ver_a_content_draft')::app.ulid,
          'opt_0AZ20000000000000000000000',
          (current_setting('rs.ids')::jsonb ->> 'org_a')::app.ulid,
          (current_setting('rs.ids')::jsonb ->> 'q2_a')::app.ulid, 'column', 'r1', 1, '0100')
$$, 'a matrix may have a row `r1` AND a column `r1` with the same code: uniqueness is scoped '
    'by item_kind, because rows and columns are different axes that happen to share a shape');
SELECT throws_ok($$
  INSERT INTO content.question_items (survey_version_id, id, org_id, question_id, item_kind,
                                      ref, code, sort_key)
  VALUES ((current_setting('rs.ids')::jsonb ->> 'ver_a_content_draft')::app.ulid,
          'opt_0AZ30000000000000000000000',
          (current_setting('rs.ids')::jsonb ->> 'org_a')::app.ulid,
          (current_setting('rs.ids')::jsonb ->> 'q2_a')::app.ulid, 'row', 'r2', 1, '0200')
$$, '23505', NULL,
  'two rows of one question cannot share a code: `code` is the exported value and Q2r{code} '
  'is named after it');
SELECT lives_ok($$
  INSERT INTO content.question_cells (survey_version_id, id, org_id, question_id,
                                      row_item_id, question_type, config)
  VALUES ((current_setting('rs.ids')::jsonb ->> 'ver_a_content_draft')::app.ulid,
          'cel_0A010000000000000000000000',
          (current_setting('rs.ids')::jsonb ->> 'org_a')::app.ulid,
          (current_setting('rs.ids')::jsonb ->> 'q2_a')::app.ulid,
          'opt_0AZ10000000000000000000000', 'numeric', '{"min":0,"max":100}')
$$, 'C §5.2 mixed matrix: a per-row control override is a thin (question_type, config) pair, '
    'so row A can be numeric while row B is text with no new engine and no new table');
SELECT throws_ok($$
  INSERT INTO content.question_cells (survey_version_id, id, org_id, question_id,
                                      row_item_id, question_type, config)
  VALUES ((current_setting('rs.ids')::jsonb ->> 'ver_a_content_draft')::app.ulid,
          'cel_0A020000000000000000000000',
          (current_setting('rs.ids')::jsonb ->> 'org_a')::app.ulid,
          (current_setting('rs.ids')::jsonb ->> 'q2_a')::app.ulid,
          'opt_0AZ10000000000000000000000', 'text', '{}')
$$, '23505', NULL,
  'one override per (question, row, column): two overrides for one cell is not "last one '
  'wins", it is a survey whose exported data TYPE depends on row order');
SELECT throws_ok($$
  INSERT INTO content.question_cells (survey_version_id, id, org_id, question_id,
                                      row_item_id, column_item_id, question_type, use_columns)
  VALUES ((current_setting('rs.ids')::jsonb ->> 'ver_a_content_draft')::app.ulid,
          'cel_0A030000000000000000000000',
          (current_setting('rs.ids')::jsonb ->> 'org_a')::app.ulid,
          (current_setting('rs.ids')::jsonb ->> 'q2_a')::app.ulid,
          'opt_0AZ10000000000000000000000', 'opt_0AZ20000000000000000000000',
          'single_select', true)
$$, '23514', NULL,
  'use_columns ("this control ranges over the matrix''s columns") is meaningless on an '
  'override that already names one column, so the combination is rejected rather than '
  'silently ignored');

-- ---------------------------------------------------------------------------
-- 9. i18n (B §6, C §16)
-- ---------------------------------------------------------------------------
SELECT throws_ok($$
  INSERT INTO content.i18n_strings (survey_version_id, lang, key, value, state, org_id)
  VALUES ((current_setting('rs.ids')::jsonb ->> 'ver_a_content_draft')::app.ulid,
          'fr', 'q.s1.label', 'Bonjour', 'translated',
          (current_setting('rs.ids')::jsonb ->> 'org_a')::app.ulid)
$$, '23503', NULL,
  'a language must be DECLARED on the version before it can be translated into, or a typo '
  'in a vendor''s import file silently creates a language nobody offers');
SELECT throws_ok($$
  UPDATE content.languages SET is_base = true
   WHERE survey_version_id = current_setting('rs.ids')::jsonb ->> 'ver_a_content_draft'
     AND lang = 'de'
$$, '23505', NULL,
  'a version has exactly one base language: two would make on_missing = fallback_to_base '
  'ambiguous, and the ambiguity surfaces as a respondent seeing a translation key');
SELECT throws_ok($$
  INSERT INTO content.i18n_strings (survey_version_id, lang, key, value, state, org_id)
  VALUES ((current_setting('rs.ids')::jsonb ->> 'ver_a_content_draft')::app.ulid,
          'en', 'q.s2.label', 'text but marked missing', 'missing',
          (current_setting('rs.ids')::jsonb ->> 'org_a')::app.ulid)
$$, '23514', NULL,
  'a row that says `missing` while holding a value is rejected: it would make the publish '
  'completeness gate lie in the safe-looking direction');

-- ---------------------------------------------------------------------------
-- 10. ADR-002: the frozen version, in both layers
-- ---------------------------------------------------------------------------
SELECT results_eq($$
  WITH u AS (UPDATE content.nodes SET label_key = 'pwned'
              WHERE survey_version_id = current_setting('rs.ids')::jsonb ->> 'ver_a_content_frozen'
              RETURNING 1) SELECT count(*)::int FROM u
$$, ARRAY[0],
  'writing to a FROZEN version''s nodes updates ZERO ROWS through the policy — not an '
  'exception thrown halfway through a transaction, which is why ADR-002 is expressed in the '
  'policy as well as in the trigger (B §12, P1-03 Tests)');
SELECT results_eq($$
  WITH u AS (UPDATE content.question_items SET label_key = 'pwned'
              WHERE survey_version_id = current_setting('rs.ids')::jsonb ->> 'ver_a_content_frozen'
              RETURNING 1) SELECT count(*)::int FROM u
$$, ARRAY[0], 'and the same for a frozen version''s options');
SELECT results_eq($$
  WITH u AS (UPDATE content.variables SET export_column = 'PWNED'
              WHERE survey_version_id = current_setting('rs.ids')::jsonb ->> 'ver_a_content_frozen'
              RETURNING 1) SELECT count(*)::int FROM u
$$, ARRAY[0],
  'and for its variables — a frozen version''s export contract cannot be renamed under a '
  'client who has already received the codebook');
SELECT results_eq($$
  WITH d AS (DELETE FROM content.nodes
              WHERE survey_version_id = current_setting('rs.ids')::jsonb ->> 'ver_a_content_frozen'
              RETURNING 1) SELECT count(*)::int FROM d
$$, ARRAY[0], 'a frozen version''s content cannot be deleted either');
SELECT throws_ok($$
  INSERT INTO content.nodes (survey_version_id, id, org_id, node_kind, sort_key, ref)
  VALUES ((current_setting('rs.ids')::jsonb ->> 'ver_a_content_frozen')::app.ulid,
          'blk_0AFR0000000000000000000000',
          (current_setting('rs.ids')::jsonb ->> 'org_a')::app.ulid, 'block', '9000', 'LATE')
$$, '23514', NULL,
  'INSERTING into a frozen version RAISES rather than affecting zero rows, and the two '
  'behaviours are both correct: a BEFORE ROW trigger fires before the policy''s WITH CHECK '
  'is consulted, so content.tg_draft_only is what answers first — with "clone a new draft to '
  'edit", which is the message the editor needs');

-- The trigger, now as the OWNER, which is the path a migration or a 2 a.m. service-role
-- script takes. FORCE ROW LEVEL SECURITY applies policies to the table owner, but a
-- SUPERUSER bypasses RLS entirely — so this reaches the table and only the trigger is left.
RESET ROLE;
SELECT throws_ok($$
  UPDATE content.nodes SET label_key = 'pwned by the owner'
   WHERE survey_version_id = current_setting('rs.ids')::jsonb ->> 'ver_a_content_frozen'
$$, '23514', NULL,
  'and as the OWNER — who bypasses RLS altogether — the same write RAISES from '
  'content.tg_draft_only (P1-03 Tests: "updates zero rows (policy) and raises from the '
  'trigger when attempted as owner"). Two layers, because the policy protects the '
  'application and the trigger protects everything else');
SELECT throws_ok($$
  DELETE FROM content.question_items
   WHERE survey_version_id = current_setting('rs.ids')::jsonb ->> 'ver_a_content_frozen'
$$, '23514', NULL, 'the trigger covers DELETE as the owner too, not only UPDATE');
SELECT matches(
  (SELECT obj_description('content.tg_draft_only()'::regprocedure, 'pg_proc')),
  'ADR-002', 'content.tg_draft_only carries the COMMENT ON citing ADR-002: db/README.md '
             'treats \d+ and obj_description() as the documentation');

-- ---------------------------------------------------------------------------
-- 11. Copy-on-write cloning (ADR-002, B §4.1's most load-bearing decision)
-- ---------------------------------------------------------------------------
SELECT pg_temp.act_as(pg_temp.tid('user_a')::uuid, pg_temp.tid('org_a'));

-- Before the legitimate clone: org A attempts to clone ORG B's frozen version into its own
-- empty draft. content.clone_version is SECURITY INVOKER, so the source is read through A's
-- policies and there is nothing there — the call copies NOTHING and says so, rather than
-- raising (which would confirm the version exists) or succeeding (which is what a DEFINER
-- version of this function would do, making it a cross-tenant copy primitive).
SELECT is(
  content.clone_version(pg_temp.tid('ver_b_content_frozen')::app.ulid,
                        pg_temp.tid('ver_a_clone_target')::app.ulid),
  -- Every version-scoped content table, all zero. The six quota/asset/theme keys arrived with
  -- 0023, which found that 0016, 0019 and 0021 had each added a content table without a
  -- clone_version branch — so the publish-then-clone workflow ADR-002 requires was silently
  -- discarding quotas, code assets and the theme pin. This map is what caught it, exactly as the
  -- comment on the next assertion has claimed since 0010. The three vendor keys arrived with 0024,
  -- which 0023's ops.content_tables_not_cloned() refused on its first run — the check catching a
  -- forgotten table on the very next opportunity.
  '{"nodes": 0, "redirects": 0, "languages": 0, "variables": 0, "code_assets": 0, '
  '"logic_rules": 0, "quota_cells": 0, "quota_plans": 0, "i18n_strings": 0, '
  '"quota_buckets": 0, "version_theme": 0, "question_cells": 0, "question_items": 0, '
  '"quota_dimensions": 0, '
  '"vendors": 0, "vendor_limits": 0, "vendor_inbound_params": 0}'::jsonb,
  'cloning ANOTHER TENANT''S version copies exactly zero rows from every content table');
SELECT is_empty($$
  SELECT 1 FROM content.nodes
   WHERE survey_version_id = current_setting('rs.ids')::jsonb ->> 'ver_a_clone_target'
$$, 'and org A''s draft is still empty afterwards');

SELECT is(
  content.clone_version(pg_temp.tid('ver_a_content_frozen')::app.ulid,
                        pg_temp.tid('ver_a_clone_target')::app.ulid),
  -- "logic_rules": 0 because THIS suite's fixture predates content.logic_rules (added, with
  -- the clone_version branch that reports it, in 0008_authored_in). Zero is still a real
  -- assertion: the key has to be PRESENT, so a future content table dropped from
  -- clone_version's enumerated list shows up here as a missing key rather than as rows
  -- silently not copied. 0008's own suite clones a version that HAS rules.
  --
  -- "redirects": 2 was added when 0010 created content.redirects and extended both
  -- clone_version and ops.test_seed_content — which is this map doing exactly the job the
  -- comment above claims for it, one migration later.
  --
  -- The six zero-valued quota/asset/theme keys arrived with 0023. Their ABSENCE was the bug: a
  -- missing key is what a forgotten table looks like, and this assertion is the only place it was
  -- ever going to be visible. It stayed invisible for three migrations because nobody added a
  -- branch — the map catches a MIS-cloned table immediately and a FORGOTTEN one never, which is
  -- why 0023 also adds ops.content_tables_not_cloned() to close that half.
  '{"nodes": 4, "redirects": 2, "languages": 2, "variables": 4, "code_assets": 0, '
  '"logic_rules": 0, "quota_cells": 0, "quota_plans": 0, "i18n_strings": 2, '
  '"quota_buckets": 0, "version_theme": 0, "question_cells": 1, "question_items": 61, '
  '"quota_dimensions": 0, '
  '"vendors": 0, "vendor_limits": 0, "vendor_inbound_params": 0}'::jsonb,
  'cloning a FROZEN version into a fresh draft copies every content table in one '
  'INSERT ... SELECT each, as `authoring`: the source is read through a policy that permits '
  'reading a frozen version and the target through the draft-only write policies');
SELECT throws_ok($$
  SELECT content.clone_version(
    (current_setting('rs.ids')::jsonb ->> 'ver_a_content_frozen')::app.ulid,
    (current_setting('rs.ids')::jsonb ->> 'ver_a_clone_target')::app.ulid)
$$, '23505', NULL,
  'cloning into a version that already has content is refused: it would interleave two '
  'surveys, and "clone once into a freshly created draft" is the only sequence that means '
  'anything');
SELECT throws_ok($$
  SELECT content.clone_version(
    (current_setting('rs.ids')::jsonb ->> 'ver_a_content_frozen')::app.ulid,
    (current_setting('rs.ids')::jsonb ->> 'ver_a_content_frozen')::app.ulid)
$$, '22023', NULL, 'and cloning a version onto itself is refused');
SELECT is_empty($$
  SELECT 1 FROM content.nodes
   WHERE survey_version_id = current_setting('rs.ids')::jsonb ->> 'ver_a_clone_target'
     AND org_id <> current_setting('rs.ids')::jsonb ->> 'org_a'
$$, 'no row belonging to another org landed in org A''s draft');

-- The comparisons below run as the OWNER, deliberately and only because pgTAP's set_eq
-- materializes both sides into a TEMP TABLE and 0001 revoked TEMPORARY on the database from
-- PUBLIC — `authoring` cannot create anything in pg_temp, which is a property worth keeping.
-- The clone itself was performed as `authoring` above, which is the part where the role
-- matters; what follows only inspects the rows it produced, and doing it with RLS bypassed
-- means the comparison sees every row rather than the ones a policy would show.
RESET ROLE;
SELECT set_eq($$
  SELECT id::text FROM content.nodes
   WHERE survey_version_id = current_setting('rs.ids')::jsonb ->> 'ver_a_content_frozen'
$$, $$
  SELECT id::text FROM content.nodes
   WHERE survey_version_id = current_setting('rs.ids')::jsonb ->> 'ver_a_clone_target'
$$, 'every node id in the clone is IDENTICAL to the source''s (P1-03 Tests). This is the '
    'most load-bearing structural decision in Deliverable B: it makes version diffing a set '
    'difference rather than fuzzy matching, so "Q12 option removed" needs no heuristics');
SELECT set_eq($$
  SELECT id::text, parent_id::text, sort_key::text, ref::text, node_kind::text,
         question_type, emits::text
    FROM content.nodes
   WHERE survey_version_id = current_setting('rs.ids')::jsonb ->> 'ver_a_content_frozen'
$$, $$
  SELECT id::text, parent_id::text, sort_key::text, ref::text, node_kind::text,
         question_type, emits::text
    FROM content.nodes
   WHERE survey_version_id = current_setting('rs.ids')::jsonb ->> 'ver_a_clone_target'
$$, 'and NO REFERENCE COLUMN CHANGED — not parent_id, not emits, not one ref. There is no '
    'id remapping step to get wrong, because every internal reference is scoped by '
    'survey_version_id through a composite FK, so changing the version column IS the whole '
    'operation');
SELECT set_eq($$
  SELECT id::text, question_id::text, code, item_kind::text
    FROM content.question_items
   WHERE survey_version_id = current_setting('rs.ids')::jsonb ->> 'ver_a_content_frozen'
$$, $$
  SELECT id::text, question_id::text, code, item_kind::text
    FROM content.question_items
   WHERE survey_version_id = current_setting('rs.ids')::jsonb ->> 'ver_a_clone_target'
$$, 'option ids, their owning question and their exported codes survive the clone unchanged');
SELECT set_eq($$
  SELECT id::text, question_id::text, row_item_id::text, coalesce(column_item_id::text,''),
         question_type
    FROM content.question_cells
   WHERE survey_version_id = current_setting('rs.ids')::jsonb ->> 'ver_a_content_frozen'
$$, $$
  SELECT id::text, question_id::text, row_item_id::text, coalesce(column_item_id::text,''),
         question_type
    FROM content.question_cells
   WHERE survey_version_id = current_setting('rs.ids')::jsonb ->> 'ver_a_clone_target'
$$, 'and so do the mixed-matrix cell overrides, row_item_id included: a cell points at an '
    'ITEM id, so if anything in this model needed reference remapping on clone it would be '
    'this table');
SELECT set_eq($$
  SELECT id::text, name::text, kind::text, vtype::text, source_question_id::text,
         export_column
    FROM content.variables
   WHERE survey_version_id = current_setting('rs.ids')::jsonb ->> 'ver_a_content_frozen'
$$, $$
  SELECT id::text, name::text, kind::text, vtype::text, source_question_id::text,
         export_column
    FROM content.variables
   WHERE survey_version_id = current_setting('rs.ids')::jsonb ->> 'ver_a_clone_target'
$$, 'and so does the variable manifest, source pointers included: the export contract of a '
    'cloned wave is the same contract, which is what makes a tracker a tracker');
SELECT results_eq($$
  SELECT count(*)::int FROM content.nodes
   WHERE survey_version_id = current_setting('rs.ids')::jsonb ->> 'ver_a_clone_target'
     AND deleted_at IS NOT NULL
$$, ARRAY[0],
  'soft-deleted rows are NOT cloned: the undo buffer belongs to the draft that has it, not '
  'to its successor');

-- Node ids are stable across versions of the same survey, which is the same invariant seen
-- from the fixture's side rather than the clone's.
-- Phrased as "no id in the frozen version is missing from the draft" rather than as set
-- equality, because this suite has since added nodes to the draft. The invariant is that a
-- version's nodes carry over by identity, not that the two versions stay the same size —
-- editing a draft is the point of having one.
SELECT is_empty($$
  SELECT id::text FROM content.nodes
   WHERE survey_version_id = current_setting('rs.ids')::jsonb ->> 'ver_a_content_frozen'
     AND id NOT IN (SELECT id FROM content.nodes
                     WHERE survey_version_id = current_setting('rs.ids')::jsonb
                                               ->> 'ver_a_content_draft')
$$, 'every node id in the frozen version is present in its successor draft under the same id '
    '(C §3: ids are opaque, immutable and never reused; only survey_version_id differs) — '
    'the same invariant the clone assertions above check, seen from the fixture''s side');

-- ---------------------------------------------------------------------------
-- 12. The structural guards again, at the end, after all the mutation above
-- ---------------------------------------------------------------------------
RESET ROLE;
SELECT is_empty($$ SELECT ops.tables_without_rls() $$,
  'RLS is still forced on every tenant table after this suite has finished with it');
SELECT is_empty($$ SELECT ops.content_tables_without_draft_trigger() $$,
  'and the draft trigger is still on every content table');
SELECT is_empty($$ SELECT ops.functions_executable_by_public() $$,
  'and nothing in the six schemas is executable by PUBLIC');
-- The fourth structural guard, which belongs in every migration's test.sql for the same
-- reason the other three do: a definer function with an unpinned search_path is a
-- privilege-escalation primitive, because the caller controls which schema an unqualified
-- name resolves in. This migration adds three definer functions (app.can_see_version,
-- app.version_is_draft, ops.test_seed_content).
SELECT is_empty($$
  SELECT n.nspname || '.' || p.proname
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname IN ('app','content','runtime','export','billing','ops')
     AND p.prosecdef
     AND NOT EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig, '{}')) c
                      WHERE c LIKE 'search\_path=%')
$$, 'every SECURITY DEFINER function still pins search_path');

SELECT * FROM finish();
ROLLBACK;
