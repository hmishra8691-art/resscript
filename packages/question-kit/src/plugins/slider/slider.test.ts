// @vitest-environment jsdom
/**
 * `slider` against the conformance harness, plus the properties that separate it from `numeric`.
 *
 * The one this file exists for: **an untouched slider must not answer the question.** Every slider
 * draws its thumb somewhere, and the bias a midpoint default introduces is invisible in the data —
 * a pile of exactly-midpoint answers looks like genuine centrism and no export can tell the
 * difference. So the resting position is asserted to be a *rendering* fact and never a value: the
 * codec's empty answer is null for every `resting_position`, and `required` still fires.
 */

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { definePluginTests, item } from '../../testkit/index.js';
import { declareVariablesFor } from '../../declare.js';
import { createCodecContext, resolveQuestion } from '../../resolve.js';
import { fixtureQuestion } from '../../testkit/spec.js';
import { slider } from './react.js';
import { restingValue, type SliderConfig } from './core.js';

const base: SliderConfig = { min: 0, max: 100, decimals: 0 };

definePluginTests(slider, {
  fixtures: {
    minimal: { config: base, required: true },
    labelled: {
      config: {
        ...base,
        min_label_key: 'q1.min',
        max_label_key: 'q1.max',
        show_value: true,
      },
      required: true,
    },
    midpoint_rest: { config: { ...base, min: -50, max: 50, resting_position: 'midpoint' } },
    decimals1: { config: { min: 0, max: 10, decimals: 1, step: 0.5 }, required: true },
    ticked: {
      config: {
        ...base,
        ticks: [
          { value: 0, labelKey: 'tick.none' },
          { value: 50, labelKey: 'tick.half' },
          { value: 100, labelKey: 'tick.all' },
        ],
      },
    },
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
      labelled: ['Q1 response number'],
      midpoint_rest: ['Q1 response number'],
      decimals1: ['Q1 response number'],
      ticked: ['Q1 response number'],
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
      partial: { value: { value: 25 } },
      complete: { value: { value: 100 } },
      untouched_midpoint: { value: { value: null } },
      with_errors: {
        value: { value: null },
        issues: [{ variableName: 'Q1', messageKey: 'err.required', severity: 'error' }],
      },
    },
    assertSsrHydrationClean: true,
    // The reason this matters more here than for most plugins: a hand-built track positioned with
    // `left: %` would look right to an LTR reviewer and mirror wrongly in Arabic. The renderer
    // delegates direction to the native range input precisely so this assertion can hold.
    assertNoPhysicalDirectionLeak: true,
  },

  validation: [
    // The headline: an untouched slider is unanswered, so a required one fails.
    { fixture: 'minimal', value: undefined, required: true, expect: ['err.required'] },
    { fixture: 'minimal', value: { value: null }, required: true, expect: ['err.required'] },
    { fixture: 'minimal', value: { value: null }, required: false, expect: [] },
    // A midpoint RESTING position does not make the midpoint an answer.
    { fixture: 'midpoint_rest', value: { value: null }, required: true, expect: ['err.required'] },
    { fixture: 'minimal', value: { value: 0 }, required: true, expect: [] },
    { fixture: 'minimal', value: { value: 100 }, required: true, expect: [] },
    { fixture: 'minimal', value: { value: 101 }, required: true, expect: ['err.out_of_range'] },
    { fixture: 'minimal', value: { value: 7.5 }, required: true, expect: ['err.not_numeric'] },
    { fixture: 'decimals1', value: { value: 7.5 }, required: true, expect: [] },
    { fixture: 'decimals1', value: { value: 7.55 }, required: true, expect: ['err.not_numeric'] },
  ],
  assertValidationSidesAgree: true,

  codec: {
    roundTrip: {
      minimal: [{ value: null }, { value: 0 }, { value: 50 }, { value: 100 }],
      decimals1: [{ value: 0.5 }, { value: 9.9 }, { value: null }],
    },
    extraHostileInputs: [
      { value: '50' },
      { value: Number.NaN },
      { value: Number.POSITIVE_INFINITY },
      { value: 1e308 },
      { value: 7.5 },
      // Off the TRACK, not merely off an authored bound: a slider cannot produce these, so the
      // codec rejects rather than validating (see core.ts' note on the difference from numeric).
      { value: -1 },
      { value: 101 },
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
    { fixture: 'decimals1', expect: [] },
    {
      fixture: 'minimal',
      mutate: (q) => ({ ...q, config: { ...q.config, min: 100, max: 0 } }),
      expect: ['impossible_bounds'],
    },
    {
      // A zero-width track: one reachable value, so the control cannot express an answer.
      fixture: 'minimal',
      mutate: (q) => ({ ...q, config: { ...q.config, min: 5, max: 5 } }),
      expect: ['impossible_bounds'],
    },
    {
      // A stride finer than the grid builds values the plugin's own codec rejects.
      fixture: 'minimal',
      mutate: (q) => ({ ...q, config: { ...q.config, decimals: 0, step: 0.5 } }),
      expect: ['step_off_grid'],
    },
    {
      fixture: 'minimal',
      mutate: (q) => ({ ...q, config: { ...q.config, step: 500 } }),
      expect: ['step_exceeds_range'],
    },
    {
      fixture: 'minimal',
      mutate: (q) => ({
        ...q,
        config: { ...q.config, ticks: [{ value: 500, labelKey: 'tick.oops' }] },
      }),
      expect: ['tick_off_track'],
    },
    {
      fixture: 'minimal',
      mutate: (q) => ({ ...q, options: [item('o1', 1)] }),
      expect: ['options_ignored'],
    },
  ],

  composition: {
    asChildOf: ['matrix'],
    asParentOf: [],
    assertChildNamespacing: true,
    assertTrustCompatibility: true,
  },
});

/* -------------------------------------------------------------------------- */
/* Properties specific to this plugin                                         */
/* -------------------------------------------------------------------------- */

describe('the resting position is never an answer', () => {
  function ctxFor(config: SliderConfig) {
    const question = fixtureQuestion('slider', { config });
    const declarations = declareVariablesFor(slider, question).declarations;
    return createCodecContext({ question, resolved: resolveQuestion(question, declarations) });
  }

  it('emptyAnswer is null for every resting position', () => {
    // The invariant the whole plugin is shaped around. If any of these returned a number, a
    // respondent who skipped the question would be recorded as having chosen it.
    for (const resting of ['min', 'midpoint', 'max'] as const) {
      const answer = slider.codec.emptyAnswer(ctxFor({ ...base, resting_position: resting }));
      expect(answer, `resting_position: ${resting}`).toEqual({ value: null });
    }
  });

  it('a null answer round-trips as null rather than as the resting value', () => {
    const config: SliderConfig = { ...base, min: -50, max: 50, resting_position: 'midpoint' };
    const ctx = ctxFor(config);

    const vars = slider.codec.toVariables({ value: null }, ctx);
    expect(Object.values(vars)).toEqual([null]);
    expect(slider.codec.fromVariables(vars, ctx)).toEqual({ value: null });
    // And the resting value it would have DRAWN is a real number that is deliberately not stored.
    expect(restingValue(config)).toBe(0);
  });

  it('restingValue lands on the grid, so the first arrow key does not appear to jump', () => {
    // An odd-width range: the true midpoint of [0, 5] is 2.5, which is off a 0-decimal grid.
    expect(restingValue({ min: 0, max: 5, decimals: 0, resting_position: 'midpoint' })).toBe(3);
    expect(restingValue({ min: 0, max: 5, decimals: 1, resting_position: 'midpoint' })).toBe(2.5);
    expect(restingValue({ min: 10, max: 20, decimals: 0, resting_position: 'min' })).toBe(10);
    expect(restingValue({ min: 10, max: 20, decimals: 0, resting_position: 'max' })).toBe(20);
    // Absent means `min` — the least anchoring choice.
    expect(restingValue({ min: 7, max: 9, decimals: 0 })).toBe(7);
  });
});

describe('slider codec properties', () => {
  const config: SliderConfig = { min: 0, max: 100, decimals: 1 };
  const question = fixtureQuestion('slider', { config });
  const declarations = declareVariablesFor(slider, question).declarations;
  const ctx = createCodecContext({ question, resolved: resolveQuestion(question, declarations) });

  it('accepts every on-grid value on the track and round-trips it exactly', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1000 }), (tenths) => {
        const value = tenths / 10;
        const parsed = slider.codec.parse({ value }, ctx);
        expect(parsed.ok, `rejected on-track value ${value}`).toBe(true);
        const vars = slider.codec.toVariables({ value }, ctx);
        expect(slider.codec.fromVariables(vars, ctx)).toEqual({ value });
      }),
      { numRuns: 300 },
    );
  });

  it('rejects everything off the track with a range error', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -5000, max: 5000 }).filter((t) => t < 0 || t > 1000),
        (tenths) => {
          const parsed = slider.codec.parse({ value: tenths / 10 }, ctx);
          expect(parsed.ok).toBe(false);
          if (!parsed.ok) expect(parsed.error.code).toBe('range');
        },
      ),
      { numRuns: 300 },
    );
  });

  it('parse never throws on arbitrary garbage', () => {
    fc.assert(
      fc.property(fc.anything(), (raw) => {
        const result = slider.codec.parse(raw, ctx);
        expect(typeof result.ok).toBe('boolean');
      }),
      { numRuns: 500 },
    );
  });
});
