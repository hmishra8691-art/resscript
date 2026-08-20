-- 0007_content_model — the version-scoped authoring content model (P1-03).
--
-- Deliverable B §4 (§4.1 one node table, §4.2 items and cells, §4.3 variables, §4.6
-- fractional ordering), §6 (i18n_strings / languages), §12 (RLS); Deliverable C §3
-- (stable id, mutable ref), §5 / §5.1 / §5.2 (the tree, options, mixed matrices), §4 (the
-- variable registry); Deliverable K §6 (the reserved variable namespace); ADR-002
-- (versions are the unit of immutability) and ADR-009 (org_id on every row).
--
-- THE LOAD-BEARING DECISION IN THIS FILE, restated because everything else follows from it
-- (B §4.1, last paragraph): **node ids are stable across versions.** Cloning a draft from a
-- frozen version reuses every `id` verbatim and only `survey_version_id` differs. That is
-- what makes content.clone_version() a flat INSERT … SELECT per table with NO reference
-- remapping, and what makes version diffing a set difference rather than fuzzy matching.
-- Every composite FK below is `(survey_version_id, <ref column>)` precisely so an internal
-- reference is scoped by version and therefore needs no rewriting on clone.
--
-- THREE THINGS THIS MIGRATION ALSO CARRIES, each recorded where it happens and listed here
-- because a reviewer should not have to find them:
--   * §7  the `vars_derived_expr` CARVE-OUT. Deliverable B §4.3's
--         CHECK ((kind = 'derived') = (expression IS NOT NULL)) is unsatisfiable for
--         structurally derived variables, and 0005 §4 recorded that as a forward note for
--         this migration. Without it the first multi-select save fails.
--   * §10a a REDEFINITION of content.rebalance_siblings(), declared in 0001 with a body that
--         combines FOR UPDATE with row_number() — which PostgreSQL rejects at execution
--         time. It has never run; from this migration onward the drag path calls it.
--   * §14  EXECUTE grants on the four functions content.move_node calls. SECURITY INVOKER is
--         transitive, so granting only the entry points is a null implementation.
--
-- Migration header, mandated by Deliverable B §14 and enforced by
-- tools/ci/lint-migrations.mjs: an ALTER TABLE waiting behind a long read drags an
-- ACCESS EXCLUSIVE lock queue with it and stalls the runtime. Failing fast and retrying is
-- strictly better than blocking.
SET lock_timeout = '3s';
SET statement_timeout = '120s';

-- ---------------------------------------------------------------------------
-- 1. Enumerated types (B §4)
-- ---------------------------------------------------------------------------
-- These are NOT Deliverable K registries (K §7 lists the four that are: org_role,
-- disposition, version_status, compile_state, all created in 0002). They are structural
-- discriminators of the physical model, so they live with the tables they discriminate.

CREATE TYPE content.node_kind AS ENUM ('block', 'page', 'question', 'text');
COMMENT ON TYPE content.node_kind IS
  'B §4.1: the discriminator that lets Blocks, Pages, Questions and text nodes share ONE '
  'table. Three tables would make every rule/mask/flow target a polymorphic reference with '
  'no FK — "logic pointing at a deleted question" would be expressible — would need a '
  'trigger or a fourth names table for survey-wide `ref` uniqueness, and would triple the '
  'tree code paths (reorder, move, subtree clone, the recursive load CTE).';

CREATE TYPE content.item_kind AS ENUM ('option', 'row', 'column');
COMMENT ON TYPE content.item_kind IS
  'B §4.2 / C §5.1: rows and columns have the same shape as options, so they share one '
  'table and one ordering implementation.';

CREATE TYPE content.var_kind AS ENUM
  ('response', 'hidden', 'derived', 'system', 'quota', 'design');
COMMENT ON TYPE content.var_kind IS
  'C §4. `response` from respondent input, `hidden` from URL/vendor params or scripts, '
  '`derived` computed, `system` platform-supplied (reserved namespace, K §6), `quota` the '
  'assigned cell, `design` the experimental block a respondent received. `design` is '
  'mandatory rather than optional: omitting it makes MaxDiff/conjoint data unanalysable.';

CREATE TYPE content.var_type AS ENUM
  ('enum', 'boolean', 'number', 'text', 'date', 'set', 'object');
COMMENT ON TYPE content.var_type IS
  'C §4. The DATA type of a variable, deliberately independent of the question type that '
  'produced it — which is why no engine downstream of here needs an '
  '`if (question_type === ''matrix'')` branch.';

CREATE TYPE content.string_state AS ENUM ('missing', 'machine', 'translated', 'reviewed');
COMMENT ON TYPE content.string_state IS
  'B §6 / C §16: per-string translation state. A JSONB bundle per language cannot say '
  '"reviewed", which is the entire operational point of the row-per-string layout.';

-- ---------------------------------------------------------------------------
-- 2. Version-scoped visibility helpers
-- ---------------------------------------------------------------------------
-- Every content table carries `survey_version_id` and NOT `survey_id` (B §0 ground rule 3),
-- so app.can_see_survey() cannot be applied directly. These two helpers are the content
-- equivalents. Both are SECURITY DEFINER for exactly the reason 0004 gives for
-- app.can_see_survey: app.survey_versions itself has RLS, and evaluating its policies
-- inside another table's policy makes the effective predicate depend on evaluation order,
-- which is not a property anyone should have to reason about while reviewing a policy.
--
-- They are also why B §12's sketch — an inline `EXISTS (SELECT 1 FROM app.survey_versions
-- …)` in the policy body — is not what shipped. The inline form is nested RLS, and it
-- repeats a four-line predicate on 24 policies.

CREATE FUNCTION app.can_see_version(p_version app.ulid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1 FROM app.survey_versions v
     WHERE v.id = p_version
       AND v.org_id = app.current_org()
       AND app.can_see_project((SELECT s.project_id FROM app.surveys s WHERE s.id = v.survey_id)))
$$;
COMMENT ON FUNCTION app.can_see_version(app.ulid) IS
  'Project scoping for the content tables, which carry survey_version_id and nothing else '
  '(B §0 ground rule 3). Resolves version -> survey -> project and defers to '
  'app.can_see_project(), so K §1''s client inversion (empty project_ids means NOTHING for '
  'a client and org-wide for staff) applies to survey content without being restated. '
  'Returns false rather than raising when the version does not exist or the JWT is forged: '
  'a cross-tenant probe must see zero rows, never an error that confirms existence.';

CREATE FUNCTION app.version_is_draft(p_version app.ulid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1 FROM app.survey_versions v WHERE v.id = p_version AND v.status = 'draft')
$$;
COMMENT ON FUNCTION app.version_is_draft(app.ulid) IS
  'ADR-002 in a form a policy can use. Immutability is expressed BOTH here (in every '
  'content write policy) and in content.tg_draft_only, on purpose — B §12: the policy makes '
  'an editor bug surface as "0 rows updated" rather than an exception thrown halfway '
  'through a transaction, and the trigger catches anything that reaches the table by '
  'another route. Deliberately carries no org predicate: it answers "is this version '
  'editable", and "may you see it" is app.can_see_version''s job. Every policy below calls '
  'both, so splitting them cannot widen anything.';

REVOKE EXECUTE ON FUNCTION app.can_see_version(app.ulid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.version_is_draft(app.ulid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.can_see_version(app.ulid) TO authoring;
GRANT EXECUTE ON FUNCTION app.version_is_draft(app.ulid) TO authoring;

-- ---------------------------------------------------------------------------
-- 3. content.nodes — one table, not three (B §4.1)
-- ---------------------------------------------------------------------------
CREATE TABLE content.nodes (
  survey_version_id app.ulid NOT NULL,
  -- No DEFAULT: the prefix is kind-dependent (blk_/pg_/qst_/txt_) and, more importantly,
  -- a clone must reuse the SOURCE id verbatim. A generated default here would be a loaded
  -- gun pointed at the one structural guarantee this file exists to provide.
  id                app.ulid NOT NULL,
  org_id            app.ulid NOT NULL,
  node_kind         content.node_kind NOT NULL,
  parent_id         app.ulid,
  sort_key          content.sort_key NOT NULL,
  ref               app.ref,
  label_key         text,
  instruction_key   text,
  title_key         text,
  question_type     text,
  required          boolean,
  config            jsonb NOT NULL DEFAULT '{}',
  settings          jsonb NOT NULL DEFAULT '{}',
  validation        jsonb NOT NULL DEFAULT '[]',
  masks             jsonb NOT NULL DEFAULT '[]',
  scripts           jsonb NOT NULL DEFAULT '{}',
  flags             jsonb NOT NULL DEFAULT '{}',
  emits             app.ulid[] NOT NULL DEFAULT '{}',
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  deleted_at        timestamptz,
  PRIMARY KEY (survey_version_id, id),
  FOREIGN KEY (org_id, survey_version_id)
    REFERENCES app.survey_versions (org_id, id) ON DELETE CASCADE,
  -- Self-reference scoped BY VERSION. This single line is what makes clone_version()
  -- reference-remapping-free: a child's parent_id resolves inside the clone because the
  -- version half of the key changed with it.
  FOREIGN KEY (survey_version_id, parent_id)
    REFERENCES content.nodes (survey_version_id, id),
  CONSTRAINT nodes_kind_shape CHECK (CASE node_kind
    WHEN 'question' THEN question_type IS NOT NULL AND ref IS NOT NULL AND required IS NOT NULL
    WHEN 'text'     THEN question_type IS NULL AND label_key IS NOT NULL
    ELSE                 question_type IS NULL AND ref IS NOT NULL END),
  CONSTRAINT nodes_no_self_parent CHECK (parent_id IS DISTINCT FROM id),
  -- C §5: pages and questions nest inside blocks/pages, so a root row is a block. Stated
  -- as a constraint because a root page is a survey with no block, which the compiler's
  -- randomization and loop machinery has nowhere to attach to.
  CONSTRAINT nodes_root_is_block CHECK (parent_id IS NOT NULL OR node_kind = 'block')
);
COMMENT ON TABLE content.nodes IS
  'B §4.1 / C §5: the content tree. ONE table with a node_kind discriminator, because rules, '
  'masks and flow edges target any of block/page/question/text — three tables would make '
  'that a polymorphic reference with no FK, and "logic pointing at a deleted question" would '
  'become expressible. Scoped to survey_version_id and never survey_id (ADR-002, B §0 '
  'ground rule 3). Ids are STABLE ACROSS VERSIONS: see this migration''s header and '
  'content.clone_version().';
COMMENT ON COLUMN content.nodes.id IS
  'C §3: opaque, immutable, never reused, and IDENTICAL in every version of the survey that '
  'contains this node. All internal references (logic ASTs, piping, quotas, masks, flow '
  'edges) point here and never at `ref`, which is why renaming Q1 to S1 is a metadata edit '
  'rather than a find-and-replace across the survey.';
COMMENT ON COLUMN content.nodes.ref IS
  'C §3: the human handle (Q1, S3, GENDER). MUTABLE while draft, unique per version, and '
  'the string every derived variable name is built from. NULL only for `text` nodes, which '
  'emit nothing and therefore have nothing to name.';
COMMENT ON COLUMN content.nodes.sort_key IS
  'B §4.6: base-62 FRACTIONAL index, not an integer position. Dragging one option to the top '
  'of a 60-option list is one UPDATE of one row instead of 60 UPDATEs, 60 audit rows, 60 '
  'rows of WAL and a guaranteed write-write conflict with a colleague editing an unrelated '
  'sibling. Reordering is the most common structural edit in a survey editor. The compiler '
  'materializes row_number() OVER (ORDER BY sort_key, id) into C §5.1''s dense integer '
  '`position` when emitting the artifact, so the wire format stays as documented.';
COMMENT ON COLUMN content.nodes.emits IS
  'C §5: the variable ids this question produces. COMPUTED at save (from the plugin''s '
  'declareVariables, F §1) and stored anyway, because "which columns does Q7 produce" must '
  'be answerable by a diff and by a text search rather than by running the compiler.';
COMMENT ON COLUMN content.nodes.deleted_at IS
  'The editor''s undo buffer, drafts only (UI §5.4). Deletes are SOFT because a hard delete '
  'would cascade the rules targeting the node and no client-side inverse could restore '
  'them; a soft delete keeps the id alive, so every AST that referenced it is still valid '
  'when the user hits undo.';
COMMENT ON COLUMN content.nodes.flags IS
  'has_custom_js / pii / exclude_from_export. `has_custom_js` is computed at save time and '
  'drives the ADR-003 badge: a programmer must be able to see at a glance that the visual '
  'view is not the whole truth.';
COMMENT ON CONSTRAINT nodes_kind_shape ON content.nodes IS
  'B §4.1: the price of one table is nullable kind-specific columns, and this CHECK is what '
  'stops that price becoming "a question with no question_type". A `text` node needs a label '
  'and no plugin; a block or page needs a ref and no plugin.';
COMMENT ON CONSTRAINT nodes_root_is_block ON content.nodes IS
  'C §5: blocks are the only legal root. A root page has no block to attach block-level '
  'randomization or a loop to, and "the survey with no blocks" is a special case every '
  'later engine would have to carry.';

-- C §3: ref unique within the survey. Content rows are version-scoped, so the physical
-- scope is (survey_version_id). PARTIAL on two axes, and both matter:
--   * deleted_at IS NULL — soft-deleted nodes release their name immediately. Delete Q7,
--     add a new Q7: the undo buffer must not block it.
--   * ref IS NOT NULL — text nodes are unnamed and are exempt rather than colliding on NULL.
CREATE UNIQUE INDEX nodes_ref_key ON content.nodes (survey_version_id, lower(ref))
  WHERE deleted_at IS NULL AND ref IS NOT NULL;
COMMENT ON INDEX content.nodes_ref_key IS
  'C §3 survey-wide ref uniqueness as ONE partial unique index. Across three tables this '
  'would need a trigger or a fourth names table (B §4.1). lower() because a ref ends up as a '
  'CSV header and an SPSS variable name, where Q7 and q7 are the same column.';

CREATE UNIQUE INDEX nodes_sibling_order_key
  ON content.nodes (survey_version_id, parent_id, sort_key) NULLS NOT DISTINCT;
COMMENT ON INDEX content.nodes_sibling_order_key IS
  'B §4.6: order within a sibling set is TOTAL. Not partial on deleted_at: a soft-deleted '
  'node keeps its slot so undo restores it where it was, and two siblings that could share a '
  'key would make ORDER BY sort_key nondeterministic under a racing rebalance. '
  'NULLS NOT DISTINCT is a deliberate deviation from B §4.6''s plain UNIQUE: parent_id is '
  'NULL for root blocks, and under the default NULLS DISTINCT two ROOT blocks could share a '
  'sort_key — the one sibling set where the totality claim above would have been false. '
  'Every reader of this index uses `parent_id IS NOT DISTINCT FROM $1` (that is also why '
  'content.rebalance_siblings is written that way), so treating NULL as a value here matches '
  'how the set is actually queried.';

CREATE INDEX nodes_tree_idx ON content.nodes (survey_version_id, parent_id, sort_key)
  WHERE deleted_at IS NULL;
COMMENT ON INDEX content.nodes_tree_idx IS
  'B §13: the studio tree load. The recursive CTE in content.tree_rows() walks '
  '(version, parent_id, sort_key) and this is the index it walks.';

CREATE INDEX nodes_custom_js_idx ON content.nodes (survey_version_id)
  WHERE (flags ->> 'has_custom_js')::boolean;
COMMENT ON INDEX content.nodes_custom_js_idx IS
  'ADR-003 / ADR-005: "which nodes in this version carry custom JS" is asked by the CSP '
  'allowlist builder, the sanitizer report and the publish gate. Partial, so it costs '
  'nothing on the overwhelming majority of surveys that have none.';

CREATE INDEX nodes_emits_gin ON content.nodes USING gin (emits);
COMMENT ON INDEX content.nodes_emits_gin IS
  '"which node emits variable var_X" — asked by the export column inspector and by the '
  'diagnostic that explains an unresolved variable reference. Array + GIN rather than a join '
  'table because `emits` is rewritten wholesale on every question save (B §4.4 makes the '
  'same argument for rule dependency closures).';

CREATE TRIGGER nodes_touch BEFORE UPDATE ON content.nodes
  FOR EACH ROW EXECUTE FUNCTION app.tg_touch_updated_at();

CREATE TRIGGER nodes_draft_only
  BEFORE INSERT OR UPDATE OR DELETE ON content.nodes
  FOR EACH ROW EXECUTE FUNCTION content.tg_draft_only();

-- ---------------------------------------------------------------------------
-- 4. content.question_items — options, rows and columns (B §4.2, C §5.1)
-- ---------------------------------------------------------------------------
CREATE TABLE content.question_items (
  survey_version_id app.ulid NOT NULL,
  -- No DEFAULT, for the same two reasons content.nodes.id has none, and one more. A clone
  -- must reuse the SOURCE id verbatim; the prefix is kind-dependent, and a single default
  -- would mint `opt_...` for two of the three item kinds, breaking B §0's "every id is
  -- self-describing"; and item ids are minted in TypeScript from the question plugin's
  -- declared parts (P1-02's variableSignature keeps them STABLE across a recompute), so a
  -- server-side random id would silently replace a stable id with a fresh one.
  id                app.ulid NOT NULL,
  org_id            app.ulid NOT NULL,
  question_id       app.ulid NOT NULL,
  item_kind         content.item_kind NOT NULL,
  ref               app.ref NOT NULL,
  code              integer NOT NULL,
  label_key         text,
  sort_key          content.sort_key NOT NULL,
  anchor            text NOT NULL DEFAULT 'none',
  exclusive         boolean NOT NULL DEFAULT false,
  behaviour         jsonb NOT NULL DEFAULT '{}',
  media_asset_id    app.ulid,
  value_override    text,
  custom_class      text,
  meta              jsonb NOT NULL DEFAULT '{}',
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  deleted_at        timestamptz,
  PRIMARY KEY (survey_version_id, id),
  FOREIGN KEY (survey_version_id, question_id)
    REFERENCES content.nodes (survey_version_id, id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, survey_version_id)
    REFERENCES app.survey_versions (org_id, id) ON DELETE CASCADE,
  -- C §5.1's randomization anchors, spelled out so `anchor: 'frist'` is a constraint
  -- violation rather than an option that silently stops being anchored.
  CONSTRAINT qitems_anchor_shape
    CHECK (anchor = 'none' OR anchor = 'first' OR anchor = 'last'
           OR anchor ~ '^fixed:[0-9]{1,4}$')
);
COMMENT ON TABLE content.question_items IS
  'B §4.2 / C §5.1: options, matrix rows and matrix columns. One table because C §5.1 says '
  'rows and columns have the same shape as options — so they get the same ordering, the same '
  'anchoring, the same behaviour ASTs and the same `meta` escape hatch, rather than three '
  'near-copies that drift.';
COMMENT ON COLUMN content.question_items.code IS
  'C §5.1: THE EXPORTED VALUE. Uniquely indexed per (question, item_kind) and completely '
  'independent of `sort_key`. C §5.1 calls confusing code with display order "a classic data '
  'disaster"; here the mistake is not expressible, because they are two columns with two '
  'different constraints. Randomizing display order therefore cannot change what lands in '
  'the data file, and Q2r3 means "the option whose code is 3" for the life of the study.';
COMMENT ON COLUMN content.question_items.sort_key IS
  'B §4.6 fractional display order. See content.nodes.sort_key. Note this is a DIFFERENT '
  'column from `code`, by design.';
COMMENT ON COLUMN content.question_items.behaviour IS
  'C §5.1: visible / enabled / preselected / auto_select / required_if, each either a '
  'literal or a condition AST. "Every option is programmable" (brief §7) is why an option is '
  'a full object rather than a string.';
COMMENT ON COLUMN content.question_items.meta IS
  'C §5.1''s deliberate escape hatch: brand_id, price_point, segment. Real research needs to '
  'attach analysis metadata to an option, and without this programmers encode it in the '
  'label and regret it.';
COMMENT ON COLUMN content.question_items.exclusive IS
  'C §5.1: selecting it clears all others ("None of these"). A property of the item, not a '
  'validation rule, because the runtime must enforce it at click time.';

CREATE UNIQUE INDEX qitems_ref_key ON content.question_items
  (survey_version_id, question_id, item_kind, lower(ref)) WHERE deleted_at IS NULL;
COMMENT ON INDEX content.qitems_ref_key IS
  'C §5.1: an item ref is unique within its question AND its kind, so a matrix may have a '
  'row `r1` and a column `r1`. Partial on deleted_at for the same reason as nodes_ref_key.';

CREATE UNIQUE INDEX qitems_code_key ON content.question_items
  (survey_version_id, question_id, item_kind, code) WHERE deleted_at IS NULL;
COMMENT ON INDEX content.qitems_code_key IS
  'The export contract: two options of one question cannot claim the same code, because '
  '`code` is what appears in the data file and what Q2r{code} is named after.';

CREATE UNIQUE INDEX qitems_order_key ON content.question_items
  (survey_version_id, question_id, item_kind, sort_key);
COMMENT ON INDEX content.qitems_order_key IS
  'B §4.6: total order within (question, kind). Unique and NOT partial for the same reason '
  'as nodes_sibling_order_key — a soft-deleted item keeps its slot for undo.';

CREATE INDEX qitems_question_idx ON content.question_items
  (survey_version_id, question_id, item_kind, sort_key) WHERE deleted_at IS NULL;
COMMENT ON INDEX content.qitems_question_idx IS
  'The lazy question-body load (UI §3.3): options/rows/columns for one node, in display '
  'order, in one index scan.';

CREATE TRIGGER qitems_touch BEFORE UPDATE ON content.question_items
  FOR EACH ROW EXECUTE FUNCTION app.tg_touch_updated_at();

CREATE TRIGGER qitems_draft_only
  BEFORE INSERT OR UPDATE OR DELETE ON content.question_items
  FOR EACH ROW EXECUTE FUNCTION content.tg_draft_only();

-- ---------------------------------------------------------------------------
-- 5. content.question_cells — mixed matrices (B §4.2, C §5.2)
-- ---------------------------------------------------------------------------
CREATE TABLE content.question_cells (
  survey_version_id app.ulid NOT NULL,
  id                app.ulid NOT NULL,   -- no DEFAULT: see content.question_items.id
  org_id            app.ulid NOT NULL,
  question_id       app.ulid NOT NULL,
  row_item_id       app.ulid NOT NULL,
  column_item_id    app.ulid,
  question_type     text NOT NULL,
  config            jsonb NOT NULL DEFAULT '{}',
  use_columns       boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (survey_version_id, id),
  FOREIGN KEY (survey_version_id, question_id)
    REFERENCES content.nodes (survey_version_id, id) ON DELETE CASCADE,
  FOREIGN KEY (survey_version_id, row_item_id)
    REFERENCES content.question_items (survey_version_id, id) ON DELETE CASCADE,
  FOREIGN KEY (survey_version_id, column_item_id)
    REFERENCES content.question_items (survey_version_id, id),
  -- C §5.2: `use_columns` means "this control ranges over the matrix's columns", which is
  -- only meaningful for a whole-row override. A per-cell override already names its column.
  CONSTRAINT qcells_use_columns_is_row_level
    CHECK (NOT use_columns OR column_item_id IS NULL)
);
COMMENT ON TABLE content.question_cells IS
  'C §5.2 mixed matrices: row A numeric, row B text, row C single-select. Modelled as a THIN '
  'per-cell override — a question type plus its config — so no new engine is needed and each '
  'cell emits its own variable with its own type, which is C §1''s variable model doing its '
  'job. Absent an override a row uses the matrix''s default control.';
COMMENT ON COLUMN content.question_cells.column_item_id IS
  'NULL = the override applies to the whole row (C §5.2''s `row_ref` form). Non-NULL = one '
  'cell. Both shapes share the table because the compiler resolves row-level to per-cell '
  'when emitting, and a second table would duplicate the FK and the uniqueness rule.';

-- ::text casts before coalesce: '' is not a valid app.ulid, so coalescing inside the domain
-- would raise at index-build time. Cast out of the domain first (B §4.2 says this verbatim).
CREATE UNIQUE INDEX qcells_key ON content.question_cells
  (survey_version_id, question_id, row_item_id, coalesce(column_item_id::text, ''));
COMMENT ON INDEX content.qcells_key IS
  'One override per (question, row, column), with the row-level override occupying the '
  'empty-string slot. Two overrides for one cell is not "last one wins", it is a survey '
  'whose data type depends on row order.';

CREATE TRIGGER qcells_touch BEFORE UPDATE ON content.question_cells
  FOR EACH ROW EXECUTE FUNCTION app.tg_touch_updated_at();

CREATE TRIGGER qcells_draft_only
  BEFORE INSERT OR UPDATE OR DELETE ON content.question_cells
  FOR EACH ROW EXECUTE FUNCTION content.tg_draft_only();

-- ---------------------------------------------------------------------------
-- 6. content.reserved_variable_names — K §6, and the trigger B §4.3 asks for
-- ---------------------------------------------------------------------------
-- Deliverable K §6's list, as data. B §4.3: "the reserved `system` namespace (03 §4) is
-- enforced by a trigger reading content.reserved_variable_names — a CHECK cannot read
-- another table, and baking the list into a domain means a migration per new system
-- variable."
--
-- This table is GLOBAL reference data: it has no org_id and no survey_version_id. It is
-- therefore the one content table that legitimately carries no tg_draft_only trigger, and
-- 0001 anticipated it by name in ops.rls_exemptions.exempt_draft_trigger's comment. It
-- still gets RLS forced, with a read-only policy, because "readable by everyone" and "not
-- protected" are different statements.
--
-- ops.content_tables_without_draft_trigger() reads that exemption row and is satisfied. The
-- STATIC half of the same net — tools/ci/lint-migrations.mjs — cannot read a table it is
-- linting, so the exemption has to be restated in a form the linter can see. That is what
-- the directive below is; the linter requires the rule code, the qualified object and a
-- reason of at least 12 characters, mirroring ops.rls_exemptions.reason's own CHECK, so an
-- exemption stays a code-review conversation in both halves.
--
-- lint:exempt CONTENT_TABLE_WITHOUT_DRAFT_TRIGGER content.reserved_variable_names
--   Deliverable K §6 global reference data: no survey_version_id for content.tg_draft_only
--   to read, so the trigger would raise feature_not_supported on every write. Matched by the
--   ops.rls_exemptions row inserted below, which exempts the draft trigger and NOT RLS.
CREATE TABLE content.reserved_variable_names (
  name       text PRIMARY KEY,
  reason     text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT reserved_names_lowercase CHECK (name = lower(name)),
  CONSTRAINT reserved_names_shape CHECK (name ~ '^[a-z][a-z0-9_]{0,63}$')
);
COMMENT ON TABLE content.reserved_variable_names IS
  'Deliverable K §6 / C §4: the reserved `system` variable namespace. Stored lowercase and '
  'compared lowercase, because B''s uniqueness index is on lower(name) and accepting '
  '`Respondent_Id` here would only defer the failure. K §6: adding to this list is a '
  'BREAKING change for any survey that already used the name, so additions ship behind a '
  'schema migration that renames colliding user variables and audits the rename.';

INSERT INTO ops.rls_exemptions (table_name, reason, exempt_rls, exempt_draft_trigger) VALUES
  ('content.reserved_variable_names',
   'Deliverable K §6''s global reserved namespace. It has no survey_version_id, so '
   'content.tg_draft_only has nothing to read and would raise feature_not_supported on '
   'every write; 0001 named this table in exempt_draft_trigger''s comment for exactly this '
   'reason. RLS is NOT exempted — the table keeps ENABLE + FORCE and a read-only policy.',
   false, true);

INSERT INTO content.reserved_variable_names (name, reason) VALUES
  ('respondent_id',      'Platform identity of the respondent (C §4 system namespace).'),
  ('session_id',         'Platform identity of the session (C §4).'),
  ('survey_id',          'Platform identity of the survey (C §4).'),
  ('survey_version_id',  'Platform identity of the version serving this session (C §4).'),
  ('artifact_hash',      'ADR-002: which compiled artifact served this respondent.'),
  ('random_seed',        'The per-session seed every randomization is derived from (C §12).'),
  ('language',           'Active language for this session (C §16).'),
  ('country',            'Geo-resolved country.'),
  ('region',             'Geo-resolved region.'),
  ('device',             'Device class.'),
  ('os_class',           'Coarse OS class; never the raw user agent.'),
  ('browser_class',      'Coarse browser class; never the raw user agent.'),
  ('user_agent_class',   'Coarse UA class used by quality scoring.'),
  ('ip_hash',            'Hashed IP. The raw address is never a variable.'),
  ('referrer',           'Entry referrer.'),
  ('entry_url',          'Full entry URL, before parameter extraction.'),
  ('source',             'Traffic source.'),
  ('vendor_ref',         'Which panel vendor delivered this respondent (C §9).'),
  ('started_at',         'Session start timestamp.'),
  ('last_activity_at',   'Last activity timestamp; drives the resume window.'),
  ('completed_at',       'Completion timestamp.'),
  ('duration_s',         'Total session duration; a speeder-detection input.'),
  ('page_count',         'Pages submitted.'),
  ('disposition',        'Deliverable K §2''s canonical disposition.'),
  ('is_test',            'Test data flag (UI §9.4): test responses are visibly flagged.'),
  ('quality_score',      'Composite data-quality score.'),
  ('speeder_flag',       'Per-page min_time_s breach (C §5 page settings).'),
  ('straightliner_flag', 'Non-differentiation across a matrix.'),
  ('duplicate_flag',     'Entry-time duplicate detection.');

CREATE FUNCTION content.tg_variable_name_not_reserved() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  -- `system` variables are the platform's own; they are SUPPOSED to be named from this
  -- list. Only a user-authored variable shadowing one is the error.
  IF NEW.kind <> 'system'
     AND EXISTS (SELECT 1 FROM content.reserved_variable_names r
                  WHERE r.name = lower(NEW.name)) THEN
    RAISE EXCEPTION 'variable name % collides with the reserved system namespace', NEW.name
      USING ERRCODE = 'check_violation',
            HINT = 'Deliverable K §6: system variable names cannot be shadowed. Rename it.';
  END IF;
  -- The export column is the other half of the same namespace: a variable named MY_COUNTRY
  -- exporting as `country` collides in the flat table just as surely (B §11).
  IF NEW.export_include
     AND EXISTS (SELECT 1 FROM content.reserved_variable_names r
                  WHERE r.name = lower(NEW.export_column)) THEN
    RAISE EXCEPTION 'export column % collides with the reserved system namespace',
      NEW.export_column
      USING ERRCODE = 'check_violation',
            HINT = 'Deliverable K §6 / B §11: the flat export table has one column per name.';
  END IF;
  RETURN NEW;
END $$;
COMMENT ON FUNCTION content.tg_variable_name_not_reserved() IS
  'B §4.3''s trigger, and the reason it is a trigger: a CHECK cannot read another table, and '
  'baking K §6''s list into a domain would mean a migration per new system variable. Checks '
  'BOTH `name` and `export_column`, because a variable called MY_COUNTRY that exports as '
  '`country` collides in the generated flat table (B §11) exactly as badly as one named '
  '`country` does. Exempts kind = ''system'', whose whole purpose is to occupy these names.';

-- ---------------------------------------------------------------------------
-- 7. content.variables — the export contract (B §4.3, C §4)
-- ---------------------------------------------------------------------------
CREATE TABLE content.variables (
  survey_version_id app.ulid NOT NULL,
  id                app.ulid NOT NULL,   -- no DEFAULT: see content.question_items.id
  org_id            app.ulid NOT NULL,
  name              app.ref NOT NULL,
  kind              content.var_kind NOT NULL,
  vtype             content.var_type NOT NULL,
  source_question_id app.ulid,
  source_item_id    app.ulid,
  source_part       jsonb,
  enum_domain       jsonb,
  expression        jsonb,
  storage           jsonb NOT NULL DEFAULT '{}',
  export_include    boolean NOT NULL DEFAULT true,
  export_column     text NOT NULL,
  export_label_key  text,
  pii               boolean NOT NULL DEFAULT false,
  persist           boolean NOT NULL DEFAULT true,
  sort_key          content.sort_key NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  deleted_at        timestamptz,
  PRIMARY KEY (survey_version_id, id),
  FOREIGN KEY (org_id, survey_version_id)
    REFERENCES app.survey_versions (org_id, id) ON DELETE CASCADE,
  FOREIGN KEY (survey_version_id, source_question_id)
    REFERENCES content.nodes (survey_version_id, id) ON DELETE CASCADE,
  FOREIGN KEY (survey_version_id, source_item_id)
    REFERENCES content.question_items (survey_version_id, id) ON DELETE CASCADE,
  CONSTRAINT vars_enum_domain CHECK (vtype NOT IN ('enum', 'set') OR enum_domain IS NOT NULL),
  --
  -- THE CARVE-OUT. Deliverable B §4.3 specifies
  --     CHECK ((kind = 'derived') = (expression IS NOT NULL))
  -- and that constraint is UNSATISFIABLE for structurally derived variables. Two
  -- first-party cases, both shipping in P1-04:
  --   * a multi_select's `set<enum>` view over its boolean fan-out — derived, but the logic
  --     AST has no operator that collects the true members of a fan-out, so there is no
  --     expression to author. The compiler synthesizes it.
  --   * an NPS band — derived from the score by a rule the plugin owns, not by an AST the
  --     author wrote.
  -- Both carry a `source` (they are produced by a question), which is exactly the
  -- discriminator packages/schema already adopted for its equivalent rule (SCH-1015):
  -- require an expression only for AUTHORED derived variables, identified by the ABSENCE of
  -- a source. Migration 0005 §4 recorded this as a forward note for P1-03, and a comment
  -- enforces nothing — this constraint is the enforcement. What stops the stricter form
  -- coming back in a later migration written from B §4.3 alone is not a lint rule (static
  -- analysis cannot tell which CHECK is the satisfiable one): it is this migration's
  -- test.sql, which INSERTS a set_view variable with a source and no expression and
  -- therefore fails loudly the moment the carve-out is narrowed.
  --
  -- `source` in C §4 is one object; here it is decomposed into three columns, so all three
  -- count as "has a source".
  CONSTRAINT vars_derived_expr
    CHECK (kind <> 'derived' OR expression IS NOT NULL
           OR source_question_id IS NOT NULL OR source_item_id IS NOT NULL
           OR source_part IS NOT NULL),
  -- The other direction still holds unconditionally: an expression on a NON-derived
  -- variable is a value nobody evaluates, which is worse than an error.
  CONSTRAINT vars_expr_only_derived CHECK (expression IS NULL OR kind = 'derived'),
  CONSTRAINT vars_transient CHECK (persist OR kind IN ('derived', 'system')),
  -- C §4: a `response` or `design` variable is BY DEFINITION produced by something. A
  -- response variable with no source is an orphan column in the export.
  CONSTRAINT vars_response_has_source
    CHECK (kind <> 'response' OR source_question_id IS NOT NULL)
);
COMMENT ON TABLE content.variables IS
  'C §1/§4 and B §4.3: THE EXPORT CONTRACT. A question is a UI construct, a variable is a '
  'data construct, and a question declares which variables it emits — which is why logic, '
  'piping, masking, quotas, validation and export all read this table and none of them '
  'needs a question-type branch. `name` is derived from (ref, part) by '
  'packages/schema''s deriveVariableName but STORED, so it is diffable and greppable: '
  '"where does Q3r2 come from" must be answerable with a text search.';
COMMENT ON COLUMN content.variables.name IS
  'C §3''s deterministic derivation ({ref}r{n}, {ref}_other, {ref}c{n}) applied to the '
  'owning node''s CURRENT ref, then stored. Renaming a question therefore renames its export '
  'columns, which is what a survey programmer expects — and why the rename is structurally '
  'impossible once the version is frozen (ADR-002).';
COMMENT ON COLUMN content.variables.pii IS
  'C §4: first-class rather than an afterthought, because open-ends and contact fields need '
  'to be redactable in debug traces, excludable from vendor callback URLs, and separately '
  'permissioned in exports (K §1''s pii_access capability). Inferring it later is guesswork '
  'over customer data.';
COMMENT ON COLUMN content.variables.sort_key IS
  'B §4.3: manifest order IS export column order. Fractional for the same reason as every '
  'other sort_key here — reordering a client''s column layout must not be N UPDATEs.';
COMMENT ON COLUMN content.variables.source_part IS
  'C §4''s `source.part`: {kind: option|row|column|cell|other_specify|set_view|suffix|'
  'design_task, …}. JSONB rather than columns because it is a tagged union whose arms carry '
  'different fields, and because packages/schema''s variableSignature() — the thing that '
  'keeps ids stable across a recompute — hashes it as a unit.';
COMMENT ON CONSTRAINT vars_derived_expr ON content.variables IS
  'Deliverable B §4.3 specifies ((kind = ''derived'') = (expression IS NOT NULL)), which is '
  'UNSATISFIABLE: a multi-select''s set<enum> view and an NPS band are derived but have no '
  'authorable expression — the compiler synthesizes them. packages/schema relaxed its '
  'equivalent the same way (SCH-1015): an expression is required only for AUTHORED derived '
  'variables, identified by the absence of a source. 0005 §4 recorded the carve-out as a '
  'forward note; this constraint is the enforcement.';
COMMENT ON CONSTRAINT vars_enum_domain ON content.variables IS
  'Widened from B §4.3''s `vtype <> ''enum''` to cover `set` as well: a set<enum> with no '
  'domain cannot answer "is code 3 a member", so C §4''s set view needs the domain exactly '
  'as much as a scalar enum does.';

CREATE UNIQUE INDEX variables_name_key ON content.variables (survey_version_id, lower(name))
  WHERE deleted_at IS NULL;
COMMENT ON INDEX content.variables_name_key IS
  'C §4: variable names are unique per version. lower() because the name becomes an SPSS/R/'
  'Stata identifier and a CSV header, where case is not a distinction.';

CREATE UNIQUE INDEX variables_export_col_key
  ON content.variables (survey_version_id, lower(export_column))
  WHERE deleted_at IS NULL AND export_include;
COMMENT ON INDEX content.variables_export_col_key IS
  'B §4.3, and the constraint that keeps a client''s column layout stable (ADR-007): two '
  'variables cannot claim the same export column, so B §11''s flat-table generator can '
  'quote_ident() straight from this table with NO run-time collision handling. Partial on '
  'export_include because an excluded variable claims no column at all.';

CREATE INDEX variables_pii_idx ON content.variables (survey_version_id) WHERE pii;
COMMENT ON INDEX content.variables_pii_idx IS
  'B §4.3. Drives redaction, vendor-URL blocking and the export permission check. Partial, '
  'so the common no-PII survey pays nothing.';

CREATE INDEX variables_source_idx
  ON content.variables (survey_version_id, source_question_id);
COMMENT ON INDEX content.variables_source_idx IS
  'B §4.3: "which variables does this question emit" — the studio''s emitted-variables panel '
  '(UI §3) and the recompute path that rewrites nodes.emits on save.';

CREATE INDEX variables_manifest_idx
  ON content.variables (survey_version_id, sort_key) WHERE deleted_at IS NULL;
COMMENT ON INDEX content.variables_manifest_idx IS
  'The variable manifest in export column order, which the compiler reads once per version '
  'and the export generator reads once per file.';

CREATE TRIGGER variables_touch BEFORE UPDATE ON content.variables
  FOR EACH ROW EXECUTE FUNCTION app.tg_touch_updated_at();

CREATE TRIGGER variables_reserved_name
  BEFORE INSERT OR UPDATE ON content.variables
  FOR EACH ROW EXECUTE FUNCTION content.tg_variable_name_not_reserved();

CREATE TRIGGER variables_draft_only
  BEFORE INSERT OR UPDATE OR DELETE ON content.variables
  FOR EACH ROW EXECUTE FUNCTION content.tg_draft_only();

-- ---------------------------------------------------------------------------
-- 8. content.languages and content.i18n_strings (B §6, C §16)
-- ---------------------------------------------------------------------------
CREATE TABLE content.languages (
  survey_version_id app.ulid NOT NULL,
  lang              text NOT NULL,
  org_id            app.ulid NOT NULL,
  is_base           boolean NOT NULL DEFAULT false,
  rtl               boolean NOT NULL DEFAULT false,
  on_missing        text NOT NULL DEFAULT 'fallback_to_base',
  block_publish_if_incomplete boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (survey_version_id, lang),
  FOREIGN KEY (org_id, survey_version_id)
    REFERENCES app.survey_versions (org_id, id) ON DELETE CASCADE,
  -- BCP 47 as far as it needs to go here: language, optional script, optional region.
  CONSTRAINT languages_tag_shape CHECK (lang ~ '^[a-z]{2,3}(-[A-Z][a-z]{3})?(-[A-Z]{2})?$'),
  CONSTRAINT languages_on_missing
    CHECK (on_missing IN ('fallback_to_base', 'show_key', 'block'))
);
COMMENT ON TABLE content.languages IS
  'B §6 / C §16: the languages one survey VERSION offers. Version-scoped, so adding a '
  'language to a draft cannot change what a version already in field is serving. `rtl` is '
  'stored rather than derived from the tag because the studio''s RTL preview and the '
  'question-kit RTL fixtures need one authoritative answer.';
COMMENT ON COLUMN content.languages.block_publish_if_incomplete IS
  'C §16''s publish gate. Per-language rather than per-survey: a client signs off on English '
  'and German while Arabic is still in translation, and blocking the whole publish would '
  'mean the tracker misses its field date.';

CREATE UNIQUE INDEX languages_one_base ON content.languages (survey_version_id)
  WHERE is_base;
COMMENT ON INDEX content.languages_one_base IS
  'Exactly one base language per version. Two base languages makes '
  '`on_missing = fallback_to_base` ambiguous, and the ambiguity would surface as a '
  'respondent seeing a translation key.';

CREATE TRIGGER languages_draft_only
  BEFORE INSERT OR UPDATE OR DELETE ON content.languages
  FOR EACH ROW EXECUTE FUNCTION content.tg_draft_only();

CREATE TABLE content.i18n_strings (
  survey_version_id app.ulid NOT NULL,
  lang              text NOT NULL,
  key               text NOT NULL,
  value             text,
  state             content.string_state NOT NULL DEFAULT 'missing',
  org_id            app.ulid NOT NULL,
  updated_by        uuid REFERENCES auth.users(id),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (survey_version_id, lang, key),
  FOREIGN KEY (org_id, survey_version_id)
    REFERENCES app.survey_versions (org_id, id) ON DELETE CASCADE,
  -- The language must be declared before it can be translated into; otherwise a typo in a
  -- vendor's import file silently creates a language nobody offers.
  FOREIGN KEY (survey_version_id, lang)
    REFERENCES content.languages (survey_version_id, lang) ON DELETE CASCADE,
  CONSTRAINT i18n_missing_has_no_value
    CHECK (state <> 'missing' OR value IS NULL OR value = '')
);
COMMENT ON TABLE content.i18n_strings IS
  'B §6 / C §16: ONE ROW PER (version, lang, key) rather than a JSONB bundle per language. '
  'It costs rows — a 2,000-question survey in 12 languages is ~300k rows per version, '
  'duplicated by copy-on-write on each publish — and buys the three things that matter '
  'operationally: per-string translation state (a blob cannot say "reviewed"), a flat '
  'key/value import-export in the shape translation vendors actually accept, and the publish '
  'completeness gate as an indexed EXISTS. 300k narrow rows is ~30 MB and under a second for '
  'INSERT … SELECT; the alternative optimizes storage we do not lack.';
COMMENT ON CONSTRAINT i18n_missing_has_no_value ON content.i18n_strings IS
  'A row that says `missing` while holding a value is a row that makes the publish gate '
  'lie in the safe-looking direction. If there is text, the state is at least `machine`.';

CREATE INDEX i18n_incomplete_idx ON content.i18n_strings (survey_version_id, lang)
  WHERE state IN ('missing', 'machine');
COMMENT ON INDEX content.i18n_incomplete_idx IS
  'B §6: the publish completeness gate and the translation manager''s "what is left" count, '
  'as one partial index scan.';

CREATE INDEX i18n_key_idx ON content.i18n_strings (survey_version_id, key);
COMMENT ON INDEX content.i18n_key_idx IS
  '"show me this key in every language" — the translation manager''s row view, and the '
  'lookup the tree''s label_preview uses when the base language is not the first one loaded.';

CREATE TRIGGER i18n_draft_only
  BEFORE INSERT OR UPDATE OR DELETE ON content.i18n_strings
  FOR EACH ROW EXECUTE FUNCTION content.tg_draft_only();

-- ---------------------------------------------------------------------------
-- 9. Readability views (B §4.1)
-- ---------------------------------------------------------------------------
-- "The cost is nullable kind-specific columns, recovered for readability by views
-- (content.questions, content.pages, content.blocks) that the authoring code reads
-- through." (B §4.1)
--
-- WITH (security_invoker = true) IS LOAD-BEARING, NOT STYLE. A PostgreSQL view is
-- SECURITY DEFINER by default: it executes with the VIEW OWNER's privileges, and the view
-- owner here is the migration runner, which is superuser on a bare cluster and BYPASSRLS on
-- Supabase. Without security_invoker every one of these views would be a complete
-- cross-tenant read of content.nodes for any caller holding SELECT on the view — and
-- ops.tables_without_rls() would never notice, because it walks relkind IN ('r','p') and a
-- view is 'v'. This migration's test.sql asserts the reloption is set, precisely because
-- the catalog assertion cannot.

CREATE VIEW content.questions WITH (security_invoker = true) AS
  SELECT n.survey_version_id, n.id, n.org_id, n.parent_id AS page_id, n.sort_key, n.ref,
         n.question_type, n.required, n.label_key, n.instruction_key,
         n.config, n.validation, n.masks, n.scripts, n.flags, n.emits,
         (n.flags ->> 'pii')::boolean               AS pii,
         (n.flags ->> 'has_custom_js')::boolean     AS has_custom_js,
         (n.flags ->> 'exclude_from_export')::boolean AS exclude_from_export,
         n.created_at, n.updated_at, n.deleted_at
    FROM content.nodes n
   WHERE n.node_kind = 'question';
COMMENT ON VIEW content.questions IS
  'B §4.1 readability view over content.nodes. Renames parent_id to page_id (a question''s '
  'parent is always a page) and lifts the three `flags` booleans into columns, so authoring '
  'code stops writing (flags->>''pii'')::boolean in eight places. security_invoker = true so '
  'RLS applies to the CALLER and not to the view owner — see this section''s header comment.';

CREATE VIEW content.pages WITH (security_invoker = true) AS
  SELECT n.survey_version_id, n.id, n.org_id, n.parent_id AS block_id, n.sort_key, n.ref,
         n.title_key, n.settings,
         COALESCE(n.settings ->> 'layout', 'stacked')             AS layout,
         (n.settings ->> 'min_time_s')::integer                   AS min_time_s,
         COALESCE((n.settings ->> 'back_allowed')::boolean, true)  AS back_allowed,
         n.created_at, n.updated_at, n.deleted_at
    FROM content.nodes n
   WHERE n.node_kind = 'page';
COMMENT ON VIEW content.pages IS
  'B §4.1 readability view. C §5: a page is the unit of submission — one HTTP round trip, '
  'one validation pass, one response_event — so `min_time_s` and `back_allowed` are surfaced '
  'as columns: they are read by the runtime''s page contract and by the speeder detector, not '
  'just by the editor.';

CREATE VIEW content.blocks WITH (security_invoker = true) AS
  SELECT n.survey_version_id, n.id, n.org_id, n.parent_id, n.sort_key, n.ref,
         n.title_key, n.settings,
         n.settings -> 'randomize_children' AS randomize_children,
         n.settings -> 'loop'               AS loop,
         n.created_at, n.updated_at, n.deleted_at
    FROM content.nodes n
   WHERE n.node_kind = 'block';
COMMENT ON VIEW content.blocks IS
  'B §4.1 readability view. Blocks NEST (C §5), so parent_id is kept as parent_id here '
  'rather than renamed: a block''s parent is another block or nothing.';

-- ---------------------------------------------------------------------------
-- 10. Ordering: insertion keys, moves, and item rebalancing (B §4.6)
-- ---------------------------------------------------------------------------
-- 10a. content.rebalance_siblings() is REDEFINED here, because it has never been able to run.
--
-- 0001 declared it against a table that did not exist yet — deliberately, so that "the
-- ordering contract has exactly one implementation from the start" — and guarded the body
-- with `IF to_regclass('content.nodes') IS NULL THEN RAISE undefined_table`. 0001's test.sql
-- asserted exactly that raise, which is the only behaviour it could assert. The consequence
-- is that the REST of the body was never executed by anything, and it does not run:
--
--     WITH ordered AS (SELECT id, row_number() OVER (...) AS rn FROM content.nodes
--                       WHERE ... FOR UPDATE)      -- 0A000 feature_not_supported:
--     UPDATE content.nodes ...                     -- "FOR UPDATE is not allowed with
--                                                  --  window functions"
--
-- PostgreSQL rejects row locking in a query that also computes a window function, and it
-- rejects it at execution time rather than at CREATE FUNCTION time, so the error waited for
-- the first caller. That caller is content.move_node below: it rebalances whenever a sibling
-- set's longest key passes 16 characters, which B §4.6 says arrives after a few dozen
-- adjacent inserts (measured here: 200 adjacent inserts reach 42 characters). So the drag
-- path — the single most common structural edit in the editor, and P1-03's headline
-- acceptance criterion — would have failed with feature_not_supported once a list had been
-- reordered enough times, in exactly the surveys that had been edited most.
--
-- Fixed by locking the sibling set in its own statement, before the window function runs.
-- That keeps the locking INTENT, which is not incidental: two concurrent rebalances of one
-- parent would otherwise compute overlapping dense keys from the same snapshot and the
-- second would trip nodes_sibling_order_key. Locking in `id` order gives the deterministic
-- lock ordering that makes that serialization deadlock-free.
--
-- Redefined rather than left alone with a wrapper, per db/README.md: a later migration may
-- redefine an earlier one's object, and it must then maintain the earlier test.sql —
-- 0001's `raises undefined_table` assertion is retired there in the same commit, and the
-- has_function assertion for this signature MOVES to this migration's test.sql, because
-- signature assertions live with whichever migration currently defines the signature.
CREATE OR REPLACE FUNCTION content.rebalance_siblings(p_version app.ulid, p_parent app.ulid)
RETURNS integer
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  v_count integer;
  v_width integer;
BEGIN
  -- Lock first, ORDER BY id, as a statement of its own. See the header above.
  PERFORM 1
     FROM content.nodes n
    WHERE n.survey_version_id = p_version
      AND n.parent_id IS NOT DISTINCT FROM p_parent
    ORDER BY n.id
      FOR UPDATE;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count = 0 THEN RETURN 0; END IF;

  -- One extra character of headroom so the set can grow without an immediate re-rebalance.
  v_width := greatest(4, ceil(ln(greatest(v_count, 2)::numeric) / ln(62::numeric))::int + 1);

  WITH ordered AS (
    SELECT n.id, row_number() OVER (ORDER BY n.sort_key, n.id) AS rn
      FROM content.nodes n
     WHERE n.survey_version_id = p_version
       AND n.parent_id IS NOT DISTINCT FROM p_parent)
  UPDATE content.nodes n
     SET sort_key = content.frac_key_at(o.rn::int, v_width)
    FROM ordered o
   WHERE n.survey_version_id = p_version AND n.id = o.id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END $$;
COMMENT ON FUNCTION content.rebalance_siblings(app.ulid, app.ulid) IS
  'B §4.6. Rewrites one sibling set to short dense keys. Called by content.move_node when '
  'max(length(sort_key)) for a parent passes 16, and by a nightly job over dirty parents: '
  'O(siblings) writes amortized over thousands of edits instead of paid on every one. '
  'Version-scoped because content rows are scoped to a survey_version_id and never a '
  'survey_id (B §0 ground rule 3) — rebalancing by parent alone would rewrite a FROZEN '
  'version''s keys. REDEFINED in 0007 from 0001''s declaration: the original body combined '
  'FOR UPDATE with row_number() in one query, which PostgreSQL refuses at execution time, so '
  'the function raised feature_not_supported for every real caller. The sibling set is now '
  'locked by a separate statement in id order — the locking is what stops two concurrent '
  'rebalances of one parent computing overlapping keys, and the id ordering is what stops '
  'them deadlocking. The to_regclass guard is gone: content.nodes exists from this migration '
  'onward.';
--
-- 10b. What follows needed content.nodes to exist: computing "the key for a new sibling at
-- this position" and performing a move as ONE row write. content.frac_key_at() (both
-- overloads) is unchanged from 0001.
--
-- Why these are database functions rather than TypeScript: the key depends on the CURRENT
-- neighbours, so computing it in the application means read-then-write and a race that
-- produces two siblings with the same key. nodes_sibling_order_key would reject the second
-- one, which is the right failure but a needless one.

CREATE FUNCTION content.next_sort_key(
  p_version   app.ulid,
  p_parent    app.ulid,
  p_after_id  app.ulid DEFAULT NULL,
  p_exclude_id app.ulid DEFAULT NULL
) RETURNS content.sort_key
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  v_before content.sort_key;
  v_after  content.sort_key;
BEGIN
  IF p_after_id IS NOT NULL THEN
    SELECT n.sort_key INTO v_before
      FROM content.nodes n
     WHERE n.survey_version_id = p_version AND n.id = p_after_id;
    IF v_before IS NULL THEN
      RAISE EXCEPTION 'node % does not exist in version %', p_after_id, p_version
        USING ERRCODE = 'foreign_key_violation';
    END IF;
  END IF;

  -- The immediate successor among the siblings, which is the upper bound for the new key.
  -- The moving node is excluded so that "move X to just after Y" does not fence itself in
  -- against its own old key.
  SELECT min(n.sort_key) INTO v_after
    FROM content.nodes n
   WHERE n.survey_version_id = p_version
     AND n.parent_id IS NOT DISTINCT FROM p_parent
     AND (p_exclude_id IS NULL OR n.id <> p_exclude_id)
     AND (v_before IS NULL OR n.sort_key > v_before);

  BEGIN
    RETURN content.frac_key_at(v_before, v_after);
  EXCEPTION WHEN invalid_parameter_value THEN
    -- frac_key_at refuses when no key can exist below the upper bound (a key of all zeros).
    -- That is the documented "rebalance the sibling set" case, so do it and retry once.
    PERFORM content.rebalance_siblings(p_version, p_parent);
    IF p_after_id IS NOT NULL THEN
      SELECT n.sort_key INTO v_before FROM content.nodes n
       WHERE n.survey_version_id = p_version AND n.id = p_after_id;
    END IF;
    SELECT min(n.sort_key) INTO v_after
      FROM content.nodes n
     WHERE n.survey_version_id = p_version
       AND n.parent_id IS NOT DISTINCT FROM p_parent
       AND (p_exclude_id IS NULL OR n.id <> p_exclude_id)
       AND (v_before IS NULL OR n.sort_key > v_before);
    RETURN content.frac_key_at(v_before, v_after);
  END;
END $$;
COMMENT ON FUNCTION content.next_sort_key(app.ulid, app.ulid, app.ulid, app.ulid) IS
  'B §4.6: the sort_key for a node inserted immediately after p_after_id under p_parent '
  '(NULL p_after_id = first position). p_exclude_id excludes the node being MOVED from its '
  'own sibling scan, without which "move X to just after Y" could pick X''s own key as the '
  'upper bound. Recovers from frac_key_at''s "no key exists below" by rebalancing once and '
  'retrying, which is the escape hatch that function''s HINT names.';

CREATE FUNCTION content.move_node(
  p_version   app.ulid,
  p_id        app.ulid,
  p_parent    app.ulid,
  p_after_id  app.ulid DEFAULT NULL
) RETURNS integer
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  v_key      content.sort_key;
  v_rows     integer;
  v_maxlen   integer;
  v_kind     content.node_kind;
  v_pkind    content.node_kind;
BEGIN
  SELECT n.node_kind INTO v_kind FROM content.nodes n
   WHERE n.survey_version_id = p_version AND n.id = p_id;
  IF v_kind IS NULL THEN
    RAISE EXCEPTION 'node % does not exist in version %', p_id, p_version
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  -- A subtree cannot be moved into itself. The FK cannot express this and the recursive
  -- read would simply never terminate, so it is checked here, once, for every caller.
  IF p_parent IS NOT NULL AND EXISTS (
       WITH RECURSIVE up AS (
         SELECT n.id, n.parent_id FROM content.nodes n
          WHERE n.survey_version_id = p_version AND n.id = p_parent
         UNION ALL
         SELECT n.id, n.parent_id FROM content.nodes n
           JOIN up ON n.id = up.parent_id AND n.survey_version_id = p_version)
       SELECT 1 FROM up WHERE up.id = p_id) THEN
    RAISE EXCEPTION 'cannot move node % into its own subtree', p_id
      USING ERRCODE = 'check_violation';
  END IF;

  IF p_parent IS NOT NULL THEN
    SELECT n.node_kind INTO v_pkind FROM content.nodes n
     WHERE n.survey_version_id = p_version AND n.id = p_parent;
    IF v_pkind IS NULL THEN
      RAISE EXCEPTION 'parent % does not exist in version %', p_parent, p_version
        USING ERRCODE = 'foreign_key_violation';
    END IF;
    -- C §5's nesting rules: blocks hold blocks and pages; pages hold questions and text.
    IF NOT ((v_pkind = 'block' AND v_kind IN ('block', 'page'))
            OR (v_pkind = 'page' AND v_kind IN ('question', 'text'))) THEN
      RAISE EXCEPTION 'a % may not contain a %', v_pkind, v_kind
        USING ERRCODE = 'check_violation',
              HINT = 'C §5: blocks nest and hold pages; pages hold questions and text nodes.';
    END IF;
  END IF;

  v_key := content.next_sort_key(p_version, p_parent, p_after_id, p_id);

  -- ONE row. This is the whole argument of B §4.6: with integer positions this statement
  -- would be N UPDATEs, N audit rows and a write-write conflict with anybody editing a
  -- sibling. P1-03's acceptance criterion — "the database shows one UPDATE on content.nodes
  -- per drag" — is this line.
  UPDATE content.nodes
     SET parent_id = p_parent, sort_key = v_key
   WHERE survey_version_id = p_version AND id = p_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;

  -- Amortized maintenance, AFTER the move has already been persisted as one row: key growth
  -- is ~1 char per adjacent insert and pathological drag sequences reach 40+, so the sibling
  -- set is rewritten once every few thousand edits rather than paid on every one.
  SELECT max(length(n.sort_key)) INTO v_maxlen
    FROM content.nodes n
   WHERE n.survey_version_id = p_version AND n.parent_id IS NOT DISTINCT FROM p_parent;
  IF v_maxlen > 16 THEN
    PERFORM content.rebalance_siblings(p_version, p_parent);
  END IF;

  RETURN v_rows;
END $$;
COMMENT ON FUNCTION content.move_node(app.ulid, app.ulid, app.ulid, app.ulid) IS
  'B §4.6 / UI §5.4: reparent-and-reorder as ONE UPDATE of ONE row, returning the row count '
  'so a caller can assert it. Also enforces the two structural rules an FK cannot: a node '
  'may not be moved into its own subtree (which would make the tree CTE non-terminating), '
  'and C §5''s nesting (blocks hold blocks/pages, pages hold questions/text). Rebalances the '
  'destination sibling set only when max key length has passed 16, and only AFTER the move '
  'is already durable, so the common drag stays a single-row write.';

CREATE FUNCTION content.rebalance_items(
  p_version   app.ulid,
  p_question  app.ulid,
  p_item_kind content.item_kind
) RETURNS integer
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  v_count integer;
  v_width integer;
BEGIN
  -- Lock the item set first, in id order, as its own statement — the same shape as
  -- content.rebalance_siblings above, and for the same two reasons: PostgreSQL refuses
  -- FOR UPDATE in a query that computes a window function (which is the bug 0007 §10a
  -- repairs in the function this one was modelled on), and two concurrent rebalances of one
  -- (question, kind) must serialize in a deterministic order rather than deadlock or race
  -- into a qitems_order_key violation.
  PERFORM 1
     FROM content.question_items i
    WHERE i.survey_version_id = p_version AND i.question_id = p_question
      AND i.item_kind = p_item_kind
    ORDER BY i.id
      FOR UPDATE;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count = 0 THEN RETURN 0; END IF;
  v_width := greatest(4, ceil(ln(greatest(v_count, 2)::numeric) / ln(62::numeric))::int + 1);

  WITH ordered AS (
    SELECT i.id, row_number() OVER (ORDER BY i.sort_key, i.id) AS rn
      FROM content.question_items i
     WHERE i.survey_version_id = p_version AND i.question_id = p_question
       AND i.item_kind = p_item_kind)
  UPDATE content.question_items t
     SET sort_key = content.frac_key_at(o.rn::int, v_width)
    FROM ordered o
   WHERE t.survey_version_id = p_version AND t.id = o.id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END $$;
COMMENT ON FUNCTION content.rebalance_items(app.ulid, app.ulid, content.item_kind) IS
  'content.rebalance_siblings() for question items. A separate function rather than a '
  'generic one over a table name: a dynamic-SQL version would take a table name from a '
  'caller and lose both the type checking and the ability to be granted per table. Scoped by '
  '(version, question, item_kind) because that is the scope qitems_order_key makes unique, '
  'and version-scoped for the same reason as rebalance_siblings — rebalancing across '
  'versions would rewrite a frozen version''s keys (B §0 ground rule 3).';

CREATE FUNCTION content.next_item_sort_key(
  p_version   app.ulid,
  p_question  app.ulid,
  p_item_kind content.item_kind,
  p_after_id  app.ulid DEFAULT NULL,
  p_exclude_id app.ulid DEFAULT NULL
) RETURNS content.sort_key
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  v_before content.sort_key;
  v_after  content.sort_key;
BEGIN
  IF p_after_id IS NOT NULL THEN
    SELECT i.sort_key INTO v_before FROM content.question_items i
     WHERE i.survey_version_id = p_version AND i.id = p_after_id;
    IF v_before IS NULL THEN
      RAISE EXCEPTION 'item % does not exist in version %', p_after_id, p_version
        USING ERRCODE = 'foreign_key_violation';
    END IF;
  END IF;

  SELECT min(i.sort_key) INTO v_after
    FROM content.question_items i
   WHERE i.survey_version_id = p_version AND i.question_id = p_question
     AND i.item_kind = p_item_kind
     AND (p_exclude_id IS NULL OR i.id <> p_exclude_id)
     AND (v_before IS NULL OR i.sort_key > v_before);

  BEGIN
    RETURN content.frac_key_at(v_before, v_after);
  EXCEPTION WHEN invalid_parameter_value THEN
    PERFORM content.rebalance_items(p_version, p_question, p_item_kind);
    IF p_after_id IS NOT NULL THEN
      SELECT i.sort_key INTO v_before FROM content.question_items i
       WHERE i.survey_version_id = p_version AND i.id = p_after_id;
    END IF;
    SELECT min(i.sort_key) INTO v_after
      FROM content.question_items i
     WHERE i.survey_version_id = p_version AND i.question_id = p_question
       AND i.item_kind = p_item_kind
       AND (p_exclude_id IS NULL OR i.id <> p_exclude_id)
       AND (v_before IS NULL OR i.sort_key > v_before);
    RETURN content.frac_key_at(v_before, v_after);
  END;
END $$;
COMMENT ON FUNCTION content.next_item_sort_key(app.ulid, app.ulid, content.item_kind, app.ulid, app.ulid) IS
  'content.next_sort_key() for options / rows / columns. The 60-option drag in P1-03''s '
  'acceptance criteria goes through here.';

CREATE FUNCTION content.move_question_item(
  p_version  app.ulid,
  p_id       app.ulid,
  p_after_id app.ulid DEFAULT NULL
) RETURNS integer
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  v_question  app.ulid;
  v_kind      content.item_kind;
  v_key       content.sort_key;
  v_rows      integer;
  v_maxlen    integer;
BEGIN
  SELECT i.question_id, i.item_kind INTO v_question, v_kind
    FROM content.question_items i
   WHERE i.survey_version_id = p_version AND i.id = p_id;
  IF v_question IS NULL THEN
    RAISE EXCEPTION 'item % does not exist in version %', p_id, p_version
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  v_key := content.next_item_sort_key(p_version, v_question, v_kind, p_after_id, p_id);

  -- ONE row, for one drag. See content.move_node's comment.
  UPDATE content.question_items
     SET sort_key = v_key
   WHERE survey_version_id = p_version AND id = p_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;

  SELECT max(length(i.sort_key)) INTO v_maxlen
    FROM content.question_items i
   WHERE i.survey_version_id = p_version AND i.question_id = v_question
     AND i.item_kind = v_kind;
  IF v_maxlen > 16 THEN
    PERFORM content.rebalance_items(p_version, v_question, v_kind);
  END IF;

  RETURN v_rows;
END $$;
COMMENT ON FUNCTION content.move_question_item(app.ulid, app.ulid, app.ulid) IS
  'Reorder one option / row / column: ONE UPDATE of ONE row, returning the row count. This '
  'is the function P1-03''s acceptance criterion measures — "reorders a 60-option list by '
  'dragging, and the database shows one UPDATE per drag". `code` is untouched, which is C '
  '§5.1''s whole point: display order and exported value are different columns.';

-- ---------------------------------------------------------------------------
-- 11. Tree load: ONE recursive CTE (B §13, UI §3.3)
-- ---------------------------------------------------------------------------
-- UI §3.3: one request returns one summary row per node, ~180-260 bytes each, so 2,000
-- questions plus their pages and blocks is well under 1 MB of heap and ~200 KB gzipped.
-- Question BODIES are deliberately absent — options, validation, masks and scripts arrive
-- from a per-node fetch when a node is selected.
--
-- No materialized path and no ltree (B §4.1): a 5,000-node tree is ~1 MB and this CTE loads
-- it in single-digit milliseconds, whereas a path column adds subtree-wide write
-- amplification on every drag-and-drop — which is precisely the write pattern being
-- optimized for.
--
-- SECURITY INVOKER (the default, stated here because it is a decision): the CTE reads
-- content.nodes through the CALLER's policies, so a cross-tenant tree load returns zero rows
-- rather than someone else's outline.

CREATE FUNCTION content.tree_rows(p_version app.ulid)
RETURNS TABLE (
  id                app.ulid,
  node_kind         content.node_kind,
  parent_id         app.ulid,
  sort_key          content.sort_key,
  depth             integer,
  ordinal           bigint,
  ref               app.ref,
  label_key         text,
  instruction_key   text,
  title_key         text,
  question_type     text,
  required          boolean,
  settings          jsonb,
  flags             jsonb,
  emits             app.ulid[],
  item_count        bigint,
  child_count       bigint,
  emit_count        integer,
  pii               boolean,
  has_custom_js     boolean,
  updated_at        timestamptz
)
LANGUAGE sql STABLE SET search_path = '' AS $$
  WITH RECURSIVE walk AS (
    SELECT n.survey_version_id, n.id, n.node_kind, n.parent_id, n.sort_key,
           1 AS depth,
           -- The document-order path. chr(1) is the separator because it sorts below every
           -- character content.sort_key permits ([0-9A-Za-z]), so no sibling's key can be a
           -- prefix of another's path segment and order stays total at every depth.
           (n.sort_key::text) AS path
      FROM content.nodes n
     WHERE n.survey_version_id = p_version
       AND n.parent_id IS NULL
       AND n.deleted_at IS NULL
    UNION ALL
    SELECT c.survey_version_id, c.id, c.node_kind, c.parent_id, c.sort_key,
           w.depth + 1,
           w.path || chr(1) || c.sort_key::text
      FROM content.nodes c
      JOIN walk w ON w.survey_version_id = c.survey_version_id AND w.id = c.parent_id
     WHERE c.deleted_at IS NULL
  )
  SELECT w.id, w.node_kind, w.parent_id, w.sort_key, w.depth,
         row_number() OVER (ORDER BY w.path COLLATE "C", w.id) AS ordinal,
         n.ref, n.label_key, n.instruction_key, n.title_key,
         n.question_type, n.required, n.settings, n.flags, n.emits,
         COALESCE(ic.n, 0) AS item_count,
         COALESCE(cc.n, 0) AS child_count,
         COALESCE(cardinality(n.emits), 0) AS emit_count,
         COALESCE((n.flags ->> 'pii')::boolean, false) AS pii,
         COALESCE((n.flags ->> 'has_custom_js')::boolean, false) AS has_custom_js,
         n.updated_at
    FROM walk w
    JOIN content.nodes n
      ON n.survey_version_id = w.survey_version_id AND n.id = w.id
    LEFT JOIN LATERAL (
      SELECT count(*) AS n FROM content.question_items i
       WHERE i.survey_version_id = w.survey_version_id AND i.question_id = w.id
         AND i.deleted_at IS NULL) ic ON true
    LEFT JOIN LATERAL (
      SELECT count(*) AS n FROM content.nodes c
       WHERE c.survey_version_id = w.survey_version_id AND c.parent_id = w.id
         AND c.deleted_at IS NULL) cc ON true
   ORDER BY w.path COLLATE "C", w.id
$$;
COMMENT ON FUNCTION content.tree_rows(app.ulid) IS
  'UI §3.3 / B §13: the studio tree in ONE round trip, via ONE recursive CTE — not N+1 per '
  'level, which at 2,000 questions across 30 blocks is 30+ queries for one screen. Returns '
  'one summary row per live node in document order, with the counts the tree renders '
  '(options, children, emitted variables) and the two flags that get a glyph (pii, custom '
  'JS). Question bodies are deliberately NOT here: UI §3.3 fetches them per node on '
  'selection, which is what caps editor memory on the largest surveys. Soft-deleted nodes '
  'are excluded, so a deleted subtree disappears from the tree while its ids stay alive for '
  'undo. SECURITY INVOKER, so RLS is the caller''s.';

-- ---------------------------------------------------------------------------
-- 12. Copy-on-write version cloning (B §4.1, ADR-002)
-- ---------------------------------------------------------------------------
CREATE FUNCTION content.clone_version(p_from app.ulid, p_to app.ulid)
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
  -- than fuzzy matching, so "Q12 option removed" is a set difference.
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
  '"Q12 option removed" is a set difference rather than fuzzy matching. Soft-deleted rows '
  'are dropped — the undo buffer belongs to the draft that has it, not to its successor. '
  'SECURITY INVOKER: the source is read through the caller''s policies (nodes_select permits '
  'reading a FROZEN version) and the target through the caller''s write policies plus '
  'content.tg_draft_only, so cloning into a non-draft is refused by both layers.';

-- ---------------------------------------------------------------------------
-- 13. Row level security (B §12, ADR-009)
-- ---------------------------------------------------------------------------
-- ENABLE makes policies apply; FORCE makes them apply to the table OWNER too, which is the
-- difference between an isolation suite that means something and one that passes because it
-- ran as the owner. ops.tables_without_rls() fails CI for any table missing either.
--
-- The SHAPE of every content policy, and why it is the same six lines seven times:
--   SELECT  — org + reviewer floor + can_see_version. NOT restricted to drafts: B §12,
--             "reviewers must read frozen versions; a separate, narrower policy grants
--             exactly that". A review link on a frozen version is the product feature this
--             enables.
--   INSERT/UPDATE/DELETE — org + programmer floor + can_see_version + version_is_draft.
--             ADR-002 lives in the policy as well as in content.tg_draft_only, on purpose:
--             the policy makes an editor bug surface as "0 rows updated" while the trigger
--             catches anything reaching the table another way.
-- One policy per command, never FOR ALL, so a read predicate cannot become a write
-- predicate by accident. Policies are ADDITIVE — they OR together — which is why every new
-- content policy has to be reviewed rather than pattern-matched.

ALTER TABLE content.nodes                    ENABLE ROW LEVEL SECURITY;
ALTER TABLE content.nodes                    FORCE  ROW LEVEL SECURITY;
ALTER TABLE content.question_items           ENABLE ROW LEVEL SECURITY;
ALTER TABLE content.question_items           FORCE  ROW LEVEL SECURITY;
ALTER TABLE content.question_cells           ENABLE ROW LEVEL SECURITY;
ALTER TABLE content.question_cells           FORCE  ROW LEVEL SECURITY;
ALTER TABLE content.variables                ENABLE ROW LEVEL SECURITY;
ALTER TABLE content.variables                FORCE  ROW LEVEL SECURITY;
ALTER TABLE content.languages                ENABLE ROW LEVEL SECURITY;
ALTER TABLE content.languages                FORCE  ROW LEVEL SECURITY;
ALTER TABLE content.i18n_strings             ENABLE ROW LEVEL SECURITY;
ALTER TABLE content.i18n_strings             FORCE  ROW LEVEL SECURITY;
ALTER TABLE content.reserved_variable_names  ENABLE ROW LEVEL SECURITY;
ALTER TABLE content.reserved_variable_names  FORCE  ROW LEVEL SECURITY;

-- --- nodes -----------------------------------------------------------------
CREATE POLICY nodes_select ON content.nodes FOR SELECT TO authoring
USING (org_id = app.current_org() AND app.has_role('reviewer')
       AND app.can_see_version(survey_version_id));
COMMENT ON POLICY nodes_select ON content.nodes IS
  'B §12''s nodes_read. The floor is `reviewer` (rank 20) and not `client` (5): K §1 gives a '
  'reviewer "read survey definitions, comment, approve" while a client gets "review + '
  'aggregate reports" on explicitly shared projects. Deliberately NOT restricted to drafts — '
  'reading a frozen version IS the review link. can_see_version() adds the project scoping '
  'that a survey_version_id-only row cannot express.';

CREATE POLICY nodes_insert ON content.nodes FOR INSERT TO authoring
WITH CHECK (org_id = app.current_org() AND app.has_role('programmer')
            AND app.can_see_version(survey_version_id)
            AND app.version_is_draft(survey_version_id));
CREATE POLICY nodes_update ON content.nodes FOR UPDATE TO authoring
USING (org_id = app.current_org() AND app.has_role('programmer')
       AND app.can_see_version(survey_version_id)
       AND app.version_is_draft(survey_version_id))
WITH CHECK (org_id = app.current_org() AND app.has_role('programmer')
            AND app.can_see_version(survey_version_id)
            AND app.version_is_draft(survey_version_id));
CREATE POLICY nodes_delete ON content.nodes FOR DELETE TO authoring
USING (org_id = app.current_org() AND app.has_role('programmer')
       AND app.can_see_version(survey_version_id)
       AND app.version_is_draft(survey_version_id));
COMMENT ON POLICY nodes_update ON content.nodes IS
  'B §12''s nodes_write, split per command. The WITH CHECK repeats every predicate in USING '
  'so an UPDATE cannot move a row into another org or onto another version — USING says '
  'which rows you may touch, WITH CHECK says what they may become, and omitting the second '
  'is the classic RLS hole. version_is_draft in BOTH clauses is ADR-002: you cannot edit a '
  'frozen version, and you cannot make a draft row belong to a frozen one.';
COMMENT ON POLICY nodes_delete ON content.nodes IS
  'A HARD delete, which the editor never issues: UI §5.4 makes deletion a soft delete '
  '(deleted_at) so undo can restore the id and every AST that referenced it. This policy '
  'exists for genuine purges of a draft, and it is still draft-only.';

-- --- question_items --------------------------------------------------------
CREATE POLICY qitems_select ON content.question_items FOR SELECT TO authoring
USING (org_id = app.current_org() AND app.has_role('reviewer')
       AND app.can_see_version(survey_version_id));
CREATE POLICY qitems_insert ON content.question_items FOR INSERT TO authoring
WITH CHECK (org_id = app.current_org() AND app.has_role('programmer')
            AND app.can_see_version(survey_version_id)
            AND app.version_is_draft(survey_version_id));
CREATE POLICY qitems_update ON content.question_items FOR UPDATE TO authoring
USING (org_id = app.current_org() AND app.has_role('programmer')
       AND app.can_see_version(survey_version_id)
       AND app.version_is_draft(survey_version_id))
WITH CHECK (org_id = app.current_org() AND app.has_role('programmer')
            AND app.can_see_version(survey_version_id)
            AND app.version_is_draft(survey_version_id));
CREATE POLICY qitems_delete ON content.question_items FOR DELETE TO authoring
USING (org_id = app.current_org() AND app.has_role('programmer')
       AND app.can_see_version(survey_version_id)
       AND app.version_is_draft(survey_version_id));
COMMENT ON POLICY qitems_update ON content.question_items IS
  'The 60-option drag runs through this policy, once, for one row (B §4.6).';

-- --- question_cells --------------------------------------------------------
CREATE POLICY qcells_select ON content.question_cells FOR SELECT TO authoring
USING (org_id = app.current_org() AND app.has_role('reviewer')
       AND app.can_see_version(survey_version_id));
CREATE POLICY qcells_insert ON content.question_cells FOR INSERT TO authoring
WITH CHECK (org_id = app.current_org() AND app.has_role('programmer')
            AND app.can_see_version(survey_version_id)
            AND app.version_is_draft(survey_version_id));
CREATE POLICY qcells_update ON content.question_cells FOR UPDATE TO authoring
USING (org_id = app.current_org() AND app.has_role('programmer')
       AND app.can_see_version(survey_version_id)
       AND app.version_is_draft(survey_version_id))
WITH CHECK (org_id = app.current_org() AND app.has_role('programmer')
            AND app.can_see_version(survey_version_id)
            AND app.version_is_draft(survey_version_id));
CREATE POLICY qcells_delete ON content.question_cells FOR DELETE TO authoring
USING (org_id = app.current_org() AND app.has_role('programmer')
       AND app.can_see_version(survey_version_id)
       AND app.version_is_draft(survey_version_id));

-- --- variables -------------------------------------------------------------
CREATE POLICY variables_select ON content.variables FOR SELECT TO authoring
USING (org_id = app.current_org() AND app.has_role('reviewer')
       AND app.can_see_version(survey_version_id));
COMMENT ON POLICY variables_select ON content.variables IS
  'Note what this policy does NOT do: it does not filter on `pii`. This table holds the '
  'variable DEFINITION — the fact that Q14 emits a PII column — not respondent data, and a '
  'reviewer must be able to see that a question collects PII in order to review it. K §1''s '
  'pii_access capability governs reading the VALUES, in export (B §11), and is checked by '
  'app.has_capability() which contains no has_role() call.';
CREATE POLICY variables_insert ON content.variables FOR INSERT TO authoring
WITH CHECK (org_id = app.current_org() AND app.has_role('programmer')
            AND app.can_see_version(survey_version_id)
            AND app.version_is_draft(survey_version_id));
CREATE POLICY variables_update ON content.variables FOR UPDATE TO authoring
USING (org_id = app.current_org() AND app.has_role('programmer')
       AND app.can_see_version(survey_version_id)
       AND app.version_is_draft(survey_version_id))
WITH CHECK (org_id = app.current_org() AND app.has_role('programmer')
            AND app.can_see_version(survey_version_id)
            AND app.version_is_draft(survey_version_id));
CREATE POLICY variables_delete ON content.variables FOR DELETE TO authoring
USING (org_id = app.current_org() AND app.has_role('programmer')
       AND app.can_see_version(survey_version_id)
       AND app.version_is_draft(survey_version_id));

-- --- languages -------------------------------------------------------------
CREATE POLICY languages_select ON content.languages FOR SELECT TO authoring
USING (org_id = app.current_org() AND app.has_role('reviewer')
       AND app.can_see_version(survey_version_id));
CREATE POLICY languages_insert ON content.languages FOR INSERT TO authoring
WITH CHECK (org_id = app.current_org() AND app.has_role('programmer')
            AND app.can_see_version(survey_version_id)
            AND app.version_is_draft(survey_version_id));
CREATE POLICY languages_update ON content.languages FOR UPDATE TO authoring
USING (org_id = app.current_org() AND app.has_role('programmer')
       AND app.can_see_version(survey_version_id)
       AND app.version_is_draft(survey_version_id))
WITH CHECK (org_id = app.current_org() AND app.has_role('programmer')
            AND app.can_see_version(survey_version_id)
            AND app.version_is_draft(survey_version_id));
CREATE POLICY languages_delete ON content.languages FOR DELETE TO authoring
USING (org_id = app.current_org() AND app.has_role('programmer')
       AND app.can_see_version(survey_version_id)
       AND app.version_is_draft(survey_version_id));

-- --- i18n_strings ----------------------------------------------------------
CREATE POLICY i18n_select ON content.i18n_strings FOR SELECT TO authoring
USING (org_id = app.current_org() AND app.has_role('reviewer')
       AND app.can_see_version(survey_version_id));
-- The write floor here is `reviewer`, not `programmer`: C §16''s translation workflow is
-- done by translators and reviewers, not by the programmer who built the questionnaire, and
-- making them ask a programmer to paste German strings is how translations end up in a
-- spreadsheet nobody reimports. Still draft-only, so a frozen version's strings are sealed.
CREATE POLICY i18n_insert ON content.i18n_strings FOR INSERT TO authoring
WITH CHECK (org_id = app.current_org() AND app.has_role('reviewer')
            AND app.can_see_version(survey_version_id)
            AND app.version_is_draft(survey_version_id));
CREATE POLICY i18n_update ON content.i18n_strings FOR UPDATE TO authoring
USING (org_id = app.current_org() AND app.has_role('reviewer')
       AND app.can_see_version(survey_version_id)
       AND app.version_is_draft(survey_version_id))
WITH CHECK (org_id = app.current_org() AND app.has_role('reviewer')
            AND app.can_see_version(survey_version_id)
            AND app.version_is_draft(survey_version_id));
CREATE POLICY i18n_delete ON content.i18n_strings FOR DELETE TO authoring
USING (org_id = app.current_org() AND app.has_role('programmer')
       AND app.can_see_version(survey_version_id)
       AND app.version_is_draft(survey_version_id));
COMMENT ON POLICY i18n_insert ON content.i18n_strings IS
  'Reviewer floor rather than programmer: C §16''s translation work is done by translators '
  'and reviewers. DELETE keeps the programmer floor, because removing a key is a structural '
  'edit — the key comes from a node''s label — not a translation.';

-- --- reserved_variable_names -----------------------------------------------
CREATE POLICY reserved_names_select ON content.reserved_variable_names
FOR SELECT TO authoring USING (app.current_org() IS NOT NULL);
COMMENT ON POLICY reserved_names_select ON content.reserved_variable_names IS
  'K §6''s list is global reference data with no org_id: the studio renders it in the '
  '"reserved name" diagnostic, so every member of any org may read it. A policy rather than '
  'an RLS exemption, because "readable by everyone" and "not protected" are different '
  'statements and only one of them survives someone adding a column later. The predicate is '
  'app.current_org() IS NOT NULL rather than `true`, and that is not decoration: 0004''s '
  'test.sql asserts that EVERY policy in app/content/billing/export mentions '
  'app.current_org(), with exactly one named exception, and a global table is precisely the '
  'kind of "it has no org_id so the rule cannot apply here" argument that turns a blanket '
  'assertion into a list of exceptions. There is nothing to scope, so the policy asserts the '
  'weakest true thing instead: an unauthenticated session, or one with no active org, reads '
  'nothing. There is deliberately NO INSERT/UPDATE/DELETE policy — K §6 says adding a name '
  'is a breaking change that ships as a migration, so the write path is DDL, not an API '
  'call.';

-- ---------------------------------------------------------------------------
-- 14. Grants (ADR-009, B §2)
-- ---------------------------------------------------------------------------
-- Explicit rather than relying on 0001's ALTER DEFAULT PRIVILEGES, per db/README.md.
GRANT SELECT, INSERT, UPDATE, DELETE ON
  content.nodes, content.question_items, content.question_cells, content.variables,
  content.languages, content.i18n_strings
  TO authoring;
-- Reference data: read only, below the policy layer as well as at it. Two independent
-- mechanisms, because K §6 additions are breaking changes.
GRANT SELECT ON content.reserved_variable_names TO authoring;

-- The readability views are read paths, so SELECT only. An updatable view over a table with
-- RLS would be a second, less obvious write surface with its own WITH CHECK OPTION
-- semantics; authoring code writes content.nodes directly.
GRANT SELECT ON content.questions, content.pages, content.blocks TO authoring;

-- ADR-009's negative capability, restated for the tables that just appeared: the runtime
-- gets NO table privilege anywhere. It reads the compiled artifact from object storage.
REVOKE ALL ON ALL TABLES IN SCHEMA content FROM runtime_writer, analytics_reader;

-- Functions: 0001's ALTER DEFAULT PRIVILEGES ... REVOKE ALL ON FUNCTIONS FROM PUBLIC is a
-- documented no-op on PostgreSQL 16 (see db/README.md and 0006), so every function needs an
-- explicit REVOKE. ops.functions_executable_by_public() names any that is forgotten.
REVOKE EXECUTE ON FUNCTION content.tg_variable_name_not_reserved() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION content.next_sort_key(app.ulid, app.ulid, app.ulid, app.ulid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION content.move_node(app.ulid, app.ulid, app.ulid, app.ulid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION content.rebalance_items(app.ulid, app.ulid, content.item_kind) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION content.next_item_sort_key(app.ulid, app.ulid, content.item_kind, app.ulid, app.ulid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION content.move_question_item(app.ulid, app.ulid, app.ulid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION content.tree_rows(app.ulid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION content.clone_version(app.ulid, app.ulid) FROM PUBLIC;

-- The studio calls these four directly. Each is SECURITY INVOKER, so RLS decides the rows
-- and the grant only decides who may ask.
GRANT EXECUTE ON FUNCTION content.tree_rows(app.ulid) TO authoring;
GRANT EXECUTE ON FUNCTION content.move_node(app.ulid, app.ulid, app.ulid, app.ulid) TO authoring;
GRANT EXECUTE ON FUNCTION content.move_question_item(app.ulid, app.ulid, app.ulid) TO authoring;
GRANT EXECUTE ON FUNCTION content.clone_version(app.ulid, app.ulid) TO authoring;

-- ...and these five, which the studio never calls, because SECURITY INVOKER is TRANSITIVE.
--
-- This is the trap 0006 is about, one level down. A SECURITY INVOKER function runs its whole
-- body — including every function IT calls — with the CALLER's privileges, and EXECUTE is
-- checked at call time, not at definition time. content.move_node therefore needs the caller
-- to hold EXECUTE on content.next_sort_key, which needs content.frac_key_at, which the
-- rebalance path needs too:
--
--   move_node -> next_sort_key -> frac_key_at(sort_key, sort_key)
--                              -> rebalance_siblings -> frac_key_at(integer, integer)
--   move_question_item -> next_item_sort_key -> frac_key_at(sort_key, sort_key)
--                                            -> rebalance_items -> frac_key_at(integer, integer)
--
-- Granting only the four entry points is not "least privilege", it is a NULL implementation:
-- 0006's catalog sweep left frac_key_at and rebalance_siblings ungranted (its own comment
-- says "P1-03 grants them to `authoring` in the migration that gives them something to
-- order"), so every drag would fail with `42501 permission denied for function
-- next_sort_key` — which reads exactly like an RLS denial and is not one. This migration's
-- test.sql calls content.move_node AS `authoring`, which is the only way that distinction
-- ever gets tested; running it as the migration runner would pass with any grant set at all.
--
-- The alternative — making move_* SECURITY DEFINER so the chain runs as the owner — is
-- strictly worse: the UPDATE inside would then bypass the RLS policy that makes a frozen
-- version unwritable, moving ADR-002's enforcement out of the policy layer and into the
-- function body. Direct access to the rebalance functions is bounded anyway, because their
-- UPDATE is still the caller's: rebalancing another tenant's sibling set, or a frozen
-- version's, affects zero rows.
GRANT EXECUTE ON FUNCTION content.next_sort_key(app.ulid, app.ulid, app.ulid, app.ulid) TO authoring;
GRANT EXECUTE ON FUNCTION content.next_item_sort_key(app.ulid, app.ulid, content.item_kind, app.ulid, app.ulid) TO authoring;
GRANT EXECUTE ON FUNCTION content.rebalance_siblings(app.ulid, app.ulid) TO authoring;
GRANT EXECUTE ON FUNCTION content.rebalance_items(app.ulid, app.ulid, content.item_kind) TO authoring;
GRANT EXECUTE ON FUNCTION content.frac_key_at(content.sort_key, content.sort_key) TO authoring;
GRANT EXECUTE ON FUNCTION content.frac_key_at(integer, integer) TO authoring;

-- ---------------------------------------------------------------------------
-- 15. Fixture helper for the content suites
-- ---------------------------------------------------------------------------
-- ops.test_seed_two_orgs() (0004) seeds orgs, surveys and versions but NO content, because
-- content did not exist when it was written. This adds content to the versions it already
-- made rather than re-signing it, because db/README.md's rule is that a later migration
-- redefining an earlier one's objects invalidates the earlier tests — and five test.sql
-- files call that function.
--
-- THE PART THAT IS NOT OBVIOUS, and that the first draft of this migration got wrong.
-- Every content suite needs two content-bearing versions per survey: one FROZEN (to assert
-- that a published survey cannot be edited) and one DRAFT (to assert that the happy path
-- works). 0004 leaves each survey with a frozen `production` version and an empty `draft`.
-- Seeding content INTO the frozen one is impossible, and both of the reasons are load-bearing
-- rather than incidental:
--
--   * content.tg_draft_only refuses writes to a non-draft version, so the version would have
--     to be temporarily reverted to `draft` — and app.tg_version_guard rejects
--     production -> draft as an illegal transition (0004 asserts that it does).
--   * even if it did not, app.sv_one_draft permits ONE draft per survey, and that survey
--     already has one.
--
-- So the fixture goes FORWARD instead, along the lifecycle 0004's trigger actually permits:
-- seed the existing draft, freeze it with draft -> review, then create version 3 as the new
-- draft and seed that. Which is simply what a survey programmer does — author, publish, clone
-- to edit — rather than a test-only cheat, and it means the fixture exercises
-- app.tg_version_guard instead of working around it.
--
-- Node ids are IDENTICAL in both versions, because that is the invariant this whole migration
-- is built on (B §4.1): a version's content is the same nodes under a different
-- survey_version_id. The suite asserts it.
CREATE FUNCTION ops.test_seed_content(p_ids jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_out    jsonb := '{}';
  v_letter text;
  v_role   text;
  v_org    app.ulid;
  v_svy    app.ulid;
  v_user   uuid;
  v_ver    app.ulid;
  v_code   text;
  v_blk    app.ulid;
  v_pg     app.ulid;
  v_q1     app.ulid;
  v_q2     app.ulid;
  i        integer;
BEGIN
  FOREACH v_letter IN ARRAY ARRAY['a', 'b'] LOOP
    v_org  := (p_ids ->> ('org_'  || v_letter))::app.ulid;
    v_svy  := (p_ids ->> ('svy_'  || v_letter))::app.ulid;
    v_user := (p_ids ->> ('user_' || v_letter))::uuid;

    -- ops.test_ulid upper-cases its tag into a Crockford base32 body, which excludes I, L, O
    -- and U and has no underscore, so the readable letter is used directly and the tags stay
    -- short enough to remain legible in a failure message.
    v_code := upper(v_letter);
    v_blk  := ops.test_ulid('blk', v_code);
    v_pg   := ops.test_ulid('pg',  v_code);
    v_q1   := ops.test_ulid('qst', v_code || '1');
    v_q2   := ops.test_ulid('qst', v_code || '2');

    FOREACH v_role IN ARRAY ARRAY['frozen', 'draft'] LOOP
      IF v_role = 'frozen' THEN
        -- 0004's empty draft (version_no 2). Frozen at the end of this iteration.
        v_ver := (p_ids ->> ('ver_' || v_letter || '_draft'))::app.ulid;
      ELSE
        -- The successor draft, created only after version 2 has left `draft` so that
        -- app.sv_one_draft is satisfied at every instant.
        v_ver := ops.test_ulid('ver', v_code || '3');
        INSERT INTO app.survey_versions
          (id, org_id, survey_id, version_no, status, compile_state, schema_version,
           created_by, cloned_from_version_id)
        VALUES (v_ver, v_org, v_svy, 3, 'draft', 'none', 1, v_user,
                (p_ids ->> ('ver_' || v_letter || '_draft'))::app.ulid);
      END IF;

      INSERT INTO content.nodes
        (survey_version_id, id, org_id, node_kind, parent_id, sort_key, ref, title_key)
      VALUES (v_ver, v_blk, v_org, 'block', NULL, '0100', 'SCREENER', 'blk.screener.title'),
             (v_ver, v_pg,  v_org, 'page',  v_blk, '0100', 'P1',      'pg.p1.title');
      INSERT INTO content.nodes
        (survey_version_id, id, org_id, node_kind, parent_id, sort_key, ref,
         question_type, required, label_key)
      VALUES (v_ver, v_q1, v_org, 'question', v_pg, '0100', 'S1',
              'single_select', true,  'q.s1.label'),
             (v_ver, v_q2, v_org, 'question', v_pg, '0200', 'S2',
              'multi_select',  false, 'q.s2.label');

      -- 60 options on S2, because P1-03's acceptance criterion is a 60-option list reordered
      -- by dragging, and a 3-option fixture would not distinguish one UPDATE from sixty.
      FOR i IN 1..60 LOOP
        INSERT INTO content.question_items
          (survey_version_id, id, org_id, question_id, item_kind, ref, code, label_key,
           sort_key)
        VALUES (v_ver, ops.test_ulid('opt', v_code || lpad(i::text, 3, '0')), v_org,
                v_q2, 'option', 'o' || i, i, 'q.s2.opt.' || i,
                content.frac_key_at(i, 4));
      END LOOP;

      -- One matrix row on S1 plus a per-row control override, so that
      -- content.question_cells is not the one content table every suite leaves EMPTY. A
      -- cross-tenant probe over an empty table passes vacuously, and content.clone_version's
      -- question_cells branch would never be executed by any test.
      INSERT INTO content.question_items
        (survey_version_id, id, org_id, question_id, item_kind, ref, code, label_key, sort_key)
      VALUES (v_ver, ops.test_ulid('row', v_code || '001'), v_org, v_q1, 'row', 'r1', 1,
              'q.s1.row.1', '0100');
      INSERT INTO content.question_cells
        (survey_version_id, id, org_id, question_id, row_item_id, question_type, config)
      VALUES (v_ver, ops.test_ulid('cel', v_code || '001'), v_org, v_q1,
              ops.test_ulid('row', v_code || '001'), 'numeric', '{"min":0,"max":100}');

      INSERT INTO content.languages (survey_version_id, lang, org_id, is_base)
      VALUES (v_ver, 'en', v_org, true), (v_ver, 'de', v_org, false);
      INSERT INTO content.i18n_strings
        (survey_version_id, lang, key, value, state, org_id)
      VALUES (v_ver, 'en', 'q.s1.label', 'Do you drink coffee?', 'reviewed', v_org),
             (v_ver, 'de', 'q.s1.label', NULL,                   'missing',  v_org);

      -- Four variables, chosen so that every arm of every CHECK on content.variables has a
      -- live example rather than only the easy one:
      --   S1         response  enum  source, no expression
      --   S2         derived   set   source, NO EXPRESSION      <- the vars_derived_expr
      --                                                            carve-out, C §1's set view
      --                                                            over a boolean fan-out
      --   AGE_BAND   derived   enum  NO source, WITH expression <- the AUTHORED derived case
      --   VENDOR_PID hidden    text  no source, pii             <- variables_pii_idx
      INSERT INTO content.variables
        (survey_version_id, id, org_id, name, kind, vtype, source_question_id, source_part,
         enum_domain, export_column, sort_key)
      VALUES (v_ver, ops.test_ulid('var', v_code || '1'), v_org, 'S1', 'response', 'enum',
              v_q1, '{"kind":"scalar"}',
              '[{"code":1,"label_key":"s1.o1"},{"code":2,"label_key":"s1.o2"}]',
              'S1', '0100');
      INSERT INTO content.variables
        (survey_version_id, id, org_id, name, kind, vtype, source_question_id, source_part,
         enum_domain, export_column, sort_key, persist)
      VALUES (v_ver, ops.test_ulid('var', v_code || '2'), v_org, 'S2', 'derived', 'set',
              v_q2, '{"kind":"set_view"}',
              '[{"code":1,"label_key":"s2.o1"},{"code":2,"label_key":"s2.o2"}]',
              'S2', '0200', false);
      INSERT INTO content.variables
        (survey_version_id, id, org_id, name, kind, vtype, expression, enum_domain,
         export_column, sort_key)
      VALUES (v_ver, ops.test_ulid('var', v_code || '3'), v_org, 'AGE_BAND', 'derived',
              'enum',
              '{"op":"case","cases":[{"when":{"op":"<","args":[{"var":"AGE"},{"lit":25}]},'
              '"then":{"lit":1}}],"else":{"lit":2}}',
              '[{"code":1,"label_key":"ageb.18_24"},{"code":2,"label_key":"ageb.25_plus"}]',
              'AGE_BAND', '0300');
      INSERT INTO content.variables
        (survey_version_id, id, org_id, name, kind, vtype, export_column, sort_key, pii)
      VALUES (v_ver, ops.test_ulid('var', v_code || '4'), v_org, 'VENDOR_PID', 'hidden',
              'text', 'VENDOR_PID', '0400', true);

      UPDATE content.nodes
         SET emits = ARRAY[ops.test_ulid('var', v_code || '1')]::app.ulid[]
       WHERE survey_version_id = v_ver AND id = v_q1;
      UPDATE content.nodes
         SET emits = ARRAY[ops.test_ulid('var', v_code || '2')]::app.ulid[]
       WHERE survey_version_id = v_ver AND id = v_q2;

      IF v_role = 'frozen' THEN
        -- draft -> review: the ONE transition app.tg_version_guard permits out of draft that
        -- freezes the version without needing a compiled artifact (K §3's
        -- sv_live_needs_compiled applies to staging and production only). A review link over
        -- a frozen version is also exactly what content's SELECT policies exist to serve.
        UPDATE app.survey_versions SET status = 'review' WHERE id = v_ver;
      END IF;

      v_out := v_out || jsonb_build_object('ver_' || v_letter || '_content_' || v_role, v_ver);
    END LOOP;

    v_out := v_out || jsonb_build_object(
      'blk_' || v_letter, v_blk,
      'pg_'  || v_letter, v_pg,
      'q1_'  || v_letter, v_q1,
      'q2_'  || v_letter, v_q2,
      'opt_' || v_letter || '_first', ops.test_ulid('opt', v_code || '001'),
      'opt_' || v_letter || '_last',  ops.test_ulid('opt', v_code || '060'),
      'row_' || v_letter, ops.test_ulid('row', v_code || '001'),
      'cel_' || v_letter, ops.test_ulid('cel', v_code || '001'),
      'var_' || v_letter || '_setview', ops.test_ulid('var', v_code || '2'));
  END LOOP;

  -- An EMPTY draft on a SECOND survey in org A, as the clone target. It has to be a second
  -- survey: app.sv_one_draft allows one draft per survey and survey A's is the one that was
  -- just seeded, so there is nowhere else for content.clone_version() to land.
  INSERT INTO app.surveys (id, org_id, project_id, ref, name, created_by)
  VALUES (ops.test_ulid('svy', 'AC'), (p_ids ->> 'org_a')::app.ulid,
          (p_ids ->> 'prj_a')::app.ulid, 'SVYAC', 'Survey A clone target',
          (p_ids ->> 'user_a')::uuid);
  INSERT INTO app.survey_versions
    (id, org_id, survey_id, version_no, status, compile_state, schema_version, created_by)
  VALUES (ops.test_ulid('ver', 'AC'), (p_ids ->> 'org_a')::app.ulid,
          ops.test_ulid('svy', 'AC'), 1, 'draft', 'none', 1,
          (p_ids ->> 'user_a')::uuid);
  v_out := v_out || jsonb_build_object(
    'svy_a_clone', ops.test_ulid('svy', 'AC'),
    'ver_a_clone_target', ops.test_ulid('ver', 'AC'));

  RETURN v_out;
END $$;
COMMENT ON FUNCTION ops.test_seed_content(jsonb) IS
  'Takes ops.test_seed_two_orgs()''s id map and adds content to it: per survey, ONE frozen '
  '(`review`) version and ONE draft version, each holding a block, a page, two questions, a '
  '60-option list, a matrix row with a per-row control override (so content.question_cells '
  'is never the table every suite leaves empty), two languages, two i18n strings and four '
  'variables — one per arm of every '
  'CHECK on content.variables, including the structurally-derived set_view that the '
  'vars_derived_expr carve-out exists for. Node ids are identical across both versions of a '
  'survey (B §4.1). Plus an empty draft on a second survey in org A as content.clone_version''s '
  'target, because app.sv_one_draft allows only one draft per survey. Reaches the frozen state '
  'by going FORWARD (seed the draft, then draft -> review), never by reverting a published '
  'version — app.tg_version_guard rejects production -> draft, which is the correct behaviour '
  'and was what broke the first version of this fixture. Separate function rather than '
  're-signing test_seed_two_orgs, whose signature five earlier test.sql files depend on. '
  'SECURITY DEFINER and ungranted: called by the migration runner inside a transaction that is '
  'rolled back, and it makes no attempt to be idempotent.';
REVOKE EXECUTE ON FUNCTION ops.test_seed_content(jsonb) FROM PUBLIC;
