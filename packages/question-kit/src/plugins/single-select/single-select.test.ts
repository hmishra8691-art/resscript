// @vitest-environment jsdom
/**
 * `single_select` against the conformance harness, plus the property tests that only make sense
 * for this plugin.
 *
 * The `expected` block below is the plugin's **export contract**. A diff to it inside a major is a
 * release blocker (F §5's table), which is the entire reason it is written out here rather than
 * generated into a snapshot file on first run.
 */

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { definePluginTests, item } from '../../testkit/index.js';
import { declareVariablesFor } from '../../declare.js';
import { createCodecContext, resolveQuestion } from '../../resolve.js';
import { fixtureQuestion } from '../../testkit/spec.js';
import { singleSelect } from './react.js';
import type { SingleSelectConfig } from './core.js';

const base: SingleSelectConfig = {
  display: 'vertical',
  columns: 1,
  other: { enabled: false, optionRef: null, maxLen: 200, required: true },
  allowDeselect: false,
};

const threeOptions = [item('o1', 1), item('o2', 2), item('o3', 3)];
const withOtherOptions = [...threeOptions, item('o4', 4, { otherSpecify: true })];
const sixtyOne = Array.from({ length: 61 }, (_unused, index) => item(`o${index + 1}`, index + 1));

definePluginTests(singleSelect, {
  fixtures: {
    minimal: { config: base, options: threeOptions, required: true },
    with_other: {
      config: { ...base, other: { enabled: true, optionRef: 'o4', maxLen: 200, required: true } },
      options: withOtherOptions,
      required: true,
    },
    dropdown: { config: { ...base, display: 'dropdown' }, options: threeOptions },
    // A tracker whose codes were fixed by a client before this platform existed. The enum domain
    // carries the override, which is why `OptionCode` is wider than schema's numeric code.
    legacy_codes: {
      config: base,
      options: [item('o1', 1, { valueOverride: 'BRAND_A' }), item('o2', 2)],
    },
    // Inside a loop: every name goes through the `{ref}_{iteration}` template (schema §13).
    looped: {
      config: base,
      options: threeOptions,
      loop: { iterationVariableRef: 'BRAND', naming: '{ref}_{iteration}', iteration: 2 },
    },
    excluded_from_export: {
      config: base,
      options: threeOptions,
      flags: { excludeFromExport: true },
    },
    flagged_pii: { config: base, options: threeOptions, flags: { pii: true } },
    masked: {
      config: base,
      options: threeOptions,
      itemStates: { o2: { visible: false }, o3: { enabled: false } },
    },
  },

  variableSnapshots: {
    expected: {
      minimal: ['Q1 response enum [1,2,3]'],
      with_other: ['Q1 response enum [1,2,3,4]', 'Q1_other response text (pii)'],
      dropdown: ['Q1 response enum [1,2,3]'],
      legacy_codes: ['Q1 response enum [BRAND_A,2]'],
      looped: ['Q1_2 response enum [1,2,3]'],
      excluded_from_export: ['Q1 response enum [1,2,3] (unexported)'],
      flagged_pii: ['Q1 response enum [1,2,3] (pii)'],
      masked: ['Q1 response enum [1,2,3]'],
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
      partial: { value: { code: 2, otherText: null } },
      complete: { value: { code: 3, otherText: null } },
      with_errors: {
        value: { code: null, otherText: null },
        issues: [{ variableName: 'Q1', messageKey: 'err.required', severity: 'error' }],
      },
      disabled_options: { itemStates: { o2: { enabled: false } } },
      masked: { itemStates: { o3: { visible: false } } },
    },
    assertSsrHydrationClean: true,
    assertNoPhysicalDirectionLeak: true,
  },

  validation: [
    { fixture: 'minimal', value: undefined, required: true, expect: ['err.required'] },
    { fixture: 'minimal', value: undefined, required: false, expect: [] },
    { fixture: 'minimal', value: { code: 2, otherText: null }, required: true, expect: [] },
    {
      fixture: 'minimal',
      value: { code: 99, otherText: null },
      required: true,
      expect: ['err.invalid_option'],
    },
    {
      fixture: 'with_other',
      value: { code: 4, otherText: '   ' },
      required: true,
      expect: ['err.other_required'],
    },
    {
      fixture: 'with_other',
      value: { code: 4, otherText: 'x'.repeat(201) },
      required: true,
      expect: ['err.too_long'],
    },
    // Selecting a non-other option must not demand a verbatim.
    { fixture: 'with_other', value: { code: 1, otherText: null }, required: true, expect: [] },
  ],
  assertValidationSidesAgree: true,

  codec: {
    roundTrip: {
      minimal: [
        { code: 1, otherText: null },
        { code: 3, otherText: null },
        { code: null, otherText: null },
      ],
      with_other: [
        { code: 4, otherText: 'because I like it' },
        { code: 1, otherText: null },
      ],
      legacy_codes: [{ code: 'BRAND_A', otherText: null }],
    },
    extraHostileInputs: [
      { code: { nested: true } },
      { code: 1, otherText: 42 },
      // A megabyte verbatim must be rejected on length, not truncated after allocation.
      { code: 1, otherText: 'x'.repeat(1_000_000) },
    ],
    assertNoThrow: true,
    assertVariablesSubsetOfDeclared: true,
  },

  a11y: {
    assertContractRolesPresent: true,
    // A dropdown is a `combobox`, not a `radiogroup`: the config changes the ARIA pattern, which a
    // single flat `requiredRoles` per plugin cannot express (F §1.3).
    rolesByFixture: { dropdown: ['combobox'] },
    assertSingleTabStopPerGroup: true,
    assertTouchTargets: true,
    assertNoLocalLiveRegion: true,
    assertErrorWiring: true,
  },

  staticChecks: [
    { fixture: 'minimal', expect: [] },
    { fixture: 'minimal', mutate: (q) => ({ ...q, options: [] }), expect: ['no_options'] },
    {
      fixture: 'with_other',
      mutate: (q) => ({
        ...q,
        config: { ...q.config, other: { ...q.config.other, optionRef: null } },
      }),
      expect: ['other_option_unset'],
    },
    {
      fixture: 'with_other',
      mutate: (q) => ({
        ...q,
        config: { ...q.config, other: { ...q.config.other, optionRef: 'nope' } },
      }),
      expect: ['other_option_missing'],
    },
    {
      fixture: 'minimal',
      mutate: (q) => ({ ...q, options: [item('o1', 1, { exclusive: true }), item('o2', 2)] }),
      expect: ['exclusive_on_single'],
    },
    { fixture: 'dropdown', mutate: (q) => ({ ...q, options: sixtyOne }), expect: ['long_dropdown'] },
  ],

  composition: {
    asChildOf: ['matrix'],
    asParentOf: [],
    assertChildNamespacing: true,
    assertTrustCompatibility: true,
  },
});

/* -------------------------------------------------------------------------- */
/* Properties that are specific to this plugin                                */
/* -------------------------------------------------------------------------- */

describe('single_select properties', () => {
  const question = fixtureQuestion('single_select', {
    config: base,
    options: threeOptions,
    required: true,
  });
  const declarations = declareVariablesFor(singleSelect, question).declarations;
  const ctx = createCodecContext({
    question,
    resolved: resolveQuestion(question, declarations),
  });

  it('any authored option set declares exactly one enum whose domain is the codes, in code order', () => {
    fc.assert(
      fc.property(
        fc
          .uniqueArray(fc.integer({ min: 1, max: 500 }), { minLength: 1, maxLength: 40 })
          .map((codes) => codes.map((code, index) => item(`o${index}_${code}`, code))),
        (options) => {
          const shuffled = [...options].reverse();
          const result = declareVariablesFor(
            singleSelect,
            fixtureQuestion('single_select', { config: base, options: shuffled }),
          );
          expect(result.diagnostics).toEqual([]);
          expect(result.declarations.length).toBe(1);
          const domain = result.declarations[0]?.enumDomain ?? [];
          // The domain is the codes, sorted — not the authored order, and not positions.
          expect(domain.map((entry) => entry.code)).toEqual(
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
        const result = singleSelect.codec.parse(raw, ctx);
        if (result.ok) {
          const code = result.value.code;
          expect(code === null || typeof code === 'number' || typeof code === 'string').toBe(true);
        }
      }),
      { numRuns: 500 },
    );
  });

  it('toVariables -> fromVariables is the identity for every representable answer', () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.constant(null), fc.integer({ min: 1, max: 3 })),
        (code) => {
          const answer = { code, otherText: null };
          const vars = singleSelect.codec.toVariables(answer, ctx);
          expect(singleSelect.codec.fromVariables(vars, ctx)).toEqual(answer);
        },
      ),
      { numRuns: 100 },
    );
  });
});
