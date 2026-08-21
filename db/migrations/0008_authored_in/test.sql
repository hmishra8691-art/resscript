-- 0008_authored_in/test.sql — pgTAP. content.logic_rules and the round-trip fidelity fact.
--
-- What this file has to prove:
--   * content.logic_rules.authored_in exists, is `text`, is NOT NULL, defaults to 'visual',
--     and its CHECK admits exactly RULE_AUTHORED_IN's two values — an out-of-registry value
--     is REJECTED, which is the assertion that stops the mirror in
--     packages/schema/src/types/logic.ts and the mirror in SQL drifting apart silently;
--   * the DSL source text is NOT a column, and trivia IS one — the decision recorded in
--     up.sql's header, asserted so that "we print the source rather than store it" cannot be
--     quietly reversed by adding a column back;
--   * a rule authored in the builder cannot carry trivia (D §6.4), because trivia that
--     outlives its source makes the fidelity report lie;
--   * the report's own query — count by authored_in over one version — returns the numbers
--     the rules were written with;
--   * C §7's survey-scoped target arm is storable (B §4.4's rules_one_target as written
--     cannot store it) while every id-bearing arm still resolves to a real referenced row;
--   * a FROZEN version's rules update through the policy as ZERO ROWS and RAISE from
--     content.tg_draft_only when attempted as the owner — two layers, two behaviours;
--   * content.clone_version() carries rules, their authored_in and their trivia into the new
--     draft, so ADR-002's copy-on-write does not silently discard a survey's logic;
--   * org A reads and writes ZERO of org B's rules, forging active_org_id yields zero rows
--     rather than an error, and runtime_writer cannot read the table at all (ADR-009);
--   * ops.tables_without_rls(), ops.content_tables_without_draft_trigger(),
--     ops.functions_executable_by_public() and the definer/search_path guard are all still
--     empty with an eighth content table in place.
--
-- Everything that can run as `authoring` does, because that is the only role a real HTTP
-- caller has; the assertions that need the owner say RESET ROLE and say why.
BEGIN;
SELECT plan(60);

-- pgTAP lives in schema `public`, hardened by 0001's REVOKE ALL ... FROM PUBLIC. Granted
-- inside this transaction, which is rolled back, exactly as 0004's and 0007's suites do.
GRANT USAGE ON SCHEMA public TO authoring, runtime_writer, analytics_reader;

SELECT set_config('rs.ids', ops.test_seed_two_orgs()::text, true);
SELECT set_config('rs.ids',
  (current_setting('rs.ids')::jsonb
   || ops.test_seed_content(current_setting('rs.ids')::jsonb))::text, true);

CREATE FUNCTION pg_temp.tid(k text) RETURNS text LANGUAGE sql STABLE AS
$$ SELECT current_setting('rs.ids', true)::jsonb ->> k $$;

-- Rule ids, built here rather than through ops.test_ulid: `authoring` has no USAGE on
-- schema ops (ADR-009 — the studio role cannot reach the job queue or the fixtures), and
-- most of the statements below run as `authoring`. Same construction, same readable shape:
-- rid('A1') is always rul_0A1000000000000000000000000, so a failure message says which rule.
CREATE FUNCTION pg_temp.rid(p_tag text) RETURNS app.ulid LANGUAGE sql IMMUTABLE AS
$$ SELECT ('rul_0' || rpad(upper(p_tag), 25, '0'))::app.ulid $$;

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
-- 1. Shape: the column the fidelity report reads, and the column it must NOT read
-- ---------------------------------------------------------------------------
SELECT has_table('content', 'logic_rules',
  'content.logic_rules exists (B §4.4): ONE central rule registry, so "what affects Q12?" '
  'is an index lookup rather than a tree walk');

SELECT has_column('content', 'logic_rules', 'authored_in',
  'content.logic_rules.authored_in exists — the stored fact the DSL round-trip fidelity '
  'report reads (C §7, D §6.4)');
SELECT col_type_is('content', 'logic_rules', 'authored_in', 'text',
  'authored_in is `text` with a CHECK, as B §4.4 spells it, not an ENUM: adding a third '
  'authoring surface is then DROP/ADD CONSTRAINT rather than an irreversible ALTER TYPE');
SELECT col_not_null('content', 'logic_rules', 'authored_in',
  'authored_in is NOT NULL: "we do not know which surface authored this" is not a state the '
  'report can render, and it is never the truth — some surface did');
SELECT col_default_is('content', 'logic_rules', 'authored_in', 'visual',
  'and it defaults to ''visual'', the SAFE direction: ''visual'' claims no trivia and no '
  'preserved formatting, so a writer that forgets the column understates fidelity instead '
  'of asserting a round trip that never happened');

SELECT has_column('content', 'logic_rules', 'trivia',
  'trivia exists as its OWN column (D §6.4): comments, comment position, blank-line '
  'grouping, symbolic-vs-numeric refs and the author''s clarifying parentheses');
SELECT col_type_is('content', 'logic_rules', 'trivia', 'jsonb',
  'trivia is jsonb — D §6.4''s Trivia interface, stored as the tagged bag it is');
SELECT col_not_null('content', 'logic_rules', 'trivia',
  'trivia is NOT NULL with an empty-object default, so "no trivia" is one representation '
  'rather than two');

-- THE ABSENCE, asserted. up.sql's header argues it at length; this is the part that holds.
SELECT hasnt_column('content', 'logic_rules', 'source',
  'there is deliberately NO source column: D §6.4''s T1/T2 make the author''s text '
  'RECOVERABLE — print(ast, trivia) — and H §2.7 confirms GET /v1/rules/{id}/source is '
  'print(ast). A stored string would be a second source of truth for one rule, free to '
  'drift the moment the builder edits the AST');
SELECT hasnt_column('content', 'logic_rules', 'dsl_source',
  'nor under another name. The decisive reason is C §3: source text embeds refs, the AST '
  'embeds ids, so renaming Q1 to S1 — a metadata edit that touches no rule — would '
  'invalidate every stored source string in the survey');

SELECT has_index('content', 'logic_rules', 'rules_target_node_idx',
  'B §13''s "what affects Q12?" index exists, and its leading column serves the fidelity '
  'report''s per-version aggregate too');
SELECT has_index('content', 'logic_rules', 'rules_depends_node_gin',
  'B §13''s "what does Q3 affect?" GIN index exists — the one behind H §2.6''s 409 on '
  'deleting a variable a rule still reads');
SELECT has_index('content', 'logic_rules', 'rules_depends_var_gin',
  'and the same over variables, which is the form the engine actually uses: logic never '
  'references questions, it references variables');

SELECT has_trigger('content', 'logic_rules', 'rules_draft_only',
  'content.tg_draft_only is attached (ADR-002, B §12.1): a content table without it is a '
  'table through which a published survey can be edited under live respondents');
SELECT has_trigger('content', 'logic_rules', 'rules_touch',
  'updated_at is maintained by trigger, not by whoever remembers');

SELECT enum_has_labels('content', 'rule_kind',
  ARRAY['display', 'skip', 'mask', 'set_variable', 'validate', 'option_state', 'terminate'],
  'content.rule_kind mirrors RULE_KINDS in packages/schema/src/types/logic.ts exactly, in '
  'order: a label added there and not here is a rule the database refuses to store');
SELECT enum_has_labels('content', 'rule_target_kind',
  ARRAY['node', 'item', 'variable', 'survey'],
  'content.rule_target_kind has four labels, not C §7''s six: question/page/block are '
  'already discriminated by content.nodes.node_kind and option/row/column by '
  'question_items.item_kind, and a second copy of a distinction is a second copy that can '
  'disagree with the row it points at');

SELECT policies_are('content', 'logic_rules',
  ARRAY['rules_select', 'rules_insert', 'rules_update', 'rules_delete'],
  'exactly one policy per command, never FOR ALL: policies are additive, so a read '
  'predicate that doubles as a write predicate is a hole nobody reviews');

-- ---------------------------------------------------------------------------
-- 2. The registry CHECK, exercised through the write policy as `authoring`
-- ---------------------------------------------------------------------------
SELECT pg_temp.act_as(pg_temp.tid('user_a')::uuid, pg_temp.tid('org_a'));

-- R1: the DSL-authored rule, with the trivia from D §9.3 — a paren hint the printer would
-- otherwise drop and the author's choice of Q5.Apple over the bare code 1.
SELECT lives_ok($$
  INSERT INTO content.logic_rules
    (survey_version_id, id, org_id, kind, target_kind, target_node_id, condition, effect,
     evaluation, authored_in, trivia, notes, depends_on_node_ids, depends_on_variable_ids,
     sort_key)
  VALUES ((current_setting('rs.ids')::jsonb ->> 'ver_a_content_draft')::app.ulid,
          pg_temp.rid('A1'),
          (current_setting('rs.ids')::jsonb ->> 'org_a')::app.ulid,
          'display', 'node',
          (current_setting('rs.ids')::jsonb ->> 'q1_a')::app.ulid,
          '{"n":1,"op":"==","args":[{"n":2,"op":"var","var":"v_s1"},'
          '{"n":3,"op":"lit","v":{"k":"enum","v":1,"d":"dom_s1"}}]}',
          '{"action":"show"}', 'on_change', 'dsl',
          '{"blank_before":1,"paren_hints":[1],"symbolic_refs":{"3":"S1.Yes"},'
          '"leading":["-- client asked for this in R2 feedback"]}',
          'Client requested in R2 feedback',
          ARRAY[current_setting('rs.ids')::jsonb ->> 'q1_a']::app.ulid[],
          ARRAY[current_setting('rs.ids')::jsonb ->> 'var_a_setview']::app.ulid[],
          '0100')
$$, 'a DSL-authored rule saves WITH its trivia, through the programmer-floor write policy');

-- R2: the same rule as the builder would have produced it — no trivia, canonical formatting.
SELECT lives_ok($$
  INSERT INTO content.logic_rules
    (survey_version_id, id, org_id, kind, target_kind, target_node_id, condition, effect,
     authored_in, sort_key)
  VALUES ((current_setting('rs.ids')::jsonb ->> 'ver_a_content_draft')::app.ulid,
          pg_temp.rid('A2'),
          (current_setting('rs.ids')::jsonb ->> 'org_a')::app.ulid,
          'display', 'node',
          (current_setting('rs.ids')::jsonb ->> 'q2_a')::app.ulid,
          '{"n":1,"op":"probe","kind":"answered",'
          '"target":{"kind":"question","id":"qst_a1"}}',
          '{"action":"hide"}', 'visual', '0200')
$$, 'and a visual-authored rule saves with no trivia at all');

SELECT throws_like($$
  INSERT INTO content.logic_rules
    (survey_version_id, id, org_id, kind, target_kind, target_node_id, condition, effect,
     authored_in, sort_key)
  VALUES ((current_setting('rs.ids')::jsonb ->> 'ver_a_content_draft')::app.ulid,
          pg_temp.rid('AX'),
          (current_setting('rs.ids')::jsonb ->> 'org_a')::app.ulid,
          'display', 'node',
          (current_setting('rs.ids')::jsonb ->> 'q1_a')::app.ulid,
          '{"op":"lit","v":{"k":"bool","v":true}}', '{"action":"show"}', 'sql', '0900')
$$, '%rules_authored_in_registry%',
  'an OUT-OF-REGISTRY authored_in is rejected by name. This is the assertion that keeps the '
  'SQL mirror and RULE_AUTHORED_IN in packages/schema/src/types/logic.ts from drifting: a '
  'third surface has to be added in both places, and the failure names the constraint');
SELECT throws_ok($$
  INSERT INTO content.logic_rules
    (survey_version_id, id, org_id, kind, target_kind, target_node_id, condition, effect,
     authored_in, sort_key)
  VALUES ((current_setting('rs.ids')::jsonb ->> 'ver_a_content_draft')::app.ulid,
          pg_temp.rid('AX'),
          (current_setting('rs.ids')::jsonb ->> 'org_a')::app.ulid,
          'display', 'node',
          (current_setting('rs.ids')::jsonb ->> 'q1_a')::app.ulid,
          '{"op":"lit","v":{"k":"bool","v":true}}', '{"action":"show"}', 'DSL', '0900')
$$, '23514', NULL,
  'and the values are case-SENSITIVE — ''DSL'' is not ''dsl''. The report groups on this '
  'column, and two spellings of one surface is two rows in a two-row report');

SELECT throws_like($$
  INSERT INTO content.logic_rules
    (survey_version_id, id, org_id, kind, target_kind, target_node_id, condition, effect,
     authored_in, trivia, sort_key)
  VALUES ((current_setting('rs.ids')::jsonb ->> 'ver_a_content_draft')::app.ulid,
          pg_temp.rid('AX'),
          (current_setting('rs.ids')::jsonb ->> 'org_a')::app.ulid,
          'display', 'node',
          (current_setting('rs.ids')::jsonb ->> 'q1_a')::app.ulid,
          '{"op":"lit","v":{"k":"bool","v":true}}', '{"action":"show"}',
          'visual', '{"leading":["-- typed in the DSL, then edited in the builder"]}', '0900')
$$, '%rules_trivia_dsl_only%',
  'a VISUAL rule carrying trivia is rejected (D §6.4: builder-authored rules get no '
  'trivia). Trivia that outlives the source it describes is worse than none: the printer '
  'replays it over an AST it no longer matches, and the report then claims a fidelity it '
  'does not have');

SELECT throws_like($$
  INSERT INTO content.logic_rules
    (survey_version_id, id, org_id, kind, target_kind, target_node_id, condition, effect,
     evaluation, sort_key)
  VALUES ((current_setting('rs.ids')::jsonb ->> 'ver_a_content_draft')::app.ulid,
          pg_temp.rid('AX'),
          (current_setting('rs.ids')::jsonb ->> 'org_a')::app.ulid,
          'display', 'node',
          (current_setting('rs.ids')::jsonb ->> 'q1_a')::app.ulid,
          '{"op":"lit","v":{"k":"bool","v":true}}', '{"action":"show"}', 'on_idle', '0900')
$$, '%rules_evaluation_registry%',
  'evaluation is mirrored from RULE_EVALUATIONS the same way, and rejects the same way');

SELECT throws_like($$
  INSERT INTO content.logic_rules
    (survey_version_id, id, org_id, kind, target_kind, target_node_id, condition, effect,
     sort_key)
  VALUES ((current_setting('rs.ids')::jsonb ->> 'ver_a_content_draft')::app.ulid,
          pg_temp.rid('AX'),
          (current_setting('rs.ids')::jsonb ->> 'org_a')::app.ulid,
          'display', 'node',
          (current_setting('rs.ids')::jsonb ->> 'q1_a')::app.ulid,
          'null'::jsonb, '{"action":"show"}', '0900')
$$, '%rules_condition_is_object%',
  'a jsonb scalar `null` condition is rejected: it satisfies NOT NULL and is exactly as '
  'unevaluable, and D §1 says the evaluator''s only failure mode is a thrown '
  'LogicInvariant — a compiler bug. The shapes it cannot evaluate must be unstorable');

-- ---------------------------------------------------------------------------
-- 3. The B §4.4 / C §7 target contradiction, both directions
-- ---------------------------------------------------------------------------
-- R3: the rule B §4.4's rules_one_target as written CANNOT store — C §7's `{type:"survey"}`
-- arm, which is what a screener termination is: scoped to the session, not to a node.
SELECT lives_ok($$
  INSERT INTO content.logic_rules
    (survey_version_id, id, org_id, kind, target_kind, condition, effect, evaluation,
     authored_in, trivia, depends_on_variable_ids, sort_key)
  VALUES ((current_setting('rs.ids')::jsonb ->> 'ver_a_content_draft')::app.ulid,
          pg_temp.rid('A3'),
          (current_setting('rs.ids')::jsonb ->> 'org_a')::app.ulid,
          'terminate', 'survey',
          '{"n":1,"op":"<","args":[{"n":2,"op":"var","var":"v_age"},'
          '{"n":3,"op":"lit","v":{"k":"num","v":18}}]}',
          '{"action":"terminate","disposition":"SCREENOUT"}', 'on_submit', 'dsl',
          '{"trailing":"-- legal minimum"}',
          ARRAY[current_setting('rs.ids')::jsonb ->> 'var_a_setview']::app.ulid[],
          '0300')
$$, 'a SURVEY-scoped terminate rule saves with no target id — the C §7 arm that B §4.4''s '
    '"exactly one of three ids" CHECK cannot express, and packages/logic-parity''s parity '
    'scenario contains one, so under B''s form as written the first TERMINATE ... IF AGE < 18 '
    'would fail to save');

SELECT throws_like($$
  INSERT INTO content.logic_rules
    (survey_version_id, id, org_id, kind, target_kind, condition, effect, sort_key)
  VALUES ((current_setting('rs.ids')::jsonb ->> 'ver_a_content_draft')::app.ulid,
          pg_temp.rid('AX'),
          (current_setting('rs.ids')::jsonb ->> 'org_a')::app.ulid,
          'display', 'node',
          '{"op":"lit","v":{"k":"bool","v":true}}', '{"action":"show"}', '0900')
$$, '%rules_one_target%',
  'and the widening is exactly one arm wide: target_kind = ''node'' with NO node id is '
  'still rejected, so "a display rule that shows nothing" stays unstorable');
SELECT throws_like($$
  INSERT INTO content.logic_rules
    (survey_version_id, id, org_id, kind, target_kind, target_node_id, target_variable_id,
     condition, effect, sort_key)
  VALUES ((current_setting('rs.ids')::jsonb ->> 'ver_a_content_draft')::app.ulid,
          pg_temp.rid('AX'),
          (current_setting('rs.ids')::jsonb ->> 'org_a')::app.ulid,
          'set_variable', 'variable',
          (current_setting('rs.ids')::jsonb ->> 'q1_a')::app.ulid,
          (current_setting('rs.ids')::jsonb ->> 'var_a_setview')::app.ulid,
          '{"op":"lit","v":{"k":"bool","v":true}}',
          '{"action":"set","value":{"op":"lit","v":{"k":"num","v":1}}}', '0900')
$$, '%rules_one_target%',
  'the biconditional form says MORE than B''s sum, not less: a variable-targeted rule '
  'carrying a node id is rejected, so a set_variable rule cannot be pointed at a question');
SELECT throws_ok($$
  INSERT INTO content.logic_rules
    (survey_version_id, id, org_id, kind, target_kind, target_node_id, condition, effect,
     sort_key)
  VALUES ((current_setting('rs.ids')::jsonb ->> 'ver_a_content_draft')::app.ulid,
          pg_temp.rid('AX'),
          (current_setting('rs.ids')::jsonb ->> 'org_a')::app.ulid,
          'display', 'node',
          (current_setting('rs.ids')::jsonb ->> 'q1_b')::app.ulid,
          '{"op":"lit","v":{"k":"bool","v":true}}', '{"action":"show"}', '0900')
$$, '23503', NULL,
  'and every arm that HAS an id resolves to a real row: a target_node_id that exists in '
  'ANOTHER version fails the composite FK, which is B §4.4''s actual guarantee — "logic '
  'pointing at a deleted question" is not expressible');

-- R4/R5/R6: the remaining target arms, plus the default. R4 omits authored_in entirely.
SELECT lives_ok($$
  INSERT INTO content.logic_rules
    (survey_version_id, id, org_id, kind, target_kind, target_item_id, condition, effect,
     sort_key)
  VALUES ((current_setting('rs.ids')::jsonb ->> 'ver_a_content_draft')::app.ulid,
          pg_temp.rid('A4'),
          (current_setting('rs.ids')::jsonb ->> 'org_a')::app.ulid,
          'option_state', 'item',
          (current_setting('rs.ids')::jsonb ->> 'opt_a_first')::app.ulid,
          '{"op":"lit","v":{"k":"bool","v":false}}',
          '{"action":"option_state","prop":"enabled",'
          '"value":{"op":"lit","v":{"k":"bool","v":false}}}', '0400')
$$, 'an ITEM-targeted option_state rule saves: C §7''s option arm generalized to rows and '
    'columns, because DISABLE Q7 ROW 2 is the same shape as HIDE Q3 OPTION 4');
SELECT lives_ok($$
  INSERT INTO content.logic_rules
    (survey_version_id, id, org_id, kind, target_kind, target_variable_id, condition,
     effect, sort_key)
  VALUES ((current_setting('rs.ids')::jsonb ->> 'ver_a_content_draft')::app.ulid,
          pg_temp.rid('A5'),
          (current_setting('rs.ids')::jsonb ->> 'org_a')::app.ulid,
          'set_variable', 'variable',
          (current_setting('rs.ids')::jsonb ->> 'var_a_setview')::app.ulid,
          '{"op":"lit","v":{"k":"bool","v":true}}',
          '{"action":"set","value":{"op":"lit","v":{"k":"num","v":1}}}', '0500')
$$, 'and a VARIABLE-targeted set_variable rule saves');
SELECT is(
  (SELECT authored_in FROM content.logic_rules
    WHERE survey_version_id = pg_temp.tid('ver_a_content_draft')::app.ulid
      AND id = pg_temp.rid('A5')),
  'visual',
  'a rule written with NO authored_in gets ''visual'': the claim that promises the least');

-- ---------------------------------------------------------------------------
-- 4. The report itself, and B §13's two rule queries
-- ---------------------------------------------------------------------------
-- D §6.4: "a round-trip fidelity report can tell a user '3 of your 40 rules were edited in
-- the builder and have been reformatted'". This is that query, on five rules instead of 40.
SELECT is(
  (SELECT count(*)::int FROM content.logic_rules
    WHERE survey_version_id = pg_temp.tid('ver_a_content_draft')::app.ulid
      AND deleted_at IS NULL AND authored_in = 'visual'),
  3,
  'THE FIDELITY REPORT''S QUERY: 3 of this version''s 5 rules were authored in the builder '
  'and carry no preserved formatting. This number is not derivable from the ASTs — a '
  'builder rule and a canonically-formatted DSL rule have byte-identical ones, which is '
  'ADR-003''s isomorphism working, and is exactly why the surface has to be stored');
SELECT is(
  (SELECT count(*)::int FROM content.logic_rules
    WHERE survey_version_id = pg_temp.tid('ver_a_content_draft')::app.ulid
      AND deleted_at IS NULL AND authored_in = 'dsl'),
  2, 'and 2 were typed in ResScript and keep their trivia');
SELECT is(
  (SELECT count(*)::int FROM content.logic_rules
    WHERE survey_version_id = pg_temp.tid('ver_a_content_draft')::app.ulid
      AND authored_in = 'dsl' AND trivia <> '{}'::jsonb),
  2,
  'both DSL rules actually carry trivia rather than an empty placeholder, so the report''s '
  '"reformatted" claim has something behind it');
SELECT is(
  (SELECT trivia -> 'symbolic_refs' ->> '3' FROM content.logic_rules
    WHERE survey_version_id = pg_temp.tid('ver_a_content_draft')::app.ulid
      AND id = pg_temp.rid('A1')),
  'S1.Yes',
  'and the trivia survives a round trip through the database intact, down to the author''s '
  'choice of the symbolic option reference over the bare code — which is the one thing '
  'D §6.4 says the printer is NOT allowed to change');

SELECT is(
  (SELECT count(*)::int FROM content.logic_rules
    WHERE survey_version_id = pg_temp.tid('ver_a_content_draft')::app.ulid
      AND target_node_id = pg_temp.tid('q1_a')::app.ulid AND deleted_at IS NULL),
  1, 'B §13: "what affects Q12?" — one rule, one index lookup on rules_target_node_idx');
SELECT is(
  (SELECT count(*)::int FROM content.logic_rules
    WHERE depends_on_node_ids @> ARRAY[pg_temp.tid('q1_a')]::app.ulid[]),
  1,
  'B §13: "what does Q3 affect?" — the other direction, from the dependency closure the GIN '
  'index serves. Both directions indexable is why the closure is stored at all');
SELECT is(
  (SELECT count(*)::int FROM content.logic_rules
    WHERE depends_on_variable_ids
          @> ARRAY[pg_temp.tid('var_a_setview')]::app.ulid[]),
  2,
  'and over variables, which is the form the engine uses — this is the query behind H '
  '§2.6''s 409 when a variable a rule reads is deleted');

-- ---------------------------------------------------------------------------
-- 5. Copy-on-write: rules follow their survey into the new draft (ADR-002)
-- ---------------------------------------------------------------------------
-- The whole point of adding logic_rules to content.clone_version. Without it, publishing a
-- survey and clicking Edit produces a draft with every question and NO logic, silently,
-- because dropping rows nobody selected is not an error.
SELECT is(
  content.clone_version(pg_temp.tid('ver_a_content_draft')::app.ulid,
                        pg_temp.tid('ver_a_clone_target')::app.ulid),
  '{"nodes": 4, "languages": 2, "variables": 4, "logic_rules": 5, "i18n_strings": 2, '
  '"question_cells": 1, "question_items": 61}'::jsonb,
  'content.clone_version() reports logic_rules alongside every other content table: five '
  'rules in, five rules out. The count map is the mechanical protection against a future '
  'content table being left out of the enumerated list');
SELECT is(
  (SELECT count(*)::int FROM content.logic_rules
    WHERE survey_version_id = pg_temp.tid('ver_a_clone_target')::app.ulid),
  5, 'and the rows are really in the new version');
SELECT results_eq($$
  SELECT id FROM content.logic_rules
   WHERE survey_version_id = current_setting('rs.ids')::jsonb ->> 'ver_a_clone_target'
   ORDER BY id
$$, $$
  SELECT id FROM content.logic_rules
   WHERE survey_version_id = current_setting('rs.ids')::jsonb ->> 'ver_a_content_draft'
     AND deleted_at IS NULL
   ORDER BY id
$$, 'rule ids are IDENTICAL across the clone, like every other content id (B §4.1): no '
    'remapping, so a diff between two waves aligns rules by identity and "this rule changed" '
    'is a comparison rather than a guess');
SELECT results_eq($$
  SELECT target_kind::text, target_node_id, target_item_id, target_variable_id
    FROM content.logic_rules
   WHERE survey_version_id = current_setting('rs.ids')::jsonb ->> 'ver_a_clone_target'
   ORDER BY id
$$, $$
  SELECT target_kind::text, target_node_id, target_item_id, target_variable_id
    FROM content.logic_rules
   WHERE survey_version_id = current_setting('rs.ids')::jsonb ->> 'ver_a_content_draft'
     AND deleted_at IS NULL
   ORDER BY id
$$, 'and so are the three target ids — the clone needs no reference remapping precisely '
    'because every reference is scoped by survey_version_id through a composite FK');
SELECT is(
  (SELECT count(*)::int FROM content.logic_rules
    WHERE survey_version_id = pg_temp.tid('ver_a_clone_target')::app.ulid
      AND authored_in = 'dsl' AND trivia <> '{}'::jsonb),
  2,
  'authored_in and trivia ride along verbatim: wave 7 of a tracker still knows which of its '
  'rules were typed in ResScript, which is what makes the fidelity report meaningful across '
  'a republish rather than only within one draft');

-- ---------------------------------------------------------------------------
-- 6. ADR-002: a frozen version's rules are not writable, in both layers
-- ---------------------------------------------------------------------------
-- The fixture's frozen version has no rules in it (0007 wrote the seed before this table
-- existed), so the version that HAS rules is frozen here — forward along the lifecycle
-- app.tg_version_guard permits, exactly as ops.test_seed_content does it: draft -> review.
RESET ROLE;
UPDATE app.survey_versions SET status = 'review'
 WHERE id = pg_temp.tid('ver_a_content_draft')::app.ulid;
SELECT isnt(
  (SELECT frozen_at FROM app.survey_versions
    WHERE id = pg_temp.tid('ver_a_content_draft')::app.ulid),
  NULL, 'the version holding those five rules is now frozen (draft -> review)');

SELECT pg_temp.act_as(pg_temp.tid('user_a')::uuid, pg_temp.tid('org_a'));
SELECT results_eq($$
  WITH u AS (UPDATE content.logic_rules SET effect = '{"action":"hide"}'
              WHERE survey_version_id =
                    current_setting('rs.ids')::jsonb ->> 'ver_a_content_draft'
              RETURNING 1) SELECT count(*)::int FROM u
$$, ARRAY[0],
  'a frozen version''s rules update through the policy as ZERO ROWS. This is the layer that '
  'matters for the editor: an out-of-date client sees "0 rows updated" and a conflict, not '
  'an exception thrown halfway through a transaction');
SELECT results_eq($$
  WITH u AS (UPDATE content.logic_rules SET authored_in = 'visual', trivia = '{}'
              WHERE survey_version_id =
                    current_setting('rs.ids')::jsonb ->> 'ver_a_content_draft'
              RETURNING 1) SELECT count(*)::int FROM u
$$, ARRAY[0],
  'and that includes authored_in: the fidelity report over a PUBLISHED version cannot be '
  'rewritten after the fact, which is the property that makes it evidence');
SELECT results_eq($$
  WITH d AS (DELETE FROM content.logic_rules
              WHERE survey_version_id =
                    current_setting('rs.ids')::jsonb ->> 'ver_a_content_draft'
              RETURNING 1) SELECT count(*)::int FROM d
$$, ARRAY[0], 'nor deleted');
SELECT throws_ok($$
  INSERT INTO content.logic_rules
    (survey_version_id, id, org_id, kind, target_kind, target_node_id, condition, effect,
     sort_key)
  VALUES ((current_setting('rs.ids')::jsonb ->> 'ver_a_content_frozen')::app.ulid,
          pg_temp.rid('AF'),
          (current_setting('rs.ids')::jsonb ->> 'org_a')::app.ulid,
          'display', 'node',
          (current_setting('rs.ids')::jsonb ->> 'q1_a')::app.ulid,
          '{"op":"lit","v":{"k":"bool","v":true}}', '{"action":"show"}', '9000')
$$, '23514', NULL,
  'INSERTING a rule into a frozen version RAISES rather than affecting zero rows, and both '
  'behaviours are correct: a BEFORE ROW trigger fires before the policy''s WITH CHECK is '
  'consulted, so content.tg_draft_only answers first — with "clone a new draft to edit", '
  'which is the message the editor needs');

RESET ROLE;
SELECT throws_ok($$
  UPDATE content.logic_rules SET notes = 'pwned by the owner'
   WHERE survey_version_id = current_setting('rs.ids')::jsonb ->> 'ver_a_content_draft'
$$, '23514', NULL,
  'and as the OWNER — who bypasses RLS altogether — the same write RAISES from '
  'content.tg_draft_only. Two layers, because the policy protects the application and the '
  'trigger protects the 2 a.m. service-role script');

-- ---------------------------------------------------------------------------
-- 7. Tenant isolation (ADR-009)
-- ---------------------------------------------------------------------------
-- Org B gets a rule of its own, written as the owner: without one, every cross-tenant
-- assertion below would pass vacuously over an empty table.
INSERT INTO content.logic_rules
  (survey_version_id, id, org_id, kind, target_kind, target_node_id, condition, effect,
   authored_in, sort_key)
VALUES (pg_temp.tid('ver_b_content_draft')::app.ulid, pg_temp.rid('B1'),
        pg_temp.tid('org_b')::app.ulid, 'display', 'node',
        pg_temp.tid('q1_b')::app.ulid,
        '{"op":"lit","v":{"k":"bool","v":true}}', '{"action":"show"}', 'dsl', '0100');

SELECT pg_temp.act_as(pg_temp.tid('user_a')::uuid, pg_temp.tid('org_a'));
SELECT is_empty($$
  SELECT 1 FROM content.logic_rules
   WHERE org_id = current_setting('rs.ids')::jsonb ->> 'org_b'
$$, 'org A reads ZERO of org B''s rules');
SELECT is(
  (SELECT count(*)::int FROM content.logic_rules),
  10,
  'and sees exactly its own: five in the frozen version it authored them in (readable — a '
  'review link over a frozen version is the product feature) and five in the clone');
SELECT results_eq($$
  WITH u AS (UPDATE content.logic_rules SET notes = 'pwned'
              WHERE org_id = current_setting('rs.ids')::jsonb ->> 'org_b'
              RETURNING 1) SELECT count(*)::int FROM u
$$, ARRAY[0],
  'and cannot write them: zero rows, not an error — the row is invisible, so there is '
  'nothing to raise about');

-- Forging the claim gains nothing, because app.has_role() reads app.org_members and there
-- is no membership row.
SELECT pg_temp.act_as(pg_temp.tid('user_a')::uuid, pg_temp.tid('org_b'));
SELECT is_empty($$ SELECT 1 FROM content.logic_rules $$,
  'claiming org_b in the JWT without a membership row sees NOTHING — zero rows rather than '
  'an error, so a cross-tenant probe cannot even confirm the table has contents');

-- ADR-009's negative capability. The runtime reads logic as logic.json from object storage
-- (C §17); it has no reason to hold a privilege here and holds none.
SET LOCAL ROLE runtime_writer;
SELECT throws_ok($$ SELECT 1 FROM content.logic_rules LIMIT 1 $$, '42501', NULL,
  'runtime_writer cannot read content.logic_rules at all — not filtered to zero rows, '
  'DENIED. Its entire capability surface is a short list of function signatures');

-- ---------------------------------------------------------------------------
-- 8. The structural guards, after everything above has finished mutating
-- ---------------------------------------------------------------------------
RESET ROLE;
SELECT is_empty($$ SELECT ops.tables_without_rls() $$,
  'ops.tables_without_rls() is still empty with an eighth content table in place: ENABLE '
  'without FORCE would leave the owner — which every migration runs as — exempt from its '
  'own policies');
SELECT is_empty($$ SELECT ops.content_tables_without_draft_trigger() $$,
  'ops.content_tables_without_draft_trigger() is still empty');
SELECT is_empty($$ SELECT ops.functions_executable_by_public() $$,
  'and nothing in the six schemas is executable by PUBLIC — CREATE OR REPLACE preserves a '
  'function''s ACL, and this is the guard that would have caught it if it did not');
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
  SELECT schemaname || '.' || tablename || '.' || policyname
    FROM pg_policies
   WHERE schemaname = 'content' AND tablename = 'logic_rules'
     AND (cmd = 'ALL'
          OR (coalesce(qual, '') || ' ' || coalesce(with_check, '')) NOT LIKE '%current_org%'
          OR (cmd IN ('INSERT','UPDATE') AND with_check IS NULL))
$$, 'and this table''s four policies each name one command, constrain org_id against '
    'app.current_org(), and carry a WITH CHECK on every write: USING says which rows you '
    'may touch, WITH CHECK says what they may become');

SELECT * FROM finish();
ROLLBACK;
