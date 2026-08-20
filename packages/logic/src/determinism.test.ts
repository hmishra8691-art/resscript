/**
 * Order independence — the P1-06 acceptance criterion, stated in the roadmap as:
 *
 *   "The D §4.3 fixture produces identical verdicts under every one of 1,000 randomized rule
 *    orderings."
 *
 * The four rules are the ones D §4.3 uses to argue that order is a real problem:
 *
 *     R1: SET SEGMENT = CASE WHEN AGE < 35 THEN "young" ELSE "old" END
 *     R2: IF SEGMENT = "young" THEN SHOW Q12
 *     R3: IF NOT SHOWN(Q12) THEN SET SKIPPED_MAIN = TRUE
 *     R4: HIDE Q12 OPTION 4 IF SEGMENT = "old"
 *
 * A weaker version of this test — "the verdicts match" — would pass on an implementation that
 * happened to produce the right answer by two different routes. This asserts the stronger property
 * the design actually claims: the *entire compiled program* is byte-identical under permutation.
 * `topo` ships in the artifact (D §4.4), so if it were permutation-dependent, two compiles of the
 * same survey would produce two different artifact hashes and ADR-002's content addressing would
 * stop meaning anything.
 *
 * The shuffle is seeded (`shuffle(xs, seed)` in the fixtures) rather than `Math.random`: ADR-006
 * bans ambient entropy, and a failure on iteration 617 of 1,000 is only useful if iteration 617
 * can be reproduced.
 */

import { describe, expect, it } from 'vitest';
import { OPT, Q, V, env, fourRules, shuffle } from './__fixtures__/survey.js';
import { compileLogic, type CompiledLogic } from './compile.js';
import { evaluate } from './engine.js';
import { errorsOnly } from './diagnostics.js';
import { varStateOf } from './state.js';
import { NULL, TRUE, num, text, valueToJson, type Value } from './value.js';

const E = env();
const ORDERINGS = 1000;

interface Scenario {
  readonly name: string;
  readonly vars: { readonly [id: string]: Value };
  readonly expected: {
    readonly segment: unknown;
    readonly q12Visible: boolean;
    readonly skipped: unknown;
    readonly optionVisible: boolean;
  };
}

const SCENARIOS: readonly Scenario[] = [
  {
    name: 'a 30-year-old: young segment, Q12 shown, no skip recorded, option 4 kept',
    vars: { [V.age]: num(30) },
    expected: { segment: 'young', q12Visible: true, skipped: null, optionVisible: true },
  },
  {
    name: 'a 40-year-old: old segment, Q12 hidden, skip recorded, option 4 hidden',
    vars: { [V.age]: num(40) },
    expected: { segment: 'old', q12Visible: false, skipped: true, optionVisible: false },
  },
  {
    name: 'AGE unanswered: the CASE else wins, because an unknown `when` is not-matched',
    // Worth pinning: D §2.5's one deviation from strict Kleene propagation means an unanswered AGE
    // lands in the `else` branch rather than nulling SEGMENT. That is a *documented* consequence,
    // and an author who wants the null instead writes `CASE WHEN ANSWERED(AGE) AND AGE < 35 …`.
    vars: {},
    expected: { segment: 'old', q12Visible: false, skipped: true, optionVisible: false },
  },
  {
    name: 'exactly 35: the boundary falls in the else branch',
    vars: { [V.age]: num(35) },
    expected: { segment: 'old', q12Visible: false, skipped: true, optionVisible: false },
  },
];

function digest(program: CompiledLogic, vars: { readonly [id: string]: Value }): string {
  const verdict = evaluate(program, varStateOf(vars), {});
  return JSON.stringify({
    segment: valueToJson(verdict.value(V.segment)),
    skipped: valueToJson(verdict.value(V.skipped)),
    q12: verdict.visible(Q.q12),
    opt4: verdict.option(OPT.q12_4, 'visible'),
    termination: verdict.termination ?? null,
    cells: program.cellKeys.map((key, i) => [key, verdict.cells[i] ?? null]),
  });
}

/** Everything about a compiled program that the runtime consumes, as one comparable string. */
function programShape(program: CompiledLogic): string {
  return JSON.stringify({
    cells: program.cellKeys,
    topo: [...program.topo].map((cell) => program.cellKeys[cell]),
    topoPos: [...program.topoPos],
    dependents: program.dependents.map((set, i) => [program.cellKeys[i], [...set].map((c) => program.cellKeys[c])]),
    writers: program.writers.map((set, i) => [
      program.cellKeys[i],
      [...set].map((r) => program.rules[r]?.id),
    ]),
    triggers: [...program.triggers.entries()]
      .map(([variableId, cells]) => [variableId, [...cells].map((c) => program.cellKeys[c])])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    rules: program.rules.map((r) => r.id),
    nodeCount: program.nodeCount,
  });
}

describe('the D §4.3 four-rule fixture', () => {
  const canonical = compileLogic(fourRules(), E);

  it('compiles without errors', () => {
    expect(errorsOnly(canonical.diagnostics)).toEqual([]);
  });

  for (const scenario of SCENARIOS) {
    it(`produces the correct verdict for ${scenario.name}`, () => {
      const verdict = evaluate(canonical, varStateOf(scenario.vars), {});
      expect(valueToJson(verdict.value(V.segment))).toBe(scenario.expected.segment);
      expect(verdict.visible(Q.q12)).toBe(scenario.expected.q12Visible);
      expect(valueToJson(verdict.value(V.skipped))).toBe(scenario.expected.skipped);
      expect(verdict.option(OPT.q12_4, 'visible')).toBe(scenario.expected.optionVisible);
    });
  }

  it(`produces identical verdicts under all ${String(ORDERINGS)} shuffled insertion orders`, () => {
    const expected = SCENARIOS.map((scenario) => digest(canonical, scenario.vars));
    const failures: string[] = [];

    for (let seed = 0; seed < ORDERINGS; seed += 1) {
      const shuffled = shuffle(fourRules(), seed);
      const program = compileLogic(shuffled, E);
      SCENARIOS.forEach((scenario, i) => {
        const actual = digest(program, scenario.vars);
        if (actual !== expected[i]) {
          failures.push(
            `seed ${String(seed)} order [${shuffled.map((r) => r.id).join(',')}] scenario "${scenario.name}"\n` +
              `  expected ${String(expected[i])}\n  actual   ${actual}`,
          );
        }
      });
    }

    expect(failures).toEqual([]);
  });

  it(`produces a byte-identical compiled program under all ${String(ORDERINGS)} orders`, () => {
    const expected = programShape(canonical);
    const mismatches: string[] = [];
    for (let seed = 0; seed < ORDERINGS; seed += 1) {
      const shuffled = shuffle(fourRules(), seed);
      if (programShape(compileLogic(shuffled, E)) !== expected) {
        mismatches.push(`seed ${String(seed)}: [${shuffled.map((r) => r.id).join(',')}]`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('actually shuffles: the seeds produce every one of the 24 permutations', () => {
    // A shuffle that returned its input would make the two tests above vacuous.
    const seen = new Set<string>();
    for (let seed = 0; seed < ORDERINGS; seed += 1) {
      seen.add(shuffle(fourRules(), seed).map((r) => r.id).join(','));
    }
    expect(seen.size).toBe(24);
  });

  it('the shuffle is a pure function of its seed, so a failure is reproducible', () => {
    expect(shuffle(fourRules(), 617).map((r) => r.id)).toEqual(shuffle(fourRules(), 617).map((r) => r.id));
  });

  it('is insensitive to order_key ties, falling back to the rule id', () => {
    // Two rules with the same order_key must still order deterministically. The fixture's rules
    // are independent enough that only the tie-break can decide.
    const tied = fourRules().map((r) => ({ ...r, order_key: 0 }));
    const expected = programShape(compileLogic(tied, E));
    for (let seed = 0; seed < 100; seed += 1) {
      expect(programShape(compileLogic(shuffle(tied, seed), E))).toBe(expected);
    }
  });

  it('R3 records a skip only when Q12 really was hidden — not because it evaluated first', () => {
    // The specific bug D §4.3 describes: R2 reads SEGMENT before R1 wrote it, producing U,
    // collapsing to false, hiding Q12, and R3 then records a skip that did not happen.
    for (let seed = 0; seed < 200; seed += 1) {
      const program = compileLogic(shuffle(fourRules(), seed), E);
      const verdict = evaluate(program, varStateOf({ [V.age]: num(30) }), {});
      expect(verdict.value(V.segment)).toEqual(text('young'));
      expect(verdict.visible(Q.q12)).toBe(true);
      expect(verdict.value(V.skipped)).toBe(NULL);
    }
  });

  it('and does record one when Q12 really was hidden', () => {
    const verdict = evaluate(canonical, varStateOf({ [V.age]: num(70) }), {});
    expect(verdict.value(V.skipped)).toBe(TRUE);
  });
});
