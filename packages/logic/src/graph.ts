/**
 * The cell dependency graph — D §4.4, §4.5, §4.6.
 *
 * The problem this file solves, stated as D §4.3 states it: an author writes
 *
 *     R1: SET SEGMENT = CASE WHEN AGE < 35 THEN "young" ELSE "old" END
 *     R2: IF SEGMENT = "young" THEN SHOW Q12
 *     R3: IF NOT SHOWN(Q12) THEN SET SKIPPED_MAIN = TRUE
 *     R4: HIDE Q12 OPTION 4 IF SEGMENT = "old"
 *
 * Evaluate in authored order and it works. Evaluate in `id` order, or in the order a `Map`
 * iterates after an edit, or in the order the client's React render happened to schedule, and R2
 * reads `SEGMENT` before R1 wrote it — producing `U`, collapsing to false, hiding Q12, and then
 * R3 records a skip that did not happen. The respondent sees a different survey than the server
 * computes, ADR-004's divergence metric fires, and nobody can reproduce it because it depends on
 * insertion order.
 *
 * **The fix is not "evaluate in authored order".** That fails the moment a rule is inserted, and
 * it makes the builder's rule list a load-bearing ordering UI that users do not understand it to
 * be. The fix is a single dependency graph over *cells*, topologically sorted once at compile
 * time, with cycles rejected at compile time.
 *
 * Two properties make the result insertion-order-independent, and both are deliberate:
 *
 *  1. **Cell indices are assigned from a sorted key list, not from discovery order.** If indices
 *     came from the order rules were visited, every downstream array would be a permutation of
 *     itself per edit, and `topo` would not be comparable between two compiles of the same
 *     survey. Sorting first is what makes "identical verdict under 1,000 shuffled insertion
 *     orders" hold *byte for byte* rather than merely semantically.
 *  2. **The topological tie-break is total.** Phase rank, then the writing rule's `order_key`,
 *     then its id, then the cell key. No ties are left for the algorithm to break arbitrarily.
 */

import type { Expr } from './ast.js';
import { probesOf, readsOf } from './ast.js';
import type { LgcDiagnostic } from './diagnostics.js';
import { diagnostic } from './diagnostics.js';
import type { CellIdx, PageId, QuestionId, RuleId, VariableId } from './ids.js';
import { LogicInvariant, at } from './ids.js';
import { MinHeap } from './heap.js';
import type { TypeEnv } from './registry.js';
import type { Cell, Rule } from './rules.js';
import { PHASE_RANK, cellKey, exprsOf, writesOf } from './rules.js';

export interface CellGraph {
  /** Index = `CellIdx`. Assigned from the sorted key list, so it is edit-order-independent. */
  readonly cells: readonly Cell[];
  readonly keys: readonly string[];
  readonly indexOf: (key: string) => CellIdx | undefined;
  /** `CellIdx` in evaluation order (D §5.2). Empty when the graph has a cycle. */
  readonly topo: Int32Array;
  /** `CellIdx` → its position in `topo`, the min-heap key for dirty-set propagation. */
  readonly topoPos: Int32Array;
  /** Forward edges, for propagation. */
  readonly dependents: readonly Int32Array[];
  /** Reverse edges. Used to explain a cycle and by the trace. */
  readonly inputs: readonly Int32Array[];
  /** Rule indices writing each cell, in application order (`order_key`, then id). */
  readonly writers: readonly Int32Array[];
  /** Variable id → cells whose value depends on it, directly or not (D §5.2). */
  readonly triggers: ReadonlyMap<VariableId, Int32Array>;
  /** `valid(rule)` cells grouped by the node a `probe(valid, …)` would name. */
  readonly validByTarget: ReadonlyMap<string, Int32Array>;
  readonly diagnostics: readonly LgcDiagnostic[];
}

export interface BuildGraphOptions {
  readonly path?: string;
}

export function buildCellGraph(
  rules: readonly Rule[],
  env: TypeEnv,
  options: BuildGraphOptions = {},
): CellGraph {
  const path = options.path ?? '';
  const diagnostics: LgcDiagnostic[] = [];

  /* ---- 1. discover cells ------------------------------------------------ */

  const byKey = new Map<string, Cell>();
  const declare = (cell: Cell): string => {
    const key = cellKey(cell);
    if (!byKey.has(key)) byKey.set(key, cell);
    return key;
  };

  // Response, hidden and system variables are source vertices (in-degree 0). Derived variables
  // are vertices written by their own expression. Every variable gets a `value` cell either way,
  // so a rule reading one always has an edge to attach to.
  for (const decl of env.variables()) declare({ c: 'value', variable_id: decl.id });

  const validByTargetKeys = new Map<string, string[]>();
  for (const rule of rules) {
    for (const cell of writesOf(rule)) {
      const key = declare(cell);
      if (cell.c === 'valid') {
        for (const target of validationTargets(rule, env)) {
          const list = validByTargetKeys.get(target) ?? [];
          list.push(key);
          validByTargetKeys.set(target, list);
        }
      }
    }
  }

  // Read cells are declared in a second pass so that a probe of a node no rule writes still
  // gets a vertex — otherwise `NOT SHOWN(Q12)` on a question with no display rule would have
  // nothing to read and R3 above could not be expressed at all.
  const ruleReads: string[][] = rules.map((rule) => {
    const keys = new Set<string>();
    for (const expr of exprsOf(rule)) collectReads(expr, env, keys, declare, validByTargetKeys);
    return [...keys];
  });

  const derivedReads = new Map<string, string[]>();
  for (const decl of env.variables()) {
    if (decl.kind !== 'derived' || decl.expression === undefined) continue;
    const keys = new Set<string>();
    collectReads(decl.expression, env, keys, declare, validByTargetKeys);
    derivedReads.set(cellKey({ c: 'value', variable_id: decl.id }), [...keys]);
  }

  /* ---- 2. index cells deterministically --------------------------------- */

  const keys = [...byKey.keys()].sort(compareCellKeys(byKey));
  const cells = keys.map((key) => {
    const cell = byKey.get(key);
    if (cell === undefined) throw new LogicInvariant(`cell ${key} vanished during indexing`);
    return cell;
  });
  const index = new Map<string, CellIdx>();
  keys.forEach((key, i) => index.set(key, i));
  const idx = (key: string): CellIdx => {
    const found = index.get(key);
    if (found === undefined) throw new LogicInvariant(`unindexed cell ${key}`);
    return found;
  };

  /* ---- 3. writers, in application order --------------------------------- */

  const writerLists: number[][] = cells.map(() => []);
  rules.forEach((rule, ruleIndex) => {
    for (const cell of writesOf(rule)) writerLists[idx(cellKey(cell))]?.push(ruleIndex);
  });
  for (const list of writerLists) {
    list.sort((a, b) => compareRules(at(rules, a), at(rules, b)));
  }

  /* ---- 4. edges --------------------------------------------------------- */

  const dependentSets: Set<number>[] = cells.map(() => new Set<number>());
  const inputSets: Set<number>[] = cells.map(() => new Set<number>());
  const edge = (from: CellIdx, to: CellIdx): void => {
    dependentSets[from]?.add(to);
    inputSets[to]?.add(from);
  };

  rules.forEach((rule, ruleIndex) => {
    const reads = ruleReads[ruleIndex] ?? [];
    for (const cell of writesOf(rule)) {
      const target = idx(cellKey(cell));
      for (const read of reads) edge(idx(read), target);
    }
  });
  for (const [target, reads] of derivedReads) {
    for (const read of reads) edge(idx(read), idx(target));
  }

  /* ---- 5. conflicts (D §4.6) ------------------------------------------- */

  diagnostics.push(...findConflicts(cells, writerLists, rules, env, derivedReads, path));

  /* ---- 6. cycles (D §4.5) ---------------------------------------------- */

  const dependents = dependentSets.map((set) => toInt32(set));
  const inputs = inputSets.map((set) => toInt32(set));
  const sccs = stronglyConnected(dependents);
  // An SCC of size > 1, or a self-loop, is a cycle. A self-loop is `SET X = X + 1`: legal in a
  // programming language, meaningless here, and it would otherwise sort happily into `topo`.
  const cyclic = sccs.filter((component) => {
    if (component.length > 1) return true;
    const only = at(component, 0);
    return at(dependents, only).includes(only);
  });
  for (const component of cyclic) {
    diagnostics.push(cycleDiagnostic(component, cells, keys, writerLists, rules, dependents, path));
  }

  /* ---- 7. topological order with a total tie-break (D §4.4) ------------- */

  const tieRank = rankCells(cells, writerLists, rules);
  const topo = cyclic.length > 0 ? new Int32Array(0) : kahn(dependents, inputs, tieRank);
  const topoPos = new Int32Array(cells.length).fill(-1);
  for (let position = 0; position < topo.length; position += 1) {
    topoPos[i32(topo, position)] = position;
  }

  /* ---- 8. trigger index (D §5.2) --------------------------------------- */

  const triggers = new Map<VariableId, Int32Array>();
  for (const decl of env.variables()) {
    const start = index.get(cellKey({ c: 'value', variable_id: decl.id }));
    if (start === undefined) continue;
    triggers.set(decl.id, closure(start, dependents, topoPos));
  }

  const validByTarget = new Map<string, Int32Array>();
  for (const [target, cellKeys] of validByTargetKeys) {
    validByTarget.set(target, toInt32(new Set(cellKeys.map(idx))));
  }

  return {
    cells,
    keys,
    indexOf: (key) => index.get(key),
    topo,
    topoPos,
    dependents,
    inputs,
    writers: writerLists.map((list) => Int32Array.from(list)),
    triggers,
    validByTarget,
    diagnostics,
  };
}

/* ========================================================================== */
/* Reads                                                                      */
/* ========================================================================== */

/**
 * `reads(R)` from D §4.4, plus one addition the document omits.
 *
 * D lists `value(x)` for variables, `visible(n)` for `shown` probes, `valid(r)` for `valid`
 * probes, and `items(q)` for an aggregation over a question's options. It does not list the
 * dependency of an **`answered`** probe on the value it interrogates — an oversight, because
 * `ANSWERED(Q9)` plainly changes when Q9 changes. Without that edge the trigger index would
 * miss it and a rule guarded the way D §2.5 *recommends* guarding it would never recompute on
 * answer change. That is a worse failure than the one the guard prevents, so the edge is here.
 */
function collectReads(
  expr: Expr,
  env: TypeEnv,
  out: Set<string>,
  declare: (cell: Cell) => string,
  validByTarget: ReadonlyMap<string, readonly string[]>,
): void {
  for (const variableId of readsOf(expr)) {
    out.add(declare({ c: 'value', variable_id: variableId }));
  }
  for (const probe of probesOf(expr)) {
    switch (probe.kind) {
      case 'answered': {
        for (const variableId of probeVariables(probe.target, env)) {
          out.add(declare({ c: 'value', variable_id: variableId }));
        }
        break;
      }
      case 'shown':
      case 'asked': {
        const node = probeNode(probe.target, env);
        if (node !== undefined) out.add(declare({ c: 'visible', node_id: node }));
        break;
      }
      case 'valid':
        // `valid` cells are keyed by *rule*, not by the node the probe names, so the read is a
        // lookup in the index the writer pass built. Without these edges a rule reading
        // `NOT VALID(Q6)` would be ordered *before* the validation it interrogates and would read
        // an uncomputed cell — which reads as "passes" and silently never fires.
        for (const key of validByTarget.get(probe.target.id) ?? []) out.add(key);
        break;
      default: {
        const never: never = probe.kind;
        throw new LogicInvariant(`unhandled probe kind ${JSON.stringify(never)}`);
      }
    }
  }
  // An aggregation over a question's *options* reads the mask result, not the answers: masking
  // an option out removes it from the group, so the count changes with no answer changing.
  walkAggs(expr, (group) => {
    out.add(declare({ c: 'items', question_id: group.question_id, axis: 'options' }));
  });
}

interface OptionsGroupRef {
  readonly question_id: QuestionId;
}

function walkAggs(expr: Expr, visit: (group: OptionsGroupRef) => void): void {
  const stack: Expr[] = [expr];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === undefined) break;
    const group = aggGroup(node);
    if (group !== undefined) visit(group);
    if (node.op === 'agg') {
      if (node.where !== undefined) stack.push(node.where);
      if (node.select !== undefined) stack.push(node.select);
      continue;
    }
    if (node.op === 'case') {
      for (const arm of node.cases) stack.push(arm.when, arm.then);
      stack.push(node.else);
      continue;
    }
    const args = (node as { readonly args?: readonly Expr[] }).args;
    if (args !== undefined) for (const arg of args) stack.push(arg);
  }
}

function aggGroup(node: Expr): OptionsGroupRef | undefined {
  if (node.op !== 'agg') return undefined;
  return node.over.kind === 'options' ? { question_id: node.over.question_id } : undefined;
}

function probeVariables(
  target: { readonly kind: 'variable' | 'question' | 'page'; readonly id: string },
  env: TypeEnv,
): readonly VariableId[] {
  switch (target.kind) {
    case 'variable':
      return [target.id as VariableId];
    case 'question':
      return env.question(target.id as QuestionId)?.emits ?? [];
    case 'page': {
      const page = env.page(target.id as PageId);
      if (page === undefined) return [];
      return page.question_ids.flatMap((id) => env.question(id)?.emits ?? []);
    }
    default: {
      const never: never = target.kind;
      throw new LogicInvariant(`unhandled probe target ${JSON.stringify(never)}`);
    }
  }
}

function probeNode(
  target: { readonly kind: 'variable' | 'question' | 'page'; readonly id: string },
  env: TypeEnv,
): QuestionId | PageId | undefined {
  if (target.kind === 'page') return target.id as PageId;
  if (target.kind === 'question') return target.id as QuestionId;
  // A variable is neither shown nor hidden — its question is (see `isShown` in evaluator.ts).
  return env.ownerQuestion(target.id as VariableId)?.id;
}

/** Which nodes a `probe(valid, …)` could name to reach this validation rule. */
function validationTargets(rule: Rule, env: TypeEnv): readonly string[] {
  const target = rule.target;
  if (target.type === 'variable') {
    const owner = env.ownerQuestion(target.id);
    return owner === undefined ? [target.id] : [target.id, owner.id];
  }
  if (target.type === 'question') {
    const question = env.question(target.id);
    return question === undefined ? [target.id] : [target.id, ...question.emits];
  }
  if (target.type === 'survey') return [];
  return [target.id];
}

/* ========================================================================== */
/* Ordering                                                                   */
/* ========================================================================== */

function compareCellKeys(byKey: ReadonlyMap<string, Cell>): (a: string, b: string) => number {
  return (a, b) => {
    const left = byKey.get(a);
    const right = byKey.get(b);
    if (left === undefined || right === undefined) throw new LogicInvariant('cell key without a cell');
    const phase = PHASE_RANK[left.c] - PHASE_RANK[right.c];
    return phase !== 0 ? phase : a < b ? -1 : a > b ? 1 : 0;
  };
}

function compareRules(a: Rule, b: Rule): number {
  // `order_key` is document order and `id` is the final tie-break, "so the order is stable
  // across machines and processes" (D §4.4).
  if (a.order_key !== b.order_key) return a.order_key - b.order_key;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * The total tie-break of D §4.4, materialised as a dense rank so the heap can key on one number.
 *
 * Phases are **not** a separate evaluation pass — they are only a tie-break between cells the
 * graph leaves unordered. A `value` cell that genuinely depends on a `visible` cell (R3 above) is
 * ordered after it by the graph, overriding its phase rank. Implementations that make phases
 * primary cannot express R3 at all.
 */
function rankCells(
  cells: readonly Cell[],
  writers: readonly number[][],
  rules: readonly Rule[],
): Int32Array {
  const order = cells.map((_, i) => i);
  order.sort((a, b) => {
    const phase = PHASE_RANK[at(cells, a).c] - PHASE_RANK[at(cells, b).c];
    if (phase !== 0) return phase;
    const firstA = writers[a]?.[0];
    const firstB = writers[b]?.[0];
    if (firstA !== undefined && firstB !== undefined) {
      const byRule = compareRules(at(rules, firstA), at(rules, firstB));
      if (byRule !== 0) return byRule;
    } else if (firstA !== undefined || firstB !== undefined) {
      // A source vertex (no writer) sorts before a written cell of the same phase: it can only
      // be an input, so putting it first keeps a trace readable top to bottom.
      return firstA === undefined ? -1 : 1;
    }
    return a - b; // indices already follow sorted cell keys, so this is the key order
  });
  const rank = new Int32Array(cells.length);
  order.forEach((cell, position) => {
    rank[cell] = position;
  });
  return rank;
}

/** Kahn's algorithm with a min-heap on the tie-break rank. */
function kahn(
  dependents: readonly Int32Array[],
  inputs: readonly Int32Array[],
  rank: Int32Array,
): Int32Array {
  const remaining = new Int32Array(inputs.length);
  for (let i = 0; i < inputs.length; i += 1) remaining[i] = at(inputs, i).length;

  const heap = new MinHeap((cell) => rank[cell] ?? cell);
  for (let i = 0; i < remaining.length; i += 1) if (remaining[i] === 0) heap.push(i);

  const topo = new Int32Array(inputs.length);
  let filled = 0;
  for (;;) {
    const cell = heap.pop();
    if (cell === undefined) break;
    topo[filled] = cell;
    filled += 1;
    for (const next of at(dependents, cell)) {
      const left = (remaining[next] ?? 0) - 1;
      remaining[next] = left;
      if (left === 0) heap.push(next);
    }
  }
  if (filled !== inputs.length) {
    // Unreachable: a cycle was already reported and `topo` is left empty in that case.
    throw new LogicInvariant(`topological sort covered ${String(filled)} of ${String(inputs.length)} cells`);
  }
  return topo;
}

/* ========================================================================== */
/* Cycles (D §4.5)                                                            */
/* ========================================================================== */

/**
 * Tarjan's SCC, iterative.
 *
 * We reject the fixpoint-iteration alternative deliberately (D §4.5). Iterating to a fixed point
 * "works" for monotone effect lattices and produces two unacceptable properties: the number of
 * iterations becomes observable in timing, and for non-monotone effects (`set_variable`) there
 * may be no fixed point or several, so the result depends on iteration order — exactly the
 * nondeterminism this whole file exists to eliminate. A cycle in survey logic is always an
 * authoring mistake; the correct response is a compile error naming it.
 */
export function stronglyConnected(dependents: readonly Int32Array[]): readonly number[][] {
  const n = dependents.length;
  const index = new Int32Array(n).fill(-1);
  const low = new Int32Array(n).fill(0);
  const onStack = new Uint8Array(n);
  const stack: number[] = [];
  const components: number[][] = [];
  let counter = 0;

  for (let root = 0; root < n; root += 1) {
    if (index[root] !== -1) continue;
    // Explicit work stack: (vertex, next child position).
    const work: { v: number; i: number }[] = [{ v: root, i: 0 }];
    index[root] = counter;
    low[root] = counter;
    counter += 1;
    stack.push(root);
    onStack[root] = 1;

    while (work.length > 0) {
      const frame = work[work.length - 1];
      if (frame === undefined) break;
      const edges = at(dependents, frame.v);
      if (frame.i < edges.length) {
        const next = i32(edges, frame.i);
        frame.i += 1;
        if (index[next] === -1) {
          index[next] = counter;
          low[next] = counter;
          counter += 1;
          stack.push(next);
          onStack[next] = 1;
          work.push({ v: next, i: 0 });
        } else if (onStack[next] === 1) {
          low[frame.v] = Math.min(low[frame.v] ?? 0, index[next] ?? 0);
        }
        continue;
      }
      work.pop();
      const parent = work[work.length - 1];
      if (parent !== undefined) {
        low[parent.v] = Math.min(low[parent.v] ?? 0, low[frame.v] ?? 0);
      }
      if (low[frame.v] === index[frame.v]) {
        const component: number[] = [];
        for (;;) {
          const popped = stack.pop();
          if (popped === undefined) break;
          onStack[popped] = 0;
          component.push(popped);
          if (popped === frame.v) break;
        }
        components.push(component.sort((a, b) => a - b));
      }
    }
  }
  return components;
}

function cycleDiagnostic(
  component: readonly number[],
  cells: readonly Cell[],
  keys: readonly string[],
  writers: readonly number[][],
  rules: readonly Rule[],
  dependents: readonly Int32Array[],
  path: string,
): LgcDiagnostic {
  const cyclePath = findCyclePath(component, dependents);
  const involved = new Set<RuleId>();
  for (const cell of component) {
    for (const ruleIndex of writers[cell] ?? []) involved.add(at(rules, ruleIndex).id);
  }
  const ruleIds = [...involved].sort();
  const pathText = [...cyclePath, cyclePath[0]]
    .filter((cell): cell is number => cell !== undefined)
    .map((cell) => at(keys, cell))
    .join(' -> ');

  const lines = ruleIds.map((ruleId) => {
    const rule = rules.find((r) => r.id === ruleId);
    const writes = rule === undefined ? [] : writesOf(rule).map(cellKey);
    return `  ${ruleId}${rule?.label === undefined ? '' : ` "${rule.label}"`} writes ${writes.join(', ')}`;
  });

  return diagnostic(
    'LGC-CYCLE',
    `Rule dependency cycle. These rules depend on each other's effects:\n${lines.join('\n')}\n` +
      `  cycle: ${pathText}\n` +
      'Break the cycle by deriving the value from a response variable rather than from an effect.',
    path,
    {
      rules: ruleIds,
      cells: component.map((cell) => at(keys, cell)),
      cycle: [...cyclePath, cyclePath[0]]
        .filter((cell): cell is number => cell !== undefined)
        .map((cell) => at(keys, cell)),
      cell_kinds: component.map((cell) => at(cells, cell).c),
    },
  );
}

/** A concrete cycle inside an SCC, so the diagnostic can print a path rather than a set. */
function findCyclePath(component: readonly number[], dependents: readonly Int32Array[]): readonly number[] {
  const inComponent = new Set(component);
  const start = component[0];
  if (start === undefined) return [];
  const previous = new Map<number, number>();
  const queue: number[] = [start];
  const seen = new Set<number>([start]);
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) break;
    for (const next of at(dependents, current)) {
      if (!inComponent.has(next)) continue;
      if (next === start) {
        const cyclePath = [start];
        let cursor = current;
        while (cursor !== start) {
          cyclePath.unshift(cursor);
          const back = previous.get(cursor);
          if (back === undefined) break;
          cursor = back;
        }
        return cyclePath;
      }
      if (seen.has(next)) continue;
      seen.add(next);
      previous.set(next, current);
      queue.push(next);
    }
  }
  return component;
}

/* ========================================================================== */
/* Conflicts (D §4.6)                                                         */
/* ========================================================================== */

/**
 * Two rules writing one cell is common and mostly benign, **but only because some cells form a
 * lattice** (D §4.6). `value` does not: two `set_variable` rules on one variable have no
 * order-independent combination, so they are banned rather than resolved.
 *
 * The one exemption is an explicit `PRIORITY GROUP`, where last-writer-wins is the author's
 * stated intent. The exemption exists because the alternative is authors writing one giant
 * nested `CASE`, which is worse to read and worse to diff.
 */
function findConflicts(
  cells: readonly Cell[],
  writers: readonly number[][],
  rules: readonly Rule[],
  env: TypeEnv,
  derivedReads: ReadonlyMap<string, readonly string[]>,
  path: string,
): readonly LgcDiagnostic[] {
  const out: LgcDiagnostic[] = [];
  cells.forEach((cell, i) => {
    if (cell.c !== 'value') return;
    const list = writers[i] ?? [];
    const decl = env.byId(cell.variable_id);
    const derived = decl?.kind === 'derived' && derivedReads.has(cellKey(cell));

    if (derived && list.length > 0) {
      out.push(
        diagnostic(
          'LGC-CONFLICT',
          `${decl?.name ?? cell.variable_id} is a derived variable — its value comes from its own ` +
            `expression — but ${list.length === 1 ? 'rule' : 'rules'} ` +
            `${list.map((r) => at(rules, r).id).join(', ')} also write it. Pick one source.`,
          path,
          { variable_id: cell.variable_id, rules: list.map((r) => at(rules, r).id) },
        ),
      );
      return;
    }
    if (list.length < 2) return;

    const groups = new Set(list.map((r) => at(rules, r).priority_group));
    if (groups.size === 1 && !groups.has(undefined)) return; // one explicit PRIORITY GROUP

    out.push(
      diagnostic(
        'LGC-CONFLICT',
        `${list.length} rules write ${cellKey(cell)}: ${list.map((r) => at(rules, r).id).join(', ')}. ` +
          'A value cell is not a lattice, so the result would depend on evaluation order. Put ' +
          'them in one PRIORITY GROUP if last-writer-wins is what you mean, or merge them into ' +
          'one rule with a CASE.',
        path,
        {
          variable_id: cell.variable_id,
          cell: cellKey(cell),
          rules: list.map((r) => at(rules, r).id),
        },
      ),
    );
  });
  return out;
}

/* ========================================================================== */
/* Small utilities                                                            */
/* ========================================================================== */

/**
 * Indexed read of a typed array under `noUncheckedIndexedAccess`. Same contract as `at`: an out
 * of range index is a compiler bug, so it is a `LogicInvariant` and not an `undefined` that
 * propagates into a respondent's verdict.
 */
function i32(array: Int32Array, index: number): number {
  const value = array[index];
  if (value === undefined) {
    throw new LogicInvariant(`index ${String(index)} out of range (length ${String(array.length)})`);
  }
  return value;
}

function toInt32(values: ReadonlySet<number>): Int32Array {
  return Int32Array.from([...values].sort((a, b) => a - b));
}

/** Every cell transitively downstream of `start`, ordered by evaluation position. */
function closure(start: CellIdx, dependents: readonly Int32Array[], topoPos: Int32Array): Int32Array {
  const seen = new Set<number>();
  const queue: number[] = [start];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) break;
    for (const next of at(dependents, current)) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  const out = [...seen];
  out.sort((a, b) => (topoPos[a] ?? a) - (topoPos[b] ?? b));
  return Int32Array.from(out);
}
