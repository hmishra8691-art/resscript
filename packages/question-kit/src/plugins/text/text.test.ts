// @vitest-environment jsdom
/**
 * `text` against the conformance harness.
 *
 * The line to notice in `expected` is `(pii)` on every fixture, including the ones that never set
 * the flag: `core.ts` hard-defaults an open-end to PII because the boolean flags view cannot
 * distinguish "cleared" from "never considered". If that default is ever weakened, this file is
 * the release blocker that makes it a decision on the record rather than a drive-by edit.
 */

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { definePluginTests, item } from '../../testkit/index.js';
import { createCodecContext, resolveQuestion } from '../../resolve.js';
import { declareVariablesFor } from '../../declare.js';
import { fixtureQuestion } from '../../testkit/spec.js';
import { text } from './react.js';
import type { TextConfig } from './core.js';

const base: TextConfig = { maxLen: 200, placeholderKey: null, inputMode: 'text' };

definePluginTests(text, {
  fixtures: {
    minimal: { config: base, required: true },
    email_hint: { config: { ...base, inputMode: 'email' } },
    with_placeholder: { config: { ...base, placeholderKey: 'qt.text.placeholder' } },
    looped: {
      config: base,
      loop: { iterationVariableRef: 'BRAND', naming: '{ref}_{iteration}', iteration: 2 },
    },
    excluded_from_export: { config: base, flags: { excludeFromExport: true } },
    // Same declaration as `minimal`: the plugin already treats the verbatim as PII, so the
    // question-level flag adds nothing — which is exactly the property under test.
    flagged_pii: { config: base, flags: { pii: true } },
  },

  variableSnapshots: {
    expected: {
      minimal: ['Q1 response text (pii)'],
      email_hint: ['Q1 response text (pii)'],
      with_placeholder: ['Q1 response text (pii)'],
      looped: ['Q1_2 response text (pii)'],
      excluded_from_export: ['Q1 response text (unexported,pii)'],
      flagged_pii: ['Q1 response text (pii)'],
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
      partial: { value: { text: 'so far' } },
      complete: { value: { text: 'a finished thought' } },
      with_errors: {
        value: { text: null },
        issues: [{ variableName: 'Q1', messageKey: 'err.required', severity: 'error' }],
      },
    },
    assertSsrHydrationClean: true,
    assertNoPhysicalDirectionLeak: true,
  },

  validation: [
    { fixture: 'minimal', value: undefined, required: true, expect: ['err.required'] },
    { fixture: 'minimal', value: { text: null }, required: true, expect: ['err.required'] },
    // Whitespace is not an answer: a respondent who typed three spaces has not answered.
    { fixture: 'minimal', value: { text: '   ' }, required: true, expect: ['err.required'] },
    { fixture: 'minimal', value: { text: null }, required: false, expect: [] },
    { fixture: 'minimal', value: { text: 'hello' }, required: true, expect: [] },
    { fixture: 'minimal', value: { text: 'x'.repeat(200) }, required: true, expect: [] },
    {
      fixture: 'minimal',
      value: { text: 'x'.repeat(201) },
      required: true,
      expect: ['err.too_long'],
    },
  ],
  assertValidationSidesAgree: true,

  codec: {
    roundTrip: {
      minimal: [{ text: null }, { text: 'hello' }, { text: 'x'.repeat(200) }],
    },
    extraHostileInputs: [
      { text: 42 },
      { text: { nested: true } },
      // A megabyte verbatim must be rejected on length, not truncated after allocation.
      { text: 'x'.repeat(1_000_000) },
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
      mutate: (q) => ({ ...q, options: [item('o1', 1)] }),
      expect: ['options_ignored'],
    },
  ],

  composition: {
    // The one declaration is `self`, which the scoped namer maps to the cell's own name — a
    // verbatim column in a mixed matrix is the canonical composed use of this plugin.
    asChildOf: ['matrix'],
    asParentOf: [],
    assertChildNamespacing: true,
    assertTrustCompatibility: true,
  },
});

/* -------------------------------------------------------------------------- */
/* Properties that are specific to this plugin                                */
/* -------------------------------------------------------------------------- */

describe('text properties', () => {
  const question = fixtureQuestion('text', { config: base, required: true });
  const declarations = declareVariablesFor(text, question).declarations;
  const ctx = createCodecContext({
    question,
    resolved: resolveQuestion(question, declarations),
  });

  it('parse truncates to maxLen code points rather than UTF-16 units', () => {
    // 250 astronaut emoji are 500 UTF-16 units; a unit-counting truncation would cut mid-surrogate
    // and store a lone half, which downstream encoders reject.
    const emoji = '\u{1F600}'.repeat(250);
    const result = text.codec.parse({ text: emoji }, ctx);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect([...(result.value.text ?? '')].length).toBe(200);
      expect((result.value.text ?? '').includes('�')).toBe(false);
    }
  });

  it('the empty string and null are one stored fact', () => {
    const parsed = text.codec.parse({ text: '' }, ctx);
    expect(parsed.ok && parsed.value.text).toBe(null);
    expect(text.codec.toVariables({ text: '' }, ctx)).toEqual({ Q1: null });
    expect(text.codec.fromVariables({ Q1: '' }, ctx)).toEqual({ text: null });
  });

  it('toVariables -> fromVariables is the identity for every storable answer', () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.constant(null), fc.string({ minLength: 1, maxLength: 200 })),
        (value) => {
          const answer = { text: value };
          const vars = text.codec.toVariables(answer, ctx);
          expect(text.codec.fromVariables(vars, ctx)).toEqual(answer);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('parse never throws for arbitrary input', () => {
    fc.assert(
      fc.property(fc.anything(), (raw) => {
        const result = text.codec.parse(raw, ctx);
        expect(typeof result.ok).toBe('boolean');
      }),
      { numRuns: 500 },
    );
  });
});
