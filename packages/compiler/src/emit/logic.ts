/**
 * `CompiledLogic` → `ArtifactLogic`: the serialization of the cell graph, and its inverse
 * (D §5.2, C §17, ADR-002, roadmap P1-08).
 *
 * ## Why a serializer has to exist at all
 *
 * `compileLogic` returns a structure that is deliberately *not* JSON: `topo`, `topoPos`,
 * `dependents` and `writers` are `Int32Array` (D §10.3 bans per-node `Map` lookups on the
 * steady-state path, so the evaluator walks typed arrays), `triggers` and `validCells` are `Map`,
 * and `baseVisible`, `baseItems`, `baseOption`, `maskItems` and `schema` are **closures** over the
 * type environment. The type environment is built from the authoring variable registry, and
 * ADR-001 forbids the runtime from reading authoring tables — so every closure has to be
 * materialized here, at publish, or the runtime cannot answer the questions they answer.
 *
 * `ArtifactLogic`'s own header states the consequence this file has to preserve: **every index in
 * the structure is positional**, fixed by `rules` being in canonical (`order_key`, then `id`) order
 * and `cells` being sorted by (phase rank, key). Nothing below re-sorts, re-numbers or filters
 * either array. A pass that dropped an "unused" cell would renumber `topo`, `dependents`,
 * `writers`, `by_trigger_variable` and `derived` all at once, and the failure would be a survey
 * evaluating rules in a different order than the one its bytes were reviewed in.
 *
 * ## Absent versus false, per materialized default
 *
 * Three of the closures are dense over key spaces large enough that emitting every entry would
 * dominate the artifact — a 60-option question has 300 `base_option` entries, of which zero are
 * usually interesting. So each is emitted **sparsely against a documented default**, and the
 * defaults are exported constants rather than comments so the runtime can import the same table:
 *
 *  - `base_visible`: absent ⇒ **visible**. Only `false` entries are emitted, which are exactly the
 *    nodes a `show` rule targets (`compileLogic`'s `deriveBaseVisible` flips the base to hidden
 *    for those, so that `IF x THEN SHOW Q12` can hide Q12 when `x` is false) plus anything the
 *    document parked as hidden.
 *  - `base_option`: absent ⇒ `BASE_OPTION_DEFAULT[prop]` — schema §5.1's literal defaults, an
 *    option is visible and enabled and nothing else.
 *  - `base_items`: **fully materialized**, no default. An item list has no natural default: the
 *    empty list and "this question has no `rows` axis" are different, and the second is what an
 *    absent key means. Only axes the question actually has items on get a key.
 *
 * The alternative — emit everything — was rejected for size, and the alternative to *that* —
 * emit `null` for a default — was rejected because a tri-state on the wire is a third case for
 * every reader to get wrong.
 *
 * ## `CompiledRule.condition` is the inlined `Expr`, not an index into `nodes`
 *
 * The contract types it as `Expr` and it is emitted as one. The tempting change is a node index,
 * since CSE has already interned every condition into `nodes` — but it buys much less than it
 * looks like it does. `nodes[i]` reaches its children *by object reference* (`compile.ts`'
 * `CompiledLogic` comment is explicit: "the children here are reached by object reference *and*
 * are present in `nodes` at their own index"), so `stableStringify(nodes)` already writes every
 * node's full subtree at every index it appears in. The sharing CSE achieves is a property of the
 * in-memory graph and of the memo table, not of the bytes. Against that, an index would fork
 * `CompiledRule.condition` away from the `Expr` the evaluator accepts, forcing every reader — the
 * trace, the runtime, a debugging tool printing one rule — to carry `nodes` alongside a rule in
 * order to know what it says. Contract kept, condition inlined.
 *
 * ## `rehydrate` used to be here, and has moved
 *
 * It was here because "the runtime is P1-09 and does not exist yet", which made the serializer
 * untestable in the only way that matters: losslessness. The runtime now exists, and keeping the
 * deserializer here would force `packages/runtime-core` to import this package in order to evaluate
 * logic — pulling the solver, nine analyses and `node:crypto` into a package that has to load in a
 * browser and in QuickJS. E §1 makes the runtime's dependency tree the largest lever on cold-start
 * latency, so it lives in `packages/runtime-core/src/artifact-logic.ts` now.
 *
 * `logic.test.ts` still asserts the round trip, importing `rehydrate` from there as a dev
 * dependency, so the two halves of the format cannot drift apart unnoticed. The sparse-encoding
 * defaults moved further still — to `@resscript/schema`, next to `ArtifactLogic` — because they are
 * the wire contract rather than either side's implementation.
 */

import type {
  ArtifactLogic,
  ArtifactLogicCell,
  ArtifactLogicSchema,
  CompiledRule,
  Expr,
  JsonObject,
} from '@resscript/schema';
import {
  BASE_OPTION_DEFAULT,
  BASE_VISIBLE_DEFAULT,
  flattenContent,
  type Survey,
} from '@resscript/schema';
import { pageOfQuestion, blockPathOf } from '../flow.js';
import {
  asQuestionId,
  cellKey,
  itemsKey,
  optionKey,
  EMPTY_SCHEMA,
  type Cell,
  type CellIdx,
  type CompiledLogic,
  type DomainId,
  type EvalSchema,
  type Expr as LogicExpr,
  type MaskAxis,
  type OptProp,
  type QuestionId,
  type Rule,
  type Target,
  type VariableId,
} from '@resscript/logic';

/* ========================================================================== */
/* 1. The key spaces and their defaults                                        */
/* ========================================================================== */

/** The three mask axes, in the order `QuestionNode` declares them. */
export const MASK_AXES: readonly MaskAxis[] = ['options', 'rows', 'columns'];

/**
 * Every option property that has a cell, in the order `OptProp` declares them.
 *
 * A local constant because `packages/logic` exports the *type* and not a value list — and a value
 * list is what materializing `base_option` needs. Written out rather than derived so that a new
 * property on either side is a visible edit here.
 */
export const OPT_PROPS: readonly OptProp[] = [
  'visible',
  'enabled',
  'preselected',
  'auto_select',
  'required',
  'prioritized',
  'deprioritized',
];

// `BASE_OPTION_DEFAULT` and `BASE_VISIBLE_DEFAULT` are imported from `@resscript/schema`. The sparse
// encoding's defaults are the wire contract — shared with the reader that restores them — not a
// property of this emitter, and a second copy here could disagree with the one the runtime reads.

/* ========================================================================== */
/* 2. Serialization                                                            */
/* ========================================================================== */

export interface EmitLogicInput {
  /** The document, for the key spaces the closures have to be materialized over. */
  readonly survey: Survey;
  readonly logic: CompiledLogic;
}

export function buildArtifactLogic(input: EmitLogicInput): ArtifactLogic {
  const logic = input.logic;
  const space = keySpace(input.survey);

  return {
    cells: logic.cells.map((cell, index) => serializeCell(cell, logic.cellKeys[index] ?? cellKey(cell))),
    topo: [...logic.topo],
    topo_pos: [...logic.topoPos],
    dependents: logic.dependents.map((edges) => [...edges]),
    // `inputs` is on the `CellGraph` and not on `CompiledLogic` — the evaluator propagates
    // forwards and never needs the reverse edges, while the trace and a cycle explanation do.
    inputs: logic.graph.inputs.map((edges) => [...edges]),
    writers: logic.writers.map((rules) => [...rules]),
    by_trigger_variable: sortedRecord(logic.triggers, (indices) => [...indices]),
    valid_by_target: sortedRecord(logic.validCells, (indices) => [...indices]),
    rules: logic.rules.map(compiledRuleOf),
    nodes: logic.nodes.map(asSchemaExpr),
    base_visible: baseVisible(logic, space),
    base_items: baseItems(logic, space),
    base_option: baseOption(logic, space),
    derived: derivedIndex(logic.derived),
    schema: buildLogicSchema(input.survey),
  };
}

/* ========================================================================== */
/* 2b. The type-environment views (EvalSchema)                                 */
/* ========================================================================== */

/**
 * Materialize the closures `EvalSchema` is made of.
 *
 * These are views of the authoring type environment, and ADR-001 forbids the runtime from reading
 * authoring tables — so they have to be emitted here or the runtime cannot build an `EvalSchema`,
 * and without one `evaluate()` cannot be called at all.
 *
 * Every map is cross-page on purpose: a rule on page 5 can ask `SHOWN(Q2r3)` or `ASKED(Q2)`, so the
 * answer is not in the page being rendered. Deriving them from compiled pages would mean reading all
 * of them, which is the per-page cost C §17 forbids.
 *
 * Derived from the `Survey` rather than from `CompiledLogic`, because that is where the content tree
 * and the variable sources are. `emit/pages.ts`' `indexContent` computes the same three maps for its
 * own use; both follow `registry.ts`' `fallbackEmits` in reading `variables[].source.question_id`
 * rather than `QuestionNode.emits`, which is stored but optional — one derivation, not a second.
 */
export function buildLogicSchema(survey: Survey): ArtifactLogicSchema {
  const questionVariables = new Map<string, string[]>();
  for (const variable of survey.variables) {
    const questionId = variable.source?.question_id;
    if (questionId === undefined) continue;
    const list = questionVariables.get(questionId) ?? [];
    list.push(variable.id);
    questionVariables.set(questionId, list);
  }

  const pageQuestions = new Map<string, string[]>();
  const pageOf = new Map<string, string>();
  const pagesOfBlock = new Map<string, Set<string>>();
  const blockPath = blockPathOf(survey);

  for (const node of flattenContent(survey.content)) {
    if (node.type !== 'page') continue;
    pageQuestions.set(
      node.id,
      node.children.filter((child) => child.type === 'question').map((child) => child.id),
    );
    for (const blockId of blockPath.get(node.id) ?? []) {
      const pages = pagesOfBlock.get(blockId) ?? new Set<string>();
      pages.add(node.id);
      pagesOfBlock.set(blockId, pages);
    }
  }

  for (const [questionId, pageId] of pageOfQuestion(survey)) pageOf.set(questionId, pageId);
  for (const [blockId, pages] of pagesOfBlock) {
    // A block spanning several pages has no single answer, so it is absent rather than pointing at
    // an arbitrary one. `pageOf` returning the wrong page would make `ASKED(block)` answer about a
    // page the respondent may not have reached.
    if (pages.size !== 1) continue;
    const only = [...pages][0];
    if (only !== undefined) pageOf.set(blockId, only);
  }

  const labelKeys: { [domainId: string]: { [code: string]: string } } = {};
  for (const variable of survey.variables) {
    const domainId = `dom_${variable.source?.question_id ?? variable.id}`;
    for (const entry of variable.enum_domain ?? []) {
      const byCode = labelKeys[domainId] ?? {};
      // First writer wins: two variables sharing a domain must agree on a code's label, and the
      // compiler already refuses to merge two questions' identical domains (`CMP-0701`).
      if (byCode[String(entry.code)] === undefined) byCode[String(entry.code)] = entry.label_key;
      labelKeys[domainId] = byCode;
    }
  }

  return {
    question_variables: sortedObject(questionVariables),
    page_questions: sortedObject(pageQuestions),
    page_of: sortedObject(new Map([...pageOf].map(([k, v]) => [k, v] as const))),
    label_keys: Object.fromEntries(
      Object.keys(labelKeys)
        .sort()
        .map((domainId) => [
          domainId,
          Object.fromEntries(
            Object.keys(labelKeys[domainId] ?? {})
              .sort()
              .map((code) => [code, labelKeys[domainId]?.[code] ?? '']),
          ),
        ]),
    ),
  };
}

/**
 * `Map` → object with keys in code-point order.
 *
 * The same argument as `sortedRecord`: this record is also the in-memory `artifact.logic`, and an
 * insertion-ordered object there would make an in-memory comparison disagree with a byte one.
 */
function sortedObject<V>(source: ReadonlyMap<string, V>): { readonly [key: string]: V } {
  const out: { [key: string]: V } = {};
  for (const key of [...source.keys()].sort()) {
    const value = source.get(key);
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function serializeCell(cell: Cell, key: string): ArtifactLogicCell {
  return {
    key,
    kind: cell.c,
    // The tagged union verbatim, so the runtime rehydrates without parsing the key — which is
    // what `ArtifactLogicCell`'s comment asks for. A `Cell` is an interface-free union of plain
    // records whose fields are all strings, so it *is* a `JsonObject`; the cast asserts the one
    // thing the type system will not, that a union of records has an index signature.
    cell: cell as unknown as JsonObject,
  };
}

/**
 * One `Rule` → one `CompiledRule`, losslessly.
 *
 * It was not lossless before: `target.type`, `evaluation`, `authored_in`, `order_key`,
 * `on_unknown`, `priority_group`, `flow_node_id` and `label` were all dropped, so the serialized
 * rules could not be evaluated and `rehydrate` could not produce a `CompiledLogic`. C §17 claims the
 * artifact is self-contained; it was not.
 *
 * `target_id` is absent for a survey-scoped rule rather than `null`. The contract admits both and
 * they mean the same thing, and the absent form is the one that does not put a key in every stored
 * artifact for the arm of `Target` that carries no id. Each optional field follows the same rule, so
 * adding them costs bytes only on the rules that use them.
 *
 * Exported because `pages.ts` emits the same shape into `CompiledPage.inline_rules`, and a page
 * whose inlined copy of a rule differed from `logic.rules`' copy would be a rule the client and
 * the server evaluate differently — which is the divergence ADR-004 exists to make impossible.
 */
export function compiledRuleOf(rule: Rule): CompiledRule {
  const targetId = rule.target.type === 'survey' ? undefined : rule.target.id;
  return {
    id: rule.id,
    kind: rule.kind,
    condition: asSchemaExpr(rule.condition),
    // `Effect` is a discriminated union of plain JSON records (its `Expr`-valued fields are
    // themselves JSON), so the cast is the same assertion `serializeCell` makes: a union of
    // records has no implicit index signature even when every member is JSON-shaped.
    effect: rule.effect as unknown as JsonObject,
    target_type: rule.target.type,
    ...(targetId === undefined ? {} : { target_id: targetId }),
    evaluation: rule.evaluation,
    authored_in: rule.authored_in,
    order_key: rule.order_key,
    ...(rule.on_unknown === undefined ? {} : { on_unknown: rule.on_unknown }),
    ...(rule.priority_group === undefined ? {} : { priority_group: rule.priority_group }),
    ...(rule.flow_node_id === undefined ? {} : { flow_node_id: rule.flow_node_id }),
    ...(rule.label === undefined ? {} : { label: rule.label }),
  };
}


/**
 * `Map` → object with keys in code-point order.
 *
 * The sort is not cosmetic even though `stableStringify` sorts keys on the way out: this record is
 * also the in-memory `artifact.logic`, which tests and the studio preview read directly, and an
 * insertion-ordered object there would make an in-memory comparison disagree with a byte
 * comparison. One order, both places.
 */
function sortedRecord<K extends string, V, O>(
  source: ReadonlyMap<K, V>,
  map: (value: V) => O,
): { readonly [key: string]: O } {
  const out: { [key: string]: O } = {};
  for (const key of [...source.keys()].sort()) {
    const value = source.get(key);
    if (value !== undefined) out[key] = map(value);
  }
  return out;
}

/** `Map<CellIdx, Expr>` → `{ [cellIndex]: nodeIndex }`. See the header on why an index here. */
function derivedIndex(derived: ReadonlyMap<CellIdx, LogicExpr>): { readonly [cellIndex: string]: number } {
  const out: { [cellIndex: string]: number } = {};
  for (const index of [...derived.keys()].sort((a, b) => a - b)) {
    const expr = derived.get(index);
    if (expr !== undefined) out[String(index)] = expr.n;
  }
  return out;
}

/* ========================================================================== */
/* 3. Materializing the closures                                               */
/* ========================================================================== */

/**
 * The key spaces the three `base_*` closures have to be called over.
 *
 * One walk of `content`, because all three want it and a second walk is a second chance to
 * disagree about which nodes exist. `flattenContent` gives document order, which is the order the
 * emitted records are built in — irrelevant to the bytes (`stableStringify` sorts) and relevant to
 * reading a diff of two artifacts.
 */
interface KeySpace {
  /** Every content node whose visibility is a cell: question, page, block. */
  readonly visibleNodes: readonly string[];
  /** Question id → the axes it declares items on. */
  readonly axes: readonly { readonly questionId: QuestionId; readonly axis: MaskAxis }[];
  /** Every option, row and column id, across every question. */
  readonly optionIds: readonly string[];
}

function keySpace(survey: Survey): KeySpace {
  const visibleNodes: string[] = [];
  const axes: { questionId: QuestionId; axis: MaskAxis }[] = [];
  const optionIds: string[] = [];

  for (const node of flattenContent(survey.content)) {
    switch (node.type) {
      case 'block':
      case 'page':
        visibleNodes.push(node.id);
        break;
      case 'question': {
        visibleNodes.push(node.id);
        const questionId = asQuestionId(node.id);
        const byAxis: { readonly [K in MaskAxis]: readonly { readonly id: string }[] } = {
          options: node.options ?? [],
          rows: node.rows ?? [],
          columns: node.columns ?? [],
        };
        for (const axis of MASK_AXES) {
          const items = byAxis[axis];
          if (items.length === 0) continue;
          axes.push({ questionId, axis });
          for (const item of items) optionIds.push(item.id);
        }
        break;
      }
      case 'text':
        // A text node has no visibility cell: `Cell` keys `visible` by question, page or block
        // (schema's own comment says a text node "emits no variables and is not referenceable
        // from logic"), so a rule cannot target one and there is nothing to materialize.
        break;
      default: {
        const never: never = node;
        throw new Error(`Unhandled content node: ${JSON.stringify(never)}`);
      }
    }
  }

  return { visibleNodes, axes, optionIds };
}

/**
 * `base_visible`, sparse: only the nodes whose base is *not* `BASE_VISIBLE_DEFAULT`.
 *
 * The rule set is also consulted, not just the content tree. A `show`/`hide` rule can name a node
 * the walk above missed — a block id that resolves to nothing, a question deleted from `content`
 * while its rule survived — and `compileLogic`'s `deriveBaseVisible` will have flipped that node's
 * base to hidden. Omitting it would make the artifact disagree with the compiled program about a
 * cell that exists in `cells`. The document's own nodes are the interesting half; this is the
 * completeness half.
 */
function baseVisible(logic: CompiledLogic, space: KeySpace): { readonly [nodeId: string]: boolean } {
  const ids = new Set<string>(space.visibleNodes);
  for (const cell of logic.cells) {
    if (cell.c === 'visible') ids.add(cell.node_id);
  }

  const out: { [nodeId: string]: boolean } = {};
  for (const id of [...ids].sort()) {
    const value = logic.baseVisible(id);
    if (value !== BASE_VISIBLE_DEFAULT) out[id] = value;
  }
  return out;
}

/** `base_items`, fully materialized over the axes a question declares items on. */
function baseItems(
  logic: CompiledLogic,
  space: KeySpace,
): { readonly [questionAxis: string]: readonly number[] } {
  const out: { [questionAxis: string]: readonly number[] } = {};
  for (const entry of space.axes) {
    out[itemsKey(entry.questionId, entry.axis)] = [...logic.baseItems(entry.questionId, entry.axis)];
  }
  return out;
}

/** `base_option`, sparse against `BASE_OPTION_DEFAULT`. */
function baseOption(
  logic: CompiledLogic,
  space: KeySpace,
): { readonly [optionProp: string]: boolean } {
  const out: { [optionProp: string]: boolean } = {};
  for (const optionId of space.optionIds) {
    for (const prop of OPT_PROPS) {
      const value = logic.baseOption(optionId, prop);
      if (value !== BASE_OPTION_DEFAULT[prop]) out[optionKey(optionId, prop)] = value;
    }
  }
  return out;
}

/**
 * Schema carries the AST opaquely (`{ op: string, …JSON }`) and `packages/logic` owns the union.
 * Same cast, same reasoning, as `registry.ts` and `rules.ts` make in the other direction.
 */
function asSchemaExpr(expr: LogicExpr): Expr {
  return expr as unknown as Expr;
}

/* ========================================================================== */
/* 4. Rehydration — the inverse, and the only proof the above is lossless      */
/* ========================================================================== */

