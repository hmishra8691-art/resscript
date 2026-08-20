// @vitest-environment jsdom
/**
 * `multi_select` against the conformance harness.
 *
 * The interesting assertions are in `expected`: n booleans plus one derived, transient,
 * unexported `set<enum>`. If the set view ever gains `include: true` this file fails, which is the
 * point — a `set` in a flat export cell is the non-analysable shape F §4 exists to prevent.
 */

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { definePluginTests, item } from '../../testkit/index.js';
import { declareVariablesFor } from '../../declare.js';
import { evaluateDerivation } from '../../contract/variables.js';
import { fixtureQuestion } from '../../testkit/spec.js';
import { multiSelect } from './react.js';
import type { MultiSelectConfig } from './core.js';

const base: MultiSelectConfig = {
  display: 'vertical',
  columns: 1,
  minSelected: 0,
  maxSelected: 0,
  other: { enabled: false, maxLen: 200, required: true },
};

const three = [item('o1', 1), item('o2', 2), item('o3', 3)];
const four = [...three, item('o4', 4)];
const withOther = [...three, item('o4', 4, { otherSpecify: true })];
const withExclusive = [...three, item('o9', 9, { exclusive: true })];

definePluginTests(multiSelect, {
  fixtures: {
    minimal: { config: base, options: three, required: true },
    with_other: {
      config: { ...base, other: { enabled: true, maxLen: 200, required: true } },
      options: withOther,
      required: true,
    },
    bounded: { config: { ...base, minSelected: 2, maxSelected: 3 }, options: four, required: true },
    with_exclusive: { config: base, options: withExclusive, required: true },
    flagged_pii: { config: base, options: three, flags: { pii: true } },
  },

  variableSnapshots: {
    expected: {
      minimal: [
        'Q1r1 response boolean',
        'Q1r2 response boolean',
        'Q1r3 response boolean',
        'Q1 derived set [1,2,3] <set_view> (unexported,transient)',
      ],
      with_other: [
        'Q1r1 response boolean',
        'Q1r2 response boolean',
        'Q1r3 response boolean',
        'Q1r4 response boolean',
        'Q1 derived set [1,2,3,4] <set_view> (unexported,transient)',
        'Q1r4_other response text (pii)',
      ],
      bounded: [
        'Q1r1 response boolean',
        'Q1r2 response boolean',
        'Q1r3 response boolean',
        'Q1r4 response boolean',
        'Q1 derived set [1,2,3,4] <set_view> (unexported,transient)',
      ],
      with_exclusive: [
        'Q1r1 response boolean',
        'Q1r2 response boolean',
        'Q1r3 response boolean',
        'Q1r9 response boolean',
        'Q1 derived set [1,2,3,9] <set_view> (unexported,transient)',
      ],
      flagged_pii: [
        'Q1r1 response boolean (pii)',
        'Q1r2 response boolean (pii)',
        'Q1r3 response boolean (pii)',
        'Q1 derived set [1,2,3] <set_view> (unexported,pii,transient)',
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
      partial: { value: { codes: [1], otherTexts: {} } },
      complete: { value: { codes: [1, 2, 3], otherTexts: {} } },
      with_errors: {
        value: { codes: [], otherTexts: {} },
        issues: [{ variableName: null, messageKey: 'err.required', severity: 'error' }],
      },
      disabled_options: { itemStates: { o2: { enabled: false } } },
      masked: { itemStates: { o3: { visible: false } } },
    },
    assertSsrHydrationClean: true,
    assertNoPhysicalDirectionLeak: true,
  },

  validation: [
    { fixture: 'minimal', value: undefined, required: true, expect: ['err.required'] },
    { fixture: 'minimal', value: { codes: [], otherTexts: {} }, required: true, expect: ['err.required'] },
    { fixture: 'minimal', value: { codes: [], otherTexts: {} }, required: false, expect: [] },
    { fixture: 'minimal', value: { codes: [1, 3], otherTexts: {} }, required: true, expect: [] },
    {
      fixture: 'minimal',
      value: { codes: [99], otherTexts: {} },
      required: true,
      expect: ['err.invalid_option'],
    },
    {
      fixture: 'bounded',
      value: { codes: [1], otherTexts: {} },
      required: true,
      expect: ['err.too_few_selected'],
    },
    {
      fixture: 'bounded',
      value: { codes: [1, 2, 3, 4], otherTexts: {} },
      required: true,
      expect: ['err.too_many_selected'],
    },
    {
      fixture: 'with_exclusive',
      value: { codes: [1, 9], otherTexts: {} },
      required: true,
      expect: ['err.exclusive_violated'],
    },
    { fixture: 'with_exclusive', value: { codes: [9], otherTexts: {} }, required: true, expect: [] },
    {
      fixture: 'with_other',
      value: { codes: [4], otherTexts: {} },
      required: true,
      expect: ['err.other_required'],
      expectFocus: { optionRef: 'o4' },
    },
    {
      fixture: 'with_other',
      value: { codes: [4], otherTexts: { o4: 'y'.repeat(201) } },
      required: true,
      expect: ['err.too_long'],
      expectFocus: { optionRef: 'o4' },
    },
  ],
  assertValidationSidesAgree: true,

  codec: {
    roundTrip: {
      minimal: [
        { codes: [], otherTexts: {} },
        { codes: [1], otherTexts: {} },
        { codes: [1, 2, 3], otherTexts: {} },
      ],
      with_other: [
        { codes: [4], otherTexts: { o4: 'a reason' } },
        { codes: [1, 4], otherTexts: { o4: 'another' } },
      ],
    },
    extraHostileInputs: [
      { codes: 'not an array' },
      { codes: [{ nested: 1 }] },
      { codes: [1], otherTexts: { unknown_ref: 'x' } },
      { codes: [1], otherTexts: { o1: 42 } },
      { codes: [1], otherTexts: { o1: 'x'.repeat(1_000_000) } },
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
    { fixture: 'minimal', mutate: (q) => ({ ...q, options: [] }), expect: ['no_options'] },
    {
      fixture: 'minimal',
      mutate: (q) => ({ ...q, config: { ...q.config, minSelected: 3, maxSelected: 2 } }),
      expect: ['impossible_selection_bounds'],
    },
    {
      fixture: 'minimal',
      mutate: (q) => ({ ...q, config: { ...q.config, minSelected: 9 } }),
      expect: ['impossible_selection_bounds'],
    },
    {
      fixture: 'minimal',
      mutate: (q) => ({
        ...q,
        config: { ...q.config, other: { enabled: true, maxLen: 200, required: true } },
      }),
      expect: ['other_option_unset'],
    },
    {
      fixture: 'minimal',
      mutate: (q) => ({
        ...q,
        options: [item('o1', 1, { exclusive: true }), item('o2', 2, { exclusive: true })],
      }),
      expect: ['multiple_exclusive_options'],
    },
  ],

  composition: {
    // Not composable: a fan-out inside a cell would need a `Q5r3r2` name, which schema §4's part
    // model does not describe. A multi-select grid is `matrix` with a per-row control.
    asChildOf: [],
    asParentOf: [],
    assertChildNamespacing: false,
    assertTrustCompatibility: false,
  },
});

/* -------------------------------------------------------------------------- */
/* The set view, which is the whole reason this plugin exists                  */
/* -------------------------------------------------------------------------- */

describe('multi_select set view', () => {
  const question = fixtureQuestion('multi_select', { config: base, options: three });
  const declarations = declareVariablesFor(multiSelect, question).declarations;
  const setView = declarations.find((declaration) => declaration.type === 'set');

  it('is structurally derived — there is no expression to type-check', () => {
    expect(setView?.kind).toBe('derived');
    // The trap this contract is shaped around: a derived variable with no expression is legal, and
    // the platform must be able to say so rather than inferring it from a missing field.
    expect(setView?.kind === 'derived' ? setView.derivation.kind : undefined).toBe('structural');
  });

  it('collects exactly the true booleans, sorted and deduped, for any selection', () => {
    const derivation =
      setView?.kind === 'derived' && setView.derivation.kind === 'structural'
        ? setView.derivation.structural
        : undefined;
    expect(derivation).toBeDefined();
    if (derivation === undefined) return;

    fc.assert(
      fc.property(
        fc.uniqueArray(fc.integer({ min: 1, max: 3 }), { maxLength: 3 }),
        (selected) => {
          const vars: Record<string, boolean> = {
            Q1r1: selected.includes(1),
            Q1r2: selected.includes(2),
            Q1r3: selected.includes(3),
          };
          expect(evaluateDerivation(derivation, vars)).toEqual([...selected].sort((a, b) => a - b));
        },
      ),
      { numRuns: 100 },
    );
  });

  it('treats a missing boolean as not-selected rather than throwing', () => {
    const derivation =
      setView?.kind === 'derived' && setView.derivation.kind === 'structural'
        ? setView.derivation.structural
        : undefined;
    if (derivation === undefined) throw new Error('expected a structural derivation');
    // The projection job runs this per response row over historical data where a variable may not
    // exist at all (an option added in wave 2). It has to be total.
    expect(evaluateDerivation(derivation, {})).toEqual([]);
    expect(evaluateDerivation(derivation, { Q1r2: true })).toEqual([2]);
  });
});
