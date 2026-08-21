// @vitest-environment jsdom
/**
 * `numeric` against the conformance harness, plus the decimal-grid property.
 *
 * The interesting rejections are the codec's: off-grid decimals and unsafe magnitudes come back
 * as `range` errors rather than being rounded into plausible-looking data. If this file is green,
 * a `numeric` column contains only numbers a respondent could actually have entered.
 */

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { definePluginTests, item } from '../../testkit/index.js';
import { declareVariablesFor } from '../../declare.js';
import { createCodecContext, resolveQuestion } from '../../resolve.js';
import { fixtureQuestion } from '../../testkit/spec.js';
import { numeric } from './react.js';
import { onDecimalGrid, type NumericConfig } from './core.js';

const base: NumericConfig = { display: 'input', decimals: 0, min: 0, max: 10 };

definePluginTests(numeric, {
  fixtures: {
    minimal: { config: base, required: true },
    unbounded: { config: { display: 'input', decimals: 0 } },
    decimals2: {
      config: {
        display: 'input',
        decimals: 2,
        min: 0,
        max: 100,
        unit: { labelKey: 'unit.percent', position: 'suffix' },
      },
      required: true,
    },
    stepper: { config: { display: 'stepper', decimals: 0, min: 1, max: 5, step: 1 } },
    looped: {
      config: base,
      loop: { iterationVariableRef: 'BRAND', naming: '{ref}_{iteration}', iteration: 3 },
    },
    excluded_from_export: { config: base, flags: { excludeFromExport: true } },
    flagged_pii: { config: base, flags: { pii: true } },
  },

  variableSnapshots: {
    expected: {
      minimal: ['Q1 response number'],
      unbounded: ['Q1 response number'],
      decimals2: ['Q1 response number'],
      stepper: ['Q1 response number'],
      looped: ['Q1_3 response number'],
      excluded_from_export: ['Q1 response number (unexported)'],
      flagged_pii: ['Q1 response number (pii)'],
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
      partial: { value: { value: 3 } },
      complete: { value: { value: 7 } },
      with_errors: {
        value: { value: null },
        issues: [{ variableName: 'Q1', messageKey: 'err.required', severity: 'error' }],
      },
    },
    assertSsrHydrationClean: true,
    assertNoPhysicalDirectionLeak: true,
  },

  validation: [
    { fixture: 'minimal', value: undefined, required: true, expect: ['err.required'] },
    { fixture: 'minimal', value: { value: null }, required: false, expect: [] },
    { fixture: 'minimal', value: { value: 0 }, required: true, expect: [] },
    { fixture: 'minimal', value: { value: 10 }, required: true, expect: [] },
    { fixture: 'minimal', value: { value: 11 }, required: true, expect: ['err.out_of_range'] },
    { fixture: 'minimal', value: { value: -1 }, required: true, expect: ['err.out_of_range'] },
    // Off the declared grid is "not a valid number for this question", not "too big".
    { fixture: 'minimal', value: { value: 7.5 }, required: true, expect: ['err.not_numeric'] },
    { fixture: 'decimals2', value: { value: 7.25 }, required: true, expect: [] },
    { fixture: 'decimals2', value: { value: 7.255 }, required: true, expect: ['err.not_numeric'] },
    // No authored bounds means any grid value passes, however large-looking.
    { fixture: 'unbounded', value: { value: 123456 }, required: false, expect: [] },
  ],
  assertValidationSidesAgree: true,

  codec: {
    roundTrip: {
      minimal: [{ value: null }, { value: 0 }, { value: 7 }],
      // 1.15's double is not 115/100 exactly; the grid check must still accept it.
      decimals2: [{ value: 1.15 }, { value: 99.99 }, { value: null }],
    },
    extraHostileInputs: [
      { value: '9' },
      { value: Number.NaN },
      { value: Number.POSITIVE_INFINITY },
      { value: Number.NEGATIVE_INFINITY },
      { value: 1e308 },
      { value: 9007199254740993 },
      { value: 7.5 },
      { value: {} },
      { value: [] },
      { value: true },
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
    {
      fixture: 'minimal',
      mutate: (q) => ({ ...q, config: { ...q.config, min: 10, max: 5 } }),
      expect: ['impossible_bounds'],
    },
    {
      fixture: 'minimal',
      mutate: (q) => ({ ...q, options: [item('o1', 1)] }),
      expect: ['options_ignored'],
    },
  ],

  composition: {
    // The composable first-party leaf: one self-named variable, so a numeric row in a mixed
    // matrix needs nothing the scoped namer cannot provide.
    asChildOf: ['matrix'],
    asParentOf: [],
    assertChildNamespacing: true,
    assertTrustCompatibility: true,
  },
});

/* -------------------------------------------------------------------------- */
/* Properties specific to this plugin                                         */
/* -------------------------------------------------------------------------- */

describe('numeric properties', () => {
  const question = fixtureQuestion('numeric', {
    config: { display: 'input', decimals: 2 } satisfies NumericConfig,
  });
  const declarations = declareVariablesFor(numeric, question).declarations;
  const ctx = createCodecContext({ question, resolved: resolveQuestion(question, declarations) });

  it('accepts every 2-decimal grid point and round-trips it exactly', () => {
    fc.assert(
      fc.property(fc.integer({ min: -1_000_000, max: 1_000_000 }), (cents) => {
        const value = cents / 100;
        const parsed = numeric.codec.parse({ value }, ctx);
        expect(parsed.ok, `rejected grid value ${value}`).toBe(true);
        const vars = numeric.codec.toVariables({ value }, ctx);
        expect(numeric.codec.fromVariables(vars, ctx)).toEqual({ value });
      }),
      { numRuns: 300 },
    );
  });

  it('rejects every off-grid value with a range error, never by rounding', () => {
    fc.assert(
      fc.property(
        fc.double({ noNaN: true, noDefaultInfinity: true, min: -1e6, max: 1e6 }),
        (value) => {
          const parsed = numeric.codec.parse({ value }, ctx);
          if (onDecimalGrid(value, 2)) {
            expect(parsed.ok).toBe(true);
            if (parsed.ok) expect(parsed.value.value).toBe(value); // exact, not rounded
          } else {
            expect(parsed.ok).toBe(false);
            if (!parsed.ok) expect(parsed.error.code).toBe('range');
          }
        },
      ),
      { numRuns: 500 },
    );
  });

  it('parse never throws on arbitrary garbage', () => {
    fc.assert(
      fc.property(fc.anything(), (raw) => {
        const result = numeric.codec.parse(raw, ctx);
        expect(typeof result.ok).toBe('boolean');
      }),
      { numRuns: 500 },
    );
  });

  it('the classic float traps sit on the right side of the grid check', () => {
    // 1.15 * 100 === 114.99999999999999, yet 1.15 IS the nearest double to a grid point.
    expect(onDecimalGrid(1.15, 2)).toBe(true);
    expect(onDecimalGrid(0.1 + 0.2, 2)).toBe(false); // 0.30000000000000004
    expect(onDecimalGrid(0.3, 2)).toBe(true);
    expect(onDecimalGrid(7.5, 0)).toBe(false);
    expect(onDecimalGrid(7, 0)).toBe(true);
  });
});
