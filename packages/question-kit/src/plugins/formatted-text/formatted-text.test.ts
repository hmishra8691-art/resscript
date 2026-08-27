// @vitest-environment jsdom
/**
 * `formatted_text` against the conformance harness, plus the format table's own behaviour.
 *
 * The tests that matter are the ACCEPTANCES. Every strict email regex in circulation rejects
 * addresses that genuinely deliver — `user+tag@`, new TLDs, quoted locals — and a false rejection
 * here is a respondent who cannot proceed and abandons, which costs a complete. A false acceptance
 * is one row an analyst cleans. So the table is permissive by design, and the cases below pin that
 * intent: `user+tag@example.co.uk` must pass, and only shapes that are not addresses at all fail.
 *
 * The second is the client/server split. `assertValidationSidesAgree` is what makes "the format is
 * checked in one place, in code that runs on both sides" true rather than aspirational, and it is
 * why the renderer must not carry `type="email"` or a `pattern` attribute.
 */

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { definePluginTests, item } from '../../testkit/index.js';
import { declareVariablesFor } from '../../declare.js';
import { createCodecContext, resolveQuestion } from '../../resolve.js';
import { fixtureQuestion } from '../../testkit/spec.js';
import { formattedText } from './react.js';
import {
  FORMAT_PATTERNS,
  normalizeText,
  patternFor,
  patternProblem,
  type FormattedTextConfig,
} from './core.js';

const base: FormattedTextConfig = { format: 'email', maxLen: 200, normalize: 'trim' };

definePluginTests(formattedText, {
  fixtures: {
    email: { config: base, required: true },
    tel: { config: { format: 'tel', maxLen: 40 }, required: true },
    url: { config: { format: 'url', maxLen: 300 } },
    postcode_uk: { config: { format: 'postcode_uk', maxLen: 12, normalize: 'lower' } },
    custom: {
      config: { format: 'custom', pattern: '^[A-Z]{2}-[0-9]{4}$', maxLen: 10 },
      required: true,
    },
    looped: {
      config: base,
      loop: { iterationVariableRef: 'BRAND', naming: '{ref}_{iteration}', iteration: 2 },
    },
    excluded_from_export: { config: base, flags: { excludeFromExport: true } },
  },

  variableSnapshots: {
    expected: {
      // `pii` on every one of them, including where the author cleared the flag: emails, phones
      // and postcodes are the canonical direct identifiers. Same hard `true` as `text`.
      email: ['Q1 response text (pii)'],
      tel: ['Q1 response text (pii)'],
      url: ['Q1 response text (pii)'],
      postcode_uk: ['Q1 response text (pii)'],
      custom: ['Q1 response text (pii)'],
      looped: ['Q1_2 response text (pii)'],
      excluded_from_export: ['Q1 response text (unexported,pii)'],
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
      partial: { value: { text: 'john@' } },
      complete: { value: { text: 'john@example.com' } },
      with_errors: {
        value: { text: 'john@' },
        issues: [{ variableName: 'Q1', messageKey: 'err.invalid_option', severity: 'error' }],
      },
    },
    assertSsrHydrationClean: true,
    assertNoPhysicalDirectionLeak: true,
  },

  validation: [
    { fixture: 'email', value: undefined, required: true, expect: ['err.required'] },
    { fixture: 'email', value: { text: null }, required: false, expect: [] },
    // Acceptances — the cases a strict regex would wrongly reject. See the header.
    { fixture: 'email', value: { text: 'john@example.com' }, required: true, expect: [] },
    { fixture: 'email', value: { text: 'user+tag@example.co.uk' }, required: true, expect: [] },
    { fixture: 'email', value: { text: 'a.b-c_d@sub.domain.travel' }, required: true, expect: [] },
    // Rejections — shapes that are not addresses at all.
    { fixture: 'email', value: { text: 'john@' }, required: true, expect: ['err.invalid_option'] },
    { fixture: 'email', value: { text: 'nodomain' }, required: true, expect: ['err.invalid_option'] },
    { fixture: 'email', value: { text: 'two@at@signs.com' }, required: true, expect: ['err.invalid_option'] },
    { fixture: 'email', value: { text: 'no@tld' }, required: true, expect: ['err.invalid_option'] },
    // Phone: national formats must pass, prose must not.
    { fixture: 'tel', value: { text: '+44 20 7946 0958' }, required: true, expect: [] },
    { fixture: 'tel', value: { text: '(555) 123-4567' }, required: true, expect: [] },
    { fixture: 'tel', value: { text: 'call me' }, required: true, expect: ['err.invalid_option'] },
    { fixture: 'url', value: { text: 'https://example.com/x?y=1' }, required: false, expect: [] },
    { fixture: 'url', value: { text: 'example.com' }, required: false, expect: ['err.invalid_option'] },
    { fixture: 'postcode_uk', value: { text: 'sw1a 1aa' }, required: false, expect: [] },
    { fixture: 'postcode_uk', value: { text: 'nope' }, required: false, expect: ['err.invalid_option'] },
    { fixture: 'custom', value: { text: 'AB-1234' }, required: true, expect: [] },
    { fixture: 'custom', value: { text: 'ab-1234' }, required: true, expect: ['err.invalid_option'] },
  ],
  // The property that makes "checked in one place, on both sides" true rather than aspirational.
  assertValidationSidesAgree: true,

  codec: {
    roundTrip: {
      email: [{ text: null }, { text: 'john@example.com' }],
      custom: [{ text: 'AB-1234' }],
    },
    extraHostileInputs: [
      { text: 5 },
      { text: {} },
      { text: [] },
      { text: true },
      { text: 'x'.repeat(5000) },
      { text: '<script>alert(1)</script>' },
      { text: '   ' },
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
    { fixture: 'email', expect: [] },
    { fixture: 'custom', expect: [] },
    {
      fixture: 'custom',
      // Deleting the key, not setting it to `undefined`: `exactOptionalPropertyTypes` makes those
      // different, and an author who cleared the field produces the former.
      mutate: (q) => {
        const { pattern: _dropped, ...config } = q.config;
        return { ...q, config } as typeof q;
      },
      expect: ['missing_pattern'],
    },
    {
      // The catastrophic-backtracking shape, on attacker-controlled input.
      fixture: 'custom',
      mutate: (q) => ({ ...q, config: { ...q.config, pattern: '^(a+)+$' } }),
      expect: ['unsafe_pattern'],
    },
    {
      // A stateful flag makes the same input produce different verdicts on successive calls.
      fixture: 'custom',
      mutate: (q) => ({ ...q, config: { ...q.config, flags: 'g' } }),
      expect: ['unsafe_pattern'],
    },
    {
      // Unanchored: `[0-9]{5}` also accepts "my zip is 12345 thanks".
      fixture: 'custom',
      mutate: (q) => ({ ...q, config: { ...q.config, pattern: '[0-9]{5}' } }),
      expect: ['unanchored_pattern'],
    },
    {
      fixture: 'email',
      mutate: (q) => ({ ...q, config: { ...q.config, pattern: '^x$' } }),
      expect: ['pattern_ignored'],
    },
    {
      fixture: 'email',
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

describe('the format table', () => {
  it('is anchored, so a pattern matches the whole answer rather than a substring', () => {
    // An unanchored named format would accept "my email is x@y.com thanks", which is the defect
    // `unanchored_pattern` warns authors about for their own patterns.
    for (const [format, pattern] of Object.entries(FORMAT_PATTERNS)) {
      expect(pattern.startsWith('^'), `${format} is not start-anchored`).toBe(true);
      expect(pattern.endsWith('$'), `${format} is not end-anchored`).toBe(true);
    }
  });

  it('is free of the shapes its own safety check rejects', () => {
    // The table must pass the rule it enforces on authors, or `unsafe_pattern` would fire on a
    // first-party format.
    for (const [format, pattern] of Object.entries(FORMAT_PATTERNS)) {
      expect(patternProblem(pattern), `${format} is unsafe`).toBeUndefined();
    }
  });

  it('resolves a named format to its own pattern and custom to the authored one', () => {
    expect(patternFor({ format: 'email', maxLen: 10 })).toBe(FORMAT_PATTERNS.email);
    expect(patternFor({ format: 'custom', pattern: '^x$', maxLen: 10 })).toBe('^x$');
    expect(patternFor({ format: 'custom', maxLen: 10 })).toBeUndefined();
  });
});

describe('patternProblem', () => {
  it('rejects the stateful flags by name, because a cached regex would drift', () => {
    expect(patternProblem('^a$', 'g')).toContain('lastIndex');
    expect(patternProblem('^a$', 'y')).toContain('lastIndex');
  });

  it('accepts the flags that do not affect statefulness', () => {
    expect(patternProblem('^a$', 'i')).toBeUndefined();
    expect(patternProblem('^a$', 'imsu')).toBeUndefined();
  });

  it('rejects an unknown flag rather than letting RegExp throw at render', () => {
    expect(patternProblem('^a$', 'q')).toContain('unsupported');
  });

  it('rejects a pattern that does not compile', () => {
    expect(patternProblem('^(unclosed')).toContain('does not compile');
  });

  it('rejects a quantifier over an already-quantified group', () => {
    expect(patternProblem('^(a+)+$')).toContain('backtrack');
    expect(patternProblem('^(a*)*$')).toContain('backtrack');
    expect(patternProblem('^(a{2,})+$')).toContain('backtrack');
  });

  it('does NOT reject the ordinary shapes it could be over-eager about', () => {
    // A false positive blocks a publish, and a check that blocks valid surveys gets deleted — so
    // the rule is deliberately narrow. These must all pass.
    expect(patternProblem('^[a-z]+$')).toBeUndefined();
    expect(patternProblem('^(abc)+$')).toBeUndefined();
    expect(patternProblem('^(a|b)+$')).toBeUndefined();
    expect(patternProblem('^([0-9]{4})$')).toBeUndefined();
  });
});

describe('normalizeText', () => {
  it('trims by default, because surrounding whitespace is never the datum', () => {
    expect(normalizeText('  x  ', undefined)).toBe('x');
    expect(normalizeText('  x  ', 'trim')).toBe('x');
  });

  it('leaves case alone unless asked, because folding changes the datum', () => {
    // `John@X.com` and `john@x.com` are the same mailbox in practice and may not be to a client
    // matching against a CRM. Quietly lowercasing would make that undebuggable.
    expect(normalizeText(' John@X.com ', 'trim')).toBe('John@X.com');
    expect(normalizeText(' John@X.com ', 'lower')).toBe('john@x.com');
  });

  it('can be turned off entirely', () => {
    expect(normalizeText('  x  ', 'none')).toBe('  x  ');
  });
});

describe('formatted_text codec properties', () => {
  const question = fixtureQuestion('formatted_text', { config: base });
  const declarations = declareVariablesFor(formattedText, question).declarations;
  const ctx = createCodecContext({ question, resolved: resolveQuestion(question, declarations) });

  it('stores a whitespace-only answer as null, never as an empty string', () => {
    // Two spellings of blank would make `Q1 == null` logic quietly miss half its cases.
    for (const raw of ['', ' ', '   ']) {
      const parsed = formattedText.codec.parse({ text: raw }, ctx);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.value.text).toBeNull();
    }
  });

  it('accepts a badly-formatted answer, because the format is validate\'s job', () => {
    // The split the plugin rests on: rejecting the page would lose the respondent's other answers.
    const parsed = formattedText.codec.parse({ text: 'not-an-email' }, ctx);

    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.text).toBe('not-an-email');
  });

  it('parse never throws on arbitrary garbage', () => {
    fc.assert(
      fc.property(fc.anything(), (raw) => {
        const result = formattedText.codec.parse(raw, ctx);
        expect(typeof result.ok).toBe('boolean');
      }),
      { numRuns: 500 },
    );
  });

  it('never rejects an arbitrary string outright, whatever it contains', () => {
    // A hostile open end must produce a validation message, not a 400 — every string is a
    // legitimate thing for a respondent to type, even if it fails the format.
    fc.assert(
      fc.property(fc.string({ maxLength: 300 }), (text) => {
        const parsed = formattedText.codec.parse({ text }, ctx);
        expect(parsed.ok).toBe(true);
      }),
      { numRuns: 300 },
    );
  });
});
