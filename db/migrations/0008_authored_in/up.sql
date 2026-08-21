-- 0008_authored_in — content.logic_rules, and persisting HOW a rule was authored (P1-06).
--
-- Deliverable B §4.4 (the logic_rules table and its three indexes), §12 (RLS), §13 ("what
-- affects Q12?" / "what does Q3 affect?"), §14 (expand/contract, the timeout header);
-- Deliverable C §7 (the rule shape, `authored_in`, `notes`); Deliverable D §4.1 (the fields
-- the engine consumes), §6.4 (the two round-trip guarantees and Trivia), §9.3 (a real rule
-- with its trivia); Deliverable H §2.7 (the rules API); ADR-002 (versions are the unit of
-- immutability), ADR-003 (the DSL and the builder are two views of one model), ADR-009
-- (org_id on every row).
--
-- WHAT THIS MIGRATION IS FOR. `authored_in` is the column the DSL round-trip fidelity report
-- reads: D §6.4 says the field "exists precisely so a round-trip fidelity report can tell a
-- user '3 of your 40 rules were edited in the builder and have been reformatted'". There is
-- nothing to read it from today — B §4.4's table had not been created yet (db/README.md
-- lists `logic_rules` as arriving "with the milestone that uses it"), so this migration
-- creates it, with `authored_in` and the trivia that makes the claim behind it true.
--
-- Migration header first, mandated by Deliverable B §14 and enforced by
-- tools/ci/lint-migrations.mjs (which reads the first 60 lines, so the reasoning below comes
-- after it rather than before): an ALTER TABLE waiting behind a long read drags an
-- ACCESS EXCLUSIVE lock queue with it and stalls the runtime. Failing fast and retrying is
-- strictly better than blocking. Everything in this file is expand-only — one new table, two
-- new types, one function body replaced — so there is no rename, no in-place type change, and
-- no default that has to be materialized over rows that already exist.
SET lock_timeout = '3s';
SET statement_timeout = '120s';

-- ---------------------------------------------------------------------------
-- 0. The two decisions and the one contradiction, recorded before the DDL
-- ---------------------------------------------------------------------------
-- THE COLUMN THAT IS DELIBERATELY ABSENT: there is no `source` / `dsl_source` text column.
-- It is tempting — "the user typed this, keep it" — and it is wrong three times over:
--
--   1. D §6.4's T1/T2 make source *recoverable* rather than storable. `print(ast, trivia)`
--      reproduces the author's text: comments, comment position, blank-line grouping,
--      symbolic-vs-numeric option refs and clarifying parentheses are exactly what Trivia
--      carries, and everything the printer is allowed to change (whitespace, keyword case,
--      `==` -> `=`, redundant parens) is by definition not worth storing. H §2.7 says the
--      same thing from the API side: `GET /v1/rules/{id}/source` is `print(ast)`, and a
--      POST carrying `source` "parses it and stores both the AST and the trivia" — the AST
--      and the trivia, not the text.
--   2. A source column is a SECOND source of truth for one rule. The builder edits the AST
--      (that is what ADR-003's isomorphism is), so a stored source string starts drifting
--      the first time a rule is touched in the visual editor — and then the fidelity report
--      is reporting on the drift of its own storage rather than on which surface the author
--      used, which is the one question it exists to answer.
--   3. Source text embeds `ref`s; the AST embeds ids (C §3, D §2.1 constraint 3). Renaming
--      Q1 to S1 is a metadata edit that touches no AST — and would silently invalidate
--      every stored source string in the survey. C §3's rename property and a source column
--      cannot both be true.
--
-- So: `condition` holds the AST and `trivia` holds the statement-level authoring detail.
-- Trivia gets its OWN COLUMN rather than riding inside `condition`, because D §6.4 is
-- explicit that "trivia lives on the statement, not inside the expression tree, so it does
-- not participate in structural equality for T1 and does not affect evaluation" — and D §9.3
-- draws it as a sibling of `condition`, not a member of it. Putting it in the AST payload
-- would mean every consumer that compares, hashes or CSEs a condition (D §10.1) has to strip
-- it first, and the one that forgets breaks T1 quietly.
--
-- THE CONTRADICTION BETWEEN B §4.4 AND C §7, resolved in §2 below rather than silently:
-- B's `rules_one_target` CHECK requires EXACTLY ONE of three target ids to be non-NULL,
-- while C §7's target union has a `{ "type": "survey" }` arm that carries no id at all — a
-- terminate rule is scoped to the session, not to a node, and packages/schema ships exactly
-- that shape (`RuleTarget` in packages/schema/src/types/logic.ts; a survey-scoped terminate
-- rule is in packages/logic-parity's parity scenario). Under B's CHECK as written, the
-- first `TERMINATE AS SCREENOUT IF AGE < 18` fails to save.
--
-- FORWARD NOTE, recorded here the way 0005 §4 recorded the vars_derived_expr carve-out for
-- 0007: D §4.1's rule shape also carries `on_unknown: 'default' | 'fire'`, the author's
-- override of §2.5's collapse (`IF Q9 > 3 ON UNKNOWN SHOW THEN SHOW Q12`). It is NOT a
-- column here, because packages/schema's LogicRule — the authoring model C §7 defines and
-- the API validates against — does not have it yet, and a column nothing writes is the
-- table equivalent of a grant with no consumer. It cannot round-trip until both exist, so
-- whichever lands first should name the other: the schema change is a `schema_version` bump
-- (B §14.1) and the column is one expand migration.

-- ---------------------------------------------------------------------------
-- 1. Enumerated types
-- ---------------------------------------------------------------------------
-- Like 0007's node_kind / item_kind / var_kind, these are NOT Deliverable K registries — K
-- §7 owns four (org_role, disposition, version_status, compile_state), all created in 0002.
-- They are structural discriminators of the physical model, so they live with the table they
-- discriminate. Their labels are MIRRORED from the TypeScript that is their source of truth,
-- and the comments name the exact export, so a reviewer can diff the two by eye and a future
-- generator has an unambiguous target.

CREATE TYPE content.rule_kind AS ENUM
  ('display', 'skip', 'mask', 'set_variable', 'validate', 'option_state', 'terminate');
COMMENT ON TYPE content.rule_kind IS
  'B §4.4 / C §7. MIRRORS RULE_KINDS in packages/schema/src/types/logic.ts, in order and '
  'spelling; that array is what the API validator and the compiler read, so a label added '
  'there and not here is a rule the database refuses to store. An ENUM rather than a CHECK '
  'because the kind is the discriminator the whole engine dispatches on (D §4.2 gives each '
  'kind a different effect shape and D §2.5 a different unknown-collapse direction), and '
  'because unlike `authored_in` it is not a list anyone expects to extend.';

CREATE TYPE content.rule_target_kind AS ENUM ('node', 'item', 'variable', 'survey');
COMMENT ON TYPE content.rule_target_kind IS
  'THE RESOLUTION of the B §4.4 / C §7 contradiction. C §7''s target union has six arms — '
  'question | page | block | option | variable | survey — and B §4.4''s rules_one_target '
  'CHECK ("exactly one of three ids is NOT NULL") can express five of them and not the '
  'sixth: a survey-scoped rule (the terminate rule in packages/logic-parity''s scenario) '
  'carries no id at all, so under B''s CHECK as written it cannot be saved. This type is the '
  'discriminator that makes the no-id arm expressible while keeping B''s real guarantee, '
  'which is that every target that HAS an id is a genuine referenced row behind a composite '
  'FK. Four labels, not six, for exactly the reason B §4.1 gives for one node table: '
  'question/page/block are already discriminated by content.nodes.node_kind and option/row/'
  'column by content.question_items.item_kind, so re-encoding those distinctions here would '
  'create a second copy that can DISAGREE with the row it points at — and a CHECK cannot '
  'read another table to stop it. The API reconstructs C §7''s six-arm `type` by reading the '
  'target row''s own kind, which it already reads to render a rule.';

-- ---------------------------------------------------------------------------
-- 2. content.logic_rules — "what affects Q12?" (B §4.4, C §7)
-- ---------------------------------------------------------------------------
CREATE TABLE content.logic_rules (
  survey_version_id       app.ulid NOT NULL,
  id                      app.ulid NOT NULL,   -- no DEFAULT: see content.question_items.id
  org_id                  app.ulid NOT NULL,
  kind                    content.rule_kind NOT NULL,
  target_kind             content.rule_target_kind NOT NULL,
  target_node_id          app.ulid,
  target_item_id          app.ulid,
  target_variable_id      app.ulid,
  -- The AST (Deliverable D), and nothing but the AST. See the header on why the author's
  -- source text is not here and why trivia is not in here either.
  condition               jsonb NOT NULL,
  effect                  jsonb NOT NULL,
  evaluation              text NOT NULL DEFAULT 'on_change',
  authored_in             text NOT NULL DEFAULT 'visual',
  trivia                  jsonb NOT NULL DEFAULT '{}',
  notes                   text,
  -- Dependency closure, recomputed from the AST on save. Makes BOTH directions indexable.
  depends_on_variable_ids app.ulid[] NOT NULL DEFAULT '{}',
  depends_on_node_ids     app.ulid[] NOT NULL DEFAULT '{}',
  sort_key                content.sort_key NOT NULL,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  deleted_at              timestamptz,
  PRIMARY KEY (survey_version_id, id),
  FOREIGN KEY (org_id, survey_version_id)
    REFERENCES app.survey_versions (org_id, id) ON DELETE CASCADE,
  FOREIGN KEY (survey_version_id, target_node_id)
    REFERENCES content.nodes (survey_version_id, id) ON DELETE CASCADE,
  FOREIGN KEY (survey_version_id, target_item_id)
    REFERENCES content.question_items (survey_version_id, id) ON DELETE CASCADE,
  FOREIGN KEY (survey_version_id, target_variable_id)
    REFERENCES content.variables (survey_version_id, id) ON DELETE CASCADE,
  -- B §4.4's rules_one_target, widened by exactly one arm and stated as three
  -- biconditionals rather than a sum. The biconditional form says strictly more than
  -- "exactly one is non-NULL": it also pins WHICH one, so `target_kind = 'variable'` with a
  -- node id — a set_variable rule that would write to a question — is not expressible. For
  -- target_kind = 'survey' all three biconditionals reduce to "this id is NULL", so the
  -- no-id arm needs no clause of its own.
  CONSTRAINT rules_one_target CHECK (
        (target_kind = 'node')     = (target_node_id     IS NOT NULL)
    AND (target_kind = 'item')     = (target_item_id     IS NOT NULL)
    AND (target_kind = 'variable') = (target_variable_id IS NOT NULL)),
  CONSTRAINT rules_evaluation_registry
    CHECK (evaluation IN ('on_change', 'on_page_enter', 'on_submit')),
  CONSTRAINT rules_authored_in_registry CHECK (authored_in IN ('visual', 'dsl')),
  -- D §6.4: "Rules authored in the builder get authored_in: 'visual' and no trivia; the
  -- printer emits them with canonical formatting." Encoded rather than assumed, because the
  -- alternative is trivia that OUTLIVES the source it describes: a DSL rule reopened in the
  -- builder keeps its old comments and paren hints, the printer replays them over an AST
  -- they no longer describe, and the round-trip report then claims fidelity it does not
  -- have. Flipping authored_in to 'visual' and clearing trivia is one UPDATE, and it is
  -- precisely the event the report exists to report.
  CONSTRAINT rules_trivia_dsl_only CHECK (authored_in = 'dsl' OR trivia = '{}'::jsonb),
  -- `jsonb NOT NULL` accepts the JSON scalar `null`, which is not SQL NULL and passes
  -- NOT NULL while being exactly as unevaluable. D §1: the evaluator's only failure mode is
  -- a thrown LogicInvariant, i.e. a compiler bug — so the shapes it cannot evaluate must be
  -- unstorable, not merely unusual.
  CONSTRAINT rules_condition_is_object CHECK (jsonb_typeof(condition) = 'object'),
  CONSTRAINT rules_effect_is_object    CHECK (jsonb_typeof(effect)    = 'object'),
  CONSTRAINT rules_trivia_is_object    CHECK (jsonb_typeof(trivia)    = 'object')
);
COMMENT ON TABLE content.logic_rules IS
  'C §7 and B §4.4: ONE central rule registry, not rules nested in the nodes they affect. '
  'The reason is the two questions a survey programmer actually asks — "what affects Q12?" '
  'and "what does Q3 affect?" — which a central registry answers with an index lookup and '
  'nested storage answers with a full tree walk. Version-scoped like every content table '
  '(B §0 ground rule 3), so a rule belongs to a survey VERSION and is frozen with it '
  '(ADR-002). Polymorphic targets are made honest by three nullable FK columns plus '
  'rules_one_target: every target that has an id is a real referenced row, so "logic '
  'pointing at a deleted question" is not expressible.';
COMMENT ON COLUMN content.logic_rules.authored_in IS
  'WHICH SURFACE THE AUTHOR USED: visual | dsl. C §7 declares it "for round-trip fidelity '
  'reporting" and D §6.4 says what that means concretely — the report tells a user "3 of '
  'your 40 rules were edited in the builder and have been reformatted", which is only '
  'answerable from a stored fact about authorship. It is NOT derivable: a builder-authored '
  'rule and a DSL-authored rule with canonical formatting have byte-identical ASTs, which '
  'is ADR-003''s isomorphism working correctly, and is exactly why the surface has to be '
  'recorded rather than inferred. Values MIRROR RULE_AUTHORED_IN in '
  'packages/schema/src/types/logic.ts (the same list json-schema.ts validates the API '
  'against); this is not a Deliverable K registry — K §7 owns four and this is not one of '
  'them. Default ''visual'': safe because it is the claim that promises the least (no '
  'trivia, canonical formatting, nothing preserved), so a writer that forgets the column '
  'understates fidelity instead of asserting a round trip it never made. The report is a '
  'per-version aggregate, served by the leading column of rules_target_node_idx.';
COMMENT ON COLUMN content.logic_rules.trivia IS
  'D §6.4''s Trivia, verbatim: {leading[], trailing, blank_before, symbolic_refs, '
  'paren_hints}. This is what makes T2 (source normalization) a real guarantee rather than a '
  'slogan — the printer may change whitespace, keyword case and `==`, and may NOT change '
  'comments, their position, blank-line grouping, or the author''s choice of Q1.Yes over 1. '
  'A SEPARATE COLUMN, not a member of `condition`: D §6.4 requires trivia to stay out of the '
  'expression tree so it does not participate in T1''s structural equality or in the '
  'compiler''s CSE, and D §9.3 draws it as a sibling of `condition`. Empty for visual rules, '
  'enforced by rules_trivia_dsl_only. NOT a substitute for a source column and not a cache '
  'of one: see this migration''s header for why the author''s text is printed rather than '
  'stored.';
COMMENT ON COLUMN content.logic_rules.condition IS
  'Deliverable D''s AST. References are variable and node IDS, never refs (C §3, D §2.1): '
  'that is what makes renaming Q1 to S1 a metadata edit which touches no rule, and why the '
  'pretty-printer renders the CURRENT ref back out. Constrained to a JSON object because a '
  'jsonb scalar `null` satisfies NOT NULL and nothing else.';
COMMENT ON COLUMN content.logic_rules.effect IS
  'D §4.2''s effect union, one shape per rule kind. JSONB rather than columns because the '
  'arms carry disjoint fields — a mask effect has applies_to/mode/per_item/fallback while a '
  'terminate effect has a disposition — and eight nullable column groups guarded by a CHECK '
  'on `kind` would be a worse version of the same tagged union.';
COMMENT ON COLUMN content.logic_rules.evaluation IS
  'C §7 / D §4.1: on_change | on_page_enter | on_submit. Mirrors RULE_EVALUATIONS in '
  'packages/schema/src/types/logic.ts. A CHECK rather than an ENUM for the reason '
  'rules_authored_in_registry gives.';
COMMENT ON COLUMN content.logic_rules.notes IS
  'C §7: "a small thing agencies care about disproportionately — six months later, ''why '
  'does this rule exist'' is the expensive question", and the answer is usually in a meeting '
  'nobody minuted.';
COMMENT ON COLUMN content.logic_rules.depends_on_node_ids IS
  'The dependency closure recomputed from the AST on every save, so BOTH directions are '
  'indexable (B §4.4). Arrays plus GIN beat a rule_dependencies join table here because the '
  'closure is rewritten wholesale — an AST is edited as a unit — so a join table means '
  'delete-all-insert-N per save, and every read is "any rule mentioning this id", which is '
  'exactly the @> the GIN index serves.';
COMMENT ON COLUMN content.logic_rules.sort_key IS
  'Document order of the rule, fractional for the same reason as every other sort_key here '
  '(B §4.6): reordering one rule must be one row write. D §4.1''s compiler-assigned '
  '`order_key` is materialized from this at compile time — dense integers in the artifact, '
  'fractional keys in the database, exactly the reconciliation B §4.6 makes for option '
  '`position`. Deliberately NOT uniquely indexed, unlike nodes_sibling_order_key: D §4.4''s '
  'tie-break chain ends at rule.id, so two rules sharing a sort_key are ordered '
  'deterministically rather than arbitrarily, and evaluation order comes from the cell graph '
  'anyway — sort_key is only the second of three tie-breaks among INDEPENDENT rules.';
COMMENT ON CONSTRAINT rules_one_target ON content.logic_rules IS
  'B §4.4''s rules_one_target with C §7''s survey arm admitted. B''s form — the three '
  'IS NOT NULL casts summed to exactly 1 — cannot store a rule whose target is the survey '
  'itself, and C §7 has that arm (packages/schema''s RuleTarget, and the survey-scoped '
  'terminate rule in packages/logic-parity''s parity scenario). Stated as biconditionals '
  'against target_kind so it says more than B''s sum, not less: it pins which id goes with '
  'which kind, so a variable-targeted rule cannot carry a node id.';
COMMENT ON CONSTRAINT rules_authored_in_registry ON content.logic_rules IS
  'MIRRORS RULE_AUTHORED_IN in packages/schema/src/types/logic.ts. A CHECK rather than an '
  'ENUM deliberately, and B §4.4 spells it as a CHECK too: adding a third authoring surface '
  'is then DROP CONSTRAINT + ADD CONSTRAINT NOT VALID + VALIDATE, which is expand/contract '
  '(B §14) and takes no ACCESS EXCLUSIVE lock for the duration of a scan. ALTER TYPE ... ADD '
  'VALUE is the shape that has no reverse and cannot be done in one transaction with a '
  'backfill, and a value removed from the TypeScript list would leave an unremovable label '
  'behind.';
COMMENT ON CONSTRAINT rules_trivia_dsl_only ON content.logic_rules IS
  'D §6.4: builder-authored rules get no trivia. Trivia that outlives the source it '
  'describes is worse than no trivia, because the printer replays it over an AST it no '
  'longer matches and the fidelity report then reports fidelity that is not there.';

-- B §13's two rule queries, which are the two a programmer actually asks.
CREATE INDEX rules_target_node_idx ON content.logic_rules (survey_version_id, target_node_id)
  WHERE deleted_at IS NULL;
COMMENT ON INDEX content.rules_target_node_idx IS
  'B §13: "what affects Q12?" — WHERE survey_version_id = $1 AND target_node_id = $2, the '
  'query H §2.7 exposes as a first-class filter on GET /v1/versions/{id}/rules. Partial on '
  'deleted_at so the editor''s undo buffer costs the index nothing, and usable on its '
  'leading column alone for the whole-version reads: the compiler''s rule load, and the '
  'round-trip fidelity report''s count by authored_in.';

CREATE INDEX rules_depends_node_gin ON content.logic_rules USING gin (depends_on_node_ids);
COMMENT ON INDEX content.rules_depends_node_gin IS
  'B §13: "what does Q3 affect?" — WHERE depends_on_node_ids @> ARRAY[$1]. This is the '
  'index behind DELETE /v1/variables/{id}''s 409 (H §2.6: "409 if any rule reads it"), so '
  'deleting a question cannot silently break the logic that reads it.';

CREATE INDEX rules_depends_var_gin ON content.logic_rules USING gin (depends_on_variable_ids);
COMMENT ON INDEX content.rules_depends_var_gin IS
  'The same query over variables, which is the form the engine actually uses: logic never '
  'references questions, it references variables (D, opening). Backs '
  'GET /v1/variables/{id}/usages.';

CREATE TRIGGER rules_touch BEFORE UPDATE ON content.logic_rules
  FOR EACH ROW EXECUTE FUNCTION app.tg_touch_updated_at();

-- ADR-002, the second of the two layers. The write POLICIES below make an edit to a frozen
-- version return "0 rows updated"; this trigger makes anything that reaches the table by
-- another route — the owner, a migration, a 2 a.m. service-role script — raise. B §12.1
-- requires it on every content table and ops.content_tables_without_draft_trigger() fails
-- CI for any table that lacks it.
CREATE TRIGGER rules_draft_only
  BEFORE INSERT OR UPDATE OR DELETE ON content.logic_rules
  FOR EACH ROW EXECUTE FUNCTION content.tg_draft_only();

-- ---------------------------------------------------------------------------
-- 3. Row level security (B §12, ADR-009)
-- ---------------------------------------------------------------------------
-- ENABLE makes policies apply; FORCE makes them apply to the table OWNER too, and every
-- migration here runs as the owner — without FORCE the isolation suite passes while
-- production leaks. ops.tables_without_rls() fails CI for a table missing either.
--
-- The shape is 0007's, unchanged and deliberately so: SELECT at the `reviewer` floor with no
-- draft restriction (B §12 — "reviewers must read frozen versions", which is what a review
-- link over a published version is), and INSERT/UPDATE/DELETE at the `programmer` floor with
-- app.version_is_draft in every clause. One policy per command, never FOR ALL. Policies are
-- ADDITIVE, so a new one has to be read rather than pattern-matched — hence the same six
-- lines again rather than a shared helper that hides which predicate applies to which
-- command.
ALTER TABLE content.logic_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE content.logic_rules FORCE  ROW LEVEL SECURITY;

CREATE POLICY rules_select ON content.logic_rules FOR SELECT TO authoring
USING (org_id = app.current_org() AND app.has_role('reviewer')
       AND app.can_see_version(survey_version_id));
COMMENT ON POLICY rules_select ON content.logic_rules IS
  'Readable at the `reviewer` floor and NOT restricted to drafts, for the same reason '
  'nodes_select is not: reviewing a frozen version is the product feature. Note what is '
  'absent — no filter on `kind`, no filter on `authored_in`. A reviewer who cannot see the '
  'terminate rules cannot review the screener, and the fidelity report is a reviewer-facing '
  'artifact.';
CREATE POLICY rules_insert ON content.logic_rules FOR INSERT TO authoring
WITH CHECK (org_id = app.current_org() AND app.has_role('programmer')
            AND app.can_see_version(survey_version_id)
            AND app.version_is_draft(survey_version_id));
CREATE POLICY rules_update ON content.logic_rules FOR UPDATE TO authoring
USING (org_id = app.current_org() AND app.has_role('programmer')
       AND app.can_see_version(survey_version_id)
       AND app.version_is_draft(survey_version_id))
WITH CHECK (org_id = app.current_org() AND app.has_role('programmer')
            AND app.can_see_version(survey_version_id)
            AND app.version_is_draft(survey_version_id));
CREATE POLICY rules_delete ON content.logic_rules FOR DELETE TO authoring
USING (org_id = app.current_org() AND app.has_role('programmer')
       AND app.can_see_version(survey_version_id)
       AND app.version_is_draft(survey_version_id));
COMMENT ON POLICY rules_update ON content.logic_rules IS
  'The WITH CHECK repeats every predicate in USING: USING says which rows you may touch, '
  'WITH CHECK says what they may become, and omitting the second is the classic RLS hole — '
  'here it would let an UPDATE move a rule onto another org''s version or onto a FROZEN one. '
  'Authoring a rule is a `programmer` capability and not an `admin` one on purpose: K §1 '
  'ranks admin above programmer, and this is a policy about who edits surveys, so the floor '
  'is the survey-editing role. (Custom JS is the case where rank is not merely the wrong '
  'floor but forbidden — K §1''s custom_code capability — and no rule in this table is '
  'custom JS: ADR-003 layer 3 is not a rule, is not in the AST and is not in the DSL.)';

-- ---------------------------------------------------------------------------
-- 4. Grants (ADR-009, B §2)
-- ---------------------------------------------------------------------------
-- Explicit rather than relying on 0001's ALTER DEFAULT PRIVILEGES, per db/README.md.
GRANT SELECT, INSERT, UPDATE, DELETE ON content.logic_rules TO authoring;

-- ADR-009's negative capability, restated for the table that just appeared. 0007's
-- REVOKE ALL ON ALL TABLES IN SCHEMA content applied to the tables that existed when it ran
-- and says nothing about this one, and 0004's test.sql asserts from pg_class.relacl —
-- catalog-wide, "covers tables that do not exist yet" — that runtime_writer and
-- analytics_reader hold NO privilege on anything in app or content. The runtime reads the
-- compiled artifact from object storage; logic reaches it as logic.json (C §17), never as
-- rows.
REVOKE ALL ON content.logic_rules FROM runtime_writer, analytics_reader;

-- ---------------------------------------------------------------------------
-- 5. content.clone_version() — REDEFINED to carry rules across a version clone
-- ---------------------------------------------------------------------------
-- Not optional, and not scope creep: 0007's clone_version copies one table per INSERT …
-- SELECT and enumerates them by name, so a content table it does not know about is a table
-- whose rows are SILENTLY DROPPED on the copy-on-write that ADR-002 makes the only way to
-- edit a published survey. Publish a survey, click Edit, and every display rule, screener
-- termination and quota condition in it would be gone — with no error, because dropping
-- rows nobody selected is not an error. The clone is exactly where a new content table has
-- to be registered, and the only mechanical protection against forgetting is a test that
-- clones a version with rules in it (this migration's test.sql does).
--
-- db/README.md's rule for redefining an earlier migration's object applies: the SIGNATURE is
-- unchanged, so 0007's has_function assertion stays where it is, but the two BEHAVIOURAL
-- assertions there compare the returned per-table count map by jsonb equality and therefore
-- had to gain a "logic_rules" key. They are maintained in 0007/test.sql in this same commit.
--
-- The INSERT goes after content.variables and before content.languages because a rule's FKs
-- point at nodes, question_items and variables, all of which must already be in the target
-- version. authored_in and trivia are copied verbatim, which is the fidelity property across
-- a republish: a tracker's wave 7 still knows which of its rules were typed in ResScript.
CREATE OR REPLACE FUNCTION content.clone_version(p_from app.ulid, p_to app.ulid)
RETURNS jsonb
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  v_counts jsonb := '{}';
  v_n      integer;
BEGIN
  IF p_from = p_to THEN
    RAISE EXCEPTION 'cannot clone version % onto itself', p_from
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- Cloning INTO a version that already has content would interleave two surveys. The
  -- caller creates the draft, then clones exactly once.
  IF EXISTS (SELECT 1 FROM content.nodes n WHERE n.survey_version_id = p_to) THEN
    RAISE EXCEPTION 'target version % already has content', p_to
      USING ERRCODE = 'unique_violation',
            HINT = 'clone into a freshly created draft.';
  END IF;

  -- Nodes first. ONE statement, parents and children together: PostgreSQL's referential
  -- triggers are AFTER ROW and fire at end of STATEMENT, so the self-FK
  -- (survey_version_id, parent_id) is satisfied by the time it is checked even though a
  -- child may be inserted before its parent.
  --
  -- NOTE WHAT IS NOT HERE: no id remapping, no parent_id rewrite, no ref fixups. Node ids
  -- are stable across versions (B §4.1) and every internal reference is scoped by
  -- survey_version_id through the composite FKs, so changing the version column is the
  -- entire operation. That is the most load-bearing structural decision in Deliverable B,
  -- and this function is where it pays: version diffing aligns nodes by identity rather
  -- than fuzzy matching, so "Q12 option removed" is a set difference. It is also why the
  -- logic_rules branch below needs no attention paid to its three target ids or to the two
  -- dependency-closure arrays: every id in them is still correct in the new version.
  INSERT INTO content.nodes (
    survey_version_id, id, org_id, node_kind, parent_id, sort_key, ref,
    label_key, instruction_key, title_key, question_type, required,
    config, settings, validation, masks, scripts, flags, emits, created_at)
  SELECT p_to, n.id, n.org_id, n.node_kind, n.parent_id, n.sort_key, n.ref,
         n.label_key, n.instruction_key, n.title_key, n.question_type, n.required,
         n.config, n.settings, n.validation, n.masks, n.scripts, n.flags, n.emits,
         n.created_at
    FROM content.nodes n
   WHERE n.survey_version_id = p_from AND n.deleted_at IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('nodes', v_n);

  INSERT INTO content.question_items (
    survey_version_id, id, org_id, question_id, item_kind, ref, code, label_key, sort_key,
    anchor, exclusive, behaviour, media_asset_id, value_override, custom_class, meta,
    created_at)
  SELECT p_to, i.id, i.org_id, i.question_id, i.item_kind, i.ref, i.code, i.label_key,
         i.sort_key, i.anchor, i.exclusive, i.behaviour, i.media_asset_id,
         i.value_override, i.custom_class, i.meta, i.created_at
    FROM content.question_items i
   WHERE i.survey_version_id = p_from AND i.deleted_at IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('question_items', v_n);

  INSERT INTO content.question_cells (
    survey_version_id, id, org_id, question_id, row_item_id, column_item_id,
    question_type, config, use_columns, created_at)
  SELECT p_to, c.id, c.org_id, c.question_id, c.row_item_id, c.column_item_id,
         c.question_type, c.config, c.use_columns, c.created_at
    FROM content.question_cells c
   WHERE c.survey_version_id = p_from;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('question_cells', v_n);

  INSERT INTO content.variables (
    survey_version_id, id, org_id, name, kind, vtype, source_question_id, source_item_id,
    source_part, enum_domain, expression, storage, export_include, export_column,
    export_label_key, pii, persist, sort_key, created_at)
  SELECT p_to, v.id, v.org_id, v.name, v.kind, v.vtype, v.source_question_id,
         v.source_item_id, v.source_part, v.enum_domain, v.expression, v.storage,
         v.export_include, v.export_column, v.export_label_key, v.pii, v.persist,
         v.sort_key, v.created_at
    FROM content.variables v
   WHERE v.survey_version_id = p_from AND v.deleted_at IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('variables', v_n);

  -- 0008. After variables, because a rule's targets and its dependency closure point at
  -- nodes, items and variables. authored_in and trivia ride along unchanged: which surface
  -- authored a rule is a fact about the rule, not about the version it happens to sit in.
  INSERT INTO content.logic_rules (
    survey_version_id, id, org_id, kind, target_kind, target_node_id, target_item_id,
    target_variable_id, condition, effect, evaluation, authored_in, trivia, notes,
    depends_on_variable_ids, depends_on_node_ids, sort_key, created_at)
  SELECT p_to, r.id, r.org_id, r.kind, r.target_kind, r.target_node_id, r.target_item_id,
         r.target_variable_id, r.condition, r.effect, r.evaluation, r.authored_in,
         r.trivia, r.notes, r.depends_on_variable_ids, r.depends_on_node_ids, r.sort_key,
         r.created_at
    FROM content.logic_rules r
   WHERE r.survey_version_id = p_from AND r.deleted_at IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('logic_rules', v_n);

  INSERT INTO content.languages (
    survey_version_id, lang, org_id, is_base, rtl, on_missing,
    block_publish_if_incomplete, created_at)
  SELECT p_to, l.lang, l.org_id, l.is_base, l.rtl, l.on_missing,
         l.block_publish_if_incomplete, l.created_at
    FROM content.languages l
   WHERE l.survey_version_id = p_from;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('languages', v_n);

  -- B §6 acknowledges the cost: ~300k narrow rows for a 2,000-question survey in 12
  -- languages, duplicated on every publish. ~30 MB and under a second for INSERT … SELECT,
  -- and it is what buys per-string translation state and the publish gate as an EXISTS.
  INSERT INTO content.i18n_strings (
    survey_version_id, lang, key, value, state, org_id, updated_by, updated_at)
  SELECT p_to, s.lang, s.key, s.value, s.state, s.org_id, s.updated_by, s.updated_at
    FROM content.i18n_strings s
   WHERE s.survey_version_id = p_from;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('i18n_strings', v_n);

  RETURN v_counts;
END $$;
COMMENT ON FUNCTION content.clone_version(app.ulid, app.ulid) IS
  'ADR-002 copy-on-write: publishing freezes a version, editing clones a new draft. ONE '
  'INSERT … SELECT per content table with NO REFERENCE REMAPPING, because node ids are '
  'stable across versions (B §4.1) and every internal reference is scoped by '
  'survey_version_id through a composite FK. Two consequences, both wanted: the clone is a '
  'flat copy with the version column changed, and version diffing aligns by identity so '
  '"Q12 option removed" is a set difference. Soft-deleted rows are dropped — the undo buffer '
  'belongs to the draft that has it, not to its successor. SECURITY INVOKER: the source is '
  'read through the caller''s policies (nodes_select permits reading a FROZEN version) and '
  'the target through the caller''s write policies plus content.tg_draft_only, so cloning '
  'into a non-draft is refused by both layers. THE TABLE LIST IS ENUMERATED BY NAME, so '
  'every new content table must be added here (0008 added content.logic_rules): a table '
  'this function does not know about loses its rows on the clone with no error, because '
  'dropping rows nobody selected is not an error.';

-- CREATE OR REPLACE preserves the function's ACL, so 0007's REVOKE/GRANT pair still stands.
-- Restated anyway, and idempotently, because "preserves the ACL" is a property of the
-- statement rather than something visible at the call site, and
-- ops.functions_executable_by_public() is the guard that would have to catch it being wrong.
REVOKE EXECUTE ON FUNCTION content.clone_version(app.ulid, app.ulid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION content.clone_version(app.ulid, app.ulid) TO authoring;
