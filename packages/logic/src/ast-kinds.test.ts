/**
 * Closure over the AST kind registry — D §7.2.
 *
 * D §7.2's mechanism is that adding a node kind is a four-file change (AST type, printer, parser,
 * builder renderer) and the build fails until all four exist. Two of those four live in other
 * packages and other milestones (the printer and parser are P1-07, the renderer is P1-12). This
 * file enforces the two that live here, and it enforces them the same way: by an **exhaustive
 * mapped type**. `SAMPLES` is typed `{ [K in AstKind]: … }`, so adding a kind to `AST_KINDS`
 * without adding a sample to this file is a TypeScript error, not a silently-untested node.
 *
 * The runtime half then proves the two exhaustive switches actually handle it: `infer` in check.ts
 * and `compute` in evaluator.ts both end in a `never` guard that throws, so a node kind the switch
 * has never heard of surfaces here rather than in field as an `undefined` read as a null answer.
 */

import { describe, expect, it } from 'vitest';
import { AST_FAMILY, AST_KINDS, isAstKind, type AstKind } from './ast-kinds.js';
import { astBuilder } from './build.js';
import { DOM, Q, V, env } from './__fixtures__/survey.js';
import { checkExpr } from './check.js';
import { buildEvalSchema } from './compile.js';
import { NO_CELLS, evalExpr, type ExprEnv } from './evaluator.js';
import { varStateOf } from './state.js';
import type { Expr } from './ast.js';
import { setValue } from './value.js';

const E = env();
const b = astBuilder(1);

/** One real node per AST kind. Exhaustive by construction — see the file header. */
const SAMPLES: { readonly [K in AstKind]: Expr } = {
  lit: b.numLit(1),
  var: b.variable(V.q6),
  probe: b.probe('answered', { kind: 'variable', id: V.q6 }),
  // `item` and `item_attr` are only well-formed inside an aggregation, so their samples are the
  // aggregations that bind them; the checker's LGC-T012 test covers the unbound case.
  item: b.agg({
    fn: 'count',
    over: { kind: 'question_emits', question_id: Q.q5 },
    where: b.item(),
  }),
  item_attr: b.agg({
    fn: 'max',
    over: { kind: 'options', question_id: Q.q5 },
    select: b.itemAttr('code'),
  }),
  '==': b.cmp('==', b.variable(V.q6), b.numLit(1)),
  '!=': b.cmp('!=', b.variable(V.q6), b.numLit(1)),
  '<': b.cmp('<', b.variable(V.q6), b.numLit(1)),
  '<=': b.cmp('<=', b.variable(V.q6), b.numLit(1)),
  '>': b.cmp('>', b.variable(V.q6), b.numLit(1)),
  '>=': b.cmp('>=', b.variable(V.q6), b.numLit(1)),
  contains: b.setOp('contains', b.variable(V.q5set), b.enumLit(1, DOM.q5)),
  any_of: b.setOp('any_of', b.variable(V.q5set), b.setLit([1, 2], DOM.q5)),
  all_of: b.setOp('all_of', b.variable(V.q5set), b.setLit([1], DOM.q5)),
  none_of: b.setOp('none_of', b.variable(V.q5set), b.setLit([99], DOM.q5)),
  set_eq: b.setOp('set_eq', b.variable(V.q5set), b.setLit([1], DOM.q5)),
  subset_of: b.setOp('subset_of', b.variable(V.q5set), b.setLit([1, 2, 3, 99], DOM.q5)),
  union: b.setOp('union', b.variable(V.q5set), b.setLit([2], DOM.q5)),
  intersect: b.setOp('intersect', b.variable(V.q5set), b.setLit([2], DOM.q5)),
  difference: b.setOp('difference', b.variable(V.q5set), b.setLit([2], DOM.q5)),
  and: b.and(b.boolLit(true), b.variable(V.heavy)),
  or: b.or(b.boolLit(false), b.variable(V.heavy)),
  not: b.not(b.variable(V.heavy)),
  '+': b.binArith('+', b.variable(V.q6), b.numLit(1)),
  '-': b.binArith('-', b.variable(V.q6), b.numLit(1)),
  '*': b.binArith('*', b.variable(V.q6), b.numLit(2)),
  '/': b.binArith('/', b.variable(V.q6), b.numLit(2)),
  mod: b.binArith('mod', b.variable(V.q6), b.numLit(2)),
  pow: b.binArith('pow', b.variable(V.q6), b.numLit(2)),
  neg: b.unArith('neg', b.variable(V.q6)),
  abs: b.unArith('abs', b.variable(V.q6)),
  floor: b.unArith('floor', b.variable(V.q6)),
  ceil: b.unArith('ceil', b.variable(V.q6)),
  round: b.round(b.variable(V.q6), b.numLit(2)),
  min: b.nAryArith('min', b.variable(V.q6), b.numLit(0)),
  max: b.nAryArith('max', b.variable(V.q6), b.numLit(0)),
  clamp: b.nAryArith('clamp', b.variable(V.q6), b.numLit(0), b.numLit(10)),
  agg: b.agg({ fn: 'count', over: { kind: 'question_emits', question_id: Q.q5 } }),
  concat: b.concat(b.variable(V.openEnd), b.textLit('!')),
  len: b.strUnary('len', b.variable(V.openEnd)),
  lower: b.strUnary('lower', b.variable(V.openEnd)),
  upper: b.strUnary('upper', b.variable(V.openEnd)),
  trim: b.strUnary('trim', b.variable(V.openEnd)),
  starts_with: b.strBinary('starts_with', b.variable(V.openEnd), b.textLit('a')),
  ends_with: b.strBinary('ends_with', b.variable(V.openEnd), b.textLit('z')),
  str_contains: b.strBinary('str_contains', b.variable(V.openEnd), b.textLit('m')),
  matches: b.matches(b.variable(V.openEnd), '^[a-z]+$'),
  substr: b.substr(b.variable(V.openEnd), b.numLit(0), b.numLit(3)),
  split_count: b.strBinary('split_count', b.variable(V.openEnd), b.textLit(',')),
  word_count: b.strUnary('word_count', b.variable(V.openEnd)),
  date_diff: b.dateDiff('year', b.variable(V.dob), b.variable(V.serverTime)),
  date_add: b.dateAdd('day', b.variable(V.dob), b.numLit(1)),
  date_part: b.datePart('year', b.variable(V.dob)),
  date_trunc: b.dateTrunc('month', b.variable(V.dob)),
  case: b.caseExpr([{ when: b.variable(V.heavy), then: b.numLit(1) }], b.numLit(0)),
  coalesce: b.coalesce(b.variable(V.q6), b.numLit(0)),
  cast: b.cast('num', b.variable(V.openEnd)),
  // Q5's set, reinterpreted in the brand domain — the deliberate cross-domain escape (D §3.2).
  recode: b.recode(b.variable(V.q5set), DOM.brand),
  label_of: b.labelOf(b.variable(V.q5set)),
};

const exprEnv: ExprEnv = {
  vars: varStateOf({
    [V.q6]: { k: 'num', v: 7 },
    [V.openEnd]: { k: 'text', v: 'hello world' },
    [V.heavy]: { k: 'bool', v: true },
    [V.q5set]: setValue([1, 3], DOM.q5),
    [V.dob]: { k: 'date', v: '1990-06-15' },
    [V.serverTime]: { k: 'date', v: '2026-08-20T09:00:00Z' },
  }),
  ctx: {},
  cells: NO_CELLS,
  schema: buildEvalSchema(E),
};

describe('the AST kind registry (D §7.2)', () => {
  it('matches D §7.2s list exactly, in order', () => {
    // Pinned verbatim. A kind added here without a printer (P1-07) or a renderer (P1-12) is a
    // build failure in those packages — that is the enforcement mechanism, and it only works if
    // this list is the single source of truth rather than a copy that drifted.
    expect([...AST_KINDS]).toEqual([
      'lit', 'var', 'probe', 'item', 'item_attr',
      '==', '!=', '<', '<=', '>', '>=',
      'contains', 'any_of', 'all_of', 'none_of', 'set_eq', 'subset_of', 'union', 'intersect', 'difference',
      'and', 'or', 'not',
      '+', '-', '*', '/', 'mod', 'pow', 'neg', 'abs', 'floor', 'ceil', 'round', 'min', 'max', 'clamp',
      'agg',
      'concat', 'len', 'lower', 'upper', 'trim', 'starts_with', 'ends_with', 'str_contains',
      'matches', 'substr', 'split_count', 'word_count',
      'date_diff', 'date_add', 'date_part', 'date_trunc',
      'case', 'coalesce', 'cast', 'recode', 'label_of',
    ]);
    expect(AST_KINDS).toHaveLength(59);
    expect(new Set(AST_KINDS).size).toBe(AST_KINDS.length);
  });

  it('assigns every kind a family', () => {
    for (const kind of AST_KINDS) expect(AST_FAMILY[kind]).toBeDefined();
  });

  it('recognizes its own kinds and nothing else', () => {
    for (const kind of AST_KINDS) expect(isAstKind(kind)).toBe(true);
    expect(isAstKind('frobnicate')).toBe(false);
    expect(isAstKind('')).toBe(false);
  });

  it('has a sample for every kind, and the samples cover every kind', () => {
    const covered = new Set<string>();
    for (const sample of Object.values(SAMPLES)) collectOps(sample, covered);
    const missing = AST_KINDS.filter((kind) => !covered.has(kind));
    expect(missing).toEqual([]);
  });

  for (const kind of AST_KINDS) {
    it(`type-checks a ${kind} node`, () => {
      const sample = SAMPLES[kind];
      const result = checkExpr(sample, E);
      // Not "produces no diagnostics" — some samples deliberately exercise odd corners. The claim
      // is narrower and is the one that matters: the checker *knows* this kind.
      expect(result.diagnostics.map((d) => d.code)).not.toContain('LGC-T002');
      expect(result.type.k).not.toBe('never');
    });

    it(`evaluates a ${kind} node`, () => {
      const checked = checkExpr(SAMPLES[kind], E).expr;
      const value = evalExpr(checked, exprEnv);
      // The `never` guard in `compute` would have thrown "unhandled AST node" for a kind the
      // switch does not cover. Reaching here with a Value is the assertion.
      expect(value.k).toBeDefined();
    });
  }
});

function collectOps(expr: Expr, out: Set<string>): void {
  out.add(expr.op);
  if (expr.op === 'agg') {
    if (expr.where !== undefined) collectOps(expr.where, out);
    if (expr.select !== undefined) collectOps(expr.select, out);
    return;
  }
  if (expr.op === 'case') {
    for (const arm of expr.cases) {
      collectOps(arm.when, out);
      collectOps(arm.then, out);
    }
    collectOps(expr.else, out);
    return;
  }
  const args = (expr as { readonly args?: readonly Expr[] }).args;
  if (args !== undefined) for (const arg of args) collectOps(arg, out);
}
