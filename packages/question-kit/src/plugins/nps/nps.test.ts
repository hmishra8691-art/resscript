// @vitest-environment jsdom
/**
 * `nps` against the conformance harness, plus the band table as a property.
 *
 * The band is the plugin's reason for existing in P1-04: a derived variable with no expression, on
 * a question whose score is an ordinary number. If this file is green, "derived" does not imply
 * "has an AST" anywhere in the platform.
 */

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { NPS_BAND_DOMAIN } from '@resscript/schema';
import { definePluginTests, item } from '../../testkit/index.js';
import { declareVariablesFor } from '../../declare.js';
import { evaluateDerivation } from '../../contract/variables.js';
import { fixtureQuestion } from '../../testkit/spec.js';
import { nps } from './react.js';
import { NPS_BANDS, type NpsConfig } from './core.js';

const base: NpsConfig = {
  lowLabelKey: 'qt.nps.anchor_low',
  highLabelKey: 'qt.nps.anchor_high',
  display: 'buttons',
};

definePluginTests(nps, {
  fixtures: {
    minimal: { config: base, required: true },
    radio_display: { config: { ...base, display: 'radio' } },
    looped: {
      config: base,
      loop: { iterationVariableRef: 'BRAND', naming: '{ref}_{iteration}', iteration: 3 },
    },
    excluded_from_export: { config: base, flags: { excludeFromExport: true } },
    flagged_pii: { config: base, flags: { pii: true } },
  },

  variableSnapshots: {
    expected: {
      minimal: ['Q1 response number', 'Q1_band derived enum [1,2,3] <numeric_band>'],
      radio_display: ['Q1 response number', 'Q1_band derived enum [1,2,3] <numeric_band>'],
      // Both variables go through the loop template, so the band of iteration 3 is `Q1_band_3` —
      // the suffix is part of the base name, the iteration is appended to the whole thing.
      looped: ['Q1_3 response number', 'Q1_band_3 derived enum [1,2,3] <numeric_band>'],
      excluded_from_export: [
        'Q1 response number (unexported)',
        'Q1_band derived enum [1,2,3] <numeric_band> (unexported)',
      ],
      flagged_pii: [
        'Q1 response number (pii)',
        'Q1_band derived enum [1,2,3] <numeric_band> (pii)',
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
      partial: { value: { score: 6 } },
      complete: { value: { score: 10 } },
      with_errors: {
        value: { score: null },
        issues: [{ variableName: 'Q1', messageKey: 'err.required', severity: 'error' }],
      },
    },
    assertSsrHydrationClean: true,
    assertNoPhysicalDirectionLeak: true,
  },

  validation: [
    { fixture: 'minimal', value: undefined, required: true, expect: ['err.required'] },
    { fixture: 'minimal', value: { score: null }, required: false, expect: [] },
    { fixture: 'minimal', value: { score: 0 }, required: true, expect: [] },
    { fixture: 'minimal', value: { score: 10 }, required: true, expect: [] },
    { fixture: 'minimal', value: { score: 11 }, required: true, expect: ['err.out_of_range'] },
    { fixture: 'minimal', value: { score: -1 }, required: true, expect: ['err.out_of_range'] },
    { fixture: 'minimal', value: { score: 7.5 }, required: true, expect: ['err.out_of_range'] },
  ],
  assertValidationSidesAgree: true,

  codec: {
    roundTrip: {
      minimal: [{ score: null }, { score: 0 }, { score: 7 }, { score: 10 }],
    },
    extraHostileInputs: [{ score: '9' }, { score: 11 }, { score: -1 }, { score: 1e308 }],
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
      mutate: (q) => ({ ...q, options: [item('o1', 1)] }),
      expect: ['options_ignored'],
    },
    {
      fixture: 'minimal',
      mutate: (q) => ({ ...q, config: { ...q.config, highLabelKey: q.config.lowLabelKey } }),
      expect: ['identical_anchors'],
    },
  ],

  composition: {
    // See `core.ts`: `Q5r3_band` has no variable part, so a plugin with a companion variable cannot
    // be a cell control until the part model gains a composite form.
    asChildOf: [],
    asParentOf: [],
    assertChildNamespacing: false,
    assertTrustCompatibility: false,
  },
});

describe('nps band', () => {
  const question = fixtureQuestion('nps', { config: base });
  const declarations = declareVariablesFor(nps, question).declarations;
  const band = declarations.find((declaration) => declaration.name === 'Q1_band');
  const derivation =
    band?.kind === 'derived' && band.derivation.kind === 'structural'
      ? band.derivation.structural
      : undefined;

  it('is derived with no expression, and the platform says so explicitly', () => {
    expect(band?.kind).toBe('derived');
    expect(derivation?.computation).toBe('numeric_band');
  });

  it('uses the domain schema owns, not a local copy', () => {
    expect(band?.enumDomain?.map((entry) => entry.code)).toEqual(
      NPS_BAND_DOMAIN.map((entry) => entry.code),
    );
    expect(band?.enumDomain?.map((entry) => entry.labelKey)).toEqual(
      NPS_BAND_DOMAIN.map((entry) => entry.label_key),
    );
  });

  it('bands every score in 0..10 exactly as the NPS definition does', () => {
    if (derivation === undefined) throw new Error('expected a structural derivation');
    const expected = new Map<number, number>([
      [0, 1], [1, 1], [2, 1], [3, 1], [4, 1], [5, 1], [6, 1],
      [7, 2], [8, 2],
      [9, 3], [10, 3],
    ]);
    for (const [score, code] of expected) {
      expect(evaluateDerivation(derivation, { Q1: score }), `score ${score}`).toBe(code);
    }
  });

  it('bands cover 0..10 with no gap and no overlap', () => {
    // A gap would silently produce a null band for a real answer; an overlap would make the result
    // depend on band order. Both are the kind of thing that is only ever noticed in a client's
    // cross-tab, so it is asserted on the table rather than on a sample.
    const covered = new Set<number>();
    for (const band_ of NPS_BANDS) {
      for (let score = band_.from; score <= band_.to; score += 1) {
        expect(covered.has(score), `score ${score} is in two bands`).toBe(false);
        covered.add(score);
      }
    }
    expect([...covered].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('returns null outside the domain rather than rounding into a band', () => {
    if (derivation === undefined) throw new Error('expected a structural derivation');
    fc.assert(
      fc.property(
        fc.oneof(
          fc.integer({ min: 11, max: 1000 }),
          fc.integer({ min: -1000, max: -1 }),
          fc.constant(Number.NaN),
        ),
        (score) => {
          expect(evaluateDerivation(derivation, { Q1: score })).toBeNull();
        },
      ),
      { numRuns: 100 },
    );
    expect(evaluateDerivation(derivation, {})).toBeNull();
    expect(evaluateDerivation(derivation, { Q1: null })).toBeNull();
  });
});
