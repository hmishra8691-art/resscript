/**
 * The value model — D §2.2.
 *
 * Two deliberate choices carried straight from the spec, because both are load-bearing:
 *
 *  - **enums carry their domain at runtime** (`d: DomainId`), so `Q3 == Q4` between two
 *    questions that both happen to use codes 1..5 is caught even when the checker was
 *    bypassed (a hand-edited artifact, an older schema version). Enum values are *nominal*.
 *  - **sets are sorted, deduped code arrays**, so set equality is an array walk with no
 *    allocation and no ordering ambiguity, and so a `set` printed into a trace is stable.
 *
 * `null` is one value, not two (D §2.5 rejects distinct `UNANSWERED`/`NOT_SHOWN` bottoms).
 * Provenance lives beside the state, reachable through `probe`, not inside the value.
 */

import type { DomainId } from './ids.js';
import { LogicInvariant } from './ids.js';

export type Value =
  | { readonly k: 'null' }
  | { readonly k: 'bool'; readonly v: boolean }
  | { readonly k: 'num'; readonly v: number }
  | { readonly k: 'text'; readonly v: string }
  | { readonly k: 'date'; readonly v: string }
  | { readonly k: 'enum'; readonly v: number; readonly d: DomainId }
  | { readonly k: 'set'; readonly v: readonly number[]; readonly d: DomainId }
  | { readonly k: 'obj'; readonly v: { readonly [key: string]: Value } };

export type ValueKind = Value['k'];

/**
 * Interned singletons. D §10.3 forbids per-node allocation on the steady-state path, and
 * `null`/`true`/`false` are the overwhelming majority of intermediate values in a condition
 * tree, so they are shared rather than constructed.
 */
export const NULL: Value = { k: 'null' };
export const TRUE: Value = { k: 'bool', v: true };
export const FALSE: Value = { k: 'bool', v: false };

/** Small non-negative integers, interned for the same reason (`COUNT` results, codes). */
const SMALL_NUMS: readonly Value[] = Array.from({ length: 129 }, (_, i) => ({ k: 'num', v: i }));

export function bool(v: boolean): Value {
  return v ? TRUE : FALSE;
}

export function num(v: number): Value {
  if (!Number.isFinite(v)) {
    // D §2.2: "finite; NaN/Inf are invariant errors". A NaN that escapes into a VarState is
    // how a comparison silently becomes false everywhere, so it is caught at construction.
    throw new LogicInvariant(`non-finite number ${String(v)}`);
  }
  if (Number.isInteger(v) && v >= 0 && v < SMALL_NUMS.length) {
    const interned = SMALL_NUMS[v];
    if (interned !== undefined) return interned;
  }
  return { k: 'num', v };
}

export function text(v: string): Value {
  return { k: 'text', v };
}

export function date(v: string): Value {
  return { k: 'date', v };
}

export function enumValue(code: number, d: DomainId): Value {
  return { k: 'enum', v: code, d };
}

/** Normalizing constructor: sorted ascending, deduped. The only way to build a set value. */
export function setValue(codes: readonly number[], d: DomainId): Value {
  return { k: 'set', v: normalizeCodes(codes), d };
}

export function objValue(fields: { readonly [key: string]: Value }): Value {
  return { k: 'obj', v: fields };
}

export function normalizeCodes(codes: readonly number[]): readonly number[] {
  if (codes.length === 0) return EMPTY_CODES;
  const sorted = [...codes].sort((a, b) => a - b);
  const out: number[] = [];
  let previous: number | undefined;
  for (const code of sorted) {
    if (code !== previous) {
      out.push(code);
      previous = code;
    }
  }
  return out;
}

export const EMPTY_CODES: readonly number[] = [];

export function isNull(v: Value): boolean {
  return v.k === 'null';
}

/**
 * Structural equality.
 *
 * This is the predicate behind value-equality pruning (D §5.3), which is "the whole game"
 * for the incremental budget, so it must be exact: `enum 1 of dom_a` is not equal to
 * `enum 1 of dom_b`, and `{1,2}` is equal to `{1,2}` by element walk rather than by
 * reference. Two nulls are equal — that is what stops a null-to-null recompute cascading.
 */
export function valueEq(a: Value, b: Value): boolean {
  if (a === b) return true;
  if (a.k !== b.k) return false;
  switch (a.k) {
    case 'null':
      return true;
    case 'bool':
      return a.v === (b as { readonly v: boolean }).v;
    case 'num':
      return a.v === (b as { readonly v: number }).v;
    case 'text':
    case 'date':
      return a.v === (b as { readonly v: string }).v;
    case 'enum': {
      const other = b as { readonly v: number; readonly d: DomainId };
      return a.v === other.v && a.d === other.d;
    }
    case 'set': {
      const other = b as { readonly v: readonly number[]; readonly d: DomainId };
      if (a.d !== other.d || a.v.length !== other.v.length) return false;
      for (let i = 0; i < a.v.length; i += 1) {
        if (a.v[i] !== other.v[i]) return false;
      }
      return true;
    }
    case 'obj': {
      const other = b as { readonly v: { readonly [key: string]: Value } };
      const aKeys = Object.keys(a.v).sort();
      const bKeys = Object.keys(other.v).sort();
      if (aKeys.length !== bKeys.length) return false;
      for (let i = 0; i < aKeys.length; i += 1) {
        const key = aKeys[i];
        if (key === undefined || key !== bKeys[i]) return false;
        const left = a.v[key];
        const right = other.v[key];
        if (left === undefined || right === undefined) return false;
        if (!valueEq(left, right)) return false;
      }
      return true;
    }
    default: {
      const never: never = a;
      throw new LogicInvariant(`unhandled value kind ${JSON.stringify(never)}`);
    }
  }
}

/**
 * Ordering for `<`, `<=`, `>`, `>=`, `min`, `max`. Returns `undefined` when the pair is not
 * ordered — the checker rejects those, so `undefined` at runtime is an invariant failure the
 * caller reports with node context.
 */
export function compareValues(a: Value, b: Value): number | undefined {
  if (a.k === 'num' && b.k === 'num') return a.v - b.v;
  if (a.k === 'date' && b.k === 'date') return a.v < b.v ? -1 : a.v > b.v ? 1 : 0;
  if (a.k === 'enum' && b.k === 'enum' && a.d === b.d) return a.v - b.v;
  if (a.k === 'text' && b.k === 'text') return a.v < b.v ? -1 : a.v > b.v ? 1 : 0;
  return undefined;
}

/** A stable, human-readable rendering for diagnostics and traces. Never used for logic. */
export function formatValue(v: Value): string {
  switch (v.k) {
    case 'null':
      return 'null';
    case 'bool':
      return v.v ? 'TRUE' : 'FALSE';
    case 'num':
      return String(v.v);
    case 'text':
      return JSON.stringify(v.v);
    case 'date':
      return v.v;
    case 'enum':
      return `${String(v.v)}`;
    case 'set':
      return `{${v.v.map((c) => String(c)).join(',')}}`;
    case 'obj':
      return `{${Object.keys(v.v)
        .sort()
        .map((key) => {
          const field = v.v[key];
          return `${key}: ${field === undefined ? 'null' : formatValue(field)}`;
        })
        .join(', ')}}`;
    default: {
      const never: never = v;
      throw new LogicInvariant(`unhandled value kind ${JSON.stringify(never)}`);
    }
  }
}

/**
 * The JSON projection used in traces (E §14.2 `value: unknown`). Deliberately lossy for
 * enums — the debug panel resolves labels from the domain, so the trace carries the code.
 */
export function valueToJson(v: Value): unknown {
  switch (v.k) {
    case 'null':
      return null;
    case 'bool':
    case 'num':
    case 'text':
    case 'date':
      return v.v;
    case 'enum':
      return v.v;
    case 'set':
      return [...v.v];
    case 'obj': {
      const out: { [key: string]: unknown } = {};
      for (const key of Object.keys(v.v).sort()) {
        const field = v.v[key];
        out[key] = field === undefined ? null : valueToJson(field);
      }
      return out;
    }
    default: {
      const never: never = v;
      throw new LogicInvariant(`unhandled value kind ${JSON.stringify(never)}`);
    }
  }
}
