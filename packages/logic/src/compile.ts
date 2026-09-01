/**
 * The compile-time half of the engine — D §5.2, §10.1.
 *
 * Everything expensive happens here, once, at publish: typecheck, group resolution, common
 * subexpression elimination, AST flattening, the cell graph, the topological order and the
 * trigger index. The runtime then does no graph work at all: it walks arrays that arrived in one
 * JSON parse. **This is the mechanism that makes ADR-004's "same verdict in both environments" a
 * structural property rather than a hope** — the ordering ships in the artifact instead of being
 * recomputed on each side.
 *
 * One decision here is not in D and is worth stating: `compileLogic` **sorts the rules into
 * canonical order (`order_key`, then `id`) before doing anything else.** D §4.4 only requires
 * that ordering as a topological tie-break, which is enough to make *verdicts*
 * insertion-order-independent. Sorting up front makes the whole compiled artifact
 * insertion-order-independent — node ids, cell indices, `topo`, every index — which is what
 * turns the acceptance criterion ("identical verdicts under 1,000 randomized rule orderings")
 * into an assertion on bytes rather than on behaviour, and what makes ADR-002's content
 * addressing stable: the same authoring model must hash to the same artifact whatever order the
 * rows came back from Postgres in.
 */

import type { Expr, Group, GroupItem, LiteralValue } from './ast.js';
import { childrenOf, mapChildren } from './ast.js';
import { checkExpr, checkRule } from './check.js';
import type { LgcDiagnostic } from './diagnostics.js';
import { hasErrors, sortDiagnostics } from './diagnostics.js';
import type { EvalSchema } from './evaluator.js';
import type { CellGraph } from './graph.js';
import { buildCellGraph } from './graph.js';
import type { CellIdx, DomainId, PageId, QuestionId, VariableId } from './ids.js';
import { LogicInvariant } from './ids.js';
import { optimizeExpr } from './optimize.js';
import type { TypeEnv } from './registry.js';
import type { Cell, MaskAxis, OptProp, Rule } from './rules.js';

/**
 * The runtime's whole input, D §5.2's `CompiledLogic` with the indexes the evaluator needs.
 *
 * `nodes` is the flattened AST: `nodes[i].n === i`, densely numbered across the entire program
 * after CSE, so the memo table (D §5.4) is a typed array indexed by node id. D §5.2 describes the
 * flattening as "children referenced by index"; the children here are reached by object reference
 * *and* are present in `nodes` at their own index. Rewriting them to integer references would
 * fork the AST into a second representation that the checker, the printer and the builder would
 * all have to learn — for no gain, because the memo table only needs the dense `n`.
 */
export interface CompiledLogic {
  readonly cells: readonly Cell[];
  readonly cellKeys: readonly string[];
  readonly topo: Int32Array;
  readonly topoPos: Int32Array;
  readonly dependents: readonly Int32Array[];
  readonly writers: readonly Int32Array[];
  readonly triggers: ReadonlyMap<VariableId, Int32Array>;
  readonly rules: readonly Rule[];
  readonly nodes: readonly Expr[];
  readonly nodeCount: number;

  /* ---- indexes into `cells`, so the evaluator never builds a key string ---- */
  readonly valueCell: ReadonlyMap<VariableId, CellIdx>;
  readonly visibleCell: ReadonlyMap<string, CellIdx>;
  readonly itemsCell: ReadonlyMap<string, CellIdx>;
  readonly optCell: ReadonlyMap<string, CellIdx>;
  readonly validCells: ReadonlyMap<string, Int32Array>;

  /* ---- authored defaults, resolved once ---------------------------------- */
  /** A `derived` variable's own expression — the writer of its `value` cell (schema §4). */
  readonly derived: ReadonlyMap<CellIdx, Expr>;
  readonly baseVisible: (nodeId: string) => boolean;
  readonly baseItems: (questionId: QuestionId, axis: MaskAxis) => readonly number[];
  readonly baseOption: (optionId: string, prop: OptProp) => boolean;
  readonly maskItems: (questionId: QuestionId, axis: MaskAxis) => readonly GroupItem[];

  readonly schema: EvalSchema;
  readonly graph: CellGraph;
  readonly diagnostics: readonly LgcDiagnostic[];
}

export interface CompileOptions {
  readonly path?: string;
  /**
   * Nodes whose visibility default is not "visible". Everything absent is visible unless a
   * `show` rule targets it, in which case the base flips to hidden — see `deriveBaseVisible`.
   */
  readonly declaredVisible?: { readonly [nodeId: string]: boolean };
  /** Authored option-property defaults (schema §5.1), by `optionKey(option_id, prop)`. */
  readonly optionDefaults?: { readonly [key: string]: boolean };
  /**
   * Run the optimizer pass (`optimize.ts`: constant-fold, flatten and reorder `and`/`or`) before
   * CSE. Defaults to `true`. The one legitimate reason to pass `false` is the roadmap P2-01 accept
   * line itself — proving the optimizer never changes a verdict means compiling the identical
   * rule set both ways and diffing `evaluate`'s output, which needs an optimizer-off code path to
   * diff against. Nothing in `apps/studio` or `apps/worker` should ever pass `false`.
   */
  readonly optimize?: boolean;
}

export function optionKey(optionId: string, prop: OptProp): string {
  return `${optionId}.${prop}`;
}

export function itemsKey(questionId: QuestionId, axis: MaskAxis): string {
  return `${questionId}.${axis}`;
}

export function compileLogic(
  inputRules: readonly Rule[],
  env: TypeEnv,
  options: CompileOptions = {},
): CompiledLogic {
  const path = options.path ?? '';
  const diagnostics: LgcDiagnostic[] = [];

  // Canonical rule order, before anything derives an index from it. See the file header.
  const ordered = [...inputRules].sort((a, b) =>
    a.order_key !== b.order_key ? a.order_key - b.order_key : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );

  /* ---- 1. typecheck, which also resolves aggregation groups -------------- */

  const typed: Rule[] = ordered.map((rule, i) => {
    const checked = checkRule(rule, env, { path: `${path}/rules/${String(i)}` });
    diagnostics.push(...checked.diagnostics);
    return checked.rule;
  });

  const derivedExprs = new Map<VariableId, Expr>();
  for (const decl of env.variables()) {
    if (decl.kind !== 'derived' || decl.expression === undefined) continue;
    const checked = checkExpr(decl.expression, env, { path: `${path}/variables/${decl.id}/expression` });
    diagnostics.push(...checked.diagnostics);
    derivedExprs.set(decl.id, checked.expr);
  }

  /* ---- 2. the optimizer (D §10.1; optimize.ts), then CSE + flattening --- */

  // Optimizing before CSE, not after: folding `S1 = 1 AND TRUE` down to `S1 = 1` is what lets CSE
  // discover it is the *same* condition as a `S1 = 1` written elsewhere — see optimize.ts's file
  // header. `options.optimize === false` exists solely so a caller can compile the identical rule
  // set both ways and diff the verdicts (the roadmap's own acceptance test for this milestone).
  const optimize = options.optimize ?? true;
  const optimized: Rule[] = optimize ? typed.map((rule) => optimizeRule(rule)) : typed;
  const optimizedDerived = optimize
    ? new Map([...derivedExprs].map(([id, expr]) => [id, optimizeExpr(expr)] as const))
    : derivedExprs;

  const interner = createInterner();
  const cseRules: Rule[] = optimized.map((rule) => internRule(rule, interner));
  const cseDerived = new Map<VariableId, Expr>();
  for (const [id, expr] of optimizedDerived) cseDerived.set(id, interner.intern(expr));
  const nodes = interner.nodes();

  /* ---- 3. the cell graph ------------------------------------------------- */

  // Built from the optimized tree, which is why `LGC-CYCLE`/`LGC-CONFLICT` are diagnostics about
  // the rules that can actually fire rather than about every edge an author happened to type. The
  // one shape this can hide: a variable read that lives inside an operand `and`/`or` absorption
  // discards outright (an author-written `AND FALSE` sibling of a real condition — the same class
  // of leftover-from-debugging pattern `LGC-W030` already exists to catch at the top level) drops
  // that operand's dependency edges along with it. optimize.test.ts documents this by name; it is
  // accepted rather than solved by diagnosing on a second, unoptimized graph build, because a var
  // read cannot disappear from the optimized tree any other way — `isStateFree` guarantees a
  // subtree containing one is never itself folded away, only ever discarded as an absorbed
  // sibling of a literal that makes the *whole* `and`/`or` constant.
  const envWithDerived = withDerivedExpressions(env, cseDerived);
  const graph = buildCellGraph(cseRules, envWithDerived, { path });
  diagnostics.push(...graph.diagnostics);

  /* ---- 4. indexes and defaults ----------------------------------------- */

  const valueCell = new Map<VariableId, CellIdx>();
  const visibleCell = new Map<string, CellIdx>();
  const itemsCellIndex = new Map<string, CellIdx>();
  const optCell = new Map<string, CellIdx>();
  graph.cells.forEach((cell, i) => {
    switch (cell.c) {
      case 'value':
        valueCell.set(cell.variable_id, i);
        break;
      case 'visible':
        visibleCell.set(cell.node_id, i);
        break;
      case 'items':
        itemsCellIndex.set(itemsKey(cell.question_id, cell.axis), i);
        break;
      case 'opt':
        optCell.set(optionKey(cell.option_id, cell.prop), i);
        break;
      case 'valid':
      case 'terminate':
      case 'flow':
        break;
      default: {
        const never: never = cell;
        throw new LogicInvariant(`unhandled cell ${JSON.stringify(never)}`);
      }
    }
  });

  const derived = new Map<CellIdx, Expr>();
  for (const [id, expr] of cseDerived) {
    const index = valueCell.get(id);
    if (index !== undefined) derived.set(index, expr);
  }

  const baseVisible = deriveBaseVisible(cseRules, options.declaredVisible ?? {});
  const optionDefaults = options.optionDefaults ?? {};

  // Item lists are resolved once per axis, here, rather than on each `items` cell recompute.
  // D §10.3 bans allocation on the steady-state path, and `axisItems` builds one object per item —
  // which on a 60-option question inside a per-keystroke mask recompute is the whole budget.
  const itemsByAxis = new Map<string, readonly GroupItem[]>();
  const codesByAxis = new Map<string, readonly number[]>();
  for (const cell of graph.cells) {
    if (cell.c !== 'items') continue;
    const key = itemsKey(cell.question_id, cell.axis);
    if (itemsByAxis.has(key)) continue;
    const items = axisItems(env, cell.question_id, cell.axis);
    itemsByAxis.set(key, items);
    codesByAxis.set(
      key,
      items.map((item) => item.code).filter((code): code is number => code !== undefined),
    );
  }
  const resolveItems = (questionId: QuestionId, axis: MaskAxis): readonly GroupItem[] => {
    const key = itemsKey(questionId, axis);
    return itemsByAxis.get(key) ?? axisItems(env, questionId, axis);
  };

  return {
    cells: graph.cells,
    cellKeys: graph.keys,
    topo: graph.topo,
    topoPos: graph.topoPos,
    dependents: graph.dependents,
    writers: graph.writers,
    triggers: graph.triggers,
    rules: cseRules,
    nodes,
    nodeCount: nodes.length,
    valueCell,
    visibleCell,
    itemsCell: itemsCellIndex,
    optCell,
    validCells: graph.validByTarget,
    derived,
    baseVisible,
    baseItems: (questionId, axis) =>
      codesByAxis.get(itemsKey(questionId, axis)) ??
      resolveItems(questionId, axis)
        .map((item) => item.code)
        .filter((code): code is number => code !== undefined),
    baseOption: (optionId, prop) => optionDefaults[optionKey(optionId, prop)] ?? defaultOptionState(prop),
    maskItems: resolveItems,
    schema: buildEvalSchema(env),
    graph,
    diagnostics: sortDiagnostics(diagnostics),
  };
}

export function compileFailed(logic: CompiledLogic): boolean {
  return hasErrors(logic.diagnostics);
}

/* ========================================================================== */
/* CSE (D §5.4)                                                               */
/* ========================================================================== */

/**
 * Common subexpression elimination by hash-consing.
 *
 * Shared subexpressions are extremely common in real surveys: a screener condition like
 * `S1 = 1 AND AGE >= 18` appears in forty rules. CSE rewrites every duplicate subtree to one
 * node index, and the memo table (D §5.4) then evaluates it once per epoch regardless of how many
 * rules reference it. D §5.4 records the measurement on a real 640-rule tracker: 4,900 distinct
 * nodes down to 1,700.
 *
 * The structural key is computed bottom-up from the operator, its discriminants, and the
 * *already-interned* child ids, so two subtrees hash together exactly when they are structurally
 * equal — the same relation `exprEq` defines, computed once instead of pairwise.
 */
export interface Interner {
  readonly intern: (expr: Expr) => Expr;
  readonly nodes: () => readonly Expr[];
}

export function createInterner(): Interner {
  const nodes: Expr[] = [];
  const byKey = new Map<string, Expr>();

  const intern = (expr: Expr): Expr => {
    const rebuilt = mapChildren(expr, intern);
    const key = structuralKey(rebuilt);
    const hit = byKey.get(key);
    if (hit !== undefined) return hit;
    const interned = { ...rebuilt, n: nodes.length } as Expr;
    nodes.push(interned);
    byKey.set(key, interned);
    return interned;
  };

  return { intern, nodes: () => nodes };
}

/** Apply `optimizeExpr` to every expression a rule carries — the same set `internRule` interns. */
function optimizeRule(rule: Rule): Rule {
  const condition = optimizeExpr(rule.condition);
  const effect = rule.effect;
  switch (effect.action) {
    case 'mask':
      return { ...rule, condition, effect: { ...effect, per_item: optimizeExpr(effect.per_item) } };
    case 'set':
    case 'option_state':
      return { ...rule, condition, effect: { ...effect, value: optimizeExpr(effect.value) } };
    default:
      return { ...rule, condition };
  }
}

function internRule(rule: Rule, interner: Interner): Rule {
  const condition = interner.intern(rule.condition);
  const effect = rule.effect;
  switch (effect.action) {
    case 'mask':
      return { ...rule, condition, effect: { ...effect, per_item: interner.intern(effect.per_item) } };
    case 'set':
    case 'option_state':
      return { ...rule, condition, effect: { ...effect, value: interner.intern(effect.value) } };
    default:
      return { ...rule, condition };
  }
}

function structuralKey(e: Expr): string {
  const kids = childrenOf(e)
    .map((child) => String(child.n))
    .join(',');
  return `${e.op}|${discriminant(e)}|${kids}`;
}

function discriminant(e: Expr): string {
  switch (e.op) {
    case 'lit':
      return literalKey(e.v);
    case 'var':
      return e.var;
    case 'probe':
      return `${e.kind}:${e.target.kind}:${e.target.id}`;
    case 'item':
      return '';
    case 'item_attr':
      return `${e.attr}:${e.meta_key ?? ''}`;
    case 'agg':
      // `resolved` is a function of `over` plus the registry, so keying on `over` is enough and
      // keeps two aggregations that resolved in different compiles from failing to share.
      return `${e.fn}:${e.nulls ?? 'skip'}:${groupKey(e.over)}:${e.where === undefined ? '-' : 'w'}:${e.select === undefined ? '-' : 's'}`;
    case 'matches':
      // JSON-joined rather than concatenated: a delimiter that cannot appear in either half
      // is the difference between sharing two distinct regexes and not.
      return JSON.stringify([e.pattern, e.flags ?? '']);
    case 'date_diff':
    case 'date_add':
    case 'date_trunc':
      return e.unit;
    case 'date_part':
      return e.part;
    case 'cast':
      return `${e.to}:${e.on_fail}`;
    case 'label_of':
      return e.form ?? 'short';
    case 'case':
      return String(e.cases.length);
    default:
      return '';
  }
}

/**
 * A literal's structural key, by explicit case rather than by `JSON.stringify`.
 *
 * `JSON.stringify` walks own-property insertion order, so `{"k":"bool","v":true}` and
 * `{"v":true,"k":"bool"}` — the same literal, differently spelled — produce different keys, the
 * interner declines to share them, and the node count changes. That is invisible until it isn't:
 * node ids are indices into the flattened AST the artifact carries, so a re-spelled literal
 * shifts every id after it and the artifact hash moves for a survey nobody edited. P1-08's
 * content addressing (ADR-002) rests on the hash being a function of meaning, so the key has to
 * be too.
 *
 * In practice `content.logic_rules.condition` is `jsonb`, which Postgres normalizes, so the
 * defect only surfaces for a document parsed from hand-written JSON — an imported questionnaire,
 * a fixture, a survey round-tripped through a formatter. Exactly the paths that get blamed on
 * something else.
 */
function literalKey(v: LiteralValue): string {
  switch (v.k) {
    case 'null':
      return 'null';
    case 'bool':
      return v.v ? 'bool:t' : 'bool:f';
    case 'num':
      // `String` and not `toString(36)`: -0 and 0 must not share a key, and they don't here
      // because `String(-0)` is '0' while the sign is recovered from... nothing. So spell it.
      return `num:${Object.is(v.v, -0) ? '-0' : String(v.v)}`;
    case 'text':
      return `text:${JSON.stringify(v.v)}`;
    case 'date':
      return `date:${v.v}`;
    case 'enum':
      return `enum:${String(v.v)}:${v.d}`;
    case 'set':
      // Codes are already sorted and deduped by `normalizeCodes`, so join is canonical.
      return `set:${v.v.join(',')}:${v.d}`;
    default: {
      const never: never = v;
      throw new LogicInvariant(`unhandled literal ${JSON.stringify(never)}`);
    }
  }
}

function groupKey(group: Group): string {
  switch (group.kind) {
    case 'explicit':
      return `explicit:${group.variable_ids.join(',')}`;
    case 'question_emits':
    case 'options':
      return `${group.kind}:${group.question_id}`;
    case 'matrix_rows':
      return `matrix_rows:${group.question_id}:${group.column_ref ?? ''}`;
    case 'matrix_cols':
      return `matrix_cols:${group.question_id}:${group.row_ref ?? ''}`;
    case 'loop_iterations':
      return `loop:${group.question_id}:${group.loop_id}`;
    default: {
      const never: never = group;
      throw new LogicInvariant(`unhandled group ${JSON.stringify(never)}`);
    }
  }
}

/* ========================================================================== */
/* Defaults                                                                   */
/* ========================================================================== */

/**
 * The `base` operand of D §4.6's visibility meet.
 *
 * D states the combination as "AND(all show-rule verdicts default-true) AND NOT(OR(hide
 * verdicts))". The base is what carries the "default-true": a node with no display rule is
 * visible, and a node that has a `show` rule is base-*hidden* and revealed by it. Without that
 * flip, `IF x THEN SHOW Q12` would show Q12 unconditionally — which is not what any author means
 * by writing it — and a show rule could never hide anything.
 *
 * An explicit `declaredVisible` entry wins, because a question the author parked as hidden with a
 * `show` rule attached is a real pattern and the schema records it.
 */
function deriveBaseVisible(
  rules: readonly Rule[],
  declared: { readonly [nodeId: string]: boolean },
): (nodeId: string) => boolean {
  const hasShow = new Set<string>();
  for (const rule of rules) {
    if (rule.effect.action !== 'show') continue;
    const target = rule.target;
    if (target.type === 'question' || target.type === 'page' || target.type === 'block') {
      hasShow.add(target.id);
    }
  }
  return (nodeId) => declared[nodeId] ?? !hasShow.has(nodeId);
}

/** schema §5.1's literal defaults: an option is visible and enabled, nothing else. */
function defaultOptionState(prop: OptProp): boolean {
  switch (prop) {
    case 'visible':
    case 'enabled':
      return true;
    case 'preselected':
    case 'auto_select':
    case 'required':
      return false;
    default: {
      const never: never = prop;
      throw new LogicInvariant(`unhandled option property ${JSON.stringify(never)}`);
    }
  }
}

function axisItems(env: TypeEnv, questionId: QuestionId, axis: MaskAxis): readonly GroupItem[] {
  const question = env.question(questionId);
  if (question === undefined) return [];
  const list = axis === 'options' ? question.options : axis === 'rows' ? question.rows : question.columns;
  return list.map((item) => ({
    option_id: item.option_id,
    code: item.code,
    ...(question.domain === undefined ? {} : { domain: question.domain }),
    label_key: item.label_key,
    position: item.position,
    ...(item.pin === undefined ? {} : { pin: item.pin }),
    ...(item.variable_id === undefined ? {} : { variable_id: item.variable_id }),
    ...(item.meta === undefined ? {} : { meta: item.meta }),
  }));
}

/* ========================================================================== */
/* The evaluator's view of the registry                                       */
/* ========================================================================== */

/**
 * Everything the evaluator needs from the registry, resolved into closures over pre-built maps.
 * D §10.3 forbids `Map` lookups keyed on strings *per node*; these are per-probe, which is rare,
 * and the alternative — shipping four more index arrays in the artifact for a node kind that
 * appears a handful of times per survey — costs more than it saves.
 */
export function buildEvalSchema(env: TypeEnv): EvalSchema {
  const labelKeys = new Map<string, string>();
  for (const question of env.questions()) {
    if (question.domain === undefined) continue;
    for (const item of [...question.options, ...question.rows, ...question.columns]) {
      labelKeys.set(`${question.domain}:${String(item.code)}`, item.label_key);
    }
  }

  const pageOf = new Map<string, PageId>();
  for (const page of env.pages()) {
    for (const questionId of page.question_ids) pageOf.set(questionId, page.id);
  }

  return {
    labelKey: (domain: DomainId, code: number) => labelKeys.get(`${domain}:${String(code)}`),
    questionVariables: (id) => env.question(id)?.emits ?? [],
    pageQuestions: (id) => env.page(id)?.question_ids ?? [],
    ownerQuestion: (id) => env.ownerQuestion(id)?.id,
    pageOf: (nodeId) => pageOf.get(nodeId),
    declaredVisible: () => true,
  };
}

/**
 * A `TypeEnv` whose derived-variable expressions are the CSE'd copies.
 *
 * The graph builder reads `VarDecl.expression` to find what a derived variable depends on, and it
 * must see the same node objects the evaluator will run — otherwise the memo table is keyed on
 * one tree and the dependency edges on another, and a derived variable silently reads a stale
 * memo slot belonging to a different node.
 */
function withDerivedExpressions(env: TypeEnv, expressions: ReadonlyMap<VariableId, Expr>): TypeEnv {
  const patched = env.variables().map((decl) => {
    const expression = expressions.get(decl.id);
    return expression === undefined ? decl : { ...decl, expression };
  });
  return {
    ...env,
    byId: (id) => {
      const decl = env.byId(id);
      if (decl === undefined) return undefined;
      const expression = expressions.get(id);
      return expression === undefined ? decl : { ...decl, expression };
    },
    variables: () => patched,
  };
}
