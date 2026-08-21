/**
 * Which operators are legal after a given operand — 09-ui §7.4: "after a variable you get **only
 * the operators legal for its type**. Completion that offers an illegal operator teaches the user
 * wrong."
 *
 * ## Derived from the checker, not from a table
 *
 * §7.1 is explicit that "the type checker's inference rules generate the dropdown contents; they
 * are not a duplicated table". So this module does not encode D §3.3's inference rules. It builds
 * a throwaway two-operand expression per candidate operator and asks `checkExpr` whether it is
 * legal. That costs a handful of microseconds per keystroke and buys the one property a table
 * cannot have: when a rule changes in `packages/logic`, this follows.
 *
 * The rule it gets right for free is the one that matters most in practice — `<` on a *nominal*
 * enum domain is `LGC-T009` (D §3.3's "top 2 box on a brand list" bug), so `<` is offered on a
 * Likert scale and withheld on a brand list without this file knowing what ordinality is.
 *
 * ## What is offered, and what is deliberately not
 *
 * Only the **infix** spellings: `= <> < <= > >= CONTAINS ANY OF ALL OF NONE OF BETWEEN`.
 * `SET_EQ`, `SUBSET_OF`, `UNION`, `INTERSECT` and `DIFFERENCE` are AST kinds with no infix syntax
 * (printer.ts prints them as calls; rescript-dsl README open decision 11), so they are not
 * completions at an *operator* position — offering `SET_EQ` where the cursor expects an infix
 * operator would insert something that cannot parse there. They belong to a call completion,
 * which is a separate position and a later milestone.
 */

import type { Expr, Type, TypeEnv } from '@resscript/logic';
import { astBuilder, checkExpr } from '@resscript/logic';

export interface OperatorSurface {
  /** The DSL spelling, which is also the completion label and the inserted text. */
  readonly label: string;
  /** How the builder phrases the same operator (§7.2), used as Monaco's `detail`. */
  readonly phrasing: string;
  /** The type rule and the null behaviour — §7.4's operator hover. */
  readonly documentation: string;
}

interface Candidate extends OperatorSurface {
  /** Builds a probe expression from a left operand of the type under test. */
  readonly probe: (left: Expr, rightOf: (type: Type) => Expr, b: ReturnType<typeof astBuilder>) => Expr;
}

/**
 * The null note on every entry is not decoration: D §2.5 says null semantics are "the single most
 * common source of wrong logic", and §7.4 puts the null-propagation behaviour in the operator
 * hover for exactly that reason. `NONE OF` carries the asymmetry warning because that is the trap
 * D §2.5 names by hand.
 */
const CANDIDATES: readonly Candidate[] = [
  {
    label: '=',
    phrasing: 'is',
    documentation: 'Equality. Both operands must have the same type; enum domains are nominal, so `Q3 = Q4` across two option lists is LGC-T007. A null operand makes the comparison UNKNOWN, never false.',
    probe: (left, rightOf, b) => b.cmp('==', left, rightOf(typeOfProbe(left))),
  },
  {
    label: '<>',
    phrasing: 'is not',
    documentation: 'Inequality. `NULL <> 5` is UNKNOWN, not true — D §2.5.',
    probe: (left, rightOf, b) => b.cmp('!=', left, rightOf(typeOfProbe(left))),
  },
  {
    label: '<',
    phrasing: 'is less than',
    documentation: 'Ordered comparison. Legal on numbers, dates and *ordinal* enum domains only; `<` on a nominal domain (a brand list) is LGC-T009.',
    probe: (left, rightOf, b) => b.cmp('<', left, rightOf(typeOfProbe(left))),
  },
  {
    label: '<=',
    phrasing: 'is at most',
    documentation: 'Ordered comparison. See `<`.',
    probe: (left, rightOf, b) => b.cmp('<=', left, rightOf(typeOfProbe(left))),
  },
  {
    label: '>',
    phrasing: 'is more than',
    documentation: 'Ordered comparison. See `<`.',
    probe: (left, rightOf, b) => b.cmp('>', left, rightOf(typeOfProbe(left))),
  },
  {
    label: '>=',
    phrasing: 'is at least',
    documentation: 'Ordered comparison. See `<`.',
    probe: (left, rightOf, b) => b.cmp('>=', left, rightOf(typeOfProbe(left))),
  },
  {
    label: 'BETWEEN',
    phrasing: 'is between',
    documentation: 'Inclusive range: `AGE BETWEEN 18 AND 24`. Sugar for two ordered comparisons, so it has the same type rule and the same UNKNOWN behaviour.',
    probe: (left, rightOf, b) =>
      b.and(b.cmp('>=', left, rightOf(typeOfProbe(left))), b.cmp('<=', left, rightOf(typeOfProbe(left)))),
  },
  {
    label: 'CONTAINS',
    phrasing: 'contains',
    documentation: 'Set membership: the left operand is a set and the right a single code from the *same* domain. UNKNOWN when the set is null; an answered multi-select with nothing checked is an empty set, not null, and `CONTAINS` on it is false.',
    probe: (left, _rightOf, b) => b.setOp('contains', left, elementLit(left, b)),
  },
  {
    label: 'ANY OF',
    phrasing: 'is one of',
    documentation: 'True when the operands share at least one code. UNKNOWN when the left operand is null.',
    probe: (left, _rightOf, b) => b.setOp('any_of', left, setLitFor(left, b)),
  },
  {
    label: 'ALL OF',
    phrasing: 'includes all of',
    documentation: 'True when the left set contains every listed code.',
    probe: (left, _rightOf, b) => b.setOp('all_of', left, setLitFor(left, b)),
  },
  {
    label: 'NONE OF',
    phrasing: 'is none of',
    documentation: 'True when the operands share no code. **UNKNOWN — not true — when the left operand is null** (D §2.5): "never saw the question" must not satisfy "selected none of these".',
    probe: (left, _rightOf, b) => b.setOp('none_of', left, setLitFor(left, b)),
  },
];

/**
 * The candidates the checker accepts for `leftType`.
 *
 * With no `leftType` (the cursor is after a question ref, or after something the registry cannot
 * type) every candidate is returned: at that point the honest answer is "any of these might be
 * legal", and withholding them all would leave the author with an empty list where the language
 * has ten operators.
 */
export function legalOperatorsFor(
  leftType: Type | undefined,
  env: TypeEnv,
): readonly OperatorSurface[] {
  if (leftType === undefined) return CANDIDATES.map(surface);
  return CANDIDATES.filter((candidate) => {
    const b = astBuilder(1);
    const left = literalOf(leftType, b);
    if (left === undefined) return false;
    let probe: Expr;
    try {
      probe = candidate.probe(left, (type) => literalOf(type, b) ?? b.nullLit(), b);
    } catch {
      // A candidate that cannot even be built for this operand type is not legal for it. This is
      // reachable for `CONTAINS` against a non-set left operand, where there is no element domain.
      return false;
    }
    const { diagnostics } = checkExpr(probe, env);
    // Errors only. A warning (`LGC-W030`, "provably constant") is exactly what a probe over two
    // literals produces, and filtering on it would return an empty operator list every time.
    return !diagnostics.some((d) => d.severity === 'error');
  }).map(surface);
}

/**
 * Kleene's three-valued connectives (D §2.5). These are hovered more often than anything else in
 * the language, because `F AND U = F` is the property that makes real screeners work and nothing
 * in the syntax hints at it.
 */
const BOOLEAN_DOCS: { readonly [token: string]: OperatorSurface } = {
  AND: {
    label: 'AND',
    phrasing: 'all of',
    documentation:
      'Kleene AND, n-ary. `F AND U = F` — a decisive operand absorbs UNKNOWN, so `S1 = 1 AND Q9 > 3` is cleanly false for someone screened out at S1, with no guard needed on Q9.',
  },
  OR: {
    label: 'OR',
    phrasing: 'any of',
    documentation: 'Kleene OR, n-ary. `T OR U = T`; `F OR U = U`.',
  },
  NOT: {
    label: 'NOT',
    phrasing: 'not',
    documentation:
      'Kleene NOT. `NOT UNKNOWN` is UNKNOWN, **not** true — which is why "terminate under-18" does not fire for a respondent who never saw the age question.',
  },
};

/** Token spellings the parser accepts → the operator they mean. D §6.2's synonyms included. */
const TOKEN_TO_LABEL: { readonly [token: string]: string } = {
  '=': '=',
  '==': '=',
  '<>': '<>',
  '!=': '<>',
  '<': '<',
  '<=': '<=',
  '>': '>',
  '>=': '>=',
  CONTAINS: 'CONTAINS',
  BETWEEN: 'BETWEEN',
  ANY: 'ANY OF',
  ALL: 'ALL OF',
  NONE: 'NONE OF',
  // `IN` is a synonym for `ANY OF` that the printer normalizes away (parser.ts `relExpr`), so it
  // hovers as what it means rather than as what was typed.
  IN: 'ANY OF',
};

/** The hover text for an operator token, or `undefined` when the token is not an operator. */
export function describeOperatorToken(token: string): OperatorSurface | undefined {
  const upper = token.toUpperCase();
  const boolean = BOOLEAN_DOCS[upper];
  if (boolean !== undefined) return boolean;
  const label = TOKEN_TO_LABEL[upper] ?? TOKEN_TO_LABEL[token];
  if (label === undefined) return undefined;
  const candidate = CANDIDATES.find((entry) => entry.label === label);
  return candidate === undefined ? undefined : surface(candidate);
}

function surface(candidate: Candidate): OperatorSurface {
  return { label: candidate.label, phrasing: candidate.phrasing, documentation: candidate.documentation };
}

/**
 * The probe's left operand: a literal of the type in question.
 *
 * The enum/set cases use code `1` whether or not the domain contains it, and that is safe for a
 * reason worth recording: validating a literal's code against its domain is the *resolver's* job
 * (`RSL-0022`), not the checker's, so `checkExpr` types `enum<d>` from the literal's `d` alone.
 * A probe is therefore never rejected for the wrong reason — which is exactly what would happen
 * if the code had to exist and a domain started at 0.
 */
function literalOf(type: Type, b: ReturnType<typeof astBuilder>): Expr | undefined {
  switch (type.k) {
    case 'bool':
      return b.boolLit(true);
    case 'num':
      return b.numLit(1);
    case 'text':
      return b.textLit('x');
    case 'date':
      return b.dateLit('2026-01-01');
    case 'enum':
      return b.enumLit(1, type.d);
    case 'set':
      return b.setLit([1], type.d);
    // `obj`, `null` and `never` have no operand literal, and none of them has an infix operator
    // in D §3.3 either — an `obj` comparison is `compatEq(obj, obj)` only, which the builder
    // reaches through a field access, not an operator dropdown.
    default:
      return undefined;
  }
}

function typeOfProbe(expr: Expr): Type {
  // Every probe operand is built by `literalOf`, which always sets `t`-inferable literals; the
  // checker re-derives the type anyway, so this only has to name the *same* type for the right
  // operand as the left one has.
  if (expr.op === 'lit') {
    const v = expr.v;
    switch (v.k) {
      case 'bool':
        return { k: 'bool' };
      case 'num':
        return { k: 'num' };
      case 'text':
        return { k: 'text' };
      case 'date':
        return { k: 'date' };
      case 'enum':
        return { k: 'enum', d: v.d };
      case 'set':
        return { k: 'set', d: v.d };
      default:
        return { k: 'null' };
    }
  }
  return { k: 'null' };
}

/** `CONTAINS` wants one code of the left set's domain; anything else has no element domain. */
function elementLit(left: Expr, b: ReturnType<typeof astBuilder>): Expr {
  const type = typeOfProbe(left);
  if (type.k !== 'set') throw new Error('no element domain');
  return b.enumLit(1, type.d);
}

/** `ANY OF` / `ALL OF` / `NONE OF` want a code list of the left operand's domain. */
function setLitFor(left: Expr, b: ReturnType<typeof astBuilder>): Expr {
  const type = typeOfProbe(left);
  if (type.k === 'set' || type.k === 'enum') return b.setLit([1], type.d);
  throw new Error('no domain for a code list');
}
