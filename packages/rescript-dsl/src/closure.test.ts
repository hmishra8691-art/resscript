/**
 * The three-way closure of D §7.2, for the two legs this package owns.
 *
 * D §7.2's mechanism: "adding a node kind is a four-file change (AST type, printer, parser, builder
 * renderer) and the build fails until all four exist." Two of the four are here, and both are
 * enforced at *compile* time as well as at run time:
 *
 *  - **Parser leg.** `PARSER_PRODUCTIONS` is typed `{ [K in AstKind]: string }`, so adding a kind to
 *    `AST_KINDS` without adding a snippet is a TypeScript error in this file. The runtime half then
 *    asserts each snippet actually parses to a tree containing that kind — a mapped type only proves
 *    a key exists, not that the production works.
 *  - **Printer leg.** `printer.ts`'s `render` is an exhaustive `switch` ending in a `never` guard, so
 *    a kind with no printer is a compile error there and a named `LogicInvariant` at run time. The
 *    per-kind round trip below is what exercises it.
 *
 * The third leg — the builder renderer — is P1-12's, in `apps/studio/src/logic-builder/registry.ts`.
 * The typed hole for it is `AstRendererRegistry` in this package's index, and the placeholder below
 * is the failing half of D §7.2's test, written now so that P1-12 has one line to change.
 */

import { describe, expect, it } from 'vitest';
import { AST_KINDS, walkExpr, type AstKind, type Expr } from '@resscript/logic';
import { statementExprs, structuralStatement } from './ast.js';
import { parse, type AstRendererRegistry } from './index.js';
import { print } from './printer.js';
import { registry } from './__fixtures__/survey.js';

const REG = registry();

/**
 * One source snippet per AST kind — the "real snippet per kind" D §7.2's test sketch calls for.
 *
 * Exhaustive by construction: the mapped type is what makes a new `AST_KINDS` entry a compile error
 * here rather than a silently unparseable node.
 */
export const PARSER_PRODUCTIONS: { readonly [K in AstKind]: string } = {
  lit: 'IF Q6 = 1 THEN SHOW Q12',
  var: 'IF HEAVY_BUYER THEN SHOW Q12',
  probe: 'IF ANSWERED(Q6) AND SHOWN(QUESTION Q12) AND VALID(Q6) AND ASKED(PAGE P2) THEN SHOW Q12',
  item: 'IF COUNT(Q5 WHERE item) > 0 THEN SHOW Q12',
  item_attr: 'IF MAX_OF(OPTIONS OF Q3 SELECT item.code) > 1 THEN SHOW Q12',
  '==': 'IF Q6 = 1 THEN SHOW Q12',
  '!=': 'IF Q6 != 1 THEN SHOW Q12',
  '<': 'IF Q6 < 1 THEN SHOW Q12',
  '<=': 'IF Q6 <= 1 THEN SHOW Q12',
  '>': 'IF Q6 > 1 THEN SHOW Q12',
  '>=': 'IF Q6 >= 1 THEN SHOW Q12',
  contains: 'IF Q5 CONTAINS Q5.Apple THEN SHOW Q12',
  any_of: 'IF Q5 ANY OF [1, 3] THEN SHOW Q12',
  all_of: 'IF Q5 ALL OF [1, 3] THEN SHOW Q12',
  none_of: 'IF Q5 NONE OF [99] THEN SHOW Q12',
  set_eq: 'IF SET_EQ(Q5, [1, 2]) THEN SHOW Q12',
  subset_of: 'IF SUBSET_OF(Q5, [1, 2, 3]) THEN SHOW Q12',
  union: 'IF UNION(Q5, Q10) CONTAINS 1 THEN SHOW Q12',
  intersect: 'IF INTERSECT(Q5, Q10) CONTAINS 1 THEN SHOW Q12',
  difference: 'IF DIFFERENCE(Q5, Q10) CONTAINS 1 THEN SHOW Q12',
  and: 'IF HEAVY_BUYER AND SKIPPED_MAIN THEN SHOW Q12',
  or: 'IF HEAVY_BUYER OR SKIPPED_MAIN THEN SHOW Q12',
  not: 'IF NOT HEAVY_BUYER THEN SHOW Q12',
  '+': 'IF Q6 + 1 > 0 THEN SHOW Q12',
  '-': 'IF Q6 - 1 > 0 THEN SHOW Q12',
  '*': 'IF Q6 * 2 > 0 THEN SHOW Q12',
  '/': 'IF Q6 / 2 > 0 THEN SHOW Q12',
  mod: 'IF Q6 MOD 2 > 0 THEN SHOW Q12',
  pow: 'IF POW(Q6, 2) > 0 THEN SHOW Q12',
  neg: 'IF -Q6 > 0 THEN SHOW Q12',
  abs: 'IF ABS(Q6) > 0 THEN SHOW Q12',
  floor: 'IF FLOOR(Q6) > 0 THEN SHOW Q12',
  ceil: 'IF CEIL(Q6) > 0 THEN SHOW Q12',
  round: 'IF ROUND(Q6, 2) > 0 THEN SHOW Q12',
  min: 'IF MIN(Q6, AGE) > 0 THEN SHOW Q12',
  max: 'IF MAX(Q6, AGE) > 0 THEN SHOW Q12',
  clamp: 'IF CLAMP(Q6, 0, 10) > 0 THEN SHOW Q12',
  agg: 'IF COUNT(Q5) >= 3 THEN SHOW Q12',
  concat: 'IF CONCAT(OE, "!") = "a!" THEN SHOW Q12',
  len: 'IF LEN(OE) > 3 THEN SHOW Q12',
  lower: 'IF LOWER(OE) = "a" THEN SHOW Q12',
  upper: 'IF UPPER(OE) = "A" THEN SHOW Q12',
  trim: 'IF TRIM(OE) = "a" THEN SHOW Q12',
  starts_with: 'IF STARTS_WITH(OE, "a") THEN SHOW Q12',
  ends_with: 'IF ENDS_WITH(OE, "z") THEN SHOW Q12',
  str_contains: 'IF STR_CONTAINS(OE, "m") THEN SHOW Q12',
  matches: 'IF MATCHES(OE, "^[a-z]+$") THEN SHOW Q12',
  substr: 'IF SUBSTR(OE, 0, 3) = "abc" THEN SHOW Q12',
  split_count: 'IF SPLIT_COUNT(OE, ",") > 1 THEN SHOW Q12',
  word_count: 'IF WORD_COUNT(OE) > 5 THEN SHOW Q12',
  date_diff: 'IF DATE_DIFF(YEAR, DOB, SERVER_TIME) >= 18 THEN SHOW Q12',
  date_add: 'IF DATE_ADD(DAY, DOB, 1) > DOB THEN SHOW Q12',
  date_part: 'IF DATE_PART(YEAR, DOB) = 1990 THEN SHOW Q12',
  date_trunc: 'IF DATE_TRUNC(MONTH, DOB) = DATE "1990-06-01" THEN SHOW Q12',
  case: 'SET SEGMENT = CASE WHEN AGE < 35 THEN "young" ELSE "old" END',
  coalesce: 'IF COALESCE(HEAVY_BUYER, FALSE) THEN SHOW Q12',
  cast: 'IF CAST(OE AS BOOL ON FAIL ERROR) THEN SHOW Q12',
  // Q5's own domain reinterpreted as Q3's brand list — the explicit cross-domain escape.
  recode: 'IF RECODE(Q5, Q3) CONTAINS Q3 THEN SHOW Q12',
  label_of: 'IF LABEL_OF(Q5) = "Apple" THEN SHOW Q12',
};

function kindsOf(source: string): ReadonlySet<AstKind> {
  const result = parse(source, REG);
  const seen = new Set<AstKind>();
  for (const statement of result.program.statements) {
    for (const expr of statementExprs(statement) as readonly Expr[]) {
      walkExpr(expr, (node) => seen.add(node.op));
    }
  }
  return seen;
}

describe('D §7.2 three-way closure — the parser leg', () => {
  for (const kind of AST_KINDS) {
    it(`parses a ${kind} node`, () => {
      const source = PARSER_PRODUCTIONS[kind];
      const result = parse(source, REG);
      expect(
        result.diagnostics.filter((d) => d.severity === 'error'),
        `${kind}: ${source}`,
      ).toEqual([]);
      expect(kindsOf(source), `${kind} is not produced by its own snippet`).toContain(kind);
    });
  }

  it('covers every kind in AST_KINDS', () => {
    const covered = new Set<AstKind>();
    for (const kind of AST_KINDS) for (const seen of kindsOf(PARSER_PRODUCTIONS[kind])) covered.add(seen);
    const missing = AST_KINDS.filter((kind) => !covered.has(kind));
    expect(missing, 'AST kinds with no parser production').toEqual([]);
  });
});

describe('D §7.2 three-way closure — the printer leg', () => {
  for (const kind of AST_KINDS) {
    it(`prints and re-parses a ${kind} node`, () => {
      const source = PARSER_PRODUCTIONS[kind];
      const first = parse(source, REG);
      const printed = print(first.program, REG);
      const second = parse(printed, REG);
      // T1 for this kind: the tree survives the round trip.
      expect(second.program.statements.map(structuralStatement), `${kind}: ${printed}`).toEqual(
        first.program.statements.map(structuralStatement),
      );
      // T2 idempotence for this kind.
      expect(print(second.program, REG)).toBe(printed);
      // And the kind is still there afterwards — a printer that dropped a node would otherwise pass
      // the two assertions above by printing nothing at all.
      expect(kindsOf(printed)).toContain(kind);
    });
  }
});

describe('D §7.2 three-way closure — the renderer leg (P1-12)', () => {
  it('has a typed hole waiting for the studio renderers', () => {
    // The third leg is `apps/studio/src/logic-builder/registry.ts`, which does not exist yet
    // (P1-12). `AstRendererRegistry<R>` is the mapped type it must be declared with, so that adding
    // an AST kind is a compile error there too. Asserting the *shape* here — rather than asserting
    // nothing, or asserting a fake registry — keeps the hole visible and typed: replace
    // `Partial<…>` with the real registry in P1-12 and this test becomes the closure assertion for
    // all three legs.
    const pending: Partial<AstRendererRegistry<string>> = {};
    const missing = AST_KINDS.filter((kind) => pending[kind] === undefined);
    expect(missing).toHaveLength(AST_KINDS.length);
    expect(AST_KINDS).toHaveLength(59);
  });
});
