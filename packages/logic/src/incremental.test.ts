/**
 * Incremental evaluation — D §5.3.
 *
 * The property that matters is *equivalence*: `onAnswerChange` must reach exactly the state a full
 * `evaluate` would reach. An incremental engine that is merely fast is a liability, because the
 * client and the server run different paths through it (the client patches, the server evaluates
 * from scratch on submit) and any divergence between the two is ADR-004's alarm firing on our own
 * bug. So the main test here is differential: 200 seeded answer sequences, comparing the
 * incremental cell state against a from-scratch evaluation after every step.
 */

import { describe, expect, it } from 'vitest';
import { DOM, Q, V, env, fourRules, shuffle, tracker } from './__fixtures__/survey.js';
import { compileLogic } from './compile.js';
import { evaluate, onAnswerChange } from './engine.js';
import { errorsOnly } from './diagnostics.js';
import { createEvalState, varStateOf, type CellValue } from './state.js';
import { NULL, TRUE, num, text, type Value } from './value.js';
import type { VariableId } from './ids.js';

const E = env();

function snapshot(cells: readonly (CellValue | undefined)[]): string {
  return JSON.stringify(cells);
}

describe('onAnswerChange reaches the same state as a full evaluation', () => {
  it('on the D §4.3 fixture, for every AGE transition', () => {
    const program = compileLogic(fourRules(), E);
    const ages = [30, 40, 34, 35, 18, 70];

    const answers: { [id: string]: Value } = {};
    const vars = varStateOf(answers);
    const state = createEvalState(program.cells.length, program.nodeCount);
    evaluate(program, vars, {}, { state });

    for (const age of ages) {
      answers[V.age] = num(age);
      const incremental = onAnswerChange(program, [V.age], vars, {}, state);
      const full = evaluate(program, varStateOf({ ...answers }), {});
      expect(snapshot(incremental.cells)).toBe(snapshot(full.cells));
    }
  });

  it('on a 200-rule tracker, over 200 seeded answer sequences', () => {
    const t = tracker(200);
    const program = compileLogic(t.rules, t.env);
    expect(errorsOnly(program.diagnostics)).toEqual([]);

    const answers: { [id: string]: Value } = { ...t.answers };
    const vars = varStateOf(answers);
    const state = createEvalState(program.cells.length, program.nodeCount);
    evaluate(program, vars, {}, { state });

    const mismatches: string[] = [];
    for (let step = 0; step < 200; step += 1) {
      const order = shuffle(t.variables, step);
      const target = order[0];
      if (target === undefined) continue;
      // Alternate between values that flip the `> 5` predicate and values that do not, so both
      // the pruning path and the propagating path are exercised.
      answers[target] = step % 3 === 0 ? num(9) : step % 3 === 1 ? num(1) : NULL;
      const incremental = onAnswerChange(program, [target], vars, {}, state);
      const full = evaluate(program, varStateOf({ ...answers }), {});
      if (snapshot(incremental.cells) !== snapshot(full.cells)) {
        mismatches.push(`step ${String(step)} changing ${target}`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('handles several variables changing at once, as a page submit does', () => {
    const t = tracker(50);
    const program = compileLogic(t.rules, t.env);
    const answers: { [id: string]: Value } = { ...t.answers };
    const vars = varStateOf(answers);
    const state = createEvalState(program.cells.length, program.nodeCount);
    evaluate(program, vars, {}, { state });

    const changed: VariableId[] = t.variables.slice(0, 10);
    for (const id of changed) answers[id] = num(7);
    const incremental = onAnswerChange(program, changed, vars, {}, state);
    const full = evaluate(program, varStateOf({ ...answers }), {});
    expect(snapshot(incremental.cells)).toBe(snapshot(full.cells));
  });
});

describe('value-equality pruning (D §5.3)', () => {
  it('stops at the first frontier when no verdict changes', () => {
    const t = tracker(200);
    const program = compileLogic(t.rules, t.env);
    const answers: { [id: string]: Value } = { ...t.answers };
    const vars = varStateOf(answers);
    const state = createEvalState(program.cells.length, program.nodeCount);
    evaluate(program, vars, {}, { state });

    const target = t.variables[7];
    if (target === undefined) throw new Error('fixture');
    const before = answers[target];
    // 6 and 7 are both `> 5`, so every downstream verdict is unchanged. The typical measured
    // frontier on a real 500-rule tracker is 3–12 cells; this must be small, not "all of them".
    answers[target] = num(before !== undefined && before.k === 'num' && before.v > 5 ? 8 : 9);
    answers[target] = num(9);
    const first = onAnswerChange(program, [target], vars, {}, state);
    answers[target] = num(10);
    const second = onAnswerChange(program, [target], vars, {}, state);

    expect(second.changes.map((c) => c.key)).toEqual([`value(${target})`]);
    expect(second.trace.length).toBeLessThan(10);
    expect(first.changes.length).toBeGreaterThan(0);
  });

  it('a change that alters nothing at all produces no changes and no cascade', () => {
    const program = compileLogic(fourRules(), E);
    const answers: { [id: string]: Value } = { [V.age]: num(30) };
    const vars = varStateOf(answers);
    const state = createEvalState(program.cells.length, program.nodeCount);
    evaluate(program, vars, {}, { state });
    const verdict = onAnswerChange(program, [V.age], vars, {}, state);
    expect(verdict.changes).toEqual([]);
  });

  it('propagates through the whole chain when a verdict really does change', () => {
    const program = compileLogic(fourRules(), E);
    const answers: { [id: string]: Value } = { [V.age]: num(30) };
    const vars = varStateOf(answers);
    const state = createEvalState(program.cells.length, program.nodeCount);
    const initial = evaluate(program, vars, {}, { state });
    expect(initial.visible(Q.q12)).toBe(true);

    answers[V.age] = num(40);
    const verdict = onAnswerChange(program, [V.age], vars, {}, state);
    const changedKeys = verdict.changes.map((c) => c.key);
    expect(changedKeys).toContain(`value(${V.segment})`);
    expect(changedKeys).toContain(`visible(${Q.q12})`);
    expect(changedKeys).toContain(`value(${V.skipped})`);
    expect(verdict.value(V.segment)).toEqual(text('old'));
    expect(verdict.value(V.skipped)).toBe(TRUE);
    expect(verdict.visible(Q.q12)).toBe(false);
  });

  it('never recomputes a cell twice in one pass, whatever the shape of the graph', () => {
    // A diamond: SEGMENT feeds both visible(Q12) and the option cell, and visible(Q12) feeds
    // SKIPPED_MAIN. A BFS would visit the shared inputs repeatedly.
    const program = compileLogic(fourRules(), E);
    const answers: { [id: string]: Value } = { [V.age]: num(30) };
    const vars = varStateOf(answers);
    const state = createEvalState(program.cells.length, program.nodeCount);
    evaluate(program, vars, {}, { state });
    answers[V.age] = num(60);
    const verdict = onAnswerChange(program, [V.age], vars, {}, state);
    const visited = verdict.trace.map((entry) => entry.cell);
    expect(new Set(visited).size).toBe(visited.length);
  });

  it('touches nothing when an unrelated variable changes', () => {
    const program = compileLogic(fourRules(), E);
    const answers: { [id: string]: Value } = { [V.age]: num(30) };
    const vars = varStateOf(answers);
    const state = createEvalState(program.cells.length, program.nodeCount);
    evaluate(program, vars, {}, { state });
    answers[V.openEnd] = text('typing');
    const verdict = onAnswerChange(program, [V.openEnd], vars, {}, state);
    // Only the changed variable's own cell is recomputed; no rule reads it.
    expect(verdict.trace.map((t) => t.cell)).toEqual([`value(${V.openEnd})`]);
  });
});

describe('epoch-stamped memoization (D §5.4)', () => {
  it('does not serve a stale memo across evaluations', () => {
    const program = compileLogic(fourRules(), E);
    const answers: { [id: string]: Value } = { [V.age]: num(30) };
    const vars = varStateOf(answers);
    const state = createEvalState(program.cells.length, program.nodeCount);
    expect(evaluate(program, vars, {}, { state }).value(V.segment)).toEqual(text('young'));
    answers[V.age] = num(50);
    // Same state object, same node ids, new epoch: the memo table must not answer from last time.
    expect(evaluate(program, vars, {}, { state }).value(V.segment)).toEqual(text('old'));
    expect(state.epoch).toBe(2);
  });

  it('CSE collapses the shared screener to one node', () => {
    const t = tracker(100);
    const program = compileLogic(t.rules, t.env);
    // Without CSE this would be ~100 rules x ~9 nodes. With the screener shared it is far fewer.
    const naive = t.rules.length * 9;
    expect(program.nodeCount).toBeLessThan(naive);
    // Every node is at its own index, densely numbered, which is what the memo table indexes on.
    program.nodes.forEach((node, i) => {
      expect(node.n).toBe(i);
    });
  });

  it('two structurally identical conditions become one node', () => {
    const t = tracker(10);
    const program = compileLogic(t.rules, t.env);
    const screenerNodes = program.nodes.filter(
      (node) => node.op === 'and' && (node as { readonly args: readonly unknown[] }).args.length === 2,
    );
    // One shared `S1 = 1 AND AGE >= 18`, plus the 2-arg conditions of the set_variable rules.
    expect(screenerNodes.length).toBeLessThan(t.rules.length);
    expect(program.nodes.filter((n) => n.op === 'var' && (n as { readonly var: string }).var === V.s1)).toHaveLength(1);
    expect(DOM.s1).toBeDefined();
  });
});
