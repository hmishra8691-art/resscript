// @vitest-environment jsdom
/**
 * `searchable_select` against the conformance harness, plus the search function's own behaviour.
 *
 * The test that matters most is the diacritic one. A long list is exactly the case where a plain
 * `toLowerCase().includes()` fails the respondents typing their own language: someone entering
 * `espana` must find `España`, and someone entering `koln` must find `Köln`. That is not
 * politeness — it is the difference between a usable control and one that appears to have no entry
 * for the respondent's own country.
 *
 * The other is that search is presentation, never data: filtering must not widen the domain, so a
 * code outside the authored options is still a codec reject however the respondent got there.
 */

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { definePluginTests, item } from '../../testkit/index.js';
import { declareVariablesFor } from '../../declare.js';
import { createCodecContext, resolveQuestion } from '../../resolve.js';
import { fixtureQuestion } from '../../testkit/spec.js';
import { searchableSelect } from './react.js';
import { fold, searchMatches, type SearchableSelectConfig } from './core.js';

const base: SearchableSelectConfig = { min_chars: 0, max_visible: 50, match: 'contains' };

/** A list long enough for the control to be the right choice — see `list_too_short_to_search`. */
const many = Array.from({ length: 14 }, (_, i) => item(`o${String(i + 1)}`, i + 1));
const few = [item('o1', 1), item('o2', 2), item('o3', 3)];

definePluginTests(searchableSelect, {
  fixtures: {
    minimal: { config: base, options: many, required: true },
    prefix: { config: { ...base, match: 'prefix' }, options: many },
    typed_first: { config: { ...base, min_chars: 2 }, options: many },
    capped: { config: { ...base, max_visible: 5, min_chars: 1 }, options: many },
    excluded_from_export: { config: base, options: many, flags: { excludeFromExport: true } },
    flagged_pii: { config: base, options: many, flags: { pii: true } },
  },

  variableSnapshots: {
    expected: {
      minimal: ['Q1 response enum [1,2,3,4,5,6,7,8,9,10,11,12,13,14]'],
      prefix: ['Q1 response enum [1,2,3,4,5,6,7,8,9,10,11,12,13,14]'],
      typed_first: ['Q1 response enum [1,2,3,4,5,6,7,8,9,10,11,12,13,14]'],
      capped: ['Q1 response enum [1,2,3,4,5,6,7,8,9,10,11,12,13,14]'],
      excluded_from_export: [
        'Q1 response enum [1,2,3,4,5,6,7,8,9,10,11,12,13,14] (unexported)',
      ],
      flagged_pii: ['Q1 response enum [1,2,3,4,5,6,7,8,9,10,11,12,13,14] (pii)'],
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
      chosen: { value: { code: 3 } },
      with_errors: {
        value: { code: null },
        issues: [{ variableName: 'Q1', messageKey: 'err.required', severity: 'error' }],
      },
    },
    assertSsrHydrationClean: true,
    // The popup is a block below the input in DOM order; the theme places it with logical
    // properties, so nothing here can mirror wrongly.
    assertNoPhysicalDirectionLeak: true,
  },

  validation: [
    { fixture: 'minimal', value: undefined, required: true, expect: ['err.required'] },
    { fixture: 'minimal', value: { code: null }, required: true, expect: ['err.required'] },
    { fixture: 'minimal', value: { code: null }, required: false, expect: [] },
    { fixture: 'minimal', value: { code: 1 }, required: true, expect: [] },
    { fixture: 'minimal', value: { code: 14 }, required: true, expect: [] },
    // A code outside the visible set: reachable only from a stale Answer across a republish.
    { fixture: 'minimal', value: { code: 99 }, required: true, expect: ['err.invalid_option'] },
  ],
  assertValidationSidesAgree: true,

  codec: {
    roundTrip: {
      minimal: [{ code: null }, { code: 1 }, { code: 14 }],
    },
    extraHostileInputs: [
      // Search does not widen the domain — see the header.
      { code: 99 },
      { code: -1 },
      { code: 'o1' },
      { code: {} },
      { code: [] },
      { code: true },
      { code: Number.NaN },
      // A query is not part of the answer, so an injected one must be ignored, not stored.
      { code: 1, query: 'anything' },
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
      mutate: (q) => ({ ...q, options: [] }),
      expect: ['no_options'],
    },
    {
      // The control costs a typing step; below a dozen options that is worse than a plain list.
      fixture: 'minimal',
      mutate: (q) => ({ ...q, options: few }),
      expect: ['list_too_short_to_search'],
    },
    {
      // Nothing visible until the respondent types: right for a country list they know, wrong for
      // one they need to browse.
      fixture: 'minimal',
      mutate: (q) => ({ ...q, config: { ...q.config, min_chars: 2 } }),
      expect: ['hidden_until_typed'],
    },
    {
      // 5 of 14 shown with no filter applied: the other 9 are unreachable until someone guesses
      // that typing helps.
      fixture: 'minimal',
      mutate: (q) => ({ ...q, config: { ...q.config, max_visible: 5, min_chars: 0 } }),
      expect: ['truncated_without_filter'],
    },
    {
      fixture: 'minimal',
      mutate: (q) => ({ ...q, rows: [item('r1', 1)] }),
      expect: ['rows_ignored'],
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

describe('fold', () => {
  it('strips diacritics, which is what makes a long list usable in its own market', () => {
    expect(fold('España')).toBe('espana');
    expect(fold('Köln')).toBe('koln');
    expect(fold('Ísafjörður')).toBe('isafjorður');
    expect(fold('  Zürich  ')).toBe('zurich');
  });

  it('lowercases and trims', () => {
    expect(fold('  UNITED Kingdom ')).toBe('united kingdom');
  });
});

describe('searchMatches', () => {
  const countries = [
    { labelKey: 'Spain' },
    { labelKey: 'España' },
    { labelKey: 'United Kingdom' },
    { labelKey: 'United States' },
    { labelKey: 'Köln' },
  ];
  const label = (x: { labelKey: string }): string => x.labelKey;

  it('finds an accented name from an unaccented query', () => {
    // The headline. A respondent typing on a keyboard without the accent must still find it.
    expect(searchMatches(countries, 'espana', { label })).toEqual([{ labelKey: 'España' }]);
    expect(searchMatches(countries, 'koln', { label })).toEqual([{ labelKey: 'Köln' }]);
  });

  it('finds an unaccented name from an accented query, which is the same bug mirrored', () => {
    expect(searchMatches(countries, 'Españ', { label })).toEqual([{ labelKey: 'España' }]);
  });

  it('matches anywhere by default and only at the start under prefix', () => {
    expect(searchMatches(countries, 'united', { label }).length).toBe(2);
    expect(searchMatches(countries, 'kingdom', { label }).length).toBe(1);
    expect(searchMatches(countries, 'kingdom', { label, match: 'prefix' }).length).toBe(0);
    expect(searchMatches(countries, 'united', { label, match: 'prefix' }).length).toBe(2);
  });

  it('is case-insensitive', () => {
    expect(searchMatches(countries, 'SPAIN', { label })).toEqual([{ labelKey: 'Spain' }]);
  });

  it('returns everything for an empty or whitespace query', () => {
    expect(searchMatches(countries, '', { label })).toHaveLength(countries.length);
    expect(searchMatches(countries, '   ', { label })).toHaveLength(countries.length);
  });

  it('never returns an item that is not in the input', () => {
    // Search is a filter, and a filter that could invent an item would let the renderer offer an
    // option outside the declared domain.
    fc.assert(
      fc.property(fc.string({ maxLength: 8 }), (query) => {
        for (const match of searchMatches(countries, query, { label })) {
          expect(countries).toContain(match);
        }
      }),
      { numRuns: 200 },
    );
  });
});

describe('searchable_select codec properties', () => {
  const question = fixtureQuestion('searchable_select', { config: base, options: many });
  const declarations = declareVariablesFor(searchableSelect, question).declarations;
  const ctx = createCodecContext({ question, resolved: resolveQuestion(question, declarations) });

  it('accepts every authored code and rejects everything else', () => {
    for (let code = 1; code <= 14; code += 1) {
      expect(searchableSelect.codec.parse({ code }, ctx).ok, `rejected ${code}`).toBe(true);
    }
    fc.assert(
      fc.property(
        fc.integer({ min: -100, max: 200 }).filter((c) => c < 1 || c > 14),
        (code) => {
          const parsed = searchableSelect.codec.parse({ code }, ctx);
          expect(parsed.ok).toBe(false);
          if (!parsed.ok) expect(parsed.error.code).toBe('unknown_key');
        },
      ),
      { numRuns: 200 },
    );
  });

  it('stores only the code — a query on the wire is ignored, never recorded', () => {
    const parsed = searchableSelect.codec.parse({ code: 3, query: 'united' }, ctx);

    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value).toEqual({ code: 3 });
    expect(searchableSelect.codec.toVariables({ code: 3 }, ctx)).toEqual({ Q1: 3 });
  });

  it('parse never throws on arbitrary garbage', () => {
    fc.assert(
      fc.property(fc.anything(), (raw) => {
        const result = searchableSelect.codec.parse(raw, ctx);
        expect(typeof result.ok).toBe('boolean');
      }),
      { numRuns: 500 },
    );
  });
});
