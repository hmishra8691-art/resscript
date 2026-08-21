// @vitest-environment jsdom
/**
 * `date` against the conformance harness, plus the calendar check as a property.
 *
 * The one assertion this file exists for: **`2026-02-30` is rejected, not rolled forward.**
 * `new Date('2026-02-30')` silently produces March 2nd, so any implementation that leans on
 * `Date` turns a fat-fingered payload into a different, plausible answer — and the property
 * test below cross-checks the pure calendar arithmetic against UTC `Date` construction on the
 * round trip where `Date` *is* trustworthy (integer fields in, integer fields out).
 */

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { definePluginTests, item } from '../../testkit/index.js';
import { declareVariablesFor } from '../../declare.js';
import { fixtureQuestion } from '../../testkit/spec.js';
import { date } from './react.js';
import { isCalendarDate, type DateConfig } from './core.js';

const bounded: DateConfig = { mode: 'date', min: '2026-01-01', max: '2026-12-31' };
const single: DateConfig = { mode: 'date' };
const range: DateConfig = { mode: 'range' };

definePluginTests(date, {
  fixtures: {
    // First fixture is the bounded single: the hostile-input suite runs against it.
    minimal: { config: bounded, required: true },
    unbounded: { config: single },
    range: { config: range, required: true },
    range_looped: {
      config: range,
      loop: { iterationVariableRef: 'WAVE', naming: '{ref}_{iteration}', iteration: 5 },
    },
    looped: {
      config: single,
      loop: { iterationVariableRef: 'WAVE', naming: '{ref}_{iteration}', iteration: 5 },
    },
    excluded_from_export: { config: single, flags: { excludeFromExport: true } },
    flagged_pii: { config: single, flags: { pii: true } },
  },

  variableSnapshots: {
    expected: {
      minimal: ['Q1 response date'],
      unbounded: ['Q1 response date'],
      range: ['Q1_from response date', 'Q1_to response date'],
      // The suffix is part of the base name; the iteration wraps the whole thing (like nps's
      // `Q1_band_3`).
      range_looped: ['Q1_from_5 response date', 'Q1_to_5 response date'],
      looped: ['Q1_5 response date'],
      excluded_from_export: ['Q1 response date (unexported)'],
      flagged_pii: ['Q1 response date (pii)'],
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
      partial: { value: { date: '2026-03-14', from: '2026-01-01', to: null } },
      complete: { value: { date: '2026-03-14', from: '2026-01-01', to: '2026-03-31' } },
      with_errors: {
        value: { date: null, from: null, to: null },
        issues: [{ variableName: 'Q1', messageKey: 'err.required', severity: 'error' }],
      },
    },
    assertSsrHydrationClean: true,
    assertNoPhysicalDirectionLeak: true,
  },

  validation: [
    { fixture: 'minimal', value: undefined, required: true, expect: ['err.required'] },
    { fixture: 'minimal', value: { date: null, from: null, to: null }, required: false, expect: [] },
    { fixture: 'minimal', value: { date: '2026-06-15', from: null, to: null }, required: true, expect: [] },
    // Inclusive bounds: the edges validate.
    { fixture: 'minimal', value: { date: '2026-01-01', from: null, to: null }, required: true, expect: [] },
    { fixture: 'minimal', value: { date: '2026-12-31', from: null, to: null }, required: true, expect: [] },
    {
      fixture: 'minimal',
      value: { date: '2025-12-31', from: null, to: null },
      required: true,
      expect: ['err.out_of_range'],
    },
    {
      fixture: 'minimal',
      value: { date: '2027-01-01', from: null, to: null },
      required: true,
      expect: ['err.out_of_range'],
    },
    // Defensive: a rolled or half-typed date reaching validate is "not a valid value", reusing
    // the closest guaranteed key (see core.ts).
    {
      fixture: 'minimal',
      value: { date: '2026-02-30', from: null, to: null },
      required: true,
      expect: ['err.invalid_option'],
    },
    { fixture: 'range', value: undefined, required: true, expect: ['err.required'] },
    {
      fixture: 'range',
      value: { date: null, from: '2026-01-01', to: null },
      required: true,
      expect: ['err.required'],
    },
    {
      fixture: 'range',
      value: { date: null, from: '2026-01-01', to: '2026-06-30' },
      required: true,
      expect: [],
    },
    // A one-day range is a range.
    {
      fixture: 'range',
      value: { date: null, from: '2026-06-30', to: '2026-06-30' },
      required: true,
      expect: [],
    },
    {
      fixture: 'range',
      value: { date: null, from: '2026-06-30', to: '2026-01-01' },
      required: true,
      expect: ['err.out_of_range'],
    },
  ],
  assertValidationSidesAgree: true,

  codec: {
    roundTrip: {
      minimal: [
        { date: null, from: null, to: null },
        { date: '2026-02-28', from: null, to: null },
      ],
      // 2024-02-29 existed; 1900 would not have (checked in the property suite below).
      unbounded: [{ date: '2024-02-29', from: null, to: null }],
      range: [
        { date: null, from: '2026-01-01', to: '2026-06-30' },
        { date: null, from: '2026-05-01', to: null },
        { date: null, from: null, to: null },
      ],
    },
    extraHostileInputs: [
      { date: '2026-02-30' },
      { date: '2026-13-01' },
      { date: '2026-00-10' },
      { date: '2026-04-31' },
      { date: '1900-02-29' },
      { date: '26-01-01' },
      { date: '2026/01/01' },
      { date: '2026-1-1' },
      { date: '2026-01-01T00:00:00Z' },
      { date: 20260101 },
      { date: '' },
      { date: 'x'.repeat(1_000_000) },
    ],
    assertNoThrow: true,
    assertVariablesSubsetOfDeclared: true,
  },

  a11y: {
    assertContractRolesPresent: true,
    // Range mode adds the wrapping group around its two textboxes.
    rolesByFixture: {
      range: ['group', 'textbox'],
      range_looped: ['group', 'textbox'],
    },
    assertSingleTabStopPerGroup: true,
    assertTouchTargets: true,
    assertNoLocalLiveRegion: true,
    assertErrorWiring: true,
  },

  staticChecks: [
    { fixture: 'minimal', expect: [] },
    { fixture: 'range', expect: [] },
    {
      fixture: 'minimal',
      mutate: (q) => ({ ...q, config: { ...q.config, min: '2026-02-30' } }),
      expect: ['invalid_bound'],
    },
    {
      fixture: 'minimal',
      mutate: (q) => ({ ...q, config: { ...q.config, min: '2026-12-31', max: '2026-01-01' } }),
      expect: ['impossible_bounds'],
    },
    {
      fixture: 'minimal',
      mutate: (q) => ({ ...q, options: [item('o1', 1)] }),
      expect: ['options_ignored'],
    },
  ],

  composition: {
    // Not composable while range mode exists on this plugin: `Q5r3_from` has no schema §4 part.
    // See `meta.composable` in core.ts for the honest version of that sentence.
    asChildOf: [],
    asParentOf: [],
    assertChildNamespacing: false,
    assertTrustCompatibility: false,
  },
});

/* -------------------------------------------------------------------------- */
/* The calendar check, which is the whole reason `Date` is banned here         */
/* -------------------------------------------------------------------------- */

describe('date calendar arithmetic', () => {
  it('agrees with UTC Date construction for every (y, m, d) triple in range', () => {
    // `Date.UTC` from integer *fields* is trustworthy (no string parsing, no timezone): the
    // round trip back to fields changes iff the input rolled over. The pure check must agree.
    fc.assert(
      fc.property(
        fc.integer({ min: 1583, max: 9999 }),
        fc.integer({ min: 1, max: 12 }),
        fc.integer({ min: 1, max: 31 }),
        (year, month, day) => {
          const text = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
          const utc = new Date(Date.UTC(year, month - 1, day));
          const real =
            utc.getUTCFullYear() === year &&
            utc.getUTCMonth() === month - 1 &&
            utc.getUTCDate() === day;
          expect(isCalendarDate(text), text).toBe(real);
        },
      ),
      { numRuns: 1000 },
    );
  });

  it('applies the full Gregorian leap rule, not %4', () => {
    expect(isCalendarDate('2024-02-29')).toBe(true); // %4
    expect(isCalendarDate('2000-02-29')).toBe(true); // %400 overrides %100
    expect(isCalendarDate('1900-02-29')).toBe(false); // %100 kills %4
    expect(isCalendarDate('2026-02-29')).toBe(false);
  });

  it('range mode declares two suffixed response variables and no self', () => {
    const question = fixtureQuestion('date', { config: range });
    const declarations = declareVariablesFor(date, question).declarations;
    expect(declarations.map((declaration) => declaration.name)).toEqual(['Q1_from', 'Q1_to']);
    for (const declaration of declarations) {
      expect(declaration.kind).toBe('response');
      expect(declaration.type).toBe('date');
      expect(declaration.source.part.kind).toBe('meta');
    }
  });
});
