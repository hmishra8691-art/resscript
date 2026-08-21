// @vitest-environment jsdom
/**
 * `content_text` against the conformance harness.
 *
 * The harness requires every section, and this file is where "required" meets a plugin for
 * which most sections are trivially empty. Emptiness is *stated*, never omitted: every fixture
 * has an explicit `[]` expectation (the export contract of a content block is "no columns", and
 * that is as freezable as any other contract), `with_errors` is declared with no issues (a
 * content block has no error state, and the spec's required key exists to make that a written
 * decision), and the validation table asserts `[]` for the states that would error anywhere
 * else — including `required: true`, which `staticChecks` diagnoses instead.
 */

import { describe, expect, it } from 'vitest';
import { definePluginTests, item } from '../../testkit/index.js';
import { declareVariablesFor } from '../../declare.js';
import { createCodecContext, resolveQuestion } from '../../resolve.js';
import { fixtureQuestion } from '../../testkit/spec.js';
import { contentText } from './react.js';
import type { ContentTextConfig } from './core.js';

const body: ContentTextConfig = { bodyKey: 'Q1.body', variant: 'body' };
const callout: ContentTextConfig = { bodyKey: 'Q1.body', variant: 'callout' };
const legal: ContentTextConfig = { bodyKey: 'Q1.body', variant: 'legal' };

definePluginTests(contentText, {
  fixtures: {
    minimal: { config: body },
    callout: { config: callout },
    legal: { config: legal },
    // A loop changes nothing: no names exist to run through the template. Present so the
    // determinism/rename suites cover the looped path too.
    looped: {
      config: body,
      loop: { iterationVariableRef: 'WAVE', naming: '{ref}_{iteration}', iteration: 3 },
    },
  },

  variableSnapshots: {
    // Explicit emptiness, per fixture: a content block that ever grows a column is a breaking
    // change to this list, exactly like any other plugin's contract diff.
    expected: {
      minimal: [],
      callout: [],
      legal: [],
      looped: [],
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
      // A content block has no error state; the required key is satisfied with no issues so the
      // decision is written down rather than the section skipped.
      with_errors: {},
    },
    assertSsrHydrationClean: true,
    assertNoPhysicalDirectionLeak: true,
  },

  validation: [
    { fixture: 'minimal', value: undefined, required: false, expect: [] },
    { fixture: 'minimal', value: null, required: false, expect: [] },
    // `required` is ignored at answer time (diagnosed at compile time): an error here would be
    // one no respondent could ever fix.
    { fixture: 'minimal', value: undefined, required: true, expect: [] },
    { fixture: 'legal', value: null, required: true, expect: [] },
  ],
  assertValidationSidesAgree: true,

  codec: {
    roundTrip: {
      minimal: [null],
      legal: [null],
    },
    extraHostileInputs: [
      // Keyed payloads against a block that takes no answer: forged, and rejected as such.
      { answer: true },
      { text: 'injected' },
      { agreed: true },
    ],
    assertNoThrow: true,
    assertVariablesSubsetOfDeclared: true,
  },

  a11y: {
    // The one declared role is `note`; everything else asserts absence (no tab stops, no
    // targets, no live region), which is this plugin's entire interaction model.
    assertContractRolesPresent: true,
    assertSingleTabStopPerGroup: true,
    assertTouchTargets: true,
    assertNoLocalLiveRegion: true,
    assertErrorWiring: true,
  },

  staticChecks: [
    { fixture: 'minimal', expect: [] },
    { fixture: 'minimal', mutate: (q) => ({ ...q, options: [item('o1', 1)] }), expect: ['options_ignored'] },
    { fixture: 'minimal', mutate: (q) => ({ ...q, required: true }), expect: ['required_ignored'] },
    {
      fixture: 'legal',
      mutate: (q) => ({ ...q, required: true, options: [item('o1', 1)] }),
      expect: ['options_ignored', 'required_ignored'],
    },
  ],

  composition: {
    // A product decision (see `meta.composable`): a paragraph is not a cell control.
    asChildOf: [],
    asParentOf: [],
    assertChildNamespacing: false,
    assertTrustCompatibility: false,
  },
});

/* -------------------------------------------------------------------------- */
/* Properties that are specific to this plugin                                 */
/* -------------------------------------------------------------------------- */

describe('content_text properties', () => {
  it('declares nothing, for every fixture shape including a loop', () => {
    for (const loop of [null, { iterationVariableRef: 'W', naming: '{ref}_{iteration}', iteration: 7 }]) {
      const question = fixtureQuestion('content_text', {
        config: body,
        ...(loop === null ? {} : { loop }),
      });
      const result = declareVariablesFor(contentText, question);
      expect(result.diagnostics).toEqual([]);
      expect(result.declarations).toEqual([]);
    }
  });

  it('rejects a keyed payload as unknown_key rather than discarding it silently', () => {
    // The distinction matters at the API boundary: a discarded forgery never shows up in the
    // rejection metrics ADR-005 watches.
    const question = fixtureQuestion('content_text', { config: body });
    const declarations = declareVariablesFor(contentText, question).declarations;
    const ctx = createCodecContext({
      question,
      resolved: resolveQuestion(question, declarations),
    });
    const keyed = contentText.codec.parse({ smuggled: 1 }, ctx);
    expect(keyed.ok).toBe(false);
    if (!keyed.ok) expect(keyed.error.code).toBe('unknown_key');
    // The empty object is the one keyless payload a lenient runtime might echo; it is emptiness.
    expect(contentText.codec.parse({}, ctx)).toEqual({ ok: true, value: null });
  });
});
