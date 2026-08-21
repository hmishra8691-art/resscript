// @vitest-environment jsdom
/**
 * `rating` against the conformance harness.
 *
 * The two facts worth defending are the ones the file header of core.ts argues for: the column is
 * an enum over the *authored* codes (never positions — reversing the scale is a relabelling, not
 * a renumbering), and the measure is `ordinal`, because that is the field an analyst's tool reads
 * before deciding whether to offer a mean over the column.
 */

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { definePluginTests, item } from '../../testkit/index.js';
import { declareVariablesFor } from '../../declare.js';
import { createCodecContext, resolveQuestion } from '../../resolve.js';
import { fixtureQuestion } from '../../testkit/spec.js';
import { rating } from './react.js';
import type { RatingConfig } from './core.js';

const base: RatingConfig = {
  display: 'radio',
  lowLabelKey: null,
  highLabelKey: null,
  showNumbers: true,
};

const anchored: Pick<RatingConfig, 'lowLabelKey' | 'highLabelKey'> = {
  lowLabelKey: 'qt.rating.anchor_low',
  highLabelKey: 'qt.rating.anchor_high',
};

const fivePoints = [item('o1', 1), item('o2', 2), item('o3', 3), item('o4', 4), item('o5', 5)];

definePluginTests(rating, {
  fixtures: {
    // Unanchored radio is the fully-labelled case: every point carries its own label, so the
    // missing anchors are fine (and staticChecks agree — see below).
    minimal: { config: base, options: fivePoints, required: true },
    stars: {
      config: { ...base, ...anchored, display: 'stars', showNumbers: false },
      options: fivePoints,
      required: true,
    },
    buttons: { config: { ...base, ...anchored, display: 'buttons' }, options: fivePoints },
    // A tracker whose scale codes were fixed before this platform existed.
    legacy_codes: {
      config: base,
      options: [item('o1', 1, { valueOverride: 'LOW' }), item('o2', 2), item('o3', 3)],
    },
    looped: {
      config: base,
      options: fivePoints,
      loop: { iterationVariableRef: 'BRAND', naming: '{ref}_{iteration}', iteration: 2 },
    },
    excluded_from_export: { config: base, options: fivePoints, flags: { excludeFromExport: true } },
    flagged_pii: { config: base, options: fivePoints, flags: { pii: true } },
    // A scale point removed by a mask: an NA point hidden for a subgroup is routine.
    masked: { config: base, options: fivePoints, itemStates: { o3: { visible: false } } },
  },

  variableSnapshots: {
    expected: {
      minimal: ['Q1 response enum [1,2,3,4,5]'],
      stars: ['Q1 response enum [1,2,3,4,5]'],
      buttons: ['Q1 response enum [1,2,3,4,5]'],
      legacy_codes: ['Q1 response enum [LOW,2,3]'],
      looped: ['Q1_2 response enum [1,2,3,4,5]'],
      excluded_from_export: ['Q1 response enum [1,2,3,4,5] (unexported)'],
      flagged_pii: ['Q1 response enum [1,2,3,4,5] (pii)'],
      // The mask is a runtime fact; the declared domain keeps all five codes (F §1.1 rule 1).
      masked: ['Q1 response enum [1,2,3,4,5]'],
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
      partial: { value: { code: 2 } },
      complete: { value: { code: 5 } },
      with_errors: {
        value: { code: null },
        issues: [{ variableName: 'Q1', messageKey: 'err.required', severity: 'error' }],
      },
      disabled_point: { itemStates: { o4: { enabled: false } } },
      masked_point: { itemStates: { o3: { visible: false } } },
    },
    assertSsrHydrationClean: true,
    assertNoPhysicalDirectionLeak: true,
  },

  validation: [
    { fixture: 'minimal', value: undefined, required: true, expect: ['err.required'] },
    { fixture: 'minimal', value: { code: null }, required: true, expect: ['err.required'] },
    { fixture: 'minimal', value: undefined, required: false, expect: [] },
    { fixture: 'minimal', value: { code: 1 }, required: true, expect: [] },
    { fixture: 'minimal', value: { code: 5 }, required: true, expect: [] },
    // Only reachable via a tampered payload — the rendered points cannot produce it.
    { fixture: 'minimal', value: { code: 99 }, required: true, expect: ['err.invalid_option'] },
    { fixture: 'minimal', value: { code: 'LOW' }, required: true, expect: ['err.invalid_option'] },
    { fixture: 'legacy_codes', value: { code: 'LOW' }, required: true, expect: [] },
    // The raw code leaves the domain once an override replaces it — same rule as single-select.
    { fixture: 'legacy_codes', value: { code: 1 }, required: true, expect: ['err.invalid_option'] },
  ],
  assertValidationSidesAgree: true,

  codec: {
    roundTrip: {
      minimal: [{ code: 1 }, { code: 3 }, { code: 5 }, { code: null }],
      legacy_codes: [{ code: 'LOW' }, { code: 2 }],
    },
    extraHostileInputs: [
      { code: { nested: true } },
      { code: [3] },
      { code: true },
      { code: Number.POSITIVE_INFINITY },
      // A megabyte string code must be rejected on length, before anything compares it.
      { code: 'x'.repeat(1_000_000) },
    ],
    assertNoThrow: true,
    assertVariablesSubsetOfDeclared: true,
  },

  a11y: {
    // No per-fixture roles: stars and buttons are radiogroups too — the whole point of the
    // contract in core.ts. A star widget with a different pattern would be a different plugin.
    assertContractRolesPresent: true,
    assertSingleTabStopPerGroup: true,
    assertTouchTargets: true,
    assertNoLocalLiveRegion: true,
    assertErrorWiring: true,
  },

  staticChecks: [
    // Unanchored is FINE for radio: every point is labelled, anchors would add nothing.
    { fixture: 'minimal', expect: [] },
    { fixture: 'stars', expect: [] },
    { fixture: 'minimal', mutate: (q) => ({ ...q, options: [] }), expect: ['no_options'] },
    {
      fixture: 'stars',
      mutate: (q) => ({ ...q, config: { ...q.config, lowLabelKey: null, highLabelKey: null } }),
      expect: ['unanchored_scale'],
    },
    {
      fixture: 'buttons',
      mutate: (q) => ({ ...q, config: { ...q.config, lowLabelKey: null, highLabelKey: null } }),
      expect: ['unanchored_scale'],
    },
    // One anchor is enough to state a direction, so it clears the warning.
    {
      fixture: 'stars',
      mutate: (q) => ({ ...q, config: { ...q.config, lowLabelKey: null } }),
      expect: [],
    },
  ],

  composition: {
    // The other canonical composed cell besides numeric: "Rate each brand" is a matrix whose
    // rows each hold one rating. One self-named enum, no companions, so the cell scope covers it.
    asChildOf: ['matrix'],
    asParentOf: [],
    assertChildNamespacing: true,
    assertTrustCompatibility: true,
  },
});

/* -------------------------------------------------------------------------- */
/* Properties specific to this plugin                                          */
/* -------------------------------------------------------------------------- */

describe('rating properties', () => {
  const question = fixtureQuestion('rating', { config: base, options: fivePoints, required: true });
  const declarations = declareVariablesFor(rating, question).declarations;
  const ctx = createCodecContext({ question, resolved: resolveQuestion(question, declarations) });

  it('declares an ordinal measure: ranked points, distances not asserted', () => {
    // This single field is what keeps analysis tools from offering a mean over intervals the
    // instrument never measured — see core.ts's header for the nps contrast.
    expect(declarations.length).toBe(1);
    expect(declarations[0]?.analysis?.measure).toBe('ordinal');
    expect(declarations[0]?.type).toBe('enum');
  });

  it('any authored point set declares one enum whose domain is the codes, in code order', () => {
    fc.assert(
      fc.property(
        fc
          .uniqueArray(fc.integer({ min: 1, max: 500 }), { minLength: 1, maxLength: 11 })
          .map((codes) => codes.map((code, index) => item(`o${index}_${code}`, code))),
        (options) => {
          // Authored in reverse so the assertion cannot pass by echoing input order: display
          // order (a reversed scale) must not leak into the data contract.
          const reversed = [...options].reverse();
          const result = declareVariablesFor(
            rating,
            fixtureQuestion('rating', { config: base, options: reversed }),
          );
          expect(result.diagnostics).toEqual([]);
          expect(result.declarations.length).toBe(1);
          expect(result.declarations[0]?.enumDomain?.map((entry) => entry.code)).toEqual(
            [...options.map((option) => option.code)].sort((a, b) => a - b),
          );
        },
      ),
      { numRuns: 200 },
    );
  });

  it('parse never throws and never returns a code outside the wire types', () => {
    fc.assert(
      fc.property(fc.anything(), (raw) => {
        const result = rating.codec.parse(raw, ctx);
        if (result.ok) {
          const code = result.value.code;
          expect(code === null || typeof code === 'number' || typeof code === 'string').toBe(true);
        }
      }),
      { numRuns: 500 },
    );
  });
});
