/**
 * The operator constraint table, proved against the CHECKER it claims to transcribe.
 *
 * Two directions, both load-bearing:
 *
 *  1. **Everything offered type-checks.** For every variable type and every operator
 *     `operatorsFor` offers, the leaf the builder would construct passes `checkExpr` with zero
 *     errors — so the dropdown can never build a rule the write-time gate then refuses.
 *  2. **Everything withheld is withheld because the checker rejects it.** `<` on a nominal
 *     enum is LGC-T009 (the top-2-box bug), `<` on text is LGC-T003 — asserted by building the
 *     forbidden leaf by hand. A table that withheld more than the checker rejects would be
 *     taste dressed as safety; these tests keep it honest in both directions.
 *
 * The environment is the studio's own DSL fixture — the one with a nominal domain (`fruit`),
 * an ordinal one (`scale`), a set, a number, a boolean and a text variable, which is exactly
 * the case split the table needs.
 */

import { describe, expect, it } from 'vitest';
import { astBuilder, buildTypeEnv, checkExpr, type Expr } from '@resscript/logic';
import { registryInput } from '@/test/dsl-fixture';
import { DOM, FRUIT, V } from '@/test/dsl-fixture';
import {
  defaultLeaf,
  leafExpr,
  leafOfExpr,
  operatorsFor,
  valueForOperator,
  type Leaf,
  type LeafOperator,
  type LeafVariable,
} from '../operators';

const ENV = buildTypeEnv(registryInput());

const S1: LeafVariable = {
  id: V.s1,
  name: 'S1',
  vtype: 'enum',
  domain: DOM.s1,
  ordinal: false,
  options: [
    { code: 1, label: 'Yes' },
    { code: 2, label: 'No' },
  ],
};
const Q9: LeafVariable = {
  id: V.q9,
  name: 'Q9',
  vtype: 'enum',
  domain: DOM.scale,
  ordinal: true,
  options: [1, 2, 3, 4, 5].map((code) => ({ code, label: `p${String(code)}` })),
};
const Q5: LeafVariable = {
  id: V.q5,
  name: 'Q5',
  vtype: 'set',
  domain: DOM.fruit,
  ordinal: false,
  options: FRUIT.map((item) => ({ code: item.code, label: item.ref })),
};
const AGE: LeafVariable = { id: V.age, name: 'AGE', vtype: 'number' };
const HEAVY: LeafVariable = { id: V.heavy, name: 'HEAVY_BUYER', vtype: 'boolean' };
const SEGMENT: LeafVariable = { id: V.segment, name: 'SEGMENT', vtype: 'text' };

function leafFor(variable: LeafVariable, operator: LeafOperator): Leaf {
  const base = defaultLeaf(variable);
  return { ...base, operator, value: valueForOperator(base, operator, variable) };
}

function errorsOf(expr: Expr): readonly string[] {
  return checkExpr(expr, ENV)
    .diagnostics.filter((d) => d.severity === 'error')
    .map((d) => d.code);
}

describe('operatorsFor — everything offered type-checks', () => {
  const cases: readonly LeafVariable[] = [S1, Q9, Q5, AGE, HEAVY, SEGMENT];
  for (const variable of cases) {
    it(`${variable.name} (${variable.vtype}${variable.ordinal === true ? ', ordinal' : ''})`, () => {
      const offered = operatorsFor(variable);
      expect(offered.length).toBeGreaterThan(0);
      for (const operator of offered) {
        const expr = leafExpr(leafFor(variable, operator), variable, astBuilder(1));
        expect(errorsOf(expr), `${variable.name} ${operator}`).toEqual([]);
        // The leaf must also be boolean — it is a rule condition.
        expect(checkExpr(expr, ENV).type.k).toBe('bool');
      }
    });
  }
});

describe('operatorsFor — the withheld operators are the checker\'s refusals, not taste', () => {
  it('a nominal enum offers no ordering; the checker calls it LGC-T009 (top-2-box)', () => {
    expect(operatorsFor(S1)).not.toContain('<');
    const b = astBuilder(1);
    const forbidden = b.cmp('<', b.variable(V.s1), b.enumLit(1, DOM.s1));
    expect(errorsOf(forbidden)).toContain('LGC-T009');
  });

  it('an ORDINAL enum does offer ordering, and the checker accepts it', () => {
    expect(operatorsFor(Q9)).toContain('<');
    const b = astBuilder(1);
    expect(errorsOf(b.cmp('>', b.variable(V.q9), b.enumLit(3, DOM.scale)))).toEqual([]);
  });

  it('text offers no ordering; the checker calls it LGC-T003', () => {
    expect(operatorsFor(SEGMENT)).not.toContain('<');
    const b = astBuilder(1);
    expect(errorsOf(b.cmp('<', b.variable(V.segment), b.textLit('a')))).toContain('LGC-T003');
  });

  it('a set offers membership, not comparison; the checker rejects < on sets', () => {
    const offered = operatorsFor(Q5);
    expect(offered).toContain('contains');
    expect(offered).toContain('none_of');
    expect(offered).not.toContain('<');
    const b = astBuilder(1);
    expect(
      errorsOf(b.cmp('<', b.variable(V.q5), b.setLit([1], DOM.fruit))).length,
    ).toBeGreaterThan(0);
  });

  it('cross-domain enum values are the checker\'s LGC-T007 — the domain on the leaf matters', () => {
    const b = astBuilder(1);
    // The builder always takes the code list from the VARIABLE's own domain; this is what
    // would happen if it did not.
    expect(errorsOf(b.cmp('==', b.variable(V.s1), b.enumLit(1, DOM.fruit)))).toContain('LGC-T007');
  });
});

describe('leafOfExpr — the recognizer inverts leafExpr', () => {
  const leaves: readonly { readonly variable: LeafVariable; readonly operator: LeafOperator }[] = [
    { variable: S1, operator: '==' },
    { variable: S1, operator: 'not_answered' },
    { variable: Q9, operator: '>' },
    { variable: Q5, operator: 'contains' },
    { variable: Q5, operator: 'not_contains' },
    { variable: Q5, operator: 'none_of' },
    { variable: AGE, operator: '>=' },
    { variable: HEAVY, operator: '==' },
    { variable: SEGMENT, operator: 'answered' },
  ];
  for (const { variable, operator } of leaves) {
    it(`${variable.name} ${operator}`, () => {
      const leaf = leafFor(variable, operator);
      const round = leafOfExpr(leafExpr(leaf, variable, astBuilder(1)));
      expect(round).toEqual(leaf);
    });
  }

  it('refuses to claim what it cannot faithfully edit', () => {
    const b = astBuilder(1);
    // var OP var — no literal side; guessing would round-trip into a different rule.
    expect(leafOfExpr(b.cmp('==', b.variable(V.s1), b.variable(V.s1)))).toBeUndefined();
    // NOT over a comparison is not a leaf spelling the builder writes.
    expect(leafOfExpr(b.not(b.cmp('==', b.variable(V.age), b.numLit(1))))).toBeUndefined();
  });
});
