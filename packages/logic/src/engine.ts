/**
 * The engine's public surface — D §1, §4.6, §5.3.
 *
 *     evaluate(program, state, ctx): Verdict
 *
 * Synchronous, pure, and unable to fail with anything other than a thrown `LogicInvariant` —
 * which means a compiler bug, not user input (D §1). Two entry points share one `recomputeCell`:
 *
 *  - `evaluate` walks the whole `topo` order. This is page entry.
 *  - `onAnswerChange` walks only the dirty frontier, in topological order, with value-equality
 *    pruning. This is every keystroke, and it is the reason the <1 ms budget holds: the budget was
 *    never about the evaluator's inner loop, it was about **not evaluating the other 497 rules**
 *    (D §5.1).
 *
 * Every cell is combined from its writers through the lattice D §4.6 assigns it, so the result
 * cannot depend on the order the writers are applied in. Where no lattice exists — a `value` cell
 * with two `set_variable` writers — the compiler has already refused to build the program
 * (`LGC-CONFLICT`), so the situation cannot reach here.
 */

import type { CompiledLogic } from './compile.js';
import { itemsKey, optionKey } from './compile.js';
import {
  bindItem,
  evalCondition,
  evalExpr,
  type CellReader,
  type ExprEnv,
  type ItemBindingValue,
} from './evaluator.js';
import type { CellIdx, QuestionId, RuleId, VariableId } from './ids.js';
import { LogicInvariant, at } from './ids.js';
import { MinHeap } from './heap.js';
import type { Tri } from './kleene.js';
import type { Cell, Collapse, Disposition, MaskAxis, OptProp, Rule } from './rules.js';
import {
  applyMask,
  collapseUnknown,
  combineVisible,
  optPropCombiner,
  setVariableOutcome,
} from './rules.js';
import type { CellValue, EvalContext, EvalState, MaskFallback, TraceCell, TraceWriter, VarState } from './state.js';
import { cellBool, cellCodes, cellValueEq, cellValueOf, createEvalState } from './state.js';
import { NULL, type Value } from './value.js';

export interface ValidationFailure {
  readonly rule_id: RuleId;
  readonly message_key: string;
  readonly scope: 'field' | 'page';
  /** The node the validation was attached to, so the runtime knows where to render it. */
  readonly target: string;
}

export interface Termination {
  readonly rule_id: RuleId;
  readonly disposition: Disposition;
  readonly custom_key?: string;
}

export interface CellChange {
  readonly cell: CellIdx;
  readonly key: string;
  readonly before: CellValue | undefined;
  readonly after: CellValue;
}

export interface Verdict {
  /** Every cell's value after this evaluation. Index = `CellIdx`. */
  readonly cells: readonly (CellValue | undefined)[];
  readonly value: (id: VariableId) => Value;
  readonly visible: (nodeId: string) => boolean;
  readonly items: (questionId: QuestionId, axis: MaskAxis) => readonly number[];
  readonly option: (optionId: string, prop: OptProp) => boolean;
  readonly validations: readonly ValidationFailure[];
  /**
   * The winning termination, or `undefined`. First in `topo` order wins and the rest are recorded
   * in `suppressedTerminations` — deterministic by construction (D §4.6), and the suppressed list
   * matters because "two rules both wanted to screen this respondent out" is a real authoring
   * smell that only shows up in a trace.
   */
  readonly termination: Termination | undefined;
  readonly suppressedTerminations: readonly RuleId[];
  readonly maskFallbacks: readonly MaskFallback[];
  /** What changed in this evaluation. Drives the DOM patch and the trace (D §5.3). */
  readonly changes: readonly CellChange[];
  readonly trace: readonly TraceCell[];
  /** The accumulator, so the caller can hand it back to `onAnswerChange`. */
  readonly state: EvalState;
}

export interface EvaluateOptions {
  /** Reuse an accumulator across evaluations. A fresh one is created when absent. */
  readonly state?: EvalState;
}

/* ========================================================================== */
/* Full evaluation                                                            */
/* ========================================================================== */

export function evaluate(
  program: CompiledLogic,
  vars: VarState,
  ctx: EvalContext,
  options: EvaluateOptions = {},
): Verdict {
  const st = options.state ?? createEvalState(program.cells.length, program.nodeCount);
  if (program.topo.length !== program.cells.length) {
    // `compileLogic` leaves `topo` empty when the graph has a cycle. Evaluating anyway would
    // produce a verdict that depends on array order — the exact failure LGC-CYCLE exists to
    // prevent — so the engine refuses instead of guessing.
    throw new LogicInvariant(
      'this program has no topological order (LGC-CYCLE was reported at compile time); ' +
        'it must not be evaluated',
    );
  }
  st.epoch += 1;
  const trace: TraceCell[] = [];
  const changes: CellChange[] = [];

  for (let position = 0; position < program.topo.length; position += 1) {
    const cell = program.topo[position];
    if (cell === undefined) throw new LogicInvariant('topo hole');
    applyCell(program, cell, position, vars, ctx, st, trace, changes);
  }

  return finalize(program, st, trace, changes);
}

/* ========================================================================== */
/* Incremental evaluation (D §5.3)                                            */
/* ========================================================================== */

/**
 * Dirty-set propagation, D §5.3, with the three properties that make it worth the machinery:
 *
 *  - **Topological pop order** means no cell is computed from a stale input and none is computed
 *    twice. A naive BFS recomputes diamond dependencies exponentially — the difference between
 *    1 ms and 40 ms on a grid with 30 rows of option-state rules.
 *  - **Value-equality pruning** makes the common case free: a respondent typing in an open-end
 *    changes `value(Q9)`, and if no verdict changes, propagation stops at the first frontier.
 *  - **Epoch-stamped memo invalidation** avoids clearing a large table per keystroke.
 */
export function onAnswerChange(
  program: CompiledLogic,
  changed: readonly VariableId[],
  vars: VarState,
  ctx: EvalContext,
  state: EvalState,
): Verdict {
  state.epoch += 1;
  const trace: TraceCell[] = [];
  const changes: CellChange[] = [];

  const queued = new Uint8Array(program.cells.length);
  const heap = new MinHeap((cell) => program.topoPos[cell] ?? cell);

  const seed = (cell: CellIdx): void => {
    if (queued[cell] === 1) return;
    queued[cell] = 1;
    heap.push(cell);
  };

  for (const variableId of changed) {
    // Seed the variable's **own** cell, not its transitive closure.
    //
    // D §5.3's pseudo-code seeds `triggers[v]`, which D §5.2 defines as the cells depending on `v`
    // "directly or not". Those two statements together contradict the paragraph immediately below
    // them in the same section: if the entire closure is seeded, then the entire closure is
    // recomputed, and "propagation stops at the first frontier … typical measured frontier 3–12
    // cells" cannot be true of a 500-rule tracker. Value-equality pruning can only prune what it
    // was not already asked to visit.
    //
    // Seeding the one cell the answer actually wrote gives the described behaviour: if the stored
    // value is unchanged nothing else is touched at all, and if it changed, its dependents are
    // enqueued and the frontier grows exactly as far as verdicts keep changing. The transitive
    // `triggers` index still ships in the artifact (D §5.2) and is still the right structure for
    // "what could this answer affect" — it is used here only for a variable with no cell of its
    // own, which the graph would otherwise have no entry point for.
    const own = program.valueCell.get(variableId);
    if (own !== undefined) {
      seed(own);
      continue;
    }
    for (const cell of program.triggers.get(variableId) ?? EMPTY_I32) seed(cell);
  }

  for (;;) {
    const cell = heap.pop();
    if (cell === undefined) break;
    queued[cell] = 0;
    const position = program.topoPos[cell] ?? -1;
    const changedHere = applyCell(program, cell, position, vars, ctx, state, trace, changes);
    if (!changedHere) continue; // ── value-equality pruning: the whole game ──
    for (const dependent of at(program.dependents, cell)) seed(dependent);
  }

  return finalize(program, state, trace, changes);
}

const EMPTY_I32 = new Int32Array(0);

/* ========================================================================== */
/* One cell                                                                   */
/* ========================================================================== */

function applyCell(
  program: CompiledLogic,
  cellIdx: CellIdx,
  position: number,
  vars: VarState,
  ctx: EvalContext,
  st: EvalState,
  trace: TraceCell[],
  changes: CellChange[],
): boolean {
  const cell = at(program.cells, cellIdx);
  const env: ExprEnv = {
    vars,
    ctx,
    cells: reader(program, st),
    schema: program.schema,
    memo: st,
  };
  const writers: TraceWriter[] = [];
  const next = recomputeCell(program, cellIdx, cell, env, vars, st, writers);
  const before = st.cells[cellIdx];
  const changedHere = !cellValueEq(before, next);
  st.cells[cellIdx] = next;

  const entry: TraceCell = {
    cell: at(program.cellKeys, cellIdx),
    topo_pos: position,
    writers,
    result: next,
    changed: changedHere,
  };
  trace.push(entry);
  ctx.trace?.cell(entry);
  if (changedHere) {
    changes.push({ cell: cellIdx, key: at(program.cellKeys, cellIdx), before, after: next });
  }
  return changedHere;
}

function recomputeCell(
  program: CompiledLogic,
  cellIdx: CellIdx,
  cell: Cell,
  env: ExprEnv,
  vars: VarState,
  st: EvalState,
  writers: TraceWriter[],
): CellValue {
  switch (cell.c) {
    case 'value':
      return { c: 'val', value: recomputeValue(program, cellIdx, cell.variable_id, env, vars, writers) };
    case 'visible':
      return { c: 'bool', on: recomputeVisible(program, cellIdx, cell.node_id, env, writers) };
    case 'items':
      return {
        c: 'codes',
        codes: recomputeItems(program, cellIdx, cell.question_id, cell.axis, env, st, writers),
      };
    case 'opt':
      return { c: 'bool', on: recomputeOption(program, cellIdx, cell.option_id, cell.prop, env, writers) };
    case 'valid':
      return { c: 'bool', on: recomputeFlag(program, cellIdx, env, writers) };
    case 'terminate':
      return { c: 'bool', on: recomputeFlag(program, cellIdx, env, writers) };
    case 'flow':
      return { c: 'target', node_id: recomputeFlow(program, cellIdx, env, writers) };
    default: {
      const never: never = cell;
      throw new LogicInvariant(`unhandled cell ${JSON.stringify(never)}`);
    }
  }
}

function recomputeValue(
  program: CompiledLogic,
  cellIdx: CellIdx,
  variableId: VariableId,
  env: ExprEnv,
  vars: VarState,
  writers: TraceWriter[],
): Value {
  const derived = program.derived.get(cellIdx);
  if (derived !== undefined) return evalExpr(derived, env);

  let value = vars.value(variableId);
  for (const rule of rulesFor(program, cellIdx)) {
    if (rule.effect.action !== 'set') continue;
    const verdict = evalCondition(rule.condition, env);
    const outcome = setVariableOutcome(verdict, rule.on_unknown);
    writers.push(
      traceWriter(
        rule.id,
        verdict,
        verdict === 'U'
          ? {
              fired: outcome === 'assign',
              collapsed: {
                from: 'U',
                to: outcome === 'assign',
                reason: `kind=set_variable, ${outcome === 'assign_null' ? 'assigns null' : 'ON UNKNOWN override'}`,
              },
            }
          : undefined,
      ),
    );
    if (outcome === 'assign') value = evalExpr(rule.effect.value, env);
    else if (outcome === 'assign_null') value = NULL;
  }
  return value;
}

function recomputeVisible(
  program: CompiledLogic,
  cellIdx: CellIdx,
  nodeId: string,
  env: ExprEnv,
  writers: TraceWriter[],
): boolean {
  let showFired = false;
  let hideFired = false;
  for (const rule of rulesFor(program, cellIdx)) {
    const action = rule.effect.action;
    if (action !== 'show' && action !== 'hide') continue;
    const verdict = evalCondition(rule.condition, env);
    const collapse = collapseUnknown(rule.kind, verdict, rule.on_unknown);
    writers.push(traceWriter(rule.id, verdict, collapse));
    if (!collapse.fired) continue;
    if (action === 'show') showFired = true;
    else hideFired = true;
  }
  // `hide` is absorbing (D §4.6). Beyond the lattice algebra, a hide rule is nearly always a
  // correction or a client-requested suppression layered on top of base logic, and making the
  // correction win is what the author means.
  return combineVisible(program.baseVisible(nodeId), showFired, hideFired);
}

function recomputeItems(
  program: CompiledLogic,
  cellIdx: CellIdx,
  questionId: QuestionId,
  axis: MaskAxis,
  env: ExprEnv,
  st: EvalState,
  writers: TraceWriter[],
): readonly number[] {
  const base = program.baseItems(questionId, axis);
  const items = program.maskItems(questionId, axis);
  let current: readonly number[] = base;
  let fallback: MaskFallback | undefined;

  for (const rule of rulesFor(program, cellIdx)) {
    if (rule.effect.action !== 'mask') continue;
    const verdict = evalCondition(rule.condition, env);
    const collapse = collapseUnknown(rule.kind, verdict, rule.on_unknown);
    writers.push(traceWriter(rule.id, verdict, collapse));
    if (!collapse.fired) continue;

    const matched: number[] = [];
    for (const item of items) {
      if (item.code === undefined || !current.includes(item.code)) continue;
      const order = env.ctx.orders?.[itemsKey(questionId, axis)];
      // A mask condition is a per-item condition over an axis of items, so `item` binds the same
      // way a `kind:'options'` aggregation binds it: the item is the option, not its answer.
      const binding: ItemBindingValue = {
        ...bindItem(item, env, true),
        ...(order === undefined ? {} : { order }),
      };
      // D §2.5: an item whose per-item condition is `U` is *excluded* under `mode:'include'` and
      // *retained* under `mode:'exclude'`. An item we cannot prove belongs should not be offered;
      // combined with the mandatory fallback this can never dead-end silently.
      if (evalCondition(rule.effect.per_item, { ...env, item: binding }) === 'T') matched.push(item.code);
    }
    current = applyMask(current, matched, rule.effect.mode);

    if (current.length === 0) {
      const whenEmpty = rule.effect.fallback.when_empty;
      if (whenEmpty === 'show_all') current = base;
      fallback = {
        question_id: questionId,
        axis,
        rule_id: rule.id,
        when_empty: whenEmpty,
        restored: whenEmpty === 'show_all',
      };
    }
  }

  if (fallback === undefined) st.fallbacks.delete(cellIdx);
  else st.fallbacks.set(cellIdx, fallback);
  return current;
}

function recomputeOption(
  program: CompiledLogic,
  cellIdx: CellIdx,
  optionId: string,
  prop: OptProp,
  env: ExprEnv,
  writers: TraceWriter[],
): boolean {
  const applied: boolean[] = [];
  for (const rule of rulesFor(program, cellIdx)) {
    if (rule.effect.action !== 'option_state') continue;
    const verdict = evalCondition(rule.condition, env);
    const collapse = collapseUnknown(rule.kind, verdict, rule.on_unknown);
    writers.push(traceWriter(rule.id, verdict, collapse));
    if (!collapse.fired) continue;
    const value = evalExpr(rule.effect.value, env);
    // A `U` *value* falls back to the authored literal default for the same reason a `U`
    // condition does: "the literal default is authored; unknown should not override it."
    if (value.k === 'bool') applied.push(value.v);
  }
  return optPropCombiner(prop)(program.baseOption(optionId, prop), applied);
}

/**
 * `valid` and `terminate` cells. Both are keyed by rule id, so each has exactly one writer by
 * construction — but the folds are opposites and getting them the same way round matters:
 *
 *  - `valid` is the **AND** of its validations, starting from *passes*. All errors are collected
 *    rather than short-circuited (D §4.6), which is why the fold does not break early.
 *  - `terminate` is the **OR** of its writers, starting from *does not fire*. Folding it with AND
 *    from `false` would make every termination unreachable — silently, and only in field.
 */
function recomputeFlag(
  program: CompiledLogic,
  cellIdx: CellIdx,
  env: ExprEnv,
  writers: TraceWriter[],
): boolean {
  const isValid = at(program.cells, cellIdx).c === 'valid';
  let result = isValid;
  for (const rule of rulesFor(program, cellIdx)) {
    const verdict = evalCondition(rule.condition, env);
    const collapse = collapseUnknown(rule.kind, verdict, rule.on_unknown);
    writers.push(traceWriter(rule.id, verdict, collapse));
    result = isValid ? result && collapse.fired : result || collapse.fired;
  }
  return result;
}

function recomputeFlow(
  program: CompiledLogic,
  cellIdx: CellIdx,
  env: ExprEnv,
  writers: TraceWriter[],
): string | null {
  let target: string | null = null;
  for (const rule of rulesFor(program, cellIdx)) {
    const action = rule.effect.action;
    if (action !== 'skip_to' && action !== 'skip_this') continue;
    const verdict = evalCondition(rule.condition, env);
    const collapse = collapseUnknown(rule.kind, verdict, rule.on_unknown);
    const fired = collapse.fired && target === null;
    writers.push({
      ...traceWriter(rule.id, verdict, collapse),
      ...(collapse.fired && target !== null ? { suppressed: true } : {}),
    });
    if (!fired) continue;
    // First writer in application order wins, and the rest are recorded as suppressed —
    // deterministic by construction, the same rule D §4.6 gives `terminate`.
    target = action === 'skip_to' ? rule.effect.node_id : (nodeIdOf(rule) ?? null);
  }
  return target;
}

function nodeIdOf(rule: Rule): string | undefined {
  return rule.target.type === 'survey' ? undefined : rule.target.id;
}

function rulesFor(program: CompiledLogic, cellIdx: CellIdx): readonly Rule[] {
  const indices = program.writers[cellIdx];
  if (indices === undefined) return [];
  const out: Rule[] = [];
  for (const index of indices) out.push(at(program.rules, index));
  return out;
}

/**
 * One trace row per writer. The collapse is recorded whenever it happened, because D §2.5 asks
 * for it explicitly: "a rule whose condition is `U` for most respondents is nearly always a bug
 * the author has not noticed yet", and the debug panel can only highlight what the trace carries.
 */
function traceWriter(ruleId: RuleId, verdict: Tri, collapse: Collapse | undefined): TraceWriter {
  const collapsed = collapse?.collapsed;
  return {
    rule_id: ruleId,
    verdict,
    ...(collapsed === undefined ? {} : { collapsed }),
  };
}

/* ========================================================================== */
/* Reading cells back                                                         */
/* ========================================================================== */

function reader(program: CompiledLogic, st: EvalState): CellReader {
  return {
    value: (id) => {
      const index = program.valueCell.get(id);
      if (index === undefined) return undefined;
      const cell = st.cells[index];
      return cell === undefined ? undefined : cellValueOf(cell);
    },
    visible: (nodeId) => {
      const index = program.visibleCell.get(nodeId);
      if (index === undefined) return undefined;
      const cell = st.cells[index];
      return cell === undefined ? undefined : cellBool(cell, true);
    },
    items: (questionId, axis) => {
      const index = program.itemsCell.get(itemsKey(questionId, axis));
      if (index === undefined) return undefined;
      return cellCodes(st.cells[index]);
    },
    option: (optionId, prop) => {
      const index = program.optCell.get(optionKey(optionId, prop));
      if (index === undefined) return undefined;
      const cell = st.cells[index];
      return cell === undefined ? undefined : cellBool(cell, true);
    },
    valid: (targetId) => {
      const indices = program.validCells.get(targetId);
      if (indices === undefined || indices.length === 0) return undefined;
      let seen = false;
      let all = true;
      for (const index of indices) {
        const cell = st.cells[index];
        if (cell === undefined) continue;
        seen = true;
        all = all && cellBool(cell, true);
      }
      return seen ? all : undefined;
    },
  };
}

/* ========================================================================== */
/* The verdict                                                                */
/* ========================================================================== */

function finalize(
  program: CompiledLogic,
  st: EvalState,
  trace: readonly TraceCell[],
  changes: readonly CellChange[],
): Verdict {
  const validations: ValidationFailure[] = [];
  let termination: Termination | undefined;
  const suppressed: RuleId[] = [];

  // Scanned in `topo` order rather than accumulated during the walk, because incremental
  // evaluation only visits a frontier: the winning termination is a property of the whole cell
  // state, not of the cells that happened to change this epoch.
  for (let position = 0; position < program.topo.length; position += 1) {
    const cellIdx = program.topo[position];
    if (cellIdx === undefined) continue;
    const cell = at(program.cells, cellIdx);
    const value = st.cells[cellIdx];
    if (value === undefined) continue;

    if (cell.c === 'valid' && !cellBool(value, true)) {
      const rule = program.rules.find((r) => r.id === cell.rule_id);
      if (rule !== undefined && rule.effect.action === 'require_valid') {
        validations.push({
          rule_id: rule.id,
          message_key: rule.effect.message_key,
          scope: rule.effect.scope,
          target: rule.target.type === 'survey' ? '' : rule.target.id,
        });
      }
    }

    if (cell.c === 'terminate' && cellBool(value, false)) {
      const rule = program.rules.find((r) => r.id === cell.rule_id);
      if (rule === undefined || rule.effect.action !== 'terminate') continue;
      if (termination === undefined) {
        termination = {
          rule_id: rule.id,
          disposition: rule.effect.disposition,
          ...(rule.effect.custom_key === undefined ? {} : { custom_key: rule.effect.custom_key }),
        };
      } else {
        suppressed.push(rule.id);
      }
    }
  }

  return {
    cells: st.cells,
    value: (id) => {
      const index = program.valueCell.get(id);
      const cell = index === undefined ? undefined : st.cells[index];
      return cell === undefined ? NULL : cellValueOf(cell);
    },
    visible: (nodeId) => {
      const index = program.visibleCell.get(nodeId);
      const cell = index === undefined ? undefined : st.cells[index];
      return cell === undefined ? program.baseVisible(nodeId) : cellBool(cell, true);
    },
    items: (questionId, axis) => {
      const index = program.itemsCell.get(itemsKey(questionId, axis));
      const cell = index === undefined ? undefined : st.cells[index];
      return cellCodes(cell) ?? program.baseItems(questionId, axis);
    },
    option: (optionId, prop) => {
      const index = program.optCell.get(optionKey(optionId, prop));
      const cell = index === undefined ? undefined : st.cells[index];
      return cell === undefined ? program.baseOption(optionId, prop) : cellBool(cell, true);
    },
    validations,
    termination,
    suppressedTerminations: suppressed,
    maskFallbacks: [...st.fallbacks.values()],
    changes,
    trace,
    state: st,
  };
}
