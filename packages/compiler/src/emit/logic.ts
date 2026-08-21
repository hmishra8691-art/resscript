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
 * ## `rehydrate` is here, and it is here on purpose
 *
 * The runtime is P1-09 and does not exist yet, so nothing consumes `ArtifactLogic` today. That
 * makes a serializer untestable in the only way that matters: losslessness. `rehydrate` is the
 * inverse, in the same module so the two cannot drift into separate files with separate ideas of
 * the format, and `logic.test.ts` asserts the round trip over `cells`, `topo`, `dependents`,
 * `writers` and `triggers`. It reconstructs the typed arrays and the maps; it does **not**
 * reconstruct `schema` or `maskItems`, which are views of the type environment rather than
 * compiled state and belong to whatever the runtime builds from a compiled page.
 */

import type { ArtifactLogic, ArtifactLogicCell, CompiledRule, Expr, JsonObject } from '@resscript/schema';
import { flattenContent, type Survey } from '@resscript/schema';
import {
  asQuestionId,
  cellKey,
  itemsKey,
  optionKey,
  type Cell,
  type CellIdx,
  type CompiledLogic,
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
];

/**
 * schema §5.1's literal option defaults: visible and enabled, nothing else.
 *
 * Exported because it is the other half of the sparse encoding — an `optionKey` absent from
 * `base_option` means *this*, and a reader that guesses `false` would render every option hidden.
 * It restates `compileLogic`'s private `defaultOptionState`; the duplication is deliberate, since
 * the alternative is either exporting an internal from `packages/logic` or shipping 300 redundant
 * entries per question to avoid writing five lines.
 */
export const BASE_OPTION_DEFAULT: { readonly [K in OptProp]: boolean } = {
  visible: true,
  enabled: true,
  preselected: false,
  auto_select: false,
  required: false,
};

/** `base_visible`'s default. Absent ⇒ the node is visible. */
export const BASE_VISIBLE_DEFAULT = true;

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
  };
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
 * `CompiledRule` → `Rule`: the inverse, and the reason the fields above are serialized.
 *
 * The branded-id casts are the whole difficulty. An id's brand is erased by JSON, and this is the
 * parse boundary, so re-attaching it is exactly what a cast is for — the ids came from a `Rule` that
 * the compiler had already validated, and the artifact is content-addressed, so a tampered id is a
 * different artifact under a different hash.
 */
export function ruleOf(compiled: CompiledRule): Rule {
  const target =
    compiled.target_type === 'survey'
      ? ({ type: 'survey' } as Target)
      : ({ type: compiled.target_type, id: compiled.target_id } as unknown as Target);

  const base = {
    id: compiled.id as Rule['id'],
    kind: compiled.kind as Rule['kind'],
    target,
    condition: compiled.condition as unknown as Rule['condition'],
    effect: compiled.effect as unknown as Rule['effect'],
    evaluation: compiled.evaluation as Rule['evaluation'],
    authored_in: compiled.authored_in,
    order_key: compiled.order_key,
  };

  // Built by conditional spread rather than by assigning `undefined`: under
  // `exactOptionalPropertyTypes` an absent optional and one set to `undefined` are different types,
  // and only the absent form round-trips through JSON unchanged.
  return {
    ...base,
    ...(compiled.on_unknown === undefined ? {} : { on_unknown: compiled.on_unknown }),
    ...(compiled.priority_group === undefined ? {} : { priority_group: compiled.priority_group }),
    ...(compiled.flow_node_id == null
      ? {}
      : { flow_node_id: compiled.flow_node_id as NonNullable<Rule['flow_node_id']> }),
    ...(compiled.label === undefined ? {} : { label: compiled.label }),
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

/**
 * What a runtime gets back from `ArtifactLogic`.
 *
 * A subset of `CompiledLogic` on purpose: `schema` and `maskItems` are views of the *type
 * environment* rather than compiled state (`buildEvalSchema` reads `env.questions()`), and
 * `diagnostics` belong to the compile that produced the artifact rather than to the artifact.
 * Everything positional is here, because everything positional is what has to survive the trip.
 */
export interface RehydratedLogic {
  readonly cells: readonly Cell[];
  readonly cellKeys: readonly string[];
  readonly topo: Int32Array;
  readonly topoPos: Int32Array;
  readonly dependents: readonly Int32Array[];
  readonly inputs: readonly Int32Array[];
  readonly writers: readonly Int32Array[];
  readonly triggers: ReadonlyMap<VariableId, Int32Array>;
  readonly validCells: ReadonlyMap<string, Int32Array>;
  /** Executable rules, not the serialized form: `evaluate` needs `Rule`, not `CompiledRule`. */
  readonly rules: readonly Rule[];
  readonly nodes: readonly LogicExpr[];
  readonly derived: ReadonlyMap<CellIdx, LogicExpr>;
  readonly baseVisible: (nodeId: string) => boolean;
  readonly baseItems: (questionId: QuestionId, axis: MaskAxis) => readonly number[];
  readonly baseOption: (optionId: string, prop: OptProp) => boolean;
  /** Cell key → index, the inverse of `cells`. The runtime's only string-keyed cell lookup. */
  readonly indexOf: (key: string) => CellIdx | undefined;
}

export function rehydrate(artifact: ArtifactLogic): RehydratedLogic {
  const cells = artifact.cells.map((entry) => entry.cell as unknown as Cell);
  const cellKeys = artifact.cells.map((entry) => entry.key);
  const byKey = new Map<string, CellIdx>();
  cellKeys.forEach((key, index) => {
    if (!byKey.has(key)) byKey.set(key, index);
  });

  const nodes = artifact.nodes.map((node) => node as unknown as LogicExpr);
  const derived = new Map<CellIdx, LogicExpr>();
  for (const [cellIndex, nodeIndex] of Object.entries(artifact.derived)) {
    const node = nodes[nodeIndex];
    if (node !== undefined) derived.set(Number(cellIndex), node);
  }

  const triggers = new Map<VariableId, Int32Array>();
  for (const [variableId, indices] of Object.entries(artifact.by_trigger_variable)) {
    triggers.set(variableId as VariableId, Int32Array.from(indices));
  }
  const validCells = new Map<string, Int32Array>();
  for (const [target, indices] of Object.entries(artifact.valid_by_target)) {
    validCells.set(target, Int32Array.from(indices));
  }

  const baseVisibleMap = artifact.base_visible;
  const baseItemsMap = artifact.base_items;
  const baseOptionMap = artifact.base_option;

  return {
    cells,
    cellKeys,
    topo: Int32Array.from(artifact.topo),
    topoPos: Int32Array.from(artifact.topo_pos),
    dependents: artifact.dependents.map((edges) => Int32Array.from(edges)),
    inputs: artifact.inputs.map((edges) => Int32Array.from(edges)),
    writers: artifact.writers.map((rules) => Int32Array.from(rules)),
    triggers,
    validCells,
    rules: artifact.rules.map(ruleOf),
    nodes,
    derived,
    // The three sparse defaults, applied on the read side. This is the only place that knows the
    // encoding is sparse, which is why the constants above are exported rather than inlined.
    baseVisible: (nodeId) => baseVisibleMap[nodeId] ?? BASE_VISIBLE_DEFAULT,
    baseItems: (questionId, axis) => baseItemsMap[itemsKey(questionId, axis)] ?? [],
    baseOption: (optionId, prop) => baseOptionMap[optionKey(optionId, prop)] ?? BASE_OPTION_DEFAULT[prop],
    indexOf: (key) => byKey.get(key),
  };
}

/**
 * The cells a serialized rule writes, recovered from the artifact.
 *
 * `writesOf` needs a `Rule`, and a `CompiledRule` is not one — the effect is a `JsonObject` and the
 * target is a bare id string. Rather than reconstructing a `Rule` (which would need the branded-id
 * casts and the `Target` arm, neither of which the artifact records) this reads the `writers` index
 * backwards, which is the authoritative answer anyway: it is what the graph builder recorded, in
 * application order. Exported because the round-trip test is the only thing that can currently
 * check `writers` from the *rule* side, and P1-09's trace will want the same lookup.
 */
export function cellsWrittenBy(logic: RehydratedLogic, ruleIndex: number): readonly CellIdx[] {
  const out: CellIdx[] = [];
  logic.writers.forEach((rules, cellIndex) => {
    if (rules.includes(ruleIndex)) out.push(cellIndex);
  });
  return out;
}
