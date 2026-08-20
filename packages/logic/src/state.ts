/**
 * The engine's two inputs — D §1: `evaluate(program, state, ctx)`.
 *
 * `EvalContext` carries only pure data: the resolved label map (for piping), the item orders
 * the randomizer already computed, and a trace sink. No handles, no promises, no clock
 * (D §2.6), no entropy (ADR-006). That is the whole reason ADR-004's "identical verdict on
 * client and server" is checkable at all: if the engine reads anything not in these two
 * arguments, divergence becomes noise, the divergence alert gets muted, and it stops catching
 * real bugs.
 *
 * The cell store (`EvalState`) is deliberately *caller-owned* and mutated in place. Purity
 * here means referential transparency with respect to `(VarState, EvalContext)` — not the
 * absence of local mutation. D §5.3's algorithm needs an epoch counter and O(1) memo
 * invalidation, which is a mutable accumulator by construction; making it an argument rather
 * than module state keeps two concurrent sessions in one process independent, which hidden
 * module state would not.
 */

import type { MaskAxis } from './rules.js';
import type { PageId, QuestionId, RuleId, VariableId } from './ids.js';
import { LogicInvariant } from './ids.js';
import { NULL, valueEq, type Value } from './value.js';

/**
 * Where a variable's value came from — E §3.2, restated (this package cannot import the
 * runtime, and the runtime cannot import a type it needs to hand *to* the engine).
 *
 * The engine reads exactly one thing from it: whether the value was invalidated by a
 * back-navigation, because an invalidated cell must not read as "answered" (E §7.2). Everything
 * else in the union exists so the trace can say who set a value without a second lookup.
 */
export type Provenance =
  | { readonly p: 'respondent'; readonly page_id: PageId; readonly visit: number }
  | { readonly p: 'entry_param'; readonly param: string }
  | { readonly p: 'derived'; readonly rule_id: RuleId }
  | { readonly p: 'set_variable'; readonly rule_id: RuleId }
  | { readonly p: 'script'; readonly asset_ref: string }
  | { readonly p: 'system' }
  | { readonly p: 'quota' }
  | { readonly p: 'design' }
  | { readonly p: 'invalidated'; readonly by_page: PageId; readonly at: number };

/**
 * The respondent's answers. `value(id)` returns `NULL` for anything unset — reading an unset
 * variable is the *normal* case in a branched survey (D §2.5 rejects "throw on null read"),
 * so it cannot be an error.
 */
export interface VarState {
  readonly value: (id: VariableId) => Value;
  readonly provenance?: (id: VariableId) => Provenance | undefined;
}

/** Facts about the session that `probe` reads and no expression can (D §2.3). */
export interface SessionFacts {
  /** True when the page was submitted, which is what separates `asked` from `shown`. */
  readonly pageSubmitted?: (id: PageId) => boolean;
}

export interface EvalContext extends SessionFacts {
  /**
   * Resolved i18n labels, keyed by `label_key`. Pure data: the compiler resolved the bundle
   * for the session's language before evaluation, so `label_of` is a map read and the engine
   * never knows a language exists.
   */
  readonly labels?: { readonly [labelKey: string]: string };
  /**
   * Item display orders already computed by `runtime-core`'s seeded PRNG (ADR-006), keyed by
   * `orderScope(question, axis)`, each value the item *codes* in display order. The engine
   * never shuffles; `item_attr:'position'` reads this. Replaying a seed therefore replays the
   * logic exactly, which is what makes "the client says the rotation is wrong" debuggable.
   */
  readonly orders?: { readonly [scope: string]: readonly number[] };
  readonly trace?: TraceSink;
}

export function orderScope(questionId: QuestionId, axis: MaskAxis): string {
  return `${questionId}.${axis}`;
}

/** A `VarState` over a plain record. The runtime's session `vars` is exactly this shape. */
export function varStateOf(
  values: { readonly [id: string]: Value },
  provenance?: { readonly [id: string]: Provenance },
): VarState {
  const read = (id: VariableId): Value => values[id] ?? NULL;
  if (provenance === undefined) return { value: read };
  return { value: read, provenance: (id) => provenance[id] };
}

/* ========================================================================== */
/* Cell values                                                                */
/* ========================================================================== */

/**
 * What a cell holds. Four shapes, one per cell family:
 *
 *  - `val`    — `value` cells: a variable's current value.
 *  - `bool`   — `visible`, `opt`, `valid`, `terminate`: two-valued *by construction*, because
 *               the collapse at the rule boundary (D §2.5) already happened. A three-valued
 *               cell would be three-valued logic leaking past its one coercion point.
 *  - `codes`  — `items` cells: the surviving item codes after masks, in canonical order.
 *  - `target` — `flow` cells: the selected skip target, or `null` for "no skip".
 */
export type CellValue =
  | { readonly c: 'val'; readonly value: Value }
  | { readonly c: 'bool'; readonly on: boolean }
  | { readonly c: 'codes'; readonly codes: readonly number[] }
  | { readonly c: 'target'; readonly node_id: string | null };

export function cellValueEq(a: CellValue | undefined, b: CellValue | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  if (a.c !== b.c) return false;
  switch (a.c) {
    case 'val':
      return valueEq(a.value, (b as { readonly value: Value }).value);
    case 'bool':
      return a.on === (b as { readonly on: boolean }).on;
    case 'codes': {
      const other = (b as { readonly codes: readonly number[] }).codes;
      if (a.codes.length !== other.length) return false;
      for (let i = 0; i < a.codes.length; i += 1) if (a.codes[i] !== other[i]) return false;
      return true;
    }
    case 'target':
      return a.node_id === (b as { readonly node_id: string | null }).node_id;
    default: {
      const never: never = a;
      throw new LogicInvariant(`unhandled cell value ${JSON.stringify(never)}`);
    }
  }
}

export function boolCell(on: boolean): CellValue {
  return { c: 'bool', on };
}

/** Read a `bool` cell, with the caller's default when the cell has not been computed yet. */
export function cellBool(value: CellValue | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (value.c !== 'bool') throw new LogicInvariant(`expected a boolean cell, got ${value.c}`);
  return value.on;
}

export function cellValueOf(value: CellValue | undefined): Value {
  if (value === undefined) return NULL;
  if (value.c !== 'val') throw new LogicInvariant(`expected a value cell, got ${value.c}`);
  return value.value;
}

export function cellCodes(value: CellValue | undefined): readonly number[] | undefined {
  if (value === undefined) return undefined;
  if (value.c !== 'codes') throw new LogicInvariant(`expected an items cell, got ${value.c}`);
  return value.codes;
}

/* ========================================================================== */
/* The evaluation accumulator                                                 */
/* ========================================================================== */

/**
 * Per-evaluation mutable state: the cell values and the memo table.
 *
 * `epoch` is bumped once per evaluation so the memo table is invalidated in O(1) rather than
 * cleared (D §5.4). A stamp of `-1` can never equal a non-negative epoch, which is why the
 * epoch starts at 0 and the stamps start at -1.
 */
export interface EvalState {
  epoch: number;
  readonly cells: (CellValue | undefined)[];
  readonly memoStamp: Int32Array;
  readonly memoSlot: (Value | undefined)[];
  /**
   * Which `items` cells emptied out and what their mask's `fallback.when_empty` says to do.
   *
   * It lives on the state rather than in the returned verdict because incremental evaluation only
   * recomputes a frontier (D §5.3): a mask that dead-ended on page entry is still dead-ended
   * after a keystroke elsewhere, and the runtime must still be told about it. Recomputing it from
   * the cell value alone is impossible — an empty item list and a mask that produced an empty
   * item list are different facts.
   */
  readonly fallbacks: Map<number, MaskFallback>;
}

/** A mask that emptied its axis, and the authored escape (schema §15, D §4.2). */
export interface MaskFallback {
  readonly question_id: QuestionId;
  readonly axis: MaskAxis;
  readonly rule_id: RuleId;
  readonly when_empty: 'skip_question' | 'show_all' | 'terminate';
  /** True when `show_all` restored the base list, so the question is not actually empty. */
  readonly restored: boolean;
}

export function createEvalState(cellCount: number, nodeCount: number): EvalState {
  return {
    epoch: 0,
    cells: new Array<CellValue | undefined>(cellCount).fill(undefined),
    memoStamp: new Int32Array(nodeCount).fill(-1),
    memoSlot: new Array<Value | undefined>(nodeCount).fill(undefined),
    fallbacks: new Map<number, MaskFallback>(),
  };
}

/* ========================================================================== */
/* Trace                                                                      */
/* ========================================================================== */

/**
 * The trace, shaped after E §14.2's `LogicTrace.cells`.
 *
 * The engine emits the part it can know. `condition_src` (pretty-printed ResScript) is absent
 * because the printer is P1-07 and lives in another package; the trace carries `rule_id` and
 * the node ids, which is what the debug panel needs to ask the printer for source. Emitting a
 * half-rendered source string here would create a second, drifting printer.
 */
export interface TraceWriter {
  readonly rule_id: RuleId;
  readonly verdict: 'T' | 'F' | 'U' | 'skipped';
  readonly collapsed?: { readonly from: 'U'; readonly to: boolean; readonly reason: string };
  /** True when this writer's effect was recorded but not applied (a suppressed terminate). */
  readonly suppressed?: boolean;
}

export interface TraceCell {
  readonly cell: string;
  readonly topo_pos: number;
  readonly writers: readonly TraceWriter[];
  readonly result: CellValue;
  /** `false` = value-equality pruning stopped propagation here (D §5.3). */
  readonly changed: boolean;
}

export interface TraceSink {
  readonly cell: (entry: TraceCell) => void;
}

/** Collects trace entries into an array. The runtime supplies a streaming sink instead. */
export function collectingTrace(): TraceSink & { readonly entries: readonly TraceCell[] } {
  const entries: TraceCell[] = [];
  return {
    entries,
    cell: (entry) => {
      entries.push(entry);
    },
  };
}

