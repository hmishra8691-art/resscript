/**
 * The evaluation budget — 01 §8 via D §5.1 and D §10.2.
 *
 *   Full evaluation of a 500-rule survey: **under 5 ms.**
 *   Single-variable dirty-set propagation:  **under 1 ms.**
 *
 * Both are asserted on the *median* of repeated runs rather than a single sample. That is not
 * softening the budget, it is measuring the right thing: a single timing on shared CI hardware
 * picks up scheduler noise and GC pauses that have nothing to do with the evaluator, and a test
 * that fails once a week for reasons nobody can reproduce gets disabled. The median of 25 runs on
 * a warm JIT is stable to a few percent and still fails immediately if the algorithm regresses —
 * the failure mode being guarded against is quadratic propagation or a per-node allocation, which
 * changes these numbers by an order of magnitude, not by 20%.
 *
 * D §10.2's own measurements on an M2 are 0.44 ms for a full 640-rule evaluation and 0.048 ms for
 * the worst observed incremental cascade, so a 10× margin is expected and the thresholds below are
 * the *budget*, not the target.
 *
 * The budgets are additionally scaled by `machineScale()` — see its comment. The median handles
 * noise *within* a run; the calibration handles a host that is uniformly slower than the one the
 * numbers were written on, which is what a parallel workspace test run produces.
 */

import { describe, expect, it } from 'vitest';
import { tracker } from './__fixtures__/survey.js';
import { compileLogic } from './compile.js';
import { evaluate, onAnswerChange } from './engine.js';
import { errorsOnly } from './diagnostics.js';
import { createEvalState, varStateOf } from './state.js';
import { num, type Value } from './value.js';

/**
 * `performance.now()` is a clock — but this is a *test* file, not the engine. ADR-006's ban is on
 * the evaluator reading a clock, because a verdict that depends on time cannot be replayed. Timing
 * the evaluator from outside is the only way to hold it to a budget at all.
 */
function median(samples: readonly number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted[middle] ?? Number.POSITIVE_INFINITY;
}

function time(runs: number, body: () => void): number {
  const samples: number[] = [];
  for (let i = 0; i < 5; i += 1) body(); // warm the JIT
  for (let i = 0; i < runs; i += 1) {
    const start = performance.now();
    body();
    samples.push(performance.now() - start);
  }
  return median(samples);
}

/**
 * How much slower this machine is, right now, than the machine the budgets were written for.
 *
 * WHY THIS EXISTS. The budgets above are absolute wall-clock numbers, and the median of 25 runs
 * is stable to a few percent — on an idle machine. Turborepo runs the whole workspace's test
 * tasks in parallel, so by P1-08 this file executes alongside eighteen other vitest processes on
 * a shared container, and then an absolute millisecond threshold is measuring the host's run
 * queue rather than the evaluator. That failure is real (it appeared the moment `packages/compiler`
 * became the nineteenth task) and it is the worst kind: it fails on a machine nobody can
 * reproduce, so the next person raises the threshold or deletes the test, and the quadratic
 * propagation the file exists to catch then ships unnoticed.
 *
 * So the budget is scaled by a calibration measured in this same process moments before: a fixed
 * arithmetic loop whose cost is pure CPU and allocation-free, timed the same way. Contention slows
 * the calibration and the evaluator together, and the ratio is what the assertion is really about.
 *
 * The scale is CLAMPED at 8x. Above that the machine is so loaded that the measurement means
 * nothing either way, and an unbounded scale would turn the budget into a tautology — the one
 * thing worse than a flaky perf test is one that cannot fail.
 */
const CALIBRATION_BASELINE_MS = 0.35;
const MAX_MACHINE_SCALE = 8;

function machineScale(): number {
  const elapsed = time(25, () => {
    let acc = 0;
    for (let i = 1; i < 200_000; i += 1) acc += i % 7;
    if (acc === -1) throw new Error('unreachable, and keeps the loop from being elided');
  });
  const scale = elapsed / CALIBRATION_BASELINE_MS;
  return Math.min(Math.max(scale, 1), MAX_MACHINE_SCALE);
}

describe('performance budget', () => {
  const t = tracker(500);
  const program = compileLogic(t.rules, t.env);
  const scale = machineScale();

  it('compiles 500 rules without diagnostics', () => {
    expect(errorsOnly(program.diagnostics)).toEqual([]);
    expect(program.rules).toHaveLength(500);
    expect(program.cells.length).toBeGreaterThan(500);
  });

  it('evaluates all 500 rules in under 5 ms', () => {
    const vars = varStateOf(t.answers);
    const elapsed = time(25, () => {
      evaluate(program, vars, {});
    });
    expect(elapsed).toBeLessThan(5 * scale);
  });

  it('propagates a single-variable change in under 1 ms', () => {
    const answers: { [id: string]: Value } = { ...t.answers };
    const vars = varStateOf(answers);
    const state = createEvalState(program.cells.length, program.nodeCount);
    evaluate(program, vars, {}, { state });

    const target = t.variables[250];
    if (target === undefined) throw new Error('fixture');
    let flip = 0;
    const elapsed = time(200, () => {
      flip += 1;
      // Alternate across the `> 5` boundary so the change really does propagate every run rather
      // than being pruned at the first frontier, which would measure nothing.
      answers[target] = num(flip % 2 === 0 ? 9 : 1);
      onAnswerChange(program, [target], vars, {}, state);
    });
    expect(elapsed).toBeLessThan(1 * scale);
  });

  it('a pruned change is far cheaper than a propagating one', () => {
    const answers: { [id: string]: Value } = { ...t.answers };
    const vars = varStateOf(answers);
    const state = createEvalState(program.cells.length, program.nodeCount);
    evaluate(program, vars, {}, { state });
    const target = t.variables[100];
    if (target === undefined) throw new Error('fixture');

    answers[target] = num(9);
    const propagating = onAnswerChange(program, [target], vars, {}, state);
    // 9 and 10 are both `> 5`, so the *stored value* changes but no verdict does. Propagation
    // visits the one cell that reads it, finds no change, and stops — 2 cells out of 600-odd.
    answers[target] = num(10);
    const pruned = onAnswerChange(program, [target], vars, {}, state);
    expect(pruned.trace).toHaveLength(2);
    expect(pruned.changes.map((c) => c.key)).toEqual([`value(${target})`]);
    expect(propagating.trace.length).toBeGreaterThan(pruned.trace.length);
    expect(pruned.trace.length * 10).toBeLessThan(program.cells.length);
  });

  it('compiles 500 rules in well under the publish budget', () => {
    // 01 §8 gives the whole publish path 5 s for 500 questions; D §10.2 measures typecheck plus
    // graph construction at ~50 ms for 640 rules. A regression here would show up as a publish
    // that takes minutes, which is the kind of thing that gets discovered by a customer.
    const elapsed = time(5, () => {
      compileLogic(t.rules, t.env);
    });
    expect(elapsed).toBeLessThan(1000 * scale);
  });
});
