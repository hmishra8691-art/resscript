/**
 * The cell dependency graph — D §4.4, §4.5, §4.6.
 *
 * Three things are being defended here, and each has a specific failure it prevents:
 *
 *  1. **Ordering by dependency, not by phase.** The R3 rule of D §4.3 makes a `value` cell depend
 *     on a `visible` cell, inverting the phase ranks. An implementation that treats phases as
 *     evaluation passes gets this wrong and reads last page's answer.
 *  2. **Cycles are a compile error, not a runtime fixpoint.** With a diagnostic naming both rules,
 *     both cells and the cycle path.
 *  3. **Two writers to a non-lattice cell are banned.** Because there is no order-independent
 *     answer, and the alternative is a verdict that depends on insertion order.
 */

import { describe, expect, it } from 'vitest';
import { astBuilder } from './build.js';
import { OPT, Q, V, env, fourRules, rule } from './__fixtures__/survey.js';
import { buildCellGraph, stronglyConnected } from './graph.js';
import { compileLogic } from './compile.js';
import { errorsOnly } from './diagnostics.js';
import { evaluate } from './engine.js';
import { MinHeap } from './heap.js';
import { asVariableId } from './ids.js';
import { buildTypeEnv, type LogicRegistryInput } from './registry.js';
import type { Rule } from './rules.js';
import type { Expr } from './ast.js';
import { NULL } from './value.js';

const E = env();

function positionOf(graph: ReturnType<typeof buildCellGraph>, key: string): number {
  const index = graph.keys.indexOf(key);
  expect(index).toBeGreaterThanOrEqual(0);
  return graph.topoPos[index] ?? -1;
}

describe('topological order (D §4.4)', () => {
  const graph = buildCellGraph(fourRules(), E);

  it('has no cycle diagnostics for the D §4.3 fixture', () => {
    expect(graph.diagnostics).toEqual([]);
    expect(graph.topo.length).toBe(graph.cells.length);
  });

  it('orders value(SEGMENT) before visible(Q12) before value(SKIPPED_MAIN)', () => {
    // The dependency chain is R1 → R2 → R3. Note that value(SKIPPED_MAIN) is a *value* cell,
    // phase rank 0, ordered after a *visible* cell, phase rank 3 — the graph overrides the phase.
    const segment = positionOf(graph, `value(${V.segment})`);
    const visible = positionOf(graph, `visible(${Q.q12})`);
    const skipped = positionOf(graph, `value(${V.skipped})`);
    expect(segment).toBeLessThan(visible);
    expect(visible).toBeLessThan(skipped);
  });

  it('orders an unconstrained value cell before a visible cell, by phase rank', () => {
    // Where the graph says nothing, the phase layering is the tie-break and keeps traces readable.
    const age = positionOf(graph, `value(${V.age})`);
    const visible = positionOf(graph, `visible(${Q.q12})`);
    expect(age).toBeLessThan(visible);
  });

  it('records writers in application order: order_key, then rule id', () => {
    const index = graph.keys.indexOf(`visible(${Q.q12})`);
    expect([...(graph.writers[index] ?? [])]).toEqual([1]); // rul_r2 is index 1 in fourRules()
  });

  it('builds a trigger closure that reaches indirectly-dependent cells', () => {
    // AGE feeds SEGMENT feeds visible(Q12) feeds SKIPPED_MAIN and opt(...). All four must be in
    // AGE's trigger set, or a keystroke on AGE leaves the skip counter stale.
    const triggered = new Set([...(graph.triggers.get(V.age) ?? [])].map((cell) => graph.keys[cell]));
    expect(triggered).toContain(`value(${V.segment})`);
    expect(triggered).toContain(`visible(${Q.q12})`);
    expect(triggered).toContain(`value(${V.skipped})`);
    expect(triggered).toContain(`opt(${OPT.q12_4}.visible)`);
    // And not the variable's own cell, which the caller seeds directly.
    expect(triggered).not.toContain(`value(${V.age})`);
  });

  it('gives a source variable an empty input set', () => {
    const index = graph.keys.indexOf(`value(${V.age})`);
    expect([...(graph.inputs[index] ?? [])]).toEqual([]);
  });

  it('makes an ANSWERED probe a real dependency (an omission in D §4.4s read list)', () => {
    const b = astBuilder();
    const guarded = rule({
      id: 'rul_guard',
      kind: 'display',
      target: { type: 'question', id: Q.q12 },
      condition: b.probe('answered', { kind: 'variable', id: V.q9 }),
      effect: { action: 'show' },
      order_key: 1,
    });
    const g = buildCellGraph([guarded], E);
    const triggered = new Set([...(g.triggers.get(V.q9) ?? [])].map((cell) => g.keys[cell]));
    expect(triggered).toContain(`visible(${Q.q12})`);
  });

  it('makes an aggregation over a question option list depend on the mask result', () => {
    const b = astBuilder();
    const counting = rule({
      id: 'rul_count',
      kind: 'display',
      target: { type: 'question', id: Q.q12 },
      condition: b.cmp(
        '>',
        b.agg({ fn: 'count', over: { kind: 'options', question_id: Q.q5 } }),
        b.numLit(2),
      ),
      effect: { action: 'show' },
      order_key: 1,
    });
    const g = buildCellGraph([counting], E);
    expect(g.keys).toContain(`items(${Q.q5}.options)`);
    expect(positionOf(g, `items(${Q.q5}.options)`)).toBeLessThan(positionOf(g, `visible(${Q.q12})`));
  });

  it('orders a derived variable after everything its expression reads', () => {
    const b = astBuilder();
    const derivedEnv = buildTypeEnv(
      derivedRegistry(b.caseExpr([{ when: b.cmp('<', b.variable(V.age), b.numLit(25)), then: b.numLit(1) }], b.numLit(2))),
    );
    const g = buildCellGraph([], derivedEnv);
    expect(positionOf(g, `value(${V.age})`)).toBeLessThan(positionOf(g, `value(${V.ageBand})`));
  });
});

/** A two-variable registry where AGE_BAND is derived from AGE, for the ordering test. */
function derivedRegistry(expression: Expr): LogicRegistryInput {
  return {
    variables: [
      { id: V.age, name: 'AGE', kind: 'response', type: 'number', persist: true, pii: false },
      {
        id: V.ageBand,
        name: 'AGE_BAND',
        kind: 'derived',
        type: 'number',
        persist: true,
        pii: false,
        expression,
      },
    ],
    domains: [],
  };
}

describe('cycles (D §4.5)', () => {
  function cyclicRules(): readonly Rule[] {
    const b1 = astBuilder(1);
    const b2 = astBuilder(100);
    // The exact pair from D §4.5's diagnostic example.
    const r2 = rule({
      id: 'rul_r2',
      kind: 'display',
      target: { type: 'question', id: Q.q12 },
      condition: b1.cmp('==', b1.variable(V.segment), b1.textLit('young')),
      effect: { action: 'show' },
      order_key: 2,
      label: 'Show Q12 to the young segment',
    });
    const r7 = rule({
      id: 'rul_r7',
      kind: 'set_variable',
      target: { type: 'variable', id: V.segment },
      condition: b2.probe('shown', { kind: 'question', id: Q.q12 }),
      effect: { action: 'set', variable_id: V.segment, value: b2.textLit('young') },
      order_key: 7,
      label: 'Infer the segment from visibility',
    });
    return [r2, r7];
  }

  it('reports LGC-CYCLE naming both rules, both cells, and the cycle path', () => {
    const graph = buildCellGraph(cyclicRules(), E);
    const cycle = graph.diagnostics.find((d) => d.code === 'LGC-CYCLE');
    expect(cycle).toBeDefined();
    expect(cycle?.message).toContain('rul_r2');
    expect(cycle?.message).toContain('rul_r7');
    expect(cycle?.detail?.['rules']).toEqual(['rul_r2', 'rul_r7']);
    expect(cycle?.detail?.['cells']).toEqual(
      expect.arrayContaining([`value(${V.segment})`, `visible(${Q.q12})`]),
    );
    const path = cycle?.detail?.['cycle'];
    expect(Array.isArray(path) ? path.length : 0).toBeGreaterThanOrEqual(3);
    // The path is a cycle: it starts and ends on the same cell.
    if (Array.isArray(path)) expect(path[0]).toBe(path[path.length - 1]);
  });

  it('leaves topo empty rather than emitting an arbitrary order', () => {
    const graph = buildCellGraph(cyclicRules(), E);
    expect(graph.topo.length).toBe(0);
  });

  it('refuses to evaluate a program with no topological order', () => {
    const program = compileLogic(cyclicRules(), E);
    expect(errorsOnly(program.diagnostics).map((d) => d.code)).toContain('LGC-CYCLE');
    // Evaluating anyway would produce a verdict that depends on array order — precisely the
    // nondeterminism LGC-CYCLE exists to prevent.
    expect(() => evaluate(program, { value: () => NULL }, {})).toThrow(/no topological order/u);
  });

  it('detects a self-loop: SET X = X + 1', () => {
    const b = astBuilder();
    const selfish = rule({
      id: 'rul_self',
      kind: 'set_variable',
      target: { type: 'variable', id: V.heavy },
      condition: b.variable(V.heavy),
      effect: { action: 'set', variable_id: V.heavy, value: b.boolLit(true) },
      order_key: 1,
    });
    const graph = buildCellGraph([selfish], E);
    expect(graph.diagnostics.map((d) => d.code)).toContain('LGC-CYCLE');
  });

  it('does not report a cycle for a diamond', () => {
    const b = astBuilder();
    const rules: readonly Rule[] = [
      rule({
        id: 'rul_d1',
        kind: 'set_variable',
        target: { type: 'variable', id: V.segment },
        condition: b.boolLit(true),
        effect: { action: 'set', variable_id: V.segment, value: b.textLit('x') },
        order_key: 1,
      }),
      rule({
        id: 'rul_d2',
        kind: 'display',
        target: { type: 'question', id: Q.q12 },
        condition: b.cmp('==', b.variable(V.segment), b.textLit('x')),
        effect: { action: 'show' },
        order_key: 2,
      }),
      rule({
        id: 'rul_d3',
        kind: 'option_state',
        target: { type: 'option', id: OPT.q5_1 },
        condition: b.cmp('==', b.variable(V.segment), b.textLit('x')),
        effect: { action: 'option_state', option_id: OPT.q5_1, prop: 'visible', value: b.boolLit(false) },
        order_key: 3,
      }),
    ];
    expect(buildCellGraph(rules, E).diagnostics).toEqual([]);
  });

  it('Tarjan finds the components of a hand-built graph', () => {
    //  0 -> 1 -> 2 -> 0  (one SCC),  3 -> 4 (two singletons)
    const dependents = [
      Int32Array.from([1]),
      Int32Array.from([2]),
      Int32Array.from([0]),
      Int32Array.from([4]),
      Int32Array.from([]),
    ];
    const components = stronglyConnected(dependents);
    const sizes = components.map((c) => c.length).sort((a, b) => a - b);
    expect(sizes).toEqual([1, 1, 3]);
    expect(components.find((c) => c.length === 3)).toEqual([0, 1, 2]);
  });
});

describe('multiple writers (D §4.6)', () => {
  function twoSetters(priorityGroup?: string): readonly Rule[] {
    const b1 = astBuilder(1);
    const b2 = astBuilder(100);
    return [
      rule({
        id: 'rul_w1',
        kind: 'set_variable',
        target: { type: 'variable', id: V.segment },
        condition: b1.boolLit(true),
        effect: { action: 'set', variable_id: V.segment, value: b1.textLit('a') },
        order_key: 1,
        ...(priorityGroup === undefined ? {} : { priority_group: priorityGroup }),
      }),
      rule({
        id: 'rul_w2',
        kind: 'set_variable',
        target: { type: 'variable', id: V.segment },
        condition: b2.boolLit(true),
        effect: { action: 'set', variable_id: V.segment, value: b2.textLit('b') },
        order_key: 2,
        ...(priorityGroup === undefined ? {} : { priority_group: priorityGroup }),
      }),
    ];
  }

  it('reports LGC-CONFLICT for two set_variable rules on one variable', () => {
    const graph = buildCellGraph(twoSetters(), E);
    const conflict = graph.diagnostics.find((d) => d.code === 'LGC-CONFLICT');
    expect(conflict).toBeDefined();
    expect(conflict?.detail?.['rules']).toEqual(['rul_w1', 'rul_w2']);
    expect(conflict?.message).toContain('PRIORITY GROUP');
  });

  it('exempts rules in one explicit PRIORITY GROUP, where last-writer-wins is the intent', () => {
    const graph = buildCellGraph(twoSetters('seg'), E);
    expect(graph.diagnostics).toEqual([]);
  });

  it('does not exempt rules in two different priority groups', () => {
    const [a, b] = twoSetters('seg');
    if (a === undefined || b === undefined) throw new Error('fixture');
    const graph = buildCellGraph([a, { ...b, priority_group: 'other' }], E);
    expect(graph.diagnostics.map((d) => d.code)).toContain('LGC-CONFLICT');
  });

  it('inside a PRIORITY GROUP the last writer in application order wins, deterministically', () => {
    const program = compileLogic(twoSetters('seg'), E);
    const verdict = evaluate(program, { value: () => NULL }, {});
    expect(verdict.value(V.segment)).toEqual({ k: 'text', v: 'b' });

    // Reversing the array does not reverse the outcome: application order is order_key, not the
    // order rules happened to arrive in.
    const reversed = compileLogic([...twoSetters('seg')].reverse(), E);
    expect(evaluate(reversed, { value: () => NULL }, {}).value(V.segment)).toEqual({ k: 'text', v: 'b' });
  });

  it('reports a conflict when a rule writes a derived variable, which owns its own value', () => {
    const b = astBuilder();
    const derivedEnv = buildTypeEnv({
      variables: [
        { id: V.age, name: 'AGE', kind: 'response', type: 'number', persist: true, pii: false },
        {
          id: V.ageBand,
          name: 'AGE_BAND',
          kind: 'derived',
          type: 'number',
          persist: true,
          pii: false,
          expression: b.numLit(1),
        },
      ],
      domains: [],
    });
    const clash = rule({
      id: 'rul_clash',
      kind: 'set_variable',
      target: { type: 'variable', id: V.ageBand },
      condition: b.boolLit(true),
      effect: { action: 'set', variable_id: V.ageBand, value: b.numLit(2) },
      order_key: 1,
    });
    const graph = buildCellGraph([clash], derivedEnv);
    const conflict = graph.diagnostics.find((d) => d.code === 'LGC-CONFLICT');
    expect(conflict?.message).toContain('derived variable');
  });
});

describe('the min-heap', () => {
  it('pops in key order regardless of push order', () => {
    const keys = [9, 1, 7, 3, 3, 0, 12, 5];
    const heap = new MinHeap((item) => keys[item] ?? 0);
    for (let i = keys.length - 1; i >= 0; i -= 1) heap.push(i);
    const popped: number[] = [];
    for (;;) {
      const item = heap.pop();
      if (item === undefined) break;
      popped.push(keys[item] ?? -1);
    }
    expect(popped).toEqual([...keys].sort((a, b) => a - b));
    expect(heap.isEmpty()).toBe(true);
    expect(heap.pop()).toBeUndefined();
  });
});

describe('unresolvable references degrade rather than crash', () => {
  it('an unknown variable still produces a cell so the graph stays total', () => {
    const b = astBuilder();
    const unknown = asVariableId('var_ghost');
    const broken = rule({
      id: 'rul_ghost',
      kind: 'display',
      target: { type: 'question', id: Q.q12 },
      condition: b.cmp('==', b.variable(unknown), b.textLit('x')),
      effect: { action: 'show' },
      order_key: 1,
    });
    const graph = buildCellGraph([broken], E);
    expect(graph.keys).toContain(`value(${unknown})`);
    expect(graph.diagnostics).toEqual([]); // the *checker* reports LGC-T001, not the graph
  });
});
