/**
 * `ArtifactLogic` → a runnable `CompiledLogic`. The read side of the format the compiler writes.
 *
 * ## Why this is here and not in `packages/compiler`
 *
 * It was there. `emit/logic.ts`' header explains why: "the runtime is P1-09 and does not exist yet,
 * so nothing consumes `ArtifactLogic` today. That makes a serializer untestable in the only way that
 * matters: losslessness." The runtime now exists, and the placement has become the wrong one — if
 * the deserializer stayed in the compiler, `runtime-core` would have to import `@resscript/compiler`
 * to evaluate logic, which pulls the solver, nine analyses and `node:crypto` into a package that has
 * to load in a browser and in QuickJS. E §1 makes the runtime's dependency tree the single largest
 * lever on cold-start latency; this is the direction that keeps it flat.
 *
 * The round-trip test stays in the compiler, importing from here as a dev dependency, so
 * losslessness is still asserted against the serializer that has to stay in step with it.
 *
 * ## What the artifact carries and what this derives
 *
 * The artifact carries everything that is *not* recomputable: the cell registry, the topological
 * order, the forward and reverse edges, the writer index, the flattened AST, the rules in executable
 * form, and the type-environment views. Eight fields of `CompiledLogic` are then derived here rather
 * than serialized, because each is a pure function of what is already present and shipping it would
 * be a second copy that could disagree:
 *
 *   nodeCount                            `nodes.length`
 *   valueCell/visibleCell/itemsCell/optCell   inverted from `cells`, which carries the tagged union
 *   graph                                the same arrays, in `CellGraph`'s shape
 *   diagnostics                          `[]` — they describe the compile, not the artifact
 *
 * `maskItems` is the ninth and is *not* derivable from the artifact alone: it is a view over the
 * question being rendered, so the caller supplies it. That split is the one P1-08's header already
 * drew, and it is why `toCompiledLogic` takes it as an argument rather than inventing an empty one —
 * an empty `maskItems` would make every per-item mask condition evaluate over nothing, silently.
 */

import type {
  ArtifactLogic,
  ArtifactLogicSchema,
  CompiledRule,
} from '@resscript/schema';
import { BASE_OPTION_DEFAULT, BASE_VISIBLE_DEFAULT } from '@resscript/schema';
import {
  EMPTY_SCHEMA,
  itemsKey,
  optionKey,
  type Cell,
  type CellGraph,
  type CellIdx,
  type CompiledLogic,
  type DomainId,
  type EvalSchema,
  type Expr,
  type GroupItem,
  type MaskAxis,
  type OptProp,
  type QuestionId,
  type Rule,
  type Target,
  type VariableId,
} from '@resscript/logic';

/* ------------------------------------------------------------------ *
 * Rules
 * ------------------------------------------------------------------ */

/**
 * `CompiledRule` → `Rule`.
 *
 * The branded-id casts are the whole difficulty, and they are legitimate here for the reason casts
 * usually are not: this is the JSON parse boundary. A brand is erased by serialization, the ids came
 * from a `Rule` the compiler had already validated, and the artifact is content-addressed — so a
 * tampered id is a different artifact under a different hash, not a bad value inside a good one.
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

  // Conditional spread rather than assigning `undefined`: under `exactOptionalPropertyTypes` an
  // absent optional and one set to `undefined` are different types, and only the absent form
  // round-trips through JSON unchanged.
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

/* ------------------------------------------------------------------ *
 * The type environment
 * ------------------------------------------------------------------ */

/**
 * `ArtifactLogicSchema` → `EvalSchema`.
 *
 * `ownerQuestion` is inverted from `question_variables` rather than read from a second map, so the
 * two cannot disagree: a variable listed under two questions would be a contradiction the artifact
 * could otherwise carry, and inverting makes it unrepresentable.
 */
export function schemaOf(
  artifactSchema: ArtifactLogicSchema | undefined,
  baseVisibleMap: { readonly [nodeId: string]: boolean },
): EvalSchema {
  if (artifactSchema === undefined) {
    // An artifact compiled before the section existed. Every probe answers "nothing", which makes a
    // page-scoped condition evaluate as if the survey had no structure — a republish path, not a
    // supported mode.
    return EMPTY_SCHEMA;
  }

  const owner = new Map<string, string>();
  for (const questionId of Object.keys(artifactSchema.question_variables).sort()) {
    for (const variableId of artifactSchema.question_variables[questionId] ?? []) {
      owner.set(variableId, questionId);
    }
  }

  return {
    labelKey: (domain: DomainId, code: number) =>
      artifactSchema.label_keys[domain]?.[String(code)],
    questionVariables: (id) => (artifactSchema.question_variables[id] ?? []) as never,
    pageQuestions: (id) => (artifactSchema.page_questions[id] ?? []) as never,
    ownerQuestion: (id) => owner.get(id) as never,
    pageOf: (nodeId) => artifactSchema.page_of[nodeId] as never,
    // The same record `baseVisible` reads, with the same sparse default. Two closures over one
    // record, because a disagreement between "visible by default" and "declared visible" is not a
    // distinction the model has.
    declaredVisible: (nodeId) => baseVisibleMap[nodeId] ?? BASE_VISIBLE_DEFAULT,
  };
}

/* ------------------------------------------------------------------ *
 * Rehydration
 * ------------------------------------------------------------------ */

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
  /** Executable rules: `evaluate` needs `Rule`, not the serialized `CompiledRule`. */
  readonly rules: readonly Rule[];
  readonly nodes: readonly Expr[];
  readonly derived: ReadonlyMap<CellIdx, Expr>;
  readonly baseVisible: (nodeId: string) => boolean;
  readonly baseItems: (questionId: QuestionId, axis: MaskAxis) => readonly number[];
  readonly baseOption: (optionId: string, prop: OptProp) => boolean;
  /** Cell key → index, the inverse of `cells`. The runtime's only string-keyed cell lookup. */
  readonly indexOf: (key: string) => CellIdx | undefined;
  readonly schema: EvalSchema;
}

export function rehydrate(artifact: ArtifactLogic): RehydratedLogic {
  const cells = artifact.cells.map((entry) => entry.cell as unknown as Cell);
  const cellKeys = artifact.cells.map((entry) => entry.key);
  const byKey = new Map<string, CellIdx>();
  cellKeys.forEach((key, index) => {
    // First writer wins. Two cells with one key would be a compiler bug, and preferring the earlier
    // index keeps the lookup consistent with `topo`, which is ordered by index.
    if (!byKey.has(key)) byKey.set(key, index);
  });

  const nodes = artifact.nodes.map((node) => node as unknown as Expr);
  const derived = new Map<CellIdx, Expr>();
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
    // encoding is sparse, which is why the constants are imported from `@resscript/schema` — they
    // are the wire contract, shared with the compiler that writes them.
    baseVisible: (nodeId) => baseVisibleMap[nodeId] ?? BASE_VISIBLE_DEFAULT,
    baseItems: (questionId, axis) => baseItemsMap[itemsKey(questionId, axis)] ?? [],
    baseOption: (optionId, prop) =>
      baseOptionMap[optionKey(optionId, prop)] ?? BASE_OPTION_DEFAULT[prop],
    indexOf: (key) => byKey.get(key),
    schema: schemaOf(artifact.schema, baseVisibleMap),
  };
}

/**
 * The cells a serialized rule writes, recovered from the artifact.
 *
 * Reads the `writers` index backwards, which is the authoritative answer: it is what the graph
 * builder recorded, in application order.
 */
export function cellsWrittenBy(logic: RehydratedLogic, ruleIndex: number): readonly CellIdx[] {
  const out: CellIdx[] = [];
  logic.writers.forEach((rules, cellIndex) => {
    if (rules.includes(ruleIndex)) out.push(cellIndex);
  });
  return out;
}

/* ------------------------------------------------------------------ *
 * The last mile: a runnable CompiledLogic
 * ------------------------------------------------------------------ */

/** Where a per-item mask condition gets its items. Supplied per render; see the module header. */
export type MaskItemsFn = (questionId: QuestionId, axis: MaskAxis) => readonly GroupItem[];

/**
 * Complete a `RehydratedLogic` into the `CompiledLogic` that `evaluate()` accepts.
 *
 * The four cell-index maps are inverted from `cells` rather than shipped, because `cells` already
 * carries the tagged union and a second copy could disagree with it. The keys they use are the same
 * ones the compiler's `cellKey` produces, which is why `itemsKey` and `optionKey` are imported from
 * `packages/logic` rather than re-spelled here — one definition of the key shape, or the lookup
 * silently misses.
 */
export function toCompiledLogic(
  logic: RehydratedLogic,
  maskItems: MaskItemsFn,
): CompiledLogic {
  const valueCell = new Map<VariableId, CellIdx>();
  const visibleCell = new Map<string, CellIdx>();
  const itemsCell = new Map<string, CellIdx>();
  const optCell = new Map<string, CellIdx>();

  logic.cells.forEach((cell, index) => {
    switch (cell.c) {
      case 'value':
        valueCell.set(cell.variable_id, index);
        break;
      case 'visible':
        visibleCell.set(cell.node_id, index);
        break;
      case 'items':
        itemsCell.set(itemsKey(cell.question_id, cell.axis), index);
        break;
      case 'opt':
        optCell.set(optionKey(cell.option_id, cell.prop), index);
        break;
      default:
        // `valid`, `flow`, `terminate` and any future arm have no by-key index on `CompiledLogic`;
        // they are reached through `validCells` or through `topo`. Not an error.
        break;
    }
  });

  // `CellGraph` is a superset of what the evaluator walks: it also carries the writer index, the
  // trigger map, the `valid` grouping and the build diagnostics, all of which the artifact already
  // has (or, for diagnostics, deliberately does not — see below).
  const graph: CellGraph = {
    cells: logic.cells,
    keys: logic.cellKeys,
    indexOf: logic.indexOf,
    topo: logic.topo,
    topoPos: logic.topoPos,
    dependents: logic.dependents,
    inputs: logic.inputs,
    writers: logic.writers,
    triggers: logic.triggers,
    validByTarget: logic.validCells,
    diagnostics: [],
  };

  return {
    cells: logic.cells,
    cellKeys: logic.cellKeys,
    topo: logic.topo,
    topoPos: logic.topoPos,
    dependents: logic.dependents,
    writers: logic.writers,
    triggers: logic.triggers,
    rules: logic.rules,
    nodes: logic.nodes,
    // Derived, not shipped: the artifact's `nodes` array is dense with `nodes[i].n === i`, so its
    // length *is* the node count and a serialized copy could only ever disagree.
    nodeCount: logic.nodes.length,
    valueCell,
    visibleCell,
    itemsCell,
    optCell,
    validCells: logic.validCells,
    derived: logic.derived,
    baseVisible: logic.baseVisible,
    baseItems: logic.baseItems,
    baseOption: logic.baseOption,
    maskItems,
    schema: logic.schema,
    graph,
    // Diagnostics describe the compile that produced the artifact, not the artifact. A published
    // artifact has no errors by construction — publish is blocked on them — so an empty list is the
    // accurate answer rather than a placeholder.
    diagnostics: [],
  };
}
