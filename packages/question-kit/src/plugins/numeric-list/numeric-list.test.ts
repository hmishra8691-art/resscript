// @vitest-environment jsdom
/**
 * `numeric_list` against the conformance harness, plus the sum arithmetic as a property.
 *
 * The `expected` block pins the per-row fan-out (`Q1r1..Q1rn`, one number per row, code-ordered)
 * — the export contract a tracker's allocation grid lives on. The property tests pin the part
 * that floats would get wrong: a grid-valid allocation that adds to the target must validate,
 * whatever decimal dust its double sum carries.
 */

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { definePluginTests, item } from '../../testkit/index.js';
import { declareVariablesFor } from '../../declare.js';
import { createValidateContext, resolveQuestion } from '../../resolve.js';
import { fixtureQuestion } from '../../testkit/spec.js';
import { numericList } from './react.js';
import type { NumericListConfig } from './core.js';

const base: NumericListConfig = { decimals: 0, min: 0, max: 100 };
const three = [item('r1', 1), item('r2', 2), item('r3', 3)];

definePluginTests(numericList, {
  fixtures: {
    minimal: { config: base, rows: three, required: true },
    allocation: { config: { ...base, sum: { equals: 100 } }, rows: three, required: true },
    sum_bounded: { config: { ...base, sum: { min: 10, max: 50 } }, rows: three },
    decimals2: { config: { decimals: 2, min: 0, max: 1 }, rows: three },
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
      allocation: ['Q1r1 response number', 'Q1r2 response number', 'Q1r3 response number'],
      sum_bounded: ['Q1r1 response number', 'Q1r2 response number', 'Q1r3 response number'],
      decimals2: ['Q1r1 response number', 'Q1r2 response number', 'Q1r3 response number'],
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
      complete: { value: { values: { r1: 40, r2: 35, r3: 25 } } },
      with_errors: {
        value: { values: { r1: 40 } },
        issues: [
          {
            variableName: 'Q1r2',
            messageKey: 'err.required',
            severity: 'error',
            focus: { rowRef: 'r2' },
          },
        ],
      },
      disabled_rows: { itemStates: { r2: { enabled: false } } },
      masked: { itemStates: { r3: { visible: false } } },
    },
    assertSsrHydrationClean: true,
    assertNoPhysicalDirectionLeak: true,
  },

  validation: [
    { fixture: 'minimal', value: undefined, required: true, expect: ['err.required'] },
    { fixture: 'minimal', value: { values: {} }, required: true, expect: ['err.required'] },
    { fixture: 'minimal', value: { values: {} }, required: false, expect: [] },
    {
      fixture: 'minimal',
      value: { values: { r1: 5, r2: 10, r3: 0 } },
      required: true,
      expect: [],
    },
    // Partially answered and required: every blank box owes a value, and the error names it.
    {
      fixture: 'minimal',
      value: { values: { r1: 5 } },
      required: true,
      expect: ['err.required', 'err.required'],
      expectFocus: { rowRef: 'r2' },
    },
    {
      fixture: 'minimal',
      value: { values: { r1: 101 } },
      required: false,
      expect: ['err.out_of_range'],
      expectFocus: { rowRef: 'r1' },
    },
    {
      fixture: 'minimal',
      value: { values: { r1: 5.5 } },
      required: false,
      expect: ['err.not_numeric'],
      expectFocus: { rowRef: 'r1' },
    },
    {
      fixture: 'allocation',
      value: { values: { r1: 50, r2: 30, r3: 20 } },
      required: true,
      expect: [],
    },
    // Sums to 90: the page-scope check fires once, question-level.
    {
      fixture: 'allocation',
      value: { values: { r1: 50, r2: 30, r3: 10 } },
      required: true,
      expect: ['err.out_of_range'],
    },
    { fixture: 'sum_bounded', value: { values: { r1: 5 } }, required: false, expect: ['err.out_of_range'] },
    { fixture: 'sum_bounded', value: { values: { r1: 30, r2: 15 } }, required: false, expect: [] },
    { fixture: 'sum_bounded', value: { values: { r1: 30, r2: 30 } }, required: false, expect: ['err.out_of_range'] },
    { fixture: 'decimals2', value: { values: { r1: 0.25, r2: 0.5 } }, required: false, expect: [] },
  ],
  assertValidationSidesAgree: true,

  codec: {
    roundTrip: {
      minimal: [
        { values: {} },
        { values: { r1: 5 } },
        { values: { r1: 5, r2: 10, r3: 0 } },
      ],
      decimals2: [{ values: { r1: 0.25 } }, { values: { r1: 0.1, r2: 0.2, r3: 0.7 } }],
    },
    extraHostileInputs: [
      { values: 'not an object' },
      { values: [] },
      { values: { nope: 5 } },
      { values: { r1: '5' } },
      { values: { r1: Number.NaN } },
      { values: { r1: Number.POSITIVE_INFINITY } },
      { values: { r1: 5.5 } },
      { values: { r1: 1e308 } },
      { values: { r1: { nested: 1 } } },
      JSON.parse('{"values":{"__proto__":{"polluted":true}}}') as unknown,
    ],
    assertNoThrow: true,
    assertVariablesSubsetOfDeclared: true,
  },

  a11y: {
    assertContractRolesPresent: true,
    assertSingleTabStopPerGroup: true,
    assertTouchTargets: true,
    assertNoLocalLiveRegion: true,
    assertErrorWiring: true,
  },

  staticChecks: [
    { fixture: 'minimal', expect: [] },
    { fixture: 'allocation', expect: [] },
    { fixture: 'minimal', mutate: (q) => ({ ...q, rows: [] }), expect: ['no_rows'] },
    {
      fixture: 'minimal',
      mutate: (q) => ({ ...q, config: { ...q.config, min: 10, max: 5 } }),
      expect: ['impossible_bounds'],
    },
    {
      fixture: 'minimal',
      mutate: (q) => ({ ...q, config: { ...q.config, sum: { min: 50, max: 10 } } }),
      expect: ['impossible_sum_bounds'],
    },
    // `equals` inside coherent min/max: redundant, warned, not fatal (documented in core.ts).
    {
      fixture: 'minimal',
      mutate: (q) => ({ ...q, config: { ...q.config, sum: { equals: 100, min: 0, max: 200 } } }),
      expect: ['redundant_sum_bounds'],
    },
    // `equals` outside min/max: nothing could ever validate, so it is an error.
    {
      fixture: 'minimal',
      mutate: (q) => ({ ...q, config: { ...q.config, sum: { equals: 300, max: 200 } } }),
      expect: ['impossible_sum_bounds'],
    },
    // Three boxes capped at 100 cannot reach 1000.
    {
      fixture: 'minimal',
      mutate: (q) => ({ ...q, config: { ...q.config, sum: { equals: 1000 } } }),
      expect: ['impossible_sum_bounds'],
    },
  ],

  composition: {
    // Not composable: the fan-out has no cell-scoped name (`Q5r3r2`). A numeric grid is `matrix`
    // composing `numeric` per cell.
    asChildOf: [],
    asParentOf: [],
    assertChildNamespacing: false,
    assertTrustCompatibility: false,
  },
});

/* -------------------------------------------------------------------------- */
/* The sum constraint, which is the whole reason this plugin exists            */
/* -------------------------------------------------------------------------- */

describe('numeric_list sum arithmetic', () => {
  const validateWith = (
    config: NumericListConfig,
    values: Readonly<Record<string, number>>,
  ): readonly string[] => {
    const question = fixtureQuestion('numeric_list', { config, rows: three, required: false });
    const declarations = declareVariablesFor(numericList, question).declarations;
    const resolved = resolveQuestion(question, declarations);
    return numericList
      .validate(createValidateContext({ resolved, value: { values }, side: 'server' }))
      .map((issue) => issue.messageKey);
  };

  it('never rejects a correct 2-decimal allocation over float dust', () => {
    // Doubles: 25.5 + 25.5 + 49 is fine, but 0.1 + 0.2 + 99.7 !== 100 in raw float addition.
    // The scaled-integer sum must accept every grid-valid triple that adds to the target.
    const config: NumericListConfig = { decimals: 2, sum: { equals: 100 } };
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 10_000 }),
        fc.integer({ min: 0, max: 10_000 }),
        (a, b) => {
          fc.pre(a + b <= 10_000);
          const c = 10_000 - a - b;
          const issues = validateWith(config, { r1: a / 100, r2: b / 100, r3: c / 100 });
          expect(issues).toEqual([]);
        },
      ),
      { numRuns: 300 },
    );
    // The named villain, explicitly: 0.1 + 0.2 + 99.7 === 100.00000000000001 in doubles.
    expect(validateWith(config, { r1: 0.1, r2: 0.2, r3: 99.7 })).toEqual([]);
  });

  it('rejects every allocation off the target by one grid unit', () => {
    const config: NumericListConfig = { decimals: 0, sum: { equals: 100 } };
    expect(validateWith(config, { r1: 34, r2: 33, r3: 32 })).toEqual(['err.out_of_range']);
    expect(validateWith(config, { r1: 34, r2: 33, r3: 34 })).toEqual(['err.out_of_range']);
    expect(validateWith(config, { r1: 34, r2: 33, r3: 33 })).toEqual([]);
  });

  it('skips the sum check while a box is individually broken', () => {
    // One message per fix: the respondent repairs the box, then sees the (recomputed) sum state.
    const config: NumericListConfig = { decimals: 0, min: 0, max: 100, sum: { equals: 100 } };
    expect(validateWith(config, { r1: 200, r2: 33, r3: 33 })).toEqual(['err.out_of_range']);
  });

  it('carries the target and the current total in params, for the message template', () => {
    const question = fixtureQuestion('numeric_list', {
      config: { decimals: 0, sum: { equals: 100 } } satisfies NumericListConfig,
      rows: three,
    });
    const declarations = declareVariablesFor(numericList, question).declarations;
    const resolved = resolveQuestion(question, declarations);
    const issues = numericList.validate(
      createValidateContext({ resolved, value: { values: { r1: 40, r2: 40 } }, side: 'server' }),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]?.params).toEqual({ min: 100, max: 100, sum: 80 });
    expect(issues[0]?.variableName).toBeNull();
  });
});
