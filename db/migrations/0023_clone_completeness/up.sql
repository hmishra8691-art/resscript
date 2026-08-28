-- 0023_clone_completeness — every version-scoped content table is cloned, and a catalog check that
-- keeps it that way.
--
-- ## The defect
--
-- `content.clone_version` enumerates its tables BY NAME. Migration 0010 said what that costs, in as
-- many words: "a content table it does not know about is a table whose rows are SILENTLY DROPPED on
-- the copy-on-write that ADR-002 makes the only way to edit a published survey", and called the
-- per-table count map "the ONLY mechanical protection against this omission".
--
-- Six content tables have been added since and none of them was added to the function:
--
--   * content.quota_dimensions, _buckets, _plans, _cells  (0016, P2-06)
--   * content.code_assets                                  (0019, P2-11)
--   * content.version_theme                                (0021, P2-12)
--
-- So the workflow ADR-002 prescribes — publish, then clone to edit — silently discarded every quota
-- definition, every script, HTML template and stylesheet, and the theme pin. A client whose wave is
-- in field, who asks for one wording change, would get a new draft with no quotas. Nothing raised,
-- nothing logged; the next publish would simply have no sample plan.
--
-- ## Why the existing protection did not work
--
-- The count map WAS the protection and it failed for a reason worth stating: 0007's and 0008's
-- pgTAP assertions compare that map for the tables that existed when they were written. A map that
-- gains no key for a new table still matches the old expectation, so the assertion passes. The
-- protection was against a table being MIS-cloned, not against one being FORGOTTEN — and forgetting
-- is the failure that actually happened, three times.
--
-- ## The fix that cannot go stale
--
-- `ops.content_tables_not_cloned()` asks the CATALOG which tables are version-scoped and compares
-- that against what the function copies, rather than against a list somebody maintains. A seventh
-- table added without a clone branch fails a standing assertion on the next migration run, whoever
-- adds it and whatever they remember. That is the same shape as `ops.tables_without_rls()` and
-- `ops.content_tables_without_draft_trigger()`, which are the two checks in this codebase that have
-- repeatedly caught real mistakes — including three of mine in 0019 and 0020.

SET lock_timeout = '3s';
SET statement_timeout = '120s';

/* ------------------------------------------------------------------ *
 * 1. content.code_assets could never have been cloned
 * ------------------------------------------------------------------ *
 *
 * A second defect, found by writing the clone test rather than by reading the code: 0019 gave
 * `content.code_assets` `PRIMARY KEY (id)` where every other version-scoped content table uses
 * `PRIMARY KEY (survey_version_id, id)`.
 *
 * That is not a stylistic difference. 0008's clone comment states the property the whole model
 * rests on: "Node ids are stable across versions (B §4.1) and every internal reference is scoped by
 * survey_version_id through the composite FKs, so changing the version column is the entire
 * operation." A globally unique `id` breaks it — the clone re-inserts the same id for the new
 * version and collides with itself. So `content.code_assets` was not merely missing from
 * `clone_version`; it could not have been added to it without this change.
 *
 * Widened rather than replaced: `(survey_version_id, id)` still enforces everything `(id)` did
 * within a version, and the unique-per-version-and-kind ref constraint is untouched. Nothing
 * references code_assets by a bare id — `AssetId` references are resolved inside a version by
 * `validateStructural` — so no foreign key has to move.
 */

ALTER TABLE content.code_assets DROP CONSTRAINT code_assets_pkey;
ALTER TABLE content.code_assets ADD CONSTRAINT code_assets_pkey
  PRIMARY KEY (survey_version_id, id);
COMMENT ON TABLE content.code_assets IS
  'C §14''s author-supplied code assets — scripts, HTML templates and stylesheets — one row per '
  'asset per version, with the integrity hash the CSP is built from and the sanitizer verdict as '
  'of the analysis that produced it. VERSION-SCOPED and never survey-scoped (B §0 ground rule 3, '
  'ADR-002). Keyed (survey_version_id, id) since 0023: 0019 keyed it on `id` alone, which made the '
  'row un-clonable — ADR-002''s copy-on-write reuses ids and rewrites only the version column, so '
  'a globally unique id collides with itself on the copy.';

/* ------------------------------------------------------------------ *
 * 2. The catalog check
 * ------------------------------------------------------------------ */

CREATE FUNCTION ops.content_tables_not_cloned()
RETURNS TABLE (table_name text, reason text)
LANGUAGE plpgsql STABLE
SET search_path = '' AS $fn$
DECLARE
  v_body text;
BEGIN
  -- EVERY `content.clone_version*` function's source, concatenated. A hand-kept list of "tables
  -- clone_version handles" would be a second thing to forget, which is the bug being fixed — but
  -- reading one function is not enough either, and finding that out was the point of running the
  -- check: `clone_version` delegates its original eight tables to `clone_version_core`, so a
  -- single-function read reported all eight as missing. Matching the family follows the delegation
  -- without caring how it is split, which is what keeps this true if somebody splits it again.
  SELECT pg_catalog.string_agg(pg_catalog.pg_get_functiondef(p.oid), E'\n') INTO v_body
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'content' AND p.proname LIKE 'clone_version%';

  IF v_body IS NULL THEN
    RETURN QUERY SELECT 'content.clone_version'::text, 'the function does not exist'::text;
    RETURN;
  END IF;

  RETURN QUERY
  SELECT ('content.' || c.relname)::text,
         'version-scoped and not copied by content.clone_version'::text
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid
   WHERE n.nspname = 'content'
     AND c.relkind = 'r'
     -- "Version-scoped" is decided by the presence of the column, not by a name list. A content
     -- table WITHOUT survey_version_id is a registry (content.reserved_variable_names) and has
     -- nothing to clone.
     AND a.attname = 'survey_version_id'
     AND a.attnum > 0
     AND NOT a.attisdropped
     -- A regex with a trailing non-identifier char rather than a substring search, so
     -- `content.quota_cells` is not matched by a branch that inserts into `content.quota_cells_x`,
     -- and so any whitespace or paren the formatter chooses still counts. `position(a IN b)` was
     -- the first attempt and is a trap: its pg_catalog form takes the arguments the other way
     -- round, which is a silent wrong answer rather than an error.
     AND v_body !~ ('INSERT INTO content\.' || c.relname || '[^a-zA-Z0-9_]')
   ORDER BY 1;
END $fn$;

COMMENT ON FUNCTION ops.content_tables_not_cloned() IS
  'Version-scoped content tables that content.clone_version does not copy. Empty is the only '
  'acceptable answer. Asks the CATALOG which tables are version-scoped — the presence of a '
  'survey_version_id column — rather than comparing against a maintained list, because a '
  'maintained list is a second thing to forget and forgetting is the bug this exists to catch: six '
  'tables were added across 0016, 0019 and 0021 and none was added to the clone, so the '
  'publish-then-clone workflow ADR-002 prescribes silently discarded every quota, every code asset '
  'and the theme pin. Same shape as ops.tables_without_rls() and '
  'ops.content_tables_without_draft_trigger(), which are the checks here that have actually caught '
  'things.';

REVOKE ALL ON FUNCTION ops.content_tables_not_cloned() FROM PUBLIC;


/* ------------------------------------------------------------------ *
 * 3. 0008's body, moved verbatim to content.clone_version_core
 * ------------------------------------------------------------------ *
 *
 * MOVED, not retyped. The eight branches below were already correct and the whole point of this
 * migration is that a hand-maintained list of tables goes wrong; retyping 100 lines of column
 * lists to add six branches would be the same class of mistake with better odds. The body is
 * byte-identical to what `pg_get_functiondef` returned before this migration ran, with one
 * character changed: the function name.
 *
 * `content.clone_version` below calls this and appends the six missing tables. Splitting rather
 * than inlining also means `ops.content_tables_not_cloned()` has a single function to read, and
 * that a future table is added in ONE place.
 */

CREATE FUNCTION content.clone_version_core(p_from app.ulid, p_to app.ulid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
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

  -- 0010. THE BRANCH THIS REDEFINITION EXISTS FOR. Without it, publish -> Edit silently drops
  -- every redirect and the next publish of that draft fails CMP-0300 on a survey that was live
  -- an hour ago. No remapping: a redirect row's key is (version, scope, scope_key, disposition,
  -- custom_key) and only the version half changes.
  INSERT INTO content.redirects (
    survey_version_id, scope, scope_key, disposition, custom_key, url_template, org_id,
    created_at)
  SELECT p_to, d.scope, d.scope_key, d.disposition, d.custom_key, d.url_template, d.org_id,
         d.created_at
    FROM content.redirects d
   WHERE d.survey_version_id = p_from;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('redirects', v_n);

  RETURN v_counts;
END $function$;

/* ------------------------------------------------------------------ *
 * 4. The six missing branches
 * ------------------------------------------------------------------ */

-- Appended to the existing function rather than rewritten, so the eight branches that were already
-- correct are untouched and this migration's diff is exactly the omission it fixes.
--
-- ORDER MATTERS for the quota tables and it is the same argument the nodes branch makes about its
-- self-FK: buckets reference dimensions and cells reference plans through composite FKs, so
-- dimensions and plans are inserted first. Unlike nodes these are separate statements, so
-- PostgreSQL's AFTER-ROW referential triggers do not paper over a wrong order.
--
-- `deleted_at` IS COPIED, deliberately. A soft-deleted quota dimension in the source is
-- soft-deleted in the clone: dropping the column would resurrect it, and skipping the row would
-- lose the fact that it once existed, which is what a soft delete is for.
CREATE OR REPLACE FUNCTION content.clone_version(p_from app.ulid, p_to app.ulid)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = ''
AS $fn$
DECLARE
  v_counts jsonb;
  v_n      integer;
BEGIN
  -- The original eight, unchanged, by delegation: this migration adds branches and must not risk
  -- retyping the parts that work. `content.clone_version_core` is 0008's body, renamed below.
  v_counts := content.clone_version_core(p_from, p_to);

  /* ---- quotas (0016) ---------------------------------------------- */

  INSERT INTO content.quota_dimensions (
    survey_version_id, id, org_id, ref, variable_id, sort_key, created_at, updated_at, deleted_at)
  SELECT p_to, d.id, d.org_id, d.ref, d.variable_id, d.sort_key, d.created_at, d.updated_at,
         d.deleted_at
    FROM content.quota_dimensions d WHERE d.survey_version_id = p_from;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || pg_catalog.jsonb_build_object('quota_dimensions', v_n);

  INSERT INTO content.quota_buckets (
    survey_version_id, id, org_id, dimension_id, ref, match, sort_key, created_at, updated_at,
    deleted_at)
  SELECT p_to, b.id, b.org_id, b.dimension_id, b.ref, b.match, b.sort_key, b.created_at,
         b.updated_at, b.deleted_at
    FROM content.quota_buckets b WHERE b.survey_version_id = p_from;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || pg_catalog.jsonb_build_object('quota_buckets', v_n);

  INSERT INTO content.quota_plans (
    survey_version_id, id, org_id, ref, plan_type, dimension_ids, count_at, reservation_ttl_s,
    on_store_unavailable, counter_scope, overflow, sort_key, created_at, updated_at, deleted_at)
  SELECT p_to, q.id, q.org_id, q.ref, q.plan_type, q.dimension_ids, q.count_at,
         q.reservation_ttl_s, q.on_store_unavailable, q.counter_scope, q.overflow, q.sort_key,
         q.created_at, q.updated_at, q.deleted_at
    FROM content.quota_plans q WHERE q.survey_version_id = p_from;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || pg_catalog.jsonb_build_object('quota_plans', v_n);

  INSERT INTO content.quota_cells (
    survey_version_id, id, org_id, plan_id, cell_key, target, target_pct, mode, created_at,
    updated_at, deleted_at)
  SELECT p_to, c.id, c.org_id, c.plan_id, c.cell_key, c.target, c.target_pct, c.mode, c.created_at,
         c.updated_at, c.deleted_at
    FROM content.quota_cells c WHERE c.survey_version_id = p_from;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || pg_catalog.jsonb_build_object('quota_cells', v_n);

  /* ---- code assets (0019) ----------------------------------------- */

  -- `sha256` is omitted because it is GENERATED ALWAYS: naming it would raise, and the clone
  -- recomputes it from the copied source — which is the point of generating it (0019's header).
  --
  -- `sanitizer_report` and `analyzed_at` ARE copied, and that is a decision rather than a default.
  -- The report is an archive of what the sanitizer found for these exact bytes, and the bytes are
  -- unchanged by a clone, so the verdict still describes them. Dropping it would make every clone
  -- look unanalysed; 0019's own header says the publish path re-analyses regardless, so a stale
  -- report can mislead nobody.
  INSERT INTO content.code_assets (
    id, survey_version_id, org_id, kind, ref, source, runs_on, scope, hooks, sanitizer_report,
    analyzed_at, created_at, updated_at)
  SELECT a.id, p_to, a.org_id, a.kind, a.ref, a.source, a.runs_on, a.scope, a.hooks,
         a.sanitizer_report, a.analyzed_at, a.created_at, a.updated_at
    FROM content.code_assets a WHERE a.survey_version_id = p_from;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || pg_catalog.jsonb_build_object('code_assets', v_n);

  /* ---- the theme pin (0021) --------------------------------------- */

  -- The SNAPSHOT is copied, not re-resolved from the theme. 0021's header is explicit about why:
  -- re-resolving consults a parent theme that may have changed, which answers a different question
  -- than the one that was approved. A clone starts life looking exactly like what it was cloned
  -- from, and an author who wants the new brand re-pins deliberately.
  INSERT INTO content.version_theme (
    survey_version_id, org_id, theme_id, theme_name, tokens_snapshot, compiled_css_sha256,
    created_at, updated_at)
  SELECT p_to, t.org_id, t.theme_id, t.theme_name, t.tokens_snapshot, t.compiled_css_sha256,
         t.created_at, t.updated_at
    FROM content.version_theme t WHERE t.survey_version_id = p_from;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || pg_catalog.jsonb_build_object('version_theme', v_n);

  RETURN v_counts;
END $fn$;

COMMENT ON FUNCTION content.clone_version(app.ulid, app.ulid) IS
  'ADR-002''s copy-on-write, complete. Delegates the eight original tables to '
  'content.clone_version_core (0008''s body, renamed) and adds the six that were added after it '
  'and never wired in: the four quota tables (0016), content.code_assets (0019) and '
  'content.version_theme (0021). Until this migration, publishing a survey and then cloning it to '
  'edit — the only editing path ADR-002 allows — silently discarded every quota definition, every '
  'script and stylesheet, and the theme pin. ops.content_tables_not_cloned() is what stops a '
  'seventh table repeating it.';

/* ------------------------------------------------------------------ *
 * 5. Grants — 0006's rule: every new function needs an explicit REVOKE
 * ------------------------------------------------------------------ */

REVOKE ALL ON FUNCTION content.clone_version_core(app.ulid, app.ulid) FROM PUBLIC;
-- `clone_version` is SECURITY INVOKER and runs as the caller, so the core it delegates to must be
-- callable by the same role. NOT a separate capability: a caller who can clone can already clone.
GRANT EXECUTE ON FUNCTION content.clone_version_core(app.ulid, app.ulid) TO authoring;
-- NO grant on the ops function, and the first version of this migration got that wrong. Three
-- standing assertions — in 0003, 0006 and 0010 — say "authoring holds EXECUTE on NO function in
-- schema ops", and 0010's adds why: the plane boundary was not widened to fix the enqueue path, "it
-- put a wrapper on the near side of it". A CI check has no caller in the authoring plane; it is run
-- by the migration harness as the owner.
