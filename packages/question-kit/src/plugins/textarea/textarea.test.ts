// @vitest-environment jsdom
/**
 * `textarea` against the conformance harness, plus the word-count behaviour as its own suite.
 *
 * The plugin-specific ground worth defending: word bounds use a whitespace-delimited count that is
 * identical on both sides of ADR-004, at most one validation message fires per state (length wins
 * over word bounds), and `(pii)` is on every fixture because an essay is the most identifying
 * column a survey collects — see `core.ts`.
 */

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { definePluginTests, item } from '../../testkit/index.js';
import { textarea } from './react.js';
import { countWords, TEXTAREA_MESSAGE_KEYS, type TextareaConfig } from './core.js';

const base: TextareaConfig = {
  maxLen: 2000,
  rows: 4,
  minWords: 0,
  maxWords: 0,
  showCounter: false,
};

const words = (count: number): string => Array.from({ length: count }, (_u, i) => `w${i}`).join(' ');

definePluginTests(textarea, {
  fixtures: {
    minimal: { config: base, required: true },
    essay_bounds: { config: { ...base, minWords: 5, maxWords: 100 }, required: true },
    with_counter: { config: { ...base, showCounter: true } },
    looped: {
      config: base,
      loop: { iterationVariableRef: 'BRAND', naming: '{ref}_{iteration}', iteration: 3 },
    },
    excluded_from_export: { config: base, flags: { excludeFromExport: true } },
    flagged_pii: { config: base, flags: { pii: true } },
  },

  variableSnapshots: {
    expected: {
      minimal: ['Q1 response text (pii)'],
      essay_bounds: ['Q1 response text (pii)'],
      with_counter: ['Q1 response text (pii)'],
      looped: ['Q1_3 response text (pii)'],
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
      partial: { value: { text: 'a start' } },
      complete: { value: { text: 'a considered paragraph of feedback about the product' } },
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
    { fixture: 'minimal', value: { text: '  \n ' }, required: true, expect: ['err.required'] },
    { fixture: 'minimal', value: { text: null }, required: false, expect: [] },
    { fixture: 'minimal', value: { text: 'fine' }, required: true, expect: [] },
    {
      fixture: 'minimal',
      value: { text: 'x'.repeat(2001) },
      required: true,
      expect: ['err.too_long'],
    },
    {
      fixture: 'essay_bounds',
      value: { text: 'only four words here' },
      required: true,
      expect: [TEXTAREA_MESSAGE_KEYS.tooFewWords],
    },
    { fixture: 'essay_bounds', value: { text: words(5) }, required: true, expect: [] },
    { fixture: 'essay_bounds', value: { text: words(100) }, required: true, expect: [] },
    {
      fixture: 'essay_bounds',
      value: { text: words(101) },
      required: true,
      expect: [TEXTAREA_MESSAGE_KEYS.tooManyWords],
    },
    // One message per state: this text is over maxLen AND under the word floor (it is one word),
    // and the respondent gets the length error alone — fixing it changes the word count anyway.
    {
      fixture: 'essay_bounds',
      value: { text: 'x'.repeat(2001) },
      required: true,
      expect: ['err.too_long'],
    },
  ],
  assertValidationSidesAgree: true,

  codec: {
    roundTrip: {
      minimal: [{ text: null }, { text: 'a longer piece of prose, with punctuation.' }],
      essay_bounds: [{ text: words(50) }],
    },
    extraHostileInputs: [
      { text: 42 },
      { text: ['not', 'a', 'string'] },
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
    { fixture: 'essay_bounds', expect: [] },
    {
      fixture: 'minimal',
      mutate: (q) => ({ ...q, options: [item('o1', 1)] }),
      expect: ['options_ignored'],
    },
    {
      fixture: 'minimal',
      mutate: (q) => ({ ...q, config: { ...q.config, minWords: 10, maxWords: 2 } }),
      expect: ['impossible_word_bounds'],
    },
    {
      fixture: 'minimal',
      mutate: (q) => ({ ...q, config: { ...q.config, maxLen: 10, minWords: 20 } }),
      expect: ['word_floor_exceeds_length'],
    },
  ],

  composition: {
    // Same footing as `text`: one `self` declaration, one response variable per cell.
    asChildOf: ['matrix'],
    asParentOf: [],
    assertChildNamespacing: true,
    assertTrustCompatibility: true,
  },
});

/* -------------------------------------------------------------------------- */
/* The word count, which is the plugin's own contract term                     */
/* -------------------------------------------------------------------------- */

describe('textarea word count', () => {
  it('counts whitespace-delimited chunks, whatever the whitespace is', () => {
    expect(countWords('')).toBe(0);
    expect(countWords('   \n\t ')).toBe(0);
    expect(countWords('one')).toBe(1);
    expect(countWords('one two')).toBe(2);
    expect(countWords('  leading and trailing  ')).toBe(3);
    expect(countWords('runs\n\nof\t\t whitespace')).toBe(3);
  });

  it('joining n non-empty chunks with any whitespace counts n', () => {
    fc.assert(
      fc.property(
        fc.array(fc.stringMatching(/^[a-z]{1,8}$/), { minLength: 1, maxLength: 40 }),
        fc.constantFrom(' ', '  ', '\n', '\t', ' \n '),
        (chunks, separator) => {
          expect(countWords(chunks.join(separator))).toBe(chunks.length);
        },
      ),
      { numRuns: 200 },
    );
  });
});
