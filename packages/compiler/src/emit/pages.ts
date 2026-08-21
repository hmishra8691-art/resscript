/**
 * `CompiledPage`, one per page per language — the unit the runtime fetches to render (C §17,
 * C §16, roadmap P1-08).
 *
 * ## The path layout, and why it is per language
 *
 * `CompiledQuestion.label` is documented as "already resolved to the respondent's language — no
 * key lookup at render", which means a page tree is a *function of the language*: the same page in
 * `en` and in `de` is two different files. `CompiledArtifact.pages` is a flat
 * `{ [pageId]: CompiledPage }` with no language in it, so the two facts are reconciled by storing
 * **N page trees** and keeping one in memory:
 *
 *  - stored: `pages/<language>/<pageId>.json`, one directory per language in
 *    `manifest.languages`.
 *  - in memory: `artifact.pages` is the **base language** tree. A caller holding a
 *    `CompiledArtifact` (a test, the studio preview, an exporter) gets the authoring language,
 *    which is the one every key is guaranteed to exist in; a respondent's runtime never reads
 *    `artifact.pages` at all, it fetches one file under its own language directory.
 *
 * The rejected alternative was one tree with unresolved keys plus a bundle, which is what the
 * authoring model already is — and it moves a key lookup per label into the render path, which is
 * exactly what §17's first guarantee ("rendering one page needs manifest + graph + logic + one
 * page") is written to avoid.
 *
 * Pages are emitted for exactly `FlowGraph.pageOrder` — the pages a respondent can reach, in flow
 * order. A page in `content` that no flow node lays out has no `page_entry`, so the runtime could
 * never navigate to it; `CMP-0004` already reports the flow node that fails to lay out content,
 * and `LGC-U002`/`U003` report a question that is provably never visible.
 *
 * ## `position` is 0-based, and that disagrees with schema's fixtures on purpose
 *
 * `QuestionItem.position` is documented as "the compiled, dense **display** position" and
 * `packages/schema`'s own fixtures write it 1-based, while `registry.ts` found that
 * `packages/logic`'s `ItemDecl.position` is "0-based canonical position" and uses the array index
 * — its comment records the whole disagreement and the reason it resolves in favour of the index:
 * `groupItems` passes `ItemDecl.position` straight through to `item_attr position`, so copying a
 * 1-based field would make `item.position == 0` unsatisfiable for the first option of every
 * survey, silently.
 *
 * **The artifact takes the same side, and it has to.** `ArtifactLogic` does not serialize
 * `maskItems` — `base_items` carries codes and nothing else — so the item metadata a rehydrated
 * per-item mask condition reads (`code`, `position`, `label`, `meta`) can only come from
 * `CompiledItem`. If the artifact emitted 1-based positions, a mask that the compile-time solver
 * decided against a 0-based position would be re-decided at runtime against a 1-based one, and the
 * client and the server would disagree about which options a respondent sees. So `position` here
 * is the **0-based dense array index**, byte-identical to what `registry.ts` gave the checker.
 * `code` is untouched, per `QuestionItem.code`'s own warning that confusing the two is "a classic
 * data disaster".
 *
 * ## `inline_rules` is computed from the cell graph, not guessed
 *
 * The contract says "rules whose trigger and target are both on this page, inlined to avoid a
 * fetch". The useful reading of that is operational: a rule may be inlined exactly when the client
 * can evaluate it from page-local state, with no server round trip and no state from an earlier
 * page. That is a property of the *cell graph*, not of the rule's text, so it is computed there:
 *
 *  1. Every cell is assigned a **page scope** — the page it belongs to, if every cell it
 *     transitively depends on belongs to that same page, and `undefined` otherwise. One pass in
 *     `topo` order, which is exactly the order that makes a transitive property a local one.
 *  2. A rule is inlined on page P when it writes at least one cell and every cell it writes has
 *     scope P.
 *
 * The scope is over the graph's `inputs` rather than over the rule's own reads, and that is the
 * conservative direction on purpose: if a *second* rule writes the same cell from off-page state,
 * the cell is not computable page-locally no matter what this rule reads, so inlining the first
 * rule would give the client a verdict the server disagrees with. A rule reading a hidden variable
 * (no question, therefore no page) is likewise not inlined — its trigger is not on the page. Under-
 * inlining costs a fetch; over-inlining costs ADR-004's divergence metric, and only one of those
 * is recoverable in field.
 *
 * ## What this module refuses to do
 *
 * It does not validate, resolve plugins, or check translations. Missing i18n keys are
 * `CMP-0200`/`CMP-0201` and `SCH-1008`; an unresolved `question_type` is `CMP-0400`. A question
 * whose plugin did not resolve keeps its authored `question_type` string rather than being dropped
 * — the compile has already failed, and a page missing its question would bury the diagnostic that
 * says why.
 */

import {
  flattenContent,
  type CompiledItem,
  type CompiledPage,
  type CompiledQuestion,
  type CompiledRule,
  type ContentNodeId,
  type JsonObject,
  type PageNode,
  type QuestionItem,
  type QuestionNode,
  type Survey,
  type VariableId,
} from '@resscript/schema';
import { cellKey, writesOf, type Cell, type CellIdx, type CompiledLogic, type Rule } from '@resscript/logic';

import type { PluginResolution } from '../analyses/plugins.js';
import { blockPathOf, pageOfQuestion } from '../flow.js';
import type { FlowGraph } from '../types.js';
import { compiledRuleOf } from './logic.js';
import { artifactLanguages, stringResolver, type StringResolver } from './i18n.js';

/** The stored path of one compiled page. The one place the layout is spelled. */
export function pagePath(language: string, pageId: string): string {
  return `pages/${language}/${pageId}.json`;
}

export interface PagesInput {
  readonly survey: Survey;
  readonly graph: FlowGraph;
  readonly logic: CompiledLogic;
  readonly plugins: PluginResolution;
}

export interface PagesResult {
  /** Language codes, base first — the same list and order `manifest.languages` carries. */
  readonly languages: readonly string[];
  readonly baseLanguage: string;
  /** `language → pageId → page`. The base language entry is `artifact.pages`. */
  readonly byLanguage: {
    readonly [language: string]: { readonly [pageId: string]: CompiledPage };
  };
}

export function buildPages(input: PagesInput): PagesResult {
  const survey = input.survey;
  const index = indexContent(survey);
  const inline = inlineRules(input, index);
  const languages = artifactLanguages(survey);

  const byLanguage: { [language: string]: { readonly [pageId: string]: CompiledPage } } = {};
  for (const language of languages) {
    const strings = stringResolver(survey, language);
    const pages: { [pageId: string]: CompiledPage } = {};
    // `pageOrder` and not the content tree: these are the pages a respondent can reach. Emitting
    // in flow order also makes a diff of two artifacts read in the order a respondent meets them.
    for (const pageId of input.graph.pageOrder) {
      const page = index.pageById.get(pageId);
      if (page === undefined) continue;
      pages[pageId] = compilePage(page, {
        index,
        strings,
        plugins: input.plugins,
        inline: inline.get(pageId) ?? [],
      });
    }
    byLanguage[language] = pages;
  }

  return { languages, baseLanguage: survey.languages.base, byLanguage };
}

/* ========================================================================== */
/* 1. The page                                                                 */
/* ========================================================================== */

interface PageContext {
  readonly index: ContentIndex;
  readonly strings: StringResolver;
  readonly plugins: PluginResolution;
  readonly inline: readonly CompiledRule[];
}

function compilePage(page: PageNode, ctx: PageContext): CompiledPage {
  const questions: CompiledQuestion[] = [];
  for (const child of page.children) {
    // A `text` node is not a `CompiledQuestion` and the contract has no arm for it: it emits no
    // variables, has no answer to validate, and its copy is a `label` the page shell renders. It
    // is dropped here rather than lowered into a question with a fabricated `question_type`, which
    // would put a control that collects nothing (`CMP-0102`'s subject) into every page.
    if (child.type !== 'question') continue;
    questions.push(compileQuestion(child, ctx));
  }

  return {
    id: page.id,
    ref: page.ref,
    block_path: ctx.index.blockPath.get(page.id) ?? [],
    questions,
    inline_rules: ctx.inline,
    settings: asJsonObject(page.settings),
  };
}

function compileQuestion(question: QuestionNode, ctx: PageContext): CompiledQuestion {
  const options = compileItems(question.options, ctx.strings);
  const rows = compileItems(question.rows, ctx.strings);
  const columns = compileItems(question.columns, ctx.strings);
  const cells = question.cells;
  const emits = question.emits ?? ctx.index.emitsOf.get(question.id) ?? [];

  return {
    id: question.id,
    ref: question.ref,
    // `resolvePlugins`' `id@major` key when the plugin resolved, the authored string when it did
    // not. F §5.3's `"matrix@3"` is the resolved form, and pinning it here is what stops a
    // republished artifact from silently rendering against a newer major.
    question_type: ctx.plugins.keys.get(question.id) ?? question.question_type,
    required: question.required,
    label: ctx.strings.resolve(question.label),
    instruction: ctx.strings.resolve(question.instruction),
    // Required by the contract, so `{}` and not absent. An absent config and an empty one are the
    // same thing to a plugin — `applySchemaDefaults` tops both up identically — and a required
    // field the runtime never has to null-check is worth two bytes.
    config: question.config ?? {},
    ...(options === undefined ? {} : { options }),
    ...(rows === undefined ? {} : { rows }),
    ...(columns === undefined ? {} : { columns }),
    // Passed through: a cell's `control` is a thin reference to a question type plus config, and
    // its labels come from the matrix's own rows and columns, which are already resolved above.
    ...(cells === undefined ? {} : { cells }),
    validation: question.validation ?? [],
    masks: question.masks ?? [],
    emits,
    // Passed through unresolved. The runtime derives the order from `(seed, salt)` per session
    // (E §8, ADR-006), so resolving it here would fix one order for every respondent. Absent stays
    // absent: `undefined` and `{ mode: 'none' }` are the same to the renderer, and a field the
    // artifact does not need is bytes in every page of every survey.
    ...(question.randomize_options === undefined
      ? {}
      : { randomize_options: question.randomize_options }),
    ...(question.randomize_rows === undefined ? {} : { randomize_rows: question.randomize_rows }),
    ...(question.randomize_columns === undefined
      ? {}
      : { randomize_columns: question.randomize_columns }),
  };
}

/**
 * One axis of items, with labels resolved and positions densified. See the header on `position`.
 *
 * `undefined` in, `undefined` out: an axis a question does not declare stays absent rather than
 * becoming `[]`, because "this question has no rows" and "this question's rows were all masked
 * away" are different states and the runtime distinguishes them.
 */
function compileItems(
  items: readonly QuestionItem[] | undefined,
  strings: StringResolver,
): readonly CompiledItem[] | undefined {
  if (items === undefined) return undefined;
  return items.map((item, index) => {
    const { label, ...rest } = item;
    return { ...rest, position: index, label: strings.resolve(label) };
  });
}

/**
 * `PageSettings` → `JsonObject`.
 *
 * An interface has no implicit index signature, so it is not a `JsonValue` even though every one
 * of its fields is — the same gap `registry.ts` and `plugins.ts` both note when building a
 * diagnostic `detail`. The cast asserts that and nothing else; no field is copied, renamed or
 * defaulted, because `PageSettings` is the runtime's contract for a page shell and a compiler that
 * filled in `layout` would be making a rendering decision the author did not.
 */
function asJsonObject(settings: PageNode['settings']): JsonObject {
  return settings === undefined ? {} : (settings as unknown as JsonObject);
}

/* ========================================================================== */
/* 2. The content index                                                        */
/* ========================================================================== */

interface ContentIndex {
  readonly pageById: ReadonlyMap<string, PageNode>;
  readonly blockPath: ReadonlyMap<string, readonly ContentNodeId[]>;
  /** Question id → its page. */
  readonly pageOfQuestion: ReadonlyMap<string, string>;
  /** Question id → the variables it emits, when `QuestionNode.emits` is absent. */
  readonly emitsOf: ReadonlyMap<string, readonly VariableId[]>;
  /** Option / row / column id → the question that declares it. */
  readonly questionOfOption: ReadonlyMap<string, string>;
  /** Variable id → the question that emits it. */
  readonly questionOfVariable: ReadonlyMap<string, string>;
  /** Block id → the single page it contains, when it contains exactly one. */
  readonly pageOfBlock: ReadonlyMap<string, string>;
}

function indexContent(survey: Survey): ContentIndex {
  const pageById = new Map<string, PageNode>();
  const questionOfOption = new Map<string, string>();
  const emitsOf = new Map<string, VariableId[]>();
  const questionOfVariable = new Map<string, string>();
  const pagesOfBlock = new Map<string, Set<string>>();

  const blockPath = blockPathOf(survey);
  for (const node of flattenContent(survey.content)) {
    if (node.type === 'page') {
      pageById.set(node.id, node);
      // Every ancestor block of this page owns it, so a `visible(block)` cell is page-scoped only
      // when the whole subtree is one page. The path is already computed by `flow.ts`.
      for (const blockId of blockPath.get(node.id) ?? []) {
        const pages = pagesOfBlock.get(blockId) ?? new Set<string>();
        pages.add(node.id);
        pagesOfBlock.set(blockId, pages);
      }
      continue;
    }
    if (node.type !== 'question') continue;
    for (const item of [...(node.options ?? []), ...(node.rows ?? []), ...(node.columns ?? [])]) {
      if (!questionOfOption.has(item.id)) questionOfOption.set(item.id, node.id);
    }
  }

  // `QuestionNode.emits` is stored but optional, and `registry.ts`' `fallbackEmits` rebuilds it
  // from `variables[].source.question_id` in registry order — which is the order
  // `buildVariableRegistry` would have written. The same two-step, not a third derivation.
  for (const variable of survey.variables) {
    const questionId = variable.source?.question_id;
    if (questionId === undefined) continue;
    questionOfVariable.set(variable.id, questionId);
    const list = emitsOf.get(questionId) ?? [];
    list.push(variable.id);
    emitsOf.set(questionId, list);
  }

  const pageOfBlock = new Map<string, string>();
  for (const [blockId, pages] of pagesOfBlock) {
    if (pages.size !== 1) continue;
    const only = [...pages][0];
    if (only !== undefined) pageOfBlock.set(blockId, only);
  }

  return {
    pageById,
    blockPath,
    pageOfQuestion: pageOfQuestion(survey),
    emitsOf,
    questionOfOption,
    questionOfVariable,
    pageOfBlock,
  };
}

/* ========================================================================== */
/* 3. inline_rules                                                             */
/* ========================================================================== */

/**
 * `page id → the rules the client may evaluate page-locally`, in `logic.rules` order.
 *
 * The order is `logic.rules`' canonical (`order_key`, then `id`) order, preserved by iterating it
 * — which matters because two inlined rules writing one cell must be applied on the client in the
 * same order the server applies them, and that order is the array's.
 */
function inlineRules(
  input: PagesInput,
  index: ContentIndex,
): ReadonlyMap<string, readonly CompiledRule[]> {
  const logic = input.logic;
  const scopes = pageScopes(input, index);
  const out = new Map<string, CompiledRule[]>();

  for (const rule of logic.rules) {
    const scope = ruleScope(rule, logic, scopes);
    if (scope === undefined) continue;
    const list = out.get(scope) ?? [];
    list.push(compiledRuleOf(rule));
    out.set(scope, list);
  }

  return out;
}

/** The one page a rule writes entirely within, or `undefined`. See `inlineRules`. */
function ruleScope(
  rule: Rule,
  logic: CompiledLogic,
  scopes: readonly (string | undefined)[],
): string | undefined {
  const written = writesOf(rule);
  if (written.length === 0) return undefined;
  let scope: string | undefined;
  for (const cell of written) {
    const cellIndex = logic.graph.indexOf(cellKey(cell));
    const cellScope = cellIndex === undefined ? undefined : scopes[cellIndex];
    if (cellScope === undefined) return undefined;
    if (scope === undefined) scope = cellScope;
    else if (scope !== cellScope) return undefined;
  }
  return scope;
}

/**
 * Cell index → the page every cell it transitively depends on lives on, or `undefined`.
 *
 * One pass in `topo` order. That order is what turns a transitive question into a local one: every
 * input of a cell precedes it, so its scope is already final by the time the cell is reached. A
 * cyclic graph has an empty `topo` (and is `CMP-0800`, a publish blocker), in which case every
 * scope stays `undefined` and nothing is inlined — the honest answer for a program with no
 * evaluation order.
 */
function pageScopes(input: PagesInput, index: ContentIndex): readonly (string | undefined)[] {
  const logic = input.logic;
  const own = logic.cells.map((cell) => cellPage(cell, input, index));
  const scopes = new Array<string | undefined>(logic.cells.length).fill(undefined);
  const inputs = logic.graph.inputs;

  for (const cellIndex of logic.topo) {
    const page = own[cellIndex];
    if (page === undefined) continue;
    let local = true;
    for (const from of inputs[cellIndex] ?? []) {
      if (scopes[from] !== page) {
        local = false;
        break;
      }
    }
    if (local) scopes[cellIndex] = page;
  }
  return scopes;
}

/**
 * The page a cell belongs to, or `undefined` when it belongs to none or to more than one.
 *
 * `undefined` is the answer for a hidden variable (no question, therefore no page), for a block
 * spanning two pages, for a flow node laying out several pages, and for a survey-scoped
 * validation. Each of those is a cell the client cannot compute from one page's state, so
 * `undefined` is what stops the rule that writes it from being inlined.
 */
function cellPage(cell: Cell, input: PagesInput, index: ContentIndex): string | undefined {
  switch (cell.c) {
    case 'value': {
      const questionId = index.questionOfVariable.get(cell.variable_id);
      return questionId === undefined ? undefined : index.pageOfQuestion.get(questionId);
    }
    case 'visible': {
      const nodeId: string = cell.node_id;
      if (index.pageById.has(nodeId)) return nodeId;
      const page = index.pageOfQuestion.get(nodeId);
      return page ?? index.pageOfBlock.get(nodeId);
    }
    case 'items':
      return index.pageOfQuestion.get(cell.question_id);
    case 'opt': {
      const questionId = index.questionOfOption.get(cell.option_id);
      return questionId === undefined ? undefined : index.pageOfQuestion.get(questionId);
    }
    case 'valid':
    case 'terminate':
      return ruleTargetPage(cell.rule_id, input, index);
    case 'flow':
      return pageOfFlowNode(input.graph, cell.node_id);
    default: {
      const never: never = cell;
      throw new Error(`Unhandled cell: ${JSON.stringify(never)}`);
    }
  }
}

/** A `valid`/`terminate` cell is keyed by rule, so its page is its rule's target's page. */
function ruleTargetPage(ruleId: string, input: PagesInput, index: ContentIndex): string | undefined {
  const rule = ruleById(input.logic).get(ruleId);
  if (rule === undefined) return undefined;
  return targetPage(rule, index);
}

function targetPage(rule: Rule, index: ContentIndex): string | undefined {
  const target = rule.target;
  switch (target.type) {
    case 'question':
      return index.pageOfQuestion.get(target.id);
    case 'page':
      return target.id;
    case 'block':
      return index.pageOfBlock.get(target.id);
    case 'option': {
      const questionId = index.questionOfOption.get(target.id);
      return questionId === undefined ? undefined : index.pageOfQuestion.get(questionId);
    }
    case 'variable': {
      const questionId = index.questionOfVariable.get(target.id);
      return questionId === undefined ? undefined : index.pageOfQuestion.get(questionId);
    }
    case 'survey':
      return undefined;
    default: {
      const never: never = target;
      throw new Error(`Unhandled rule target: ${JSON.stringify(never)}`);
    }
  }
}

/**
 * Rule id → rule, memoized per `CompiledLogic`.
 *
 * A `WeakMap` rather than an index built in `buildPages`, because `cellPage` is called once per
 * cell and the map is wanted only when a `valid` or `terminate` cell appears — which on a survey
 * with no validation rules is never.
 */
const ruleIndexCache = new WeakMap<object, ReadonlyMap<string, Rule>>();

function ruleById(logic: CompiledLogic): ReadonlyMap<string, Rule> {
  const cached = ruleIndexCache.get(logic);
  if (cached !== undefined) return cached;
  const built = new Map<string, Rule>();
  for (const rule of logic.rules) built.set(rule.id, rule);
  ruleIndexCache.set(logic, built);
  return built;
}

/** The page a flow node lays out, when it lays out exactly one. */
function pageOfFlowNode(graph: FlowGraph, flowNodeId: string): string | undefined {
  let found: string | undefined;
  for (const [pageId, owner] of graph.pageEntry) {
    if (owner !== flowNodeId) continue;
    if (found !== undefined) return undefined;
    found = pageId;
  }
  return found;
}

/** Exported for the tests: the cell index of a key, so a scope assertion can name a cell. */
export function cellIndexOf(logic: CompiledLogic, key: string): CellIdx | undefined {
  return logic.graph.indexOf(key);
}
