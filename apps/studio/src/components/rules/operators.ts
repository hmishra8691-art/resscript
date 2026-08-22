/**
 * The builder's leaf model: which operators a variable offers, and the AST a leaf builds.
 *
 * ## The constraint table is the CHECKER's, transcribed — not invented
 *
 * Every row below is traceable to a rule in `packages/logic/src/check.ts`, and the unit test
 * beside this file proves the transcription both ways (every offered operator type-checks;
 * every withheld one is withheld because the checker rejects it):
 *
 * | vtype        | offered                                            | checker rule |
 * |--------------|----------------------------------------------------|--------------|
 * | enum         | `=` `≠` (+ `<` `≤` `>` `≥` iff the domain is ordinal) | `checkEquality` (same domain), `checkOrdered` → LGC-T009 on a nominal domain — the top-2-box bug |
 * | number, date | `=` `≠` `<` `≤` `>` `≥`                              | `checkOrdered`: `ordered` is num, date |
 * | text         | `=` `≠`                                              | `checkOrdered` rejects text (LGC-T003): "lexicographic comparison of translated strings is never what an author means" |
 * | boolean      | `=` `≠`                                              | `typeEq` bool~bool |
 * | set          | `contains` `not contains` `any of` `none of` `all of` `subset of` `set =` | the `SetOp` cases; `not contains` is `not(contains(…))` — a builder spelling, not a new kind |
 * | object       | — (probes only)                                      | no comparison unifies an `obj` usefully |
 * | every vtype  | `answered` `not answered`                            | `probe : bool`, target `{kind:'variable'}` |
 *
 * ## Leaves build REAL ASTs
 *
 * `leafExpr` constructs through `astBuilder` — "P1-07's parser and P1-12's builder UI both
 * construct trees; this is the one place that decides what a well-formed node looks like, so
 * they cannot disagree" (build.ts's header). `leafOfExpr` is its inverse: the recognizer the
 * tree editor uses to decide whether a subtree gets controls or the read-only `ExprView`.
 */

import type { AstBuilder, CmpOp, Expr } from '@resscript/logic';

/* -------------------------------------------------------------------------- */
/* The variable, as the builder sees it                                       */
/* -------------------------------------------------------------------------- */

export type LeafVtype = 'enum' | 'boolean' | 'number' | 'text' | 'date' | 'set' | 'object';

export interface LeafVariable {
  readonly id: string;
  readonly name: string;
  readonly vtype: LeafVtype;
  /** Domain identity for enum/set — `dom_<question id>`, the same synthesis the server makes. */
  readonly domain?: string;
  /** True only when the domain is declared ordinal. 0007 has no column yet, so today: false. */
  readonly ordinal?: boolean;
  readonly options?: readonly { readonly code: number; readonly label: string }[];
}

/* -------------------------------------------------------------------------- */
/* Operators                                                                  */
/* -------------------------------------------------------------------------- */

export type LeafOperator =
  | CmpOp
  | 'answered'
  | 'not_answered'
  | 'contains'
  | 'not_contains'
  | 'any_of'
  | 'none_of'
  | 'all_of'
  | 'subset_of'
  | 'set_eq';

export const OPERATOR_LABELS: { readonly [K in LeafOperator]: string } = {
  '==': '=',
  '!=': '≠',
  '<': '<',
  '<=': '≤',
  '>': '>',
  '>=': '≥',
  answered: 'is answered',
  not_answered: 'is not answered',
  contains: 'contains',
  not_contains: 'does not contain',
  any_of: 'has any of',
  none_of: 'has none of',
  all_of: 'has all of',
  subset_of: 'is a subset of',
  set_eq: 'is exactly',
};

const EQ: readonly LeafOperator[] = ['==', '!='];
const ORDERED: readonly LeafOperator[] = ['<', '<=', '>', '>='];
const PROBES: readonly LeafOperator[] = ['answered', 'not_answered'];
const SET_OPS: readonly LeafOperator[] = [
  'contains',
  'not_contains',
  'any_of',
  'none_of',
  'all_of',
  'subset_of',
  'set_eq',
];

/** The dropdown for one variable. Never offers what the checker rejects. */
export function operatorsFor(variable: Pick<LeafVariable, 'vtype' | 'ordinal'>): readonly LeafOperator[] {
  switch (variable.vtype) {
    case 'enum':
      return variable.ordinal === true ? [...EQ, ...ORDERED, ...PROBES] : [...EQ, ...PROBES];
    case 'number':
    case 'date':
      return [...EQ, ...ORDERED, ...PROBES];
    case 'text':
    case 'boolean':
      return [...EQ, ...PROBES];
    case 'set':
      return [...SET_OPS, ...PROBES];
    case 'object':
      return [...PROBES];
    default: {
      const never: never = variable.vtype;
      throw new Error(`unhandled vtype ${JSON.stringify(never)}`);
    }
  }
}

/* -------------------------------------------------------------------------- */
/* The leaf                                                                   */
/* -------------------------------------------------------------------------- */

/** The value side of a leaf, typed by what the operator consumes. */
export type LeafValue =
  | { readonly k: 'none' }
  | { readonly k: 'num'; readonly v: number }
  | { readonly k: 'text'; readonly v: string }
  | { readonly k: 'bool'; readonly v: boolean }
  | { readonly k: 'date'; readonly v: string }
  | { readonly k: 'code'; readonly v: number }
  | { readonly k: 'codes'; readonly v: readonly number[] };

export interface Leaf {
  readonly variable_id: string;
  readonly operator: LeafOperator;
  readonly value: LeafValue;
}

/** A sensible starting leaf for a variable the author just picked. */
export function defaultLeaf(variable: LeafVariable): Leaf {
  const firstCode = variable.options?.[0]?.code ?? 1;
  switch (variable.vtype) {
    case 'enum':
      return { variable_id: variable.id, operator: '==', value: { k: 'code', v: firstCode } };
    case 'set':
      return { variable_id: variable.id, operator: 'contains', value: { k: 'code', v: firstCode } };
    case 'number':
      return { variable_id: variable.id, operator: '==', value: { k: 'num', v: 0 } };
    case 'boolean':
      return { variable_id: variable.id, operator: '==', value: { k: 'bool', v: true } };
    case 'date':
      return { variable_id: variable.id, operator: '==', value: { k: 'date', v: '2026-01-01' } };
    case 'text':
      return { variable_id: variable.id, operator: '==', value: { k: 'text', v: '' } };
    case 'object':
      return { variable_id: variable.id, operator: 'answered', value: { k: 'none' } };
    default: {
      const never: never = variable.vtype;
      throw new Error(`unhandled vtype ${JSON.stringify(never)}`);
    }
  }
}

/** Carry a leaf's value across an operator change, re-defaulting only when the SHAPE changes. */
export function valueForOperator(leaf: Leaf, next: LeafOperator, variable: LeafVariable): LeafValue {
  if (next === 'answered' || next === 'not_answered') return { k: 'none' };
  const wantsCodes = next === 'any_of' || next === 'none_of' || next === 'all_of' || next === 'subset_of' || next === 'set_eq';
  if (wantsCodes) {
    if (leaf.value.k === 'codes') return leaf.value;
    if (leaf.value.k === 'code') return { k: 'codes', v: [leaf.value.v] };
    return { k: 'codes', v: [variable.options?.[0]?.code ?? 1] };
  }
  if (next === 'contains' || next === 'not_contains') {
    if (leaf.value.k === 'code') return leaf.value;
    if (leaf.value.k === 'codes') return { k: 'code', v: leaf.value.v[0] ?? 1 };
    return { k: 'code', v: variable.options?.[0]?.code ?? 1 };
  }
  // A comparison: keep the value when it already matches the variable's shape.
  if (leaf.value.k !== 'none' && leaf.value.k !== 'codes') return leaf.value;
  return defaultLeaf(variable).value;
}

/* -------------------------------------------------------------------------- */
/* leaf → AST                                                                 */
/* -------------------------------------------------------------------------- */

function literalFor(value: LeafValue, variable: LeafVariable, b: AstBuilder): Expr {
  switch (value.k) {
    case 'num':
      return b.numLit(value.v);
    case 'text':
      return b.textLit(value.v);
    case 'bool':
      return b.boolLit(value.v);
    case 'date':
      return b.dateLit(value.v);
    case 'code':
      // An enum literal needs its NOMINAL domain (D §2.2) — the same identity the server's
      // registry mapper synthesizes, or the checker reports LGC-T007 on our own leaf.
      return variable.domain === undefined ? b.numLit(value.v) : b.enumLit(value.v, variable.domain as never);
    case 'codes':
      return variable.domain === undefined
        ? b.numLit(value.v[0] ?? 0)
        : b.setLit(value.v, variable.domain as never);
    case 'none':
      return b.nullLit();
    default: {
      const never: never = value;
      throw new Error(`unhandled leaf value ${JSON.stringify(never)}`);
    }
  }
}

export function leafExpr(leaf: Leaf, variable: LeafVariable, b: AstBuilder): Expr {
  const probe = (): Expr => b.probe('answered', { kind: 'variable', id: variable.id as never });
  switch (leaf.operator) {
    case 'answered':
      return probe();
    case 'not_answered':
      return b.not(probe());
    case 'contains':
      return b.setOp('contains', b.variable(variable.id as never), literalFor(leaf.value, variable, b));
    case 'not_contains':
      return b.not(
        b.setOp('contains', b.variable(variable.id as never), literalFor(leaf.value, variable, b)),
      );
    case 'any_of':
    case 'none_of':
    case 'all_of':
    case 'subset_of':
    case 'set_eq':
      return b.setOp(leaf.operator, b.variable(variable.id as never), literalFor(leaf.value, variable, b));
    default:
      return b.cmp(leaf.operator, b.variable(variable.id as never), literalFor(leaf.value, variable, b));
  }
}

/* -------------------------------------------------------------------------- */
/* AST → leaf (the recognizer)                                                */
/* -------------------------------------------------------------------------- */

function valueOfLiteral(expr: Expr): LeafValue | undefined {
  if (expr.op !== 'lit') return undefined;
  switch (expr.v.k) {
    case 'num':
      return { k: 'num', v: expr.v.v };
    case 'text':
      return { k: 'text', v: expr.v.v };
    case 'bool':
      return { k: 'bool', v: expr.v.v };
    case 'date':
      return { k: 'date', v: expr.v.v };
    case 'enum':
      return { k: 'code', v: expr.v.v };
    case 'set':
      return { k: 'codes', v: expr.v.v };
    default:
      return undefined;
  }
}

/**
 * Recognize `var OP lit`, `var setop lit`, `ANSWERED(var)` and the negations the builder
 * itself writes. Anything else — a nested arithmetic left side, an `agg`, `var OP var` —
 * returns `undefined` and renders read-only. Deliberately narrow: a recognizer that guessed
 * would round-trip a rule into a DIFFERENT rule, which is the one unforgivable failure here.
 */
export function leafOfExpr(expr: Expr): Leaf | undefined {
  if (expr.op === 'probe') {
    if (expr.kind !== 'answered' || expr.target.kind !== 'variable') return undefined;
    return { variable_id: expr.target.id, operator: 'answered', value: { k: 'none' } };
  }
  if (expr.op === 'not') {
    const inner = expr.args[0];
    const leaf = leafOfExpr(inner);
    if (leaf === undefined) return undefined;
    if (leaf.operator === 'answered') return { ...leaf, operator: 'not_answered' };
    if (leaf.operator === 'contains') return { ...leaf, operator: 'not_contains' };
    return undefined;
  }
  const comparison =
    expr.op === '==' || expr.op === '!=' || expr.op === '<' || expr.op === '<=' || expr.op === '>' || expr.op === '>=';
  const setOperator =
    expr.op === 'contains' ||
    expr.op === 'any_of' ||
    expr.op === 'none_of' ||
    expr.op === 'all_of' ||
    expr.op === 'subset_of' ||
    expr.op === 'set_eq';
  if (!comparison && !setOperator) return undefined;
  const [left, right] = (expr as { readonly args: readonly [Expr, Expr] }).args;
  if (left.op !== 'var') return undefined;
  const value = valueOfLiteral(right);
  if (value === undefined) return undefined;
  return { variable_id: left.var, operator: expr.op as LeafOperator, value };
}
