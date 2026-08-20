/**
 * Kleene strong three-valued logic — D §2.5.
 *
 * This is the most bug-prone area in every survey platform, and the reason is that the wrong
 * answer is *cheap*: coerce null to `false` at read time and everything appears to work until
 * `NOT` flips it and a thousand respondents get terminated on a question they never saw.
 *
 * So: `U` is a first-class truth value inside expressions, it is absorbed by a decisive
 * operand (`F AND U = F`, `T OR U = T`), and it collapses exactly once — at the rule
 * boundary, in the safe direction for that rule kind (see `collapseUnknown` in rules.ts).
 *
 * The truth tables from D §2.5, reproduced as data rather than as `if` chains so that the
 * tests can assert them cell by cell and so that reading this file is reading the spec:
 *
 *     AND    | F  U  T        OR     | F  U  T        NOT
 *     -------+---------       -------+---------       -----
 *        F   | F  F  F           F   | F  U  T          F | T
 *        U   | F  U  U           U   | U  U  T          U | U
 *        T   | F  U  T           T   | T  T  T          T | F
 */

import { LogicInvariant } from './ids.js';
import { FALSE, NULL, TRUE, type Value } from './value.js';

/** The three truth values. Spelled as in the trace format (E §14.2: `'T' | 'F' | 'U'`). */
export type Tri = 'T' | 'F' | 'U';

export const TRI_VALUES: readonly Tri[] = ['F', 'U', 'T'];

const INDEX: { readonly [K in Tri]: 0 | 1 | 2 } = { F: 0, U: 1, T: 2 };

/** Row = left operand (F,U,T), column = right operand (F,U,T). */
const AND_TABLE: readonly (readonly Tri[])[] = [
  ['F', 'F', 'F'],
  ['F', 'U', 'U'],
  ['F', 'U', 'T'],
];

const OR_TABLE: readonly (readonly Tri[])[] = [
  ['F', 'U', 'T'],
  ['U', 'U', 'T'],
  ['T', 'T', 'T'],
];

const NOT_TABLE: { readonly [K in Tri]: Tri } = { F: 'T', U: 'U', T: 'F' };

function cell(table: readonly (readonly Tri[])[], a: Tri, b: Tri): Tri {
  const row = table[INDEX[a]];
  const value = row?.[INDEX[b]];
  if (value === undefined) throw new LogicInvariant(`truth table hole at (${a},${b})`);
  return value;
}

export function and3(a: Tri, b: Tri): Tri {
  return cell(AND_TABLE, a, b);
}

export function or3(a: Tri, b: Tri): Tri {
  return cell(OR_TABLE, a, b);
}

export function not3(a: Tri): Tri {
  return NOT_TABLE[a];
}

/**
 * n-ary fold. `and`/`or` are n-ary in the AST (D §2.3) and both are associative and
 * commutative under these tables, which is what licenses the optimizer to flatten and
 * reorder them (D §10.1). The fold order therefore cannot change the result — asserted by
 * a property test rather than assumed.
 */
export function andAll(values: readonly Tri[]): Tri {
  let acc: Tri = 'T';
  for (const v of values) {
    acc = and3(acc, v);
    if (acc === 'F') return 'F'; // absorbing: short-circuit is legal on F, never on U
  }
  return acc;
}

export function orAll(values: readonly Tri[]): Tri {
  let acc: Tri = 'F';
  for (const v of values) {
    acc = or3(acc, v);
    if (acc === 'T') return 'T'; // absorbing: short-circuit is legal on T, never on U
  }
  return acc;
}

/**
 * Value ⇄ Tri.
 *
 * The evaluator carries three-valued booleans as `Value` (`{k:'bool'}` or `{k:'null'}`)
 * rather than as `Tri`, so that one uniform `Value` flows through every node and the memo
 * table needs one slot type. `Tri` exists at the two boundaries where three-valuedness is
 * the subject: the truth tables here, and the collapse at the rule boundary.
 */
export function triOf(v: Value): Tri {
  switch (v.k) {
    case 'bool':
      return v.v ? 'T' : 'F';
    case 'null':
      return 'U';
    default:
      // The checker guarantees rule conditions and boolean operands are bool-typed; anything
      // else here is a compiler bug, not user input (D §1).
      throw new LogicInvariant(`expected a boolean or null value, got ${v.k}`);
  }
}

export function triToValue(t: Tri): Value {
  switch (t) {
    case 'T':
      return TRUE;
    case 'F':
      return FALSE;
    case 'U':
      return NULL;
    default: {
      const never: never = t;
      throw new LogicInvariant(`unhandled truth value ${JSON.stringify(never)}`);
    }
  }
}
