/**
 * The optimizer — D §10.1, roadmap P2-01.
 *
 * Three layers, matching the roadmap's own test line:
 *
 *  1. Unit tests per transformation (fold, flatten, absorb, reorder, `case` pruning), each
 *     asserting the *shape* of the result so a regression that folds the wrong thing, or stops
 *     folding at all, fails close to its cause.
 *  2. A semantic-equivalence property test: generate arbitrary boolean expressions over the
 *     fixture registry and arbitrary variable states, and assert `optimizeExpr` never changes
 *     `evalCondition`'s verdict — "the optimizer never changes a verdict over 1,000 generated
 *     states per AST" from the roadmap's Tests line, read as 1,000 (AST, state) evaluations in
 *     total rather than 1,000 states replayed against one tree, which would test reordering and
 *     folding but never the AST-shape diversity that flattening and `case` pruning depend on.
 *  3. `compileLogic({ optimize: true })` vs `compileLogic({ optimize: false })` on real rule
 *     fixtures, compared through `evaluate`'s own accessors — the roadmap's accept line, "turning
 *     the optimizer off and on produces identical verdicts for every fixture in the corpus".
 */

import { describe, expect, it } from 'vitest';
import { T_BOOL, type Expr } from './ast.js';
import { astBuilder } from './build.js';
import { DOM, V, env, fourRules, tracker } from './__fixtures__/survey.js';
import { compileLogic } from './compile.js';
import { EMPTY_SCHEMA, NO_CELLS, evalCondition, evalExpr } from './evaluator.js';
import { evaluate } from './engine.js';
import { errorsOnly } from './diagnostics.js';
import { asVariableId } from './ids.js';
import { optimizeExpr } from './optimize.js';
import { varStateOf } from './state.js';
import { NULL, num, type Value } from './value.js';

const E = env();

/* ========================================================================== */
/* Helpers                                                                    */
/* ========================================================================== */

function exprEnv(answers: { readonly [id: string]: Value }) {
  return { vars: varStateOf(answers), ctx: {}, cells: NO_CELLS, schema: EMPTY_SCHEMA };
}

function verdictOf(expr: Expr, answers: { readonly [id: string]: Value } = {}): 'T' | 'F' | 'U' {
  return evalCondition(expr, exprEnv(answers));
}

/** Deterministic, seeded, reproducible — the same requirement `__fixtures__/survey.ts`'s own
 * `shuffle` states for exactly this reason: a property test that fails on run 617 has to fail
 * the same way on run 618. */
function rngOf(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A small, well-typed boolean expression grammar over the fixture's `S1` (enum) and `AGE`
 * (number) variables — enough surface to exercise every fold this file tests: literal
 * absorption, flattening (nested `and`/`or` of the same op), and mixed literal/variable operands.
 */
function genBool(rng: () => number, depth: number): Expr {
  const b = astBuilder(1);
  const leaf = (): Expr => {
    const pick = Math.floor(rng() * 6);
    switch (pick) {
      case 0:
        return b.cmp('==', b.variable(V.s1), b.enumLit(rng() < 0.5 ? 1 : 2, DOM.s1));
      case 1:
        return b.cmp('>', b.variable(V.age), b.numLit(Math.floor(rng() * 100)));
      case 2:
        return b.cmp('<', b.variable(V.age), b.numLit(Math.floor(rng() * 100)));
      case 3:
        return b.probe('answered', { kind: 'variable', id: V.age });
      case 4:
        return b.boolLit(rng() < 0.5);
      default:
        return b.nullLit();
    }
  };
  if (depth <= 0) return leaf();
  const shape = Math.floor(rng() * 4);
  switch (shape) {
    case 0:
      return leaf();
    case 1: {
      const arity = 2 + Math.floor(rng() * 2);
      return b.and(...Array.from({ length: arity }, () => genBool(rng, depth - 1)));
    }
    case 2: {
      const arity = 2 + Math.floor(rng() * 2);
      return b.or(...Array.from({ length: arity }, () => genBool(rng, depth - 1)));
    }
    default:
      return b.not(genBool(rng, depth - 1));
  }
}

function randomAnswers(rng: () => number): { readonly [id: string]: Value } {
  const answers: { [id: string]: Value } = {};
  const s1 = rng();
  if (s1 < 0.7) answers[V.s1] = { k: 'enum', v: rng() < 0.5 ? 1 : 2, d: DOM.s1 };
  const age = rng();
  if (age < 0.7) answers[V.age] = num(Math.floor(rng() * 100));
  return answers;
}

/* ========================================================================== */
/* 1. Constant folding — non-boolean                                          */
/* ========================================================================== */

describe('constant folding', () => {
  it('folds arithmetic on all-literal operands', () => {
    const b = astBuilder(1);
    const folded = optimizeExpr(b.binArith('+', b.numLit(2), b.numLit(3)));
    expect(folded).toMatchObject({ op: 'lit', v: { k: 'num', v: 5 } });
  });

  it('folds a nested state-free subtree even inside a node that itself reads state', () => {
    const b = astBuilder(1);
    // AGE > (2 + 3): the comparison stays (AGE is a var), but its literal-only child folds.
    const folded = optimizeExpr(b.cmp('>', b.variable(V.age), b.binArith('+', b.numLit(2), b.numLit(3))));
    expect(folded).toMatchObject({
      op: '>',
      args: [{ op: 'var', var: V.age }, { op: 'lit', v: { k: 'num', v: 5 } }],
    });
  });

  it('folds string concatenation', () => {
    const b = astBuilder(1);
    const folded = optimizeExpr(b.concat(b.textLit('a'), b.textLit('b')));
    expect(folded).toMatchObject({ op: 'lit', v: { k: 'text', v: 'ab' } });
  });

  it('folds coalesce over all-literal arguments', () => {
    const b = astBuilder(1);
    const folded = optimizeExpr(b.coalesce(b.nullLit(), b.nullLit(), b.numLit(7)));
    expect(folded).toMatchObject({ op: 'lit', v: { k: 'num', v: 7 } });
  });

  it('never folds a var, probe, item or agg — even one with no arguments', () => {
    const b = astBuilder(1);
    const v = optimizeExpr(b.variable(V.age));
    expect(v).toMatchObject({ op: 'var' });
    const p = optimizeExpr(b.probe('answered', { kind: 'variable', id: V.age }));
    expect(p).toMatchObject({ op: 'probe' });
  });

  it('leaves an agg whose where/select are state-free as an agg — but folds inside it', () => {
    const b = astBuilder(1);
    const agg = b.agg({
      fn: 'count',
      over: { kind: 'explicit', variable_ids: [V.q5r1, V.q5r2, V.q5r3] },
      // item.code > (5-4): the comparison itself is not state-free (item_attr reads state), but
      // its right-hand literal-only child is, and should fold on its own.
      where: b.cmp('>', b.itemAttr('code'), b.binArith('-', b.numLit(5), b.numLit(4))),
    });
    const folded = optimizeExpr(agg);
    expect(folded.op).toBe('agg');
    const where = (folded as { readonly where?: Expr }).where;
    expect(where).toMatchObject({
      op: '>',
      args: [{ op: 'item_attr' }, { op: 'lit', v: { k: 'num', v: 1 } }],
    });
  });
});

/* ========================================================================== */
/* 2. `and` / `or`: flatten, absorb, reorder                                  */
/* ========================================================================== */

describe('and/or flattening and absorption', () => {
  it('flattens nested and into one n-ary and', () => {
    const b = astBuilder(1);
    const a = b.cmp('==', b.variable(V.s1), b.enumLit(1, DOM.s1));
    const c = b.cmp('>', b.variable(V.age), b.numLit(18));
    const d = b.probe('answered', { kind: 'variable', id: V.age });
    const nested = b.and(b.and(a, c), d);
    const folded = optimizeExpr(nested);
    expect(folded.op).toBe('and');
    expect((folded as { readonly args: readonly Expr[] }).args).toHaveLength(3);
  });

  it('a literal false absorbs the whole and, discarding every sibling', () => {
    const b = astBuilder(1);
    const real = b.cmp('==', b.variable(V.s1), b.enumLit(1, DOM.s1));
    const folded = optimizeExpr(b.and(real, b.boolLit(false)));
    expect(folded).toMatchObject({ op: 'lit', v: { k: 'bool', v: false } });
  });

  it('a literal true absorbs the whole or', () => {
    const b = astBuilder(1);
    const real = b.cmp('==', b.variable(V.s1), b.enumLit(1, DOM.s1));
    const folded = optimizeExpr(b.or(real, b.boolLit(true)));
    expect(folded).toMatchObject({ op: 'lit', v: { k: 'bool', v: true } });
  });

  it('drops a literal true from and (identity) and unwraps the singleton', () => {
    const b = astBuilder(1);
    const real = b.cmp('==', b.variable(V.s1), b.enumLit(1, DOM.s1));
    const folded = optimizeExpr(b.and(real, b.boolLit(true)));
    expect(folded).toMatchObject({ op: '==' });
  });

  it('drops a literal false from or (identity) and unwraps the singleton', () => {
    const b = astBuilder(1);
    const real = b.cmp('==', b.variable(V.s1), b.enumLit(1, DOM.s1));
    const folded = optimizeExpr(b.or(real, b.boolLit(false)));
    expect(folded).toMatchObject({ op: '==' });
  });

  it('and of only true/null literals collapses to null when a null is present', () => {
    const b = astBuilder(1);
    const folded = optimizeExpr(b.and(b.boolLit(true), b.nullLit(), b.boolLit(true)));
    expect(folded).toMatchObject({ op: 'lit', v: { k: 'null' } });
  });

  it('and of only true literals collapses to true', () => {
    const b = astBuilder(1);
    const folded = optimizeExpr(b.and(b.boolLit(true), b.boolLit(true)));
    expect(folded).toMatchObject({ op: 'lit', v: { k: 'bool', v: true } });
  });

  it('cannot drop a null literal sibling of a real condition — U AND F = F, U AND T = U', () => {
    const b = astBuilder(1);
    const real = b.cmp('==', b.variable(V.s1), b.enumLit(1, DOM.s1));
    const folded = optimizeExpr(b.and(real, b.nullLit()));
    // Must stay a two-operand and: neither operand is safe to drop.
    expect(folded.op).toBe('and');
    expect((folded as { readonly args: readonly Expr[] }).args).toHaveLength(2);
    // And it must actually behave like AND(real, U) — not silently become `real` or `U`.
    expect(verdictOf(folded, { [V.s1]: { k: 'enum', v: 2, d: DOM.s1 } })).toBe('F'); // real=F -> F
    expect(verdictOf(folded, { [V.s1]: { k: 'enum', v: 1, d: DOM.s1 } })).toBe('U'); // real=T -> U
  });

  it('reorders operands cheapest (fewest nodes) first', () => {
    const b = astBuilder(1);
    const small = b.cmp('==', b.variable(V.s1), b.enumLit(1, DOM.s1)); // 3 nodes: cmp, var, lit
    // (AGE + 1) > 18: 5 nodes — a strictly bigger leaf, and neither operand is itself an `and`,
    // so this test isolates cost-based reordering from associative flattening (covered above).
    const big = b.cmp('>', b.binArith('+', b.variable(V.age), b.numLit(1)), b.numLit(18));
    const folded = optimizeExpr(b.and(big, small));
    expect(folded.op).toBe('and');
    const args = (folded as { readonly args: readonly Expr[] }).args;
    expect(args).toHaveLength(2);
    // `small` (fewer nodes) sorts before `big`, even though `big` was authored first.
    expect(args[0]).toMatchObject({ op: '==' });
    expect(args[1]).toMatchObject({ op: '>' });
  });

  it('reordering does not change the verdict for any state — commutativity, D §2.5', () => {
    const b = astBuilder(1);
    const cheap = b.cmp('==', b.variable(V.s1), b.enumLit(1, DOM.s1));
    const expensive = b.cmp('>', b.variable(V.age), b.numLit(18));
    const original = b.and(cheap, expensive);
    const optimized = optimizeExpr(original);
    for (const s1 of [1, 2, undefined]) {
      for (const age of [10, 25, undefined]) {
        const answers: { [id: string]: Value } = {};
        if (s1 !== undefined) answers[V.s1] = { k: 'enum', v: s1, d: DOM.s1 };
        if (age !== undefined) answers[V.age] = num(age);
        expect(verdictOf(optimized, answers)).toBe(verdictOf(original, answers));
      }
    }
  });
});

describe('not', () => {
  it('folds not(true) / not(false) / not(null) to a literal', () => {
    const b = astBuilder(1);
    expect(optimizeExpr(b.not(b.boolLit(true)))).toMatchObject({ op: 'lit', v: { k: 'bool', v: false } });
    expect(optimizeExpr(b.not(b.boolLit(false)))).toMatchObject({ op: 'lit', v: { k: 'bool', v: true } });
    expect(optimizeExpr(b.not(b.nullLit()))).toMatchObject({ op: 'lit', v: { k: 'null' } });
  });

  it('leaves not(x) alone for a real condition', () => {
    const b = astBuilder(1);
    const real = b.cmp('==', b.variable(V.s1), b.enumLit(1, DOM.s1));
    const folded = optimizeExpr(b.not(real));
    expect(folded).toMatchObject({ op: 'not', args: [{ op: '==' }] });
  });
});

/* ========================================================================== */
/* 3. `case` branch pruning                                                   */
/* ========================================================================== */

describe('case branch pruning', () => {
  it('drops a branch whose when is provably false', () => {
    const b = astBuilder(1);
    const real = b.cmp('==', b.variable(V.s1), b.enumLit(1, DOM.s1));
    const c = b.caseExpr([{ when: b.boolLit(false), then: b.numLit(1) }, { when: real, then: b.numLit(2) }], b.numLit(3));
    const folded = optimizeExpr(c) as { readonly op: 'case'; readonly cases: readonly { readonly when: Expr }[] };
    expect(folded.op).toBe('case');
    expect(folded.cases).toHaveLength(1);
    expect(folded.cases[0]?.when).toMatchObject({ op: '==' });
  });

  it('drops a branch whose when is provably null — D §2.5: unknown when is "not matched"', () => {
    const b = astBuilder(1);
    const c = b.caseExpr([{ when: b.nullLit(), then: b.numLit(1) }], b.numLit(2));
    const folded = optimizeExpr(c);
    // Every branch dropped: falls straight through to else.
    expect(folded).toMatchObject({ op: 'lit', v: { k: 'num', v: 2 } });
  });

  it('a provably-true when becomes the else, discarding every later branch', () => {
    const b = astBuilder(1);
    const real = b.cmp('==', b.variable(V.s1), b.enumLit(1, DOM.s1));
    const c = b.caseExpr(
      [
        { when: real, then: b.numLit(1) },
        { when: b.boolLit(true), then: b.numLit(2) },
        { when: b.boolLit(false), then: b.numLit(999) }, // unreachable either way
      ],
      b.numLit(3),
    );
    const folded = optimizeExpr(c) as { readonly op: 'case'; readonly cases: readonly unknown[]; readonly else: Expr };
    expect(folded.op).toBe('case');
    expect(folded.cases).toHaveLength(1); // only the real, unresolvable branch survives
    expect(folded.else).toMatchObject({ op: 'lit', v: { k: 'num', v: 2 } });
  });

  it('a case with no real branches left folds straight to a literal else', () => {
    const b = astBuilder(1);
    const c = b.caseExpr([{ when: b.boolLit(true), then: b.numLit(5) }], b.numLit(0));
    expect(optimizeExpr(c)).toMatchObject({ op: 'lit', v: { k: 'num', v: 5 } });
  });
});

/* ========================================================================== */
/* 4. The documented edge case: absorption can discard a variable read        */
/* ========================================================================== */

describe('the documented tradeoff: absorption discards sibling operands, var reads included', () => {
  it('AND(real-condition-reading-a-var, FALSE) folds away the var read entirely', () => {
    const b = astBuilder(1);
    const readsAge = b.cmp('>', b.variable(V.age), b.numLit(18));
    const folded = optimizeExpr(b.and(readsAge, b.boolLit(false)));
    // The fold is correct (the and really is always false) — this test exists so a reader of
    // compile.ts's cell-graph comment can see the exact shape of the case it is describing.
    expect(folded).toMatchObject({ op: 'lit', v: { k: 'bool', v: false } });
    expect(JSON.stringify(folded)).not.toContain('"var"');
  });
});

/* ========================================================================== */
/* 5. Semantic equivalence — the roadmap's property test                      */
/* ========================================================================== */

describe('semantic equivalence: optimizeExpr never changes a verdict', () => {
  it('holds over 50 generated ASTs x 20 generated states (1,000 evaluations)', () => {
    const rng = rngOf(0xc0ffee);
    let evaluations = 0;
    for (let astIndex = 0; astIndex < 50; astIndex += 1) {
      const original = genBool(rng, 3);
      const optimized = optimizeExpr(original);
      for (let stateIndex = 0; stateIndex < 20; stateIndex += 1) {
        const answers = randomAnswers(rng);
        const before = verdictOf(original, answers);
        const after = verdictOf(optimized, answers);
        expect(after).toBe(before);
        evaluations += 1;
      }
    }
    expect(evaluations).toBe(1000);
  });

  it('optimizing twice is the same as optimizing once (idempotence)', () => {
    const rng = rngOf(1);
    for (let i = 0; i < 30; i += 1) {
      const original = genBool(rng, 3);
      const once = optimizeExpr(original);
      const twice = optimizeExpr(once);
      expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
    }
  });
});

/* ========================================================================== */
/* 6. compileLogic({ optimize }) parity — the roadmap's accept line           */
/* ========================================================================== */

describe('compileLogic optimize:true vs optimize:false — identical verdicts', () => {
  it('agree on every variable and every visible target for the D §4.3 four-rule fixture', () => {
    const rules = fourRules();
    const on = compileLogic(rules, E, { optimize: true });
    const off = compileLogic(rules, E, { optimize: false });
    expect(errorsOnly(on.diagnostics)).toEqual([]);
    expect(errorsOnly(off.diagnostics)).toEqual([]);

    for (const age of [10, 20, 40]) {
      const answers = { [V.age]: num(age) };
      const vOn = evaluate(on, varStateOf(answers), {});
      const vOff = evaluate(off, varStateOf(answers), {});
      for (const id of [V.segment, V.skipped, V.heavy]) {
        expect(vOn.value(id)).toEqual(vOff.value(id));
      }
    }
  });

  it('agree across a 200-rule generated tracker, including the shared-screener CSE case', () => {
    const t = tracker(200);
    const on = compileLogic(t.rules, t.env, { optimize: true });
    const off = compileLogic(t.rules, t.env, { optimize: false });
    expect(errorsOnly(on.diagnostics)).toEqual([]);
    expect(errorsOnly(off.diagnostics)).toEqual([]);

    const vOn = evaluate(on, varStateOf(t.answers), {});
    const vOff = evaluate(off, varStateOf(t.answers), {});
    for (const id of t.variables) {
      expect(vOn.value(id)).toEqual(vOff.value(id));
    }
    for (let i = 0; i < 200; i += 1) {
      const nodeId = `qst_t${String(i)}`;
      expect(vOn.visible(nodeId)).toBe(vOff.visible(nodeId));
    }
  });

  it('the optimized program is never larger, and is usually smaller, than the unoptimized one', () => {
    const t = tracker(200);
    const on = compileLogic(t.rules, t.env, { optimize: true });
    const off = compileLogic(t.rules, t.env, { optimize: false });
    expect(on.nodeCount).toBeLessThanOrEqual(off.nodeCount);
  });

  it('optimize defaults to true', () => {
    const t = tracker(50);
    const withDefault = compileLogic(t.rules, t.env);
    const explicitOn = compileLogic(t.rules, t.env, { optimize: true });
    expect(withDefault.nodeCount).toBe(explicitOn.nodeCount);
  });
});

/* ========================================================================== */
/* Sanity: verdictOf/evalExpr agree on a trivial case (guards the harness itself) */
/* ========================================================================== */

it('the test harness itself evaluates a bare literal correctly', () => {
  const b = astBuilder(1);
  expect(evalExpr(b.numLit(4), exprEnv({}))).toEqual(num(4));
  expect(evalExpr(b.nullLit(), exprEnv({}))).toEqual(NULL);
  expect(asVariableId(V.age)).toBe(V.age);
  expect(T_BOOL).toEqual({ k: 'bool' });
});
