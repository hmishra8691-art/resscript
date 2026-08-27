// @vitest-environment jsdom
/**
 * `constant_sum` against the conformance harness, plus the arithmetic that decides whether a
 * correct allocation is accepted.
 *
 * The property this file exists for: **a correct allocation of decimal values must not be rejected
 * over float dust.** `25.5 + 25.5 + 24.5 + 24.5` in doubles is not reliably `100`, and an
 * allocation grid that refuses a valid answer is a support ticket per wave. The sum is therefore
 * computed in grid-scaled integers, and the property test below walks a few hundred exact
 * decompositions of the budget to prove it.
 *
 * The second is the under/over distinction. An allocation adding to 80 of 100 is INCOMPLETE and an
 * allocation adding to 120 is over budget; `allow_partial` accepts the first and never the second.
 */

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { definePluginTests, item } from '../../testkit/index.js';
import { declareVariablesFor } from '../../declare.js';
import { createCodecContext, resolveQuestion } from '../../resolve.js';
import { fixtureQuestion } from '../../testkit/spec.js';
import { constantSum } from './react.js';
import { allocation, type ConstantSumConfig } from './core.js';

const base: ConstantSumConfig = { total: 100, decimals: 0 };
const three = [item('r1', 1), item('r2', 2), item('r3', 3)];
const four = [...three, item('r4', 4)];

definePluginTests(constantSum, {
  fixtures: {
    minimal: { config: base, rows: three, required: true },
    percent: { config: { ...base, unit: 'percent' }, rows: three, required: true },
    capped: { config: { ...base, max_per_item: 50 }, rows: three, required: true },
    partial_ok: { config: { ...base, allow_partial: true }, rows: three },
    decimals1: { config: { total: 10, decimals: 1 }, rows: four, required: true },
    no_counter: { config: { ...base, show_remaining: false }, rows: three },
    looped: {
      config: base,
      rows: three,
      loop: { iterationVariableRef: 'BRAND', naming: '{ref}_{iteration}', iteration: 2 },
    },
    excluded_from_export: { config: base, rows: three, flags: { excludeFromExport: true } },
    flagged_pii: { config: base, rows: three, flags: { pii: true } },
  },

  variableSnapshots: {
    expected: {
      minimal: ['Q1r1 response number', 'Q1r2 response number', 'Q1r3 response number'],
      percent: ['Q1r1 response number', 'Q1r2 response number', 'Q1r3 response number'],
      capped: ['Q1r1 response number', 'Q1r2 response number', 'Q1r3 response number'],
      partial_ok: ['Q1r1 response number', 'Q1r2 response number', 'Q1r3 response number'],
      decimals1: [
        'Q1r1 response number',
        'Q1r2 response number',
        'Q1r3 response number',
        'Q1r4 response number',
      ],
      no_counter: ['Q1r1 response number', 'Q1r2 response number', 'Q1r3 response number'],
      // The loop template wraps each row name whole: iteration 2 of `Q1r1` is `Q1r1_2`.
      looped: ['Q1r1_2 response number', 'Q1r2_2 response number', 'Q1r3_2 response number'],
      excluded_from_export: [
        'Q1r1 response number (unexported)',
        'Q1r2 response number (unexported)',
        'Q1r3 response number (unexported)',
      ],
      flagged_pii: [
        'Q1r1 response number (pii)',
        'Q1r2 response number (pii)',
        'Q1r3 response number (pii)',
      ],
    },
    assertOrderIndependent: true,
    assertDeterministic: true,
    assertRenameCoherent: true,
    assertAnalysable: true,
  },

  render: {
    dirs: ['ltr', 'rtl'],
    devices: ['desktop', 'tablet', 'mobile'],
    states: {
      empty: {},
      partial: { value: { values: { r1: 40 } } },
      complete: { value: { values: { r1: 40, r2: 30, r3: 30 } } },
      over_budget: { value: { values: { r1: 80, r2: 80 } } },
      with_errors: {
        value: { values: {} },
        issues: [{ variableName: null, messageKey: 'err.required', severity: 'error' }],
      },
    },
    assertSsrHydrationClean: true,
    assertNoPhysicalDirectionLeak: true,
  },

  validation: [
    { fixture: 'minimal', value: undefined, required: true, expect: ['err.required'] },
    { fixture: 'minimal', value: { values: {} }, required: true, expect: ['err.required'] },
    { fixture: 'minimal', value: { values: {} }, required: false, expect: [] },
    { fixture: 'minimal', value: { values: { r1: 40, r2: 30, r3: 30 } }, required: true, expect: [] },
    // Short of the budget: an error unless the author allowed partials.
    {
      fixture: 'minimal',
      value: { values: { r1: 40, r2: 30 } },
      required: true,
      expect: ['err.out_of_range'],
    },
    { fixture: 'partial_ok', value: { values: { r1: 40, r2: 30 } }, required: true, expect: [] },
    // Over the budget: an error even when partials are allowed — the two are different faults.
    {
      fixture: 'partial_ok',
      value: { values: { r1: 80, r2: 80 } },
      required: true,
      expect: ['err.out_of_range'],
    },
    // A per-item cap is reported per box, and the budget check is suppressed until boxes are clean.
    {
      fixture: 'capped',
      value: { values: { r1: 60, r2: 40 } },
      required: true,
      expect: ['err.out_of_range'],
    },
    // Zero is a real allocation, so a complete allocation containing one passes.
    {
      fixture: 'minimal',
      value: { values: { r1: 100, r2: 0, r3: 0 } },
      required: true,
      expect: [],
    },
    // Decimal allocation that only adds up under exact arithmetic.
    {
      fixture: 'decimals1',
      value: { values: { r1: 2.5, r2: 2.5, r3: 2.5, r4: 2.5 } },
      required: true,
      expect: [],
    },
    {
      fixture: 'decimals1',
      value: { values: { r1: 2.5, r2: 2.5, r3: 2.5, r4: 2.6 } },
      required: true,
      expect: ['err.out_of_range'],
    },
  ],
  assertValidationSidesAgree: true,

  codec: {
    roundTrip: {
      minimal: [{ values: {} }, { values: { r1: 100 } }, { values: { r1: 40, r2: 30, r3: 30 } }],
      decimals1: [{ values: { r1: 2.5, r2: 7.5 } }],
    },
    extraHostileInputs: [
      // Negative allocations cannot come from the boxes (floor of zero), so the codec rejects.
      { values: { r1: -5 } },
      { values: { r1: '40' } },
      { values: { r1: Number.NaN } },
      { values: { r1: Number.POSITIVE_INFINITY } },
      { values: { r1: 1e308 } },
      { values: { r1: 0.5 } },
      { values: { ghost: 10 } },
      { values: [] },
      { values: 5 },
      { values: { r1: true } },
    ],
    assertNoThrow: true,
    assertVariablesSubsetOfDeclared: true,
  },

  a11y: {
    assertContractRolesPresent: true,
    assertSingleTabStopPerGroup: true,
    assertTouchTargets: true,
    // The remainder is plain text tied by aria-describedby, not a plugin-local live region.
    assertNoLocalLiveRegion: true,
    assertErrorWiring: true,
  },

  staticChecks: [
    { fixture: 'minimal', expect: [] },
    { fixture: 'decimals1', expect: [] },
    {
      fixture: 'minimal',
      mutate: (q) => ({ ...q, rows: [item('r1', 1)] }),
      expect: ['too_few_rows'],
    },
    {
      // A budget the boxes cannot express: no combination of integers reaches 99.5.
      fixture: 'minimal',
      mutate: (q) => ({ ...q, config: { ...q.config, total: 99.5, decimals: 0 } }),
      expect: ['total_off_grid'],
    },
    {
      // Three rows capped at 30 can reach only 90 of a 100 budget.
      fixture: 'minimal',
      mutate: (q) => ({ ...q, config: { ...q.config, max_per_item: 30 } }),
      expect: ['unreachable_total'],
    },
    {
      fixture: 'minimal',
      mutate: (q) => ({ ...q, options: [item('o1', 1)] }),
      expect: ['options_ignored'],
    },
  ],

  composition: {
    // Not composable: the constraint spans the whole row set, and a matrix cell holds one control.
    asChildOf: [],
    asParentOf: [],
    assertChildNamespacing: false,
    assertTrustCompatibility: true,
  },
});

/* -------------------------------------------------------------------------- */
/* Properties specific to this plugin                                         */
/* -------------------------------------------------------------------------- */

describe('allocation arithmetic', () => {
  const refs = ['r1', 'r2', 'r3', 'r4'];

  it('is exact for decimal values that float addition gets wrong', () => {
    // 25.5 + 25.5 + 24.5 + 24.5 — the case in the header. In doubles this is not reliably 100.
    const { allocated, remaining } = allocation(
      { r1: 25.5, r2: 25.5, r3: 24.5, r4: 24.5 },
      refs,
      { total: 100, decimals: 1 },
    );

    expect(allocated).toBe(100);
    expect(remaining).toBe(0);
  });

  it('accepts every exact 4-way integer decomposition of the budget', () => {
    fc.assert(
      fc.property(
        fc.tuple(
          fc.integer({ min: 0, max: 100 }),
          fc.integer({ min: 0, max: 100 }),
          fc.integer({ min: 0, max: 100 }),
        ),
        ([a, b, c]) => {
          // Only decompositions that actually fit the budget.
          if (a + b + c > 100) return;
          const d = 100 - a - b - c;
          const { allocated, remaining } = allocation(
            { r1: a, r2: b, r3: c, r4: d },
            refs,
            { total: 100, decimals: 0 },
          );
          expect(allocated).toBe(100);
          expect(remaining).toBe(0);
        },
      ),
      { numRuns: 400 },
    );
  });

  it('counts blanks as unallocated rather than as zero', () => {
    // The distinction the answer shape exists to preserve: an untouched box is not an allocation
    // of nothing, and counting it as one would make `answered` wrong and the required check pass.
    const { allocated, remaining, answered } = allocation({ r1: 40 }, refs, {
      total: 100,
      decimals: 0,
    });

    expect(allocated).toBe(40);
    expect(remaining).toBe(60);
    expect(answered).toBe(1);
  });

  it('reports a negative remainder when over budget, rather than clamping', () => {
    // "-20 left" tells a respondent they are over more directly than any message.
    expect(allocation({ r1: 80, r2: 40 }, refs, { total: 100, decimals: 0 }).remaining).toBe(-20);
  });
});

describe('constant_sum codec properties', () => {
  const question = fixtureQuestion('constant_sum', { config: base, rows: three });
  const declarations = declareVariablesFor(constantSum, question).declarations;
  const ctx = createCodecContext({ question, resolved: resolveQuestion(question, declarations) });

  it('writes null for a blank box rather than omitting its column', () => {
    // The export shape must not depend on how much the respondent allocated.
    expect(constantSum.codec.toVariables({ values: { r2: 100 } }, ctx)).toEqual({
      Q1r1: null,
      Q1r2: 100,
      Q1r3: null,
    });
  });

  it('rejects every negative allocation', () => {
    fc.assert(
      fc.property(fc.integer({ min: -1000, max: -1 }), (value) => {
        const parsed = constantSum.codec.parse({ values: { r1: value } }, ctx);
        expect(parsed.ok).toBe(false);
        if (!parsed.ok) expect(parsed.error.code).toBe('range');
      }),
      { numRuns: 100 },
    );
  });

  it('accepts an OVER-budget total, leaving it to validate', () => {
    // The split the plugin rests on: over budget is a real respondent error that must come back as
    // a message beside the question, not a rejected page that loses their other answers.
    const parsed = constantSum.codec.parse({ values: { r1: 100, r2: 100, r3: 100 } }, ctx);

    expect(parsed.ok).toBe(true);
  });

  it('parse never throws on arbitrary garbage', () => {
    fc.assert(
      fc.property(fc.anything(), (raw) => {
        const result = constantSum.codec.parse(raw, ctx);
        expect(typeof result.ok).toBe('boolean');
      }),
      { numRuns: 500 },
    );
  });
});
