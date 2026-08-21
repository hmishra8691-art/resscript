// @vitest-environment jsdom
/**
 * `binary` against the conformance harness.
 *
 * The plugin is single-select's smallest relative, so the interesting assertions are the ones
 * that keep it *that*: exactly one enum over exactly two authored codes, whatever the display,
 * whatever the order the two options were authored in — and the `two_options_required` check
 * that stops a third option from quietly turning it into a single-select with a misleading type.
 */

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { definePluginTests, item } from '../../testkit/index.js';
import { declareVariablesFor } from '../../declare.js';
import { createCodecContext, resolveQuestion } from '../../resolve.js';
import { fixtureQuestion } from '../../testkit/spec.js';
import { binary } from './react.js';
import type { BinaryConfig } from './core.js';

const base: BinaryConfig = { display: 'buttons' };

const yesNo = [item('o1', 1), item('o2', 2)];

definePluginTests(binary, {
  fixtures: {
    minimal: { config: base, options: yesNo, required: true },
    toggle: { config: { display: 'toggle' }, options: yesNo },
    radio: { config: { display: 'radio' }, options: yesNo },
    // A client tracker with fixed Y/N codes: the enum domain carries the override, like
    // single-select's `legacy_codes`, because "true/false" is a labelling fact, not a code fact.
    legacy_codes: {
      config: base,
      options: [item('o1', 1, { valueOverride: 'Y' }), item('o2', 2, { valueOverride: 'N' })],
    },
    looped: {
      config: base,
      options: yesNo,
      loop: { iterationVariableRef: 'BRAND', naming: '{ref}_{iteration}', iteration: 2 },
    },
    excluded_from_export: { config: base, options: yesNo, flags: { excludeFromExport: true } },
    flagged_pii: { config: base, options: yesNo, flags: { pii: true } },
  },

  variableSnapshots: {
    expected: {
      minimal: ['Q1 response enum [1,2]'],
      toggle: ['Q1 response enum [1,2]'],
      radio: ['Q1 response enum [1,2]'],
      legacy_codes: ['Q1 response enum [Y,N]'],
      looped: ['Q1_2 response enum [1,2]'],
      excluded_from_export: ['Q1 response enum [1,2] (unexported)'],
      flagged_pii: ['Q1 response enum [1,2] (pii)'],
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
      yes: { value: { code: 1 } },
      no: { value: { code: 2 } },
      with_errors: {
        value: { code: null },
        issues: [{ variableName: 'Q1', messageKey: 'err.required', severity: 'error' }],
      },
      // One of two options masked off: what remains must still be a coherent (if degenerate)
      // group, because a display condition can do this to any live survey.
      disabled_option: { itemStates: { o2: { enabled: false } } },
    },
    assertSsrHydrationClean: true,
    assertNoPhysicalDirectionLeak: true,
  },

  validation: [
    { fixture: 'minimal', value: undefined, required: true, expect: ['err.required'] },
    { fixture: 'minimal', value: { code: null }, required: true, expect: ['err.required'] },
    { fixture: 'minimal', value: undefined, required: false, expect: [] },
    { fixture: 'minimal', value: { code: 1 }, required: true, expect: [] },
    { fixture: 'minimal', value: { code: 2 }, required: true, expect: [] },
    // Only reachable by a tampered payload — the two rendered inputs cannot produce it.
    { fixture: 'minimal', value: { code: 99 }, required: true, expect: ['err.invalid_option'] },
    { fixture: 'legacy_codes', value: { code: 'Y' }, required: true, expect: [] },
    // The raw code is not in the domain once an override replaces it: storing 1 next to 'Y'
    // would put two spellings of "yes" in one column.
    { fixture: 'legacy_codes', value: { code: 1 }, required: true, expect: ['err.invalid_option'] },
  ],
  assertValidationSidesAgree: true,

  codec: {
    roundTrip: {
      minimal: [{ code: 1 }, { code: 2 }, { code: null }],
      legacy_codes: [{ code: 'Y' }, { code: 'N' }],
    },
    extraHostileInputs: [
      { code: { nested: true } },
      { code: [1] },
      { code: true },
      { code: Number.NaN },
      // A megabyte string code must be rejected on length, before anything compares it.
      { code: 'x'.repeat(1_000_000) },
    ],
    assertNoThrow: true,
    assertVariablesSubsetOfDeclared: true,
  },

  a11y: {
    // No per-fixture roles: all three displays — the toggle included — are radiogroups, which is
    // the point the a11y contract in core.ts makes at length.
    assertContractRolesPresent: true,
    assertSingleTabStopPerGroup: true,
    assertTouchTargets: true,
    assertNoLocalLiveRegion: true,
    assertErrorWiring: true,
  },

  staticChecks: [
    { fixture: 'minimal', expect: [] },
    { fixture: 'minimal', mutate: (q) => ({ ...q, options: [] }), expect: ['two_options_required'] },
    {
      fixture: 'minimal',
      mutate: (q) => ({ ...q, options: [item('o1', 1)] }),
      expect: ['two_options_required'],
    },
    {
      fixture: 'minimal',
      mutate: (q) => ({ ...q, options: [...yesNo, item('o3', 3)] }),
      expect: ['two_options_required'],
    },
    {
      fixture: 'minimal',
      mutate: (q) => ({ ...q, options: [item('o1', 1, { exclusive: true }), item('o2', 2)] }),
      expect: ['exclusive_on_binary'],
    },
  ],

  composition: {
    // The classic composed cell: a yes/no per matrix row ("Do you own this brand?"). One
    // self-named enum, no companions, so the cell scope names everything the plugin declares.
    asChildOf: ['matrix'],
    asParentOf: [],
    assertChildNamespacing: true,
    assertTrustCompatibility: true,
  },
});

/* -------------------------------------------------------------------------- */
/* Properties specific to this plugin                                          */
/* -------------------------------------------------------------------------- */

describe('binary properties', () => {
  const question = fixtureQuestion('binary', { config: base, options: yesNo, required: true });
  const declarations = declareVariablesFor(binary, question).declarations;
  const ctx = createCodecContext({ question, resolved: resolveQuestion(question, declarations) });

  it('declares a nominal measure: two authored codes are a category, not a truth value', () => {
    expect(declarations.length).toBe(1);
    expect(declarations[0]?.analysis?.measure).toBe('nominal');
    expect(declarations[0]?.type).toBe('enum');
  });

  it('any authored pair declares one enum whose domain is exactly the two codes, in code order', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.integer({ min: 1, max: 500 }), { minLength: 2, maxLength: 2 }),
        (codes) => {
          // Authored in reverse so the assertion cannot pass by echoing input order.
          const options = codes.map((code, index) => item(`o${index + 1}`, code)).reverse();
          const result = declareVariablesFor(
            binary,
            fixtureQuestion('binary', { config: base, options }),
          );
          expect(result.diagnostics).toEqual([]);
          expect(result.declarations.length).toBe(1);
          expect(result.declarations[0]?.enumDomain?.map((entry) => entry.code)).toEqual(
            [...codes].sort((a, b) => a - b),
          );
        },
      ),
      { numRuns: 200 },
    );
  });

  it('parse never throws and never returns a code outside the wire types', () => {
    fc.assert(
      fc.property(fc.anything(), (raw) => {
        const result = binary.codec.parse(raw, ctx);
        if (result.ok) {
          const code = result.value.code;
          expect(code === null || typeof code === 'number' || typeof code === 'string').toBe(true);
        }
      }),
      { numRuns: 500 },
    );
  });
});
