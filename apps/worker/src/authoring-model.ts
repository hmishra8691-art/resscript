/**
 * `content.*` rows → a `Survey` document. The "load authoring model" step of P1-08's pipeline.
 *
 * WHY THIS FILE HAS TO EXIST. The roadmap's P1-08 Backend column begins "load authoring model →
 * migrate to current schema_version → …", and nothing in this repository could do the first
 * step: `packages/schema` defines the `Survey` document, `packages/compiler` consumes one, and
 * the DATABASE stores the same information decomposed across nine tables that migrations 0007-0010
 * created deliberately shredded (B §4.1: one row per node so that reordering a 60-option list is
 * one UPDATE). There is no `survey_document jsonb` column anywhere — 0004's `app.survey_versions`
 * has `schema_version` but no document, and 0007/0008 add none. **The authoring model is the
 * tables.** So the compile job's first act is to reassemble one, and this is that reassembly.
 *
 * It is a separate module from `kinds/compile.ts` for the reason `apps/studio`'s
 * `server/dsl/registry.ts` is separate from its routes, and that file says it: the mapping from
 * column to declaration happens ONCE, so "why does the compiler not see my mask" is a question
 * about one file. It is the studio-side twin of that adapter, one level up — that one builds a
 * type environment for a single rule, this one builds the whole document.
 *
 * ## Pure, and therefore testable without Postgres
 *
 * Rows in, document out, no I/O and no clock. `PgPublishStore` does the reading; this does the
 * shaping. That split is what lets the interesting assertions of this milestone (a survey that
 * fails the gate, a republish that writes no object) run in milliseconds against literal rows,
 * with the integration suite proving only that the SELECTs return the columns this expects.
 *
 * ## The four things the tables cannot answer, and what is done about each
 *
 *  1. **`flow`.** THERE IS NO FLOW TABLE. 0007 created nodes, items, cells, variables,
 *     languages and i18n strings; 0008 added logic rules; neither adds flow, quotas, vendors,
 *     redirects, designs or assets, and the word "flow" appears in 0007 only inside comments
 *     about what `content.nodes` is a target for. C §6 says why that is survivable: "a survey
 *     with no branches has a trivial flow graph (start → sequence over all blocks → end), so
 *     simple surveys are never forced through graph editing". This file synthesizes exactly that
 *     trivial graph, and the flow node ids are DERIVED from the content ids rather than minted
 *     (`fn_<block body>`), because the compiler must be deterministic — a fresh ULID per compile
 *     would change `graph.json`, change the artifact hash, and destroy the one property the
 *     milestone is judged on. The consequence is honest and worth stating: a survey whose author
 *     wanted a branch cannot express one until a flow table exists, and the compiled artifact of
 *     such a survey is linear. It is not a silent approximation — every page is reachable and
 *     every diagnostic is true of the graph that was compiled.
 *  2. **`settings`.** No column, so `DEFAULT_SURVEY_SETTINGS` below. Chosen to be the least
 *     surprising rather than the most featureful: back navigation on, resume off, no progress
 *     bar, no screenout interstitial. A default that enabled resume would mint resume tokens for
 *     surveys nobody asked to be resumable (E §7), which is a behaviour change disguised as a
 *     fallback.
 *  3. **The survey-level language policy.** `content.languages` stores `on_missing` and
 *     `block_publish_if_incomplete` PER LANGUAGE; `Languages.policy` is per survey. The
 *     reduction is deliberate and asymmetric: `on_missing` comes from the BASE language's row
 *     (it is the fallback target, so its own policy is the one that governs), while
 *     `block_publish_if_incomplete` is the OR across languages — 0007's column comment says the
 *     column is per-language precisely so "a client signs off on English and German while Arabic
 *     is still in translation" is expressible, and taking the OR is what keeps a single blocking
 *     language blocking. Reducing it to AND, or to the base row alone, would let the one language
 *     that must not ship incomplete ship incomplete.
 *  4. **`quotas`, `vendors`, `designs` and `assets`.** No columns. All four are optional in
 *     `Survey` and their absence is merely a feature not yet reachable. **`redirects` used to be
 *     the fifth entry here and is not any more**: it was never in that category, because
 *     `CMP-0300` blocks the publish of any survey whose flow can reach `COMPLETE` with nowhere to
 *     send the respondent and the synthesized flow always can — so with no store, NO SURVEY COULD
 *     PUBLISH AT ALL. Migration 0010 gave it `content.redirects` (C §9, flattened one row per
 *     scope and disposition), and this file now reads it like every other table. The injected
 *     `AssembleOptions.redirects` fallback that stood in for the column is GONE: a redirect map
 *     supplied by the deployment rather than by the author is a third-party destination nobody
 *     configured, and C §9 is explicit that a redirect template is exactly where personal data
 *     leaves the platform. A version with no redirect rows now draws `CMP-0300` naming the
 *     disposition, which is the gate working correctly on a fact the author can fix.
 *
 * ## What is passed through rather than re-validated
 *
 * `nodes.config`, `.settings`, `.validation`, `.masks`, `.scripts`, `.flags`, `variables.storage`,
 * `.expression`, `logic_rules.condition` and `.effect` are `jsonb` columns whose shapes are
 * `packages/schema`'s types. They are attached with one narrow cast each and NOT re-checked here,
 * because `compileSurvey`'s first stage is `migrateToCurrent` + `parseValue` (see
 * `pipeline.ts`'s `loadSurvey`) and that is the validator. A second shape check here would be a
 * second definition of the document format — the thing ADR-010 exists to prevent — and it would
 * disagree with the first one the day a schema migration lands. The database's own guarantees are
 * narrower and real: 0008's `rules_condition_is_object` / `rules_effect_is_object` mean those two
 * are objects and not the JSON scalar `null`, and 0009 added the same shape CHECKs to the two
 * JSONB columns on the version row.
 *
 * Ids are branded with `asId`, which THROWS on a malformed value. That is correct here and would
 * be wrong in an API handler: these strings come out of `app.ulid`-domained columns, so a throw
 * means the domain was dropped, and failing the job loudly beats emitting an artifact full of
 * references that resolve to nothing.
 */

import {
  asId,
  type BlockId,
  type ContentNode,
  type ContentNodeId,
  type Expr,
  type Flow,
  type FlowNode,
  type FlowNodeId,
  type I18nRef,
  type JsonObject,
  type JsonValue,
  type LanguageDef,
  type LogicRule,
  type Mask,
  type OptionId,
  type PageChild,
  type PageId,
  type QuestionCell,
  type QuestionId,
  type QuestionItem,
  type Redirects,
  type RuleEffect,
  type RuleEvaluation,
  type RuleKind,
  type RuleTarget,
  type StringBundle,
  type Survey,
  type SurveySettings,
  type TextNodeId,
  type ValidationRule,
  type Variable,
  type VariableId,
  type VariableKind,
  type VariablePart,
  type VariableType,
} from '@resscript/schema';

/* -------------------------------------------------------------------------- */
/* The rows, exactly as the columns are named                                 */
/* -------------------------------------------------------------------------- */

/**
 * Column names are snake_case and verbatim from `db/migrations/0007_content_model/up.sql` and
 * `0008_authored_in/up.sql`, the same rule `apps/studio/src/server/repo/types.ts` states for its
 * own row types: the point of a mapping layer is that the mapping happens once, and a row
 * interface that renamed a column would make this file the second place the schema is described.
 */
export interface AuthoringVersionRow {
  readonly id: string;
  readonly org_id: string;
  readonly survey_id: string;
  readonly version_no: number;
  readonly status: string;
  readonly compile_state: string;
  readonly schema_version: number;
  readonly artifact_hash: string | null;
  readonly artifact_bytes: number | null;
  readonly entitlement_reqs: readonly string[];
  readonly acknowledged_warnings: readonly JsonValue[];
  readonly revision: number;
}

export interface AuthoringSurveyRow {
  readonly id: string;
  readonly ref: string;
  readonly name: string;
  readonly description: string | null;
  readonly default_language: string;
  readonly theme_id: string | null;
}

export interface AuthoringNodeRow {
  readonly id: string;
  readonly node_kind: 'block' | 'page' | 'question' | 'text';
  readonly parent_id: string | null;
  readonly sort_key: string;
  readonly ref: string | null;
  readonly label_key: string | null;
  readonly instruction_key: string | null;
  readonly title_key: string | null;
  readonly question_type: string | null;
  readonly required: boolean | null;
  readonly config: JsonObject;
  readonly settings: JsonObject;
  readonly validation: readonly JsonValue[];
  readonly masks: readonly JsonValue[];
  readonly scripts: JsonObject;
  readonly flags: JsonObject;
  readonly emits: readonly string[];
}

export interface AuthoringItemRow {
  readonly id: string;
  readonly question_id: string;
  readonly item_kind: 'option' | 'row' | 'column';
  readonly ref: string;
  readonly code: number;
  readonly label_key: string | null;
  readonly sort_key: string;
  readonly anchor: string;
  readonly exclusive: boolean;
  readonly behaviour: JsonObject;
  readonly media_asset_id: string | null;
  readonly value_override: string | null;
  readonly custom_class: string | null;
  readonly meta: JsonObject;
}

export interface AuthoringCellRow {
  readonly id: string;
  readonly question_id: string;
  readonly row_item_id: string;
  readonly column_item_id: string | null;
  readonly question_type: string;
  readonly config: JsonObject;
  readonly use_columns: boolean;
}

export interface AuthoringVariableRow {
  readonly id: string;
  readonly name: string;
  readonly kind: VariableKind;
  readonly vtype: VariableType;
  readonly source_question_id: string | null;
  readonly source_item_id: string | null;
  readonly source_part: JsonObject | null;
  readonly enum_domain: readonly JsonValue[] | null;
  readonly expression: JsonValue | null;
  readonly storage: JsonObject;
  readonly export_include: boolean;
  readonly export_column: string;
  readonly export_label_key: string | null;
  readonly pii: boolean;
  readonly persist: boolean;
  readonly sort_key: string;
}

export interface AuthoringLanguageRow {
  readonly lang: string;
  readonly is_base: boolean;
  readonly rtl: boolean;
  readonly on_missing: string;
  readonly block_publish_if_incomplete: boolean;
}

export interface AuthoringStringRow {
  readonly lang: string;
  readonly key: string;
  readonly value: string | null;
  readonly state: string;
}

/**
 * `content.redirects` (0010). One row per (scope, scope key, disposition, custom key).
 *
 * `scope_key` is `''` for the default scope and `custom_key` is `''` for every disposition but
 * `CUSTOM` — both pinned by biconditional CHECKs, so the empty strings are the table's own
 * encoding of "not applicable" rather than a convention this file has to defend.
 */
export interface AuthoringThemeRow {
  readonly id: string;
  readonly name: string;
  readonly tokens: { readonly [k: string]: string };
}

export interface AuthoringRedirectRow {
  readonly scope: 'default' | 'vendor' | 'language';
  readonly scope_key: string;
  readonly disposition: string;
  readonly custom_key: string;
  readonly url_template: string;
}

export interface AuthoringRuleRow {
  readonly id: string;
  readonly kind: RuleKind;
  readonly target_kind: 'node' | 'item' | 'variable' | 'survey';
  readonly target_node_id: string | null;
  readonly target_item_id: string | null;
  readonly target_variable_id: string | null;
  readonly condition: JsonObject;
  readonly effect: JsonObject;
  readonly evaluation: string;
  readonly authored_in: string;
  readonly notes: string | null;
  readonly sort_key: string;
}

/** Everything one version's document is made of. One object so adding a table is one field. */
export interface AuthoringRows {
  readonly version: AuthoringVersionRow;
  readonly survey: AuthoringSurveyRow;
  readonly nodes: readonly AuthoringNodeRow[];
  readonly items: readonly AuthoringItemRow[];
  readonly cells: readonly AuthoringCellRow[];
  readonly variables: readonly AuthoringVariableRow[];
  readonly languages: readonly AuthoringLanguageRow[];
  readonly strings: readonly AuthoringStringRow[];
  readonly rules: readonly AuthoringRuleRow[];
  readonly redirects: readonly AuthoringRedirectRow[];
  /**
   * The survey's theme and its ancestors, ROOT-FIRST — the order `compileTheme`'s `layers` expects
   * (nearest-last). Empty when the survey pins no theme, which is the common case and means the
   * compiler's own default vocabulary is the whole theme.
   */
  readonly themeChain: readonly AuthoringThemeRow[];
}

/* -------------------------------------------------------------------------- */
/* Defaults for the slots no table fills                                      */
/* -------------------------------------------------------------------------- */

/** See the header, note 2. Least-surprising, not most-featureful. */
export const DEFAULT_SURVEY_SETTINGS: SurveySettings = {
  navigation: { back_allowed: true },
  resume: { enabled: false, window_s: 3600, position: 'last_page' },
  progress_bar: { mode: 'none' },
  screenout: { show_message: false },
};

/**
 * The synthesized flow's terminal nodes.
 *
 * Spelled in Crockford base32 so they satisfy `app.ulid`'s body pattern AND read as words in a
 * diagnostic: `CMP-0001` naming `fn_00000000000000000000START` is self-explaining in a way that
 * `fn_01JC8KX9Q2M4V7ZB3F0T5N6R8W` is not. The letters S, T, A, R, E, N and D are all in the
 * alphabet; I, L, O and U are not, which is why "LOOP" and "SOURCE" could not have been used.
 */
export const SYNTHETIC_START_ID: FlowNodeId = asId('fn', `fn_${'0'.repeat(21)}START`);
export const SYNTHETIC_END_ID: FlowNodeId = asId('fn', `fn_${'0'.repeat(23)}END`);

/**
 * The flow node that lays out one root block.
 *
 * Derived from the block's own id rather than minted, so two compiles of an unchanged survey
 * produce byte-identical `graph.json`. `blk_<body>` → `fn_<body>`: the body is already 26
 * Crockford characters starting 0-7, so the result satisfies the same domain, and the mapping is
 * injective, which is what makes the ids unique across root blocks.
 */
export function sequenceFlowNodeId(blockId: string): FlowNodeId {
  const body = blockId.slice(blockId.indexOf('_') + 1);
  return asId('fn', `fn_${body}`);
}

/* -------------------------------------------------------------------------- */
/* Assembly                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Rows in, document out — and NO OPTIONS PARAMETER.
 *
 * There used to be an `AssembleOptions` carrying an injected `redirects` map, because C §9's
 * redirect map had no column in 0004/0007/0008 and `CMP-0300` blocks every survey without one.
 * Migration 0010 created `content.redirects`, so the map is now a fact about the version like
 * every other field here, and the parameter is gone rather than kept as a fallback: a redirect
 * the deployment supplied is a destination the author never authored, and it would have made
 * "this survey publishes" depend on worker configuration instead of on survey content.
 */
export function assembleSurvey(rows: AuthoringRows): Survey {
  const children = childIndexOf(rows.nodes);
  const roots = (children.get(null) ?? []).filter((n) => n.node_kind === 'block');

  const content: readonly ContentNode[] = roots.map((root) => blockOf(root, children, rows));
  const flow = synthesizeFlow(roots);

  const description = rows.survey.description;
  const themeRef = rows.survey.theme_id;
  const redirects = redirectsOf(rows.redirects);

  return {
    meta: {
      id: asId('svy', rows.survey.id),
      ref: rows.survey.ref,
      name: rows.survey.name,
      ...(description === null ? {} : { description }),
    },
    schema_version: rows.version.schema_version,
    settings: DEFAULT_SURVEY_SETTINGS,
    languages: languagesOf(rows),
    ...(themeRef === null ? {} : { theme_ref: themeRef }),
    variables: rows.variables
      .slice()
      .sort(bySortKey)
      .map((row) => variableOf(row)),
    content,
    flow,
    logic_rules: rows.rules
      .slice()
      .sort(bySortKey)
      .map((row) => ruleOf(row, rows.nodes)),
    ...(redirects === undefined ? {} : { redirects }),
    ...(rows.version.entitlement_reqs.length === 0
      ? {}
      : { entitlement_reqs: [...rows.version.entitlement_reqs] }),
  };
}

/**
 * `(sort_key, id)`, and the tiebreak is load-bearing.
 *
 * B §4.6's `sort_key` is a base-62 FRACTIONAL index, so it is unique in practice but nothing
 * enforces uniqueness across siblings after a rebalance races. `Array.prototype.sort` is stable
 * in every modern engine, but the ROW ORDER it would be stable with respect to is the order
 * Postgres happened to return, which is not a guarantee at all. Breaking the tie on `id` — which
 * IS unique — is what makes the emitted `position` deterministic, and therefore what makes two
 * compiles of an unchanged survey hash the same.
 */
function bySortKey<T extends { readonly sort_key: string; readonly id: string }>(a: T, b: T): number {
  if (a.sort_key !== b.sort_key) return a.sort_key < b.sort_key ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function childIndexOf(
  nodes: readonly AuthoringNodeRow[],
): ReadonlyMap<string | null, readonly AuthoringNodeRow[]> {
  const index = new Map<string | null, AuthoringNodeRow[]>();
  for (const node of nodes) {
    const bucket = index.get(node.parent_id) ?? [];
    bucket.push(node);
    index.set(node.parent_id, bucket);
  }
  for (const [key, bucket] of index) index.set(key, bucket.slice().sort(bySortKey));
  return index;
}

function blockOf(
  row: AuthoringNodeRow,
  children: ReadonlyMap<string | null, readonly AuthoringNodeRow[]>,
  rows: AuthoringRows,
): ContentNode {
  const title = i18nRefOf(row.title_key);
  return {
    id: asId('blk', row.id),
    type: 'block',
    ref: row.ref ?? row.id,
    ...(title === undefined ? {} : { title }),
    ...(isEmpty(row.settings) ? {} : { settings: row.settings as never }),
    children: (children.get(row.id) ?? []).map((child) =>
      child.node_kind === 'block' ? blockOf(child, children, rows) : pageOrChildOf(child, children, rows),
    ),
  };
}

function pageOrChildOf(
  row: AuthoringNodeRow,
  children: ReadonlyMap<string | null, readonly AuthoringNodeRow[]>,
  rows: AuthoringRows,
): ContentNode {
  switch (row.node_kind) {
    case 'page': {
      const title = i18nRefOf(row.title_key);
      return {
        id: asId('pg', row.id),
        type: 'page',
        ref: row.ref ?? row.id,
        ...(title === undefined ? {} : { title }),
        ...(isEmpty(row.settings) ? {} : { settings: row.settings as never }),
        children: (children.get(row.id) ?? []).map((child) => pageChildOf(child, rows)),
      };
    }
    case 'question':
    case 'text':
      return pageChildOf(row, rows);
    case 'block':
      return blockOf(row, children, rows);
  }
}

function pageChildOf(row: AuthoringNodeRow, rows: AuthoringRows): PageChild {
  if (row.node_kind === 'text') {
    return {
      id: asId('txt', row.id) satisfies TextNodeId,
      type: 'text',
      label: { key: row.label_key ?? '' },
    };
  }
  return questionOf(row, rows);
}

function questionOf(row: AuthoringNodeRow, rows: AuthoringRows): PageChild {
  const items = rows.items.filter((item) => item.question_id === row.id);
  const options = itemsOf(items, 'option');
  const matrixRows = itemsOf(items, 'row');
  const columns = itemsOf(items, 'column');
  const cells = cellsOf(rows.cells, items, row.id);
  const label = i18nRefOf(row.label_key);
  const instruction = i18nRefOf(row.instruction_key);

  return {
    id: asId('qst', row.id) satisfies QuestionId,
    type: 'question',
    ref: row.ref ?? row.id,
    // `nodes_kind_shape` makes question_type NOT NULL for a question row; the fallback keeps
    // this total rather than asserting, and an empty plugin id draws `CMP-0500` from the
    // resolver, which names the question.
    question_type: row.question_type ?? '',
    ...(label === undefined ? {} : { label }),
    ...(instruction === undefined ? {} : { instruction }),
    required: row.required ?? false,
    ...(isEmpty(row.config) ? {} : { config: row.config }),
    ...(options.length === 0 ? {} : { options }),
    ...(matrixRows.length === 0 ? {} : { rows: matrixRows }),
    ...(columns.length === 0 ? {} : { columns }),
    ...(cells.length === 0 ? {} : { cells }),
    ...(row.validation.length === 0
      ? {}
      : { validation: row.validation as unknown as readonly ValidationRule[] }),
    ...(row.masks.length === 0 ? {} : { masks: row.masks as unknown as readonly Mask[] }),
    ...(row.emits.length === 0
      ? {}
      : { emits: row.emits.map((id): VariableId => asId('var', id)) }),
    ...(isEmpty(row.scripts) ? {} : { scripts: row.scripts as never }),
    ...(isEmpty(row.flags) ? {} : { flags: row.flags as never }),
  };
}

/**
 * One item kind, ordered by `sort_key` and given a DENSE 1-based `position`.
 *
 * This is the roadmap's "materialize dense integer `position` from `sort_key`", and it happens
 * here rather than in `packages/compiler` because `position` is a column of the authoring model
 * in the wire format (`QuestionItem.position`) and the fractional key is a column of the
 * database. `code` is untouched: 0007 keeps them in separate columns with separate constraints
 * because randomizing display order must never rewrite an exported value, and this function is
 * the one place a reader might expect the two to be conflated.
 */
function itemsOf(
  items: readonly AuthoringItemRow[],
  kind: AuthoringItemRow['item_kind'],
): readonly QuestionItem[] {
  return items
    .filter((item) => item.item_kind === kind)
    .sort(bySortKey)
    .map((item, index): QuestionItem => {
      const label = i18nRefOf(item.label_key);
      const media = item.media_asset_id;
      return {
        id: brandItemId(item.id),
        ref: item.ref,
        code: item.code,
        ...(label === undefined ? {} : { label }),
        ...(media === null ? {} : { media: { image_asset_id: asId('ast', media) } }),
        position: index + 1,
        ...(item.anchor === 'none' ? {} : { anchor: item.anchor as never }),
        ...(item.exclusive ? { exclusive: true } : {}),
        ...(isEmpty(item.behaviour) ? {} : { behaviour: item.behaviour as never }),
        ...(item.value_override === null ? {} : { value_override: item.value_override }),
        ...(item.custom_class === null ? {} : { custom_class: item.custom_class }),
        ...(isEmpty(item.meta) ? {} : { meta: item.meta }),
      };
    });
}

/**
 * `content.question_cells` → `QuestionCell[]`.
 *
 * The table addresses a cell by ITEM ID and the document addresses it by ITEM REF (C §5.2's
 * `row_ref` / `column_ref`), so this resolves ids back to refs through the item rows. A cell
 * whose row item is missing is dropped rather than emitted with an empty ref: the composite FK
 * makes that unreachable, and an emitted cell with `row_ref: ''` would draw a structural
 * diagnostic naming a row nobody wrote.
 */
function cellsOf(
  cells: readonly AuthoringCellRow[],
  items: readonly AuthoringItemRow[],
  questionId: string,
): readonly QuestionCell[] {
  const refOf = new Map(items.map((item) => [item.id, item.ref]));
  return cells
    .filter((cell) => cell.question_id === questionId)
    .slice()
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .flatMap((cell): readonly QuestionCell[] => {
      const rowRef = refOf.get(cell.row_item_id);
      if (rowRef === undefined) return [];
      const columnRef = cell.column_item_id === null ? undefined : refOf.get(cell.column_item_id);
      return [
        {
          row_ref: rowRef,
          ...(columnRef === undefined ? {} : { column_ref: columnRef }),
          control: {
            question_type: cell.question_type,
            ...(isEmpty(cell.config) ? {} : { config: cell.config }),
            ...(cell.use_columns ? { use_columns: true } : {}),
          },
        },
      ];
    });
}

function variableOf(row: AuthoringVariableRow): Variable {
  const part = partOf(row);
  const source =
    part === undefined
      ? undefined
      : {
          ...(row.source_question_id === null
            ? {}
            : { question_id: asId('qst', row.source_question_id) }),
          part,
        };
  const label = row.export_label_key;
  return {
    id: asId('var', row.id),
    name: row.name,
    kind: row.kind,
    type: row.vtype,
    ...(source === undefined ? {} : { source }),
    ...(row.enum_domain === null ? {} : { enum_domain: row.enum_domain as never }),
    ...(row.expression === null ? {} : { expression: row.expression as Expr }),
    ...(isEmpty(row.storage) ? {} : { storage: row.storage as never }),
    export: {
      include: row.export_include,
      column: row.export_column,
      ...(label === null ? {} : { label_key: label }),
    },
    pii: row.pii,
    persist: row.persist,
  };
}

/**
 * `content.variables.source_part` → `VariablePart`.
 *
 * `undefined` when the column is NULL, which is how a hidden, system or authored-derived
 * variable says "no question produced me" — and it must stay distinguishable from
 * `{kind:'scalar'}`, because `VariableSource.part` is what `deriveVariableName` reads and a
 * spurious `scalar` part on a hidden variable would claim the name was derived from a ref the
 * variable does not have.
 */
function partOf(row: AuthoringVariableRow): VariablePart | undefined {
  if (row.source_part === null) return undefined;
  return row.source_part as unknown as VariablePart;
}

function ruleOf(row: AuthoringRuleRow, nodes: readonly AuthoringNodeRow[]): LogicRule {
  const notes = row.notes;
  return {
    id: asId('rul', row.id),
    kind: row.kind,
    target: ruleTargetOf(row, nodes),
    condition: row.condition as unknown as Expr,
    effect: row.effect as unknown as RuleEffect,
    evaluation: row.evaluation as RuleEvaluation,
    authored_in: row.authored_in === 'dsl' ? 'dsl' : 'visual',
    ...(notes === null ? {} : { notes }),
  };
}

/**
 * `target_kind` + three nullable id columns → `RuleTarget`.
 *
 * 0008's `rules_one_target` is three biconditionals, so exactly one id is non-NULL and WHICH one
 * is pinned by `target_kind` — a `variable` target with a node id is not storable. What the table
 * does NOT record is whether a `node` target is a question, a page or a block, because
 * `content.nodes` is one table with a discriminator (0007: three tables would make every rule
 * target a polymorphic reference with no FK). So the node's own `node_kind` supplies it, which is
 * the only place in this file where a row's meaning depends on another row.
 */
function ruleTargetOf(row: AuthoringRuleRow, nodes: readonly AuthoringNodeRow[]): RuleTarget {
  switch (row.target_kind) {
    case 'item':
      // The `?? ''` is unreachable and is deliberately left where it will throw: 0008's
      // rules_one_target is a biconditional, so target_kind = 'item' implies the id is NOT NULL,
      // and a row that reached here without one means the constraint is gone. This file's header
      // rule applies — a throw beats an artifact full of references that resolve to nothing.
      return { type: 'option', id: brandItemId(row.target_item_id ?? '') };
    case 'variable':
      return { type: 'variable', id: asId('var', row.target_variable_id ?? '') };
    case 'survey':
      return { type: 'survey' };
    case 'node': {
      const id = row.target_node_id ?? '';
      const kind = nodes.find((node) => node.id === id)?.node_kind;
      switch (kind) {
        case 'page':
          return { type: 'page', id: asId('pg', id) satisfies PageId };
        case 'block':
          return { type: 'block', id: asId('blk', id) satisfies BlockId };
        default:
          // `question` and the unreachable "node row not in this version" case. Defaulting to
          // `question` rather than throwing keeps the load total: a target that resolves to
          // nothing is `SCH-1006`'s job, and it names the rule.
          return { type: 'question', id: asId('qst', id) satisfies ContentNodeId };
      }
    }
  }
}

/**
 * The trivial flow of C §6: `start → sequence per root block → end(COMPLETE)`.
 *
 * `COMPLETE` and not `SCREENED_OUT` because a respondent who reaches the last page of every
 * block has finished the survey, and K's disposition registry makes `COMPLETE` the one that
 * counts toward quota — a synthesized terminal with any other disposition would silently
 * un-count every completion.
 *
 * A version with NO root block still gets a start and an end. That is deliberate: the compiler's
 * `CMP-0801` ("no reachable flow node lays out a page") is the diagnostic an author can act on,
 * and it is only reachable if the graph exists. Returning an empty node list would instead
 * produce `CMP-0001` (no start node), which describes this file's output rather than the survey.
 */
function synthesizeFlow(roots: readonly AuthoringNodeRow[]): Flow {
  const sequences = roots.map((root) => sequenceFlowNodeId(root.id));
  const nodes: FlowNode[] = [
    { id: SYNTHETIC_START_ID, type: 'start', next: sequences[0] ?? SYNTHETIC_END_ID },
  ];
  roots.forEach((root, index) => {
    nodes.push({
      id: sequenceFlowNodeId(root.id),
      type: 'sequence',
      target_id: asId('blk', root.id) satisfies BlockId,
      next: sequences[index + 1] ?? SYNTHETIC_END_ID,
    });
  });
  nodes.push({ id: SYNTHETIC_END_ID, type: 'end', disposition: 'COMPLETE' });
  return { nodes };
}

/**
 * `content.languages` + `content.i18n_strings` → `Languages`.
 *
 * A string whose `state` is `missing` is OMITTED from its bundle rather than emitted as `''`.
 * 0007's `i18n_missing_has_no_value` already forbids a `missing` row from holding a value, and
 * the distinction matters downstream: C §16's completeness gate and the compiler's translation
 * check both ask "is this key present in this bundle", and a present-but-empty string answers
 * yes to a question whose honest answer is no. The publish gate would then pass on a survey that
 * shows a respondent a blank label.
 */
function languagesOf(rows: AuthoringRows): Survey['languages'] {
  const base =
    rows.languages.find((lang) => lang.is_base)?.lang ?? rows.survey.default_language;
  const available: readonly LanguageDef[] =
    rows.languages.length === 0
      ? [{ code: base }]
      : rows.languages
          .slice()
          .sort((a, b) => (a.lang < b.lang ? -1 : a.lang > b.lang ? 1 : 0))
          .map((lang): LanguageDef => ({ code: lang.lang, ...(lang.rtl ? { rtl: true } : {}) }));

  const bundles: { [code: string]: StringBundle } = {};
  for (const lang of available) bundles[lang.code] = {};
  for (const row of rows.strings) {
    if (row.state === 'missing' || row.value === null || row.value === '') continue;
    const bundle = bundles[row.lang];
    if (bundle === undefined) continue; // the FK makes this unreachable; typed anyway.
    (bundle as { [key: string]: string })[row.key] = row.value;
  }

  const baseRow = rows.languages.find((lang) => lang.is_base);
  return {
    base,
    available,
    bundles,
    policy: {
      on_missing: onMissingOf(baseRow?.on_missing),
      // The OR, not the base row and not the AND. See the header, note 3.
      block_publish_if_incomplete: rows.languages.some(
        (lang) => lang.block_publish_if_incomplete,
      ),
    },
  };
}

function onMissingOf(value: string | undefined): Survey['languages']['policy']['on_missing'] {
  return value === 'show_key' || value === 'block' ? value : 'fallback_to_base';
}

/**
 * `content.redirects` rows → C §9's `Redirects` (0010).
 *
 * `undefined` FOR ZERO ROWS, and that is the load-bearing case rather than an edge one: it is
 * what makes `CMP-0300` fire and name the disposition. Returning `{ default: {} }` instead would
 * be a document that claims to carry a redirect map and then answers nothing, which the gate
 * would still refuse — but it would refuse it against a shape the author cannot recognize, and
 * "this survey has no redirects" is the sentence the publish dialog has to show.
 *
 * The three scopes are reassembled from `scope` + `scope_key` because the table is flattened
 * (Deliverable B's word) while the document is nested. The row is the source of truth for the
 * pair: 0010's `redirects_scope_key_shape` makes `scope = 'default'` and `scope_key = ''`
 * equivalent, so this function needs no defence against a vendor row with no ref.
 */
function redirectsOf(rows: readonly AuthoringRedirectRow[]): Redirects | undefined {
  if (rows.length === 0) return undefined;

  // Mutable maps, cast once at the boundary. Every model type here is deeply readonly, and
  // building a readonly structure incrementally means either a cast or a fold that rebuilds the
  // whole map per row; the cast is confined to this function and the values never escape it
  // before the return.
  type MutableMap = { [key: string]: string | { [key: string]: string } };
  const scoped = new Map<string, MutableMap>();
  const mapFor = (key: string): MutableMap => {
    const existing = scoped.get(key);
    if (existing !== undefined) return existing;
    const fresh: MutableMap = {};
    scoped.set(key, fresh);
    return fresh;
  };

  for (const row of rows) {
    const key = row.scope === 'default' ? 'default' : `${row.scope}:${row.scope_key}`;
    const map = mapFor(key);
    if (row.disposition === 'CUSTOM') {
      // C §9 nests named custom terminations one level deeper, keyed by
      // `TerminationNode.custom_key` — which 0010 makes half of the primary key, so two rows
      // cannot collide here.
      const custom = (map['CUSTOM'] ?? {}) as { [key: string]: string };
      custom[row.custom_key] = row.url_template;
      map['CUSTOM'] = custom;
      continue;
    }
    map[row.disposition] = row.url_template;
  }

  const byScope = (prefix: string): { [key: string]: MutableMap } | undefined => {
    const out: { [key: string]: MutableMap } = {};
    let any = false;
    for (const [key, map] of scoped) {
      if (!key.startsWith(`${prefix}:`)) continue;
      out[key.slice(prefix.length + 1)] = map;
      any = true;
    }
    return any ? out : undefined;
  };


  const vendors = byScope('vendor');
  const languages = byScope('language');
  return {
    // `default` is REQUIRED by C §9 and a version may legitimately carry only vendor overrides,
    // so an absent default scope is an empty map rather than an omission. The gate then reports
    // the missing COMPLETE against the disposition, which is the diagnostic that names what to
    // fix; a missing `default` key would be a schema error naming the document format instead.
    default: (scoped.get('default') ?? {}) as Redirects['default'],
    // NonNullable, because `exactOptionalPropertyTypes` makes `Redirects['by_vendor']` include
    // `undefined` and an optional property that does not accept `undefined` will not take it.
    ...(vendors === undefined
      ? {}
      : { by_vendor: vendors as NonNullable<Redirects['by_vendor']> }),
    ...(languages === undefined
      ? {}
      : { by_language: languages as NonNullable<Redirects['by_language']> }),
  };
}

/**
 * Brand a `content.question_items.id`, ASSERTING the prefix — which is only possible because the
 * two sides now agree.
 *
 * This function used to be a bare cast, with a long comment about a contradiction it could not
 * resolve: `packages/schema` brands every option, row and column `OptionId` (= `Id<'opt'>`)
 * because `QuestionItem` is one shape for all three (C §5.1), while 0007's comment on
 * `question_items.id` claimed the prefix was kind-dependent and `ops.test_seed_content` duly wrote
 * `row_…`. `asId('opt', …)` therefore threw on a legitimately stored row id, so the cast existed
 * to hand the malformed id to `parseValue` and get a diagnostic naming the item instead of a 500 —
 * which meant NO MATRIX QUESTION COULD PUBLISH, because that diagnostic is `SCH-0104` and it is an
 * error.
 *
 * Migration 0010 §4 settled it in favour of C, which is the contract: `qitems_id_prefix` now
 * refuses any item id that is not `opt_`-prefixed, and the KIND lives in `item_kind` where a
 * discriminator belongs. So the assertion is back on, and it is worth having rather than merely
 * safe: these strings come out of an `app.ulid` column behind that CHECK, so a throw here means
 * the constraint was dropped, and failing the job loudly beats emitting an artifact whose item
 * references resolve to nothing.
 */
function brandItemId(id: string): OptionId {
  return asId('opt', id);
}

function i18nRefOf(key: string | null): I18nRef | undefined {
  return key === null || key === '' ? undefined : { key };
}

function isEmpty(value: JsonObject): boolean {
  return Object.keys(value).length === 0;
}
