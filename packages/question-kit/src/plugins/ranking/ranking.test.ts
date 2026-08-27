// @vitest-environment jsdom
/**
 * `ranking` against the conformance harness, plus the properties that make a rank column analysable.
 *
 * Two things this file is really asserting.
 *
 * **The columns are per ITEM, not per slot.** `variableSnapshots` pins one numeric column per
 * option, holding that option's rank. If it ever flips to slot-keyed columns this file fails, which
 * is the point: slot-keyed columns renumber the moment a brand is inserted and silently break every
 * wave-on-wave comparison in a tracker.
 *
 * **Ties and gaps cannot reach the data.** The codec rejects them rather than reporting them,
 * because the rendered widget cannot produce either — a duplicate rank is a forged or stale payload,
 * and once it is stored every mean-rank calculation downstream is quietly wrong.
 */

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { definePluginTests, item } from '../../testkit/index.js';
import { declareVariablesFor } from '../../declare.js';
import { createCodecContext, resolveQuestion } from '../../resolve.js';
import { fixtureQuestion } from '../../testkit/spec.js';
import { ranking } from './react.js';
import { isDenseRanking, type RankingConfig } from './core.js';

const base: RankingConfig = { display: 'list' };
const three = [item('o1', 1), item('o2', 2), item('o3', 3)];
const five = [...three, item('o4', 4), item('o5', 5)];

definePluginTests(ranking, {
  fixtures: {
    minimal: { config: base, options: three, required: true },
    drag: { config: { display: 'drag' }, options: three, required: true },
    top3_of_5: { config: { ...base, max_ranked: 3 }, options: five, required: true },
    excluded_from_export: { config: base, options: three, flags: { excludeFromExport: true } },
    flagged_pii: { config: base, options: three, flags: { pii: true } },
  },

  variableSnapshots: {
    expected: {
      // One column per ITEM, holding that item's rank — see the header.
      minimal: ['Q1r1 response number', 'Q1r2 response number', 'Q1r3 response number'],
      drag: ['Q1r1 response number', 'Q1r2 response number', 'Q1r3 response number'],
      top3_of_5: [
        'Q1r1 response number',
        'Q1r2 response number',
        'Q1r3 response number',
        // Five columns for a top-3 ranking: the two unranked items are `null`, not absent
        // columns, so the shape does not change with how much the respondent ranked.
        'Q1r4 response number',
        'Q1r5 response number',
      ],
      excluded_from_export: [
        'Q1r1 response number (unexported)',
        'Q1r2 response number (unexported)',
        'Q1r3 response number (unexported)',
      ],
      flagged_pii: [
        'Q1r1 response number (pii)',
        'Q1r2 response number (pii)',
        'Q1r3 response number (pii)',
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
      partial: { value: { ranks: { o1: 1 } } },
      complete: { value: { ranks: { o1: 1, o2: 2, o3: 3 } } },
      reversed: { value: { ranks: { o1: 3, o2: 2, o3: 1 } } },
      with_errors: {
        value: { ranks: {} },
        issues: [{ variableName: null, messageKey: 'err.required', severity: 'error' }],
      },
    },
    assertSsrHydrationClean: true,
    // The drag display orders by DOM position and never by a physical offset, which is what lets
    // this hold for `display: 'drag'` as well as for the select list.
    assertNoPhysicalDirectionLeak: true,
  },

  validation: [
    { fixture: 'minimal', value: undefined, required: true, expect: ['err.required'] },
    { fixture: 'minimal', value: { ranks: {} }, required: true, expect: ['err.required'] },
    { fixture: 'minimal', value: { ranks: {} }, required: false, expect: [] },
    { fixture: 'minimal', value: { ranks: { o1: 1, o2: 2, o3: 3 } }, required: true, expect: [] },
    // Started but not finished: "too few", not "required" — the respondent HAS engaged, and the
    // actionable message is how many more to place.
    {
      fixture: 'minimal',
      value: { ranks: { o1: 1 } },
      required: true,
      expect: ['err.too_few_selected'],
    },
    { fixture: 'top3_of_5', value: { ranks: { o1: 1, o2: 2, o3: 3 } }, required: true, expect: [] },
    {
      fixture: 'top3_of_5',
      value: { ranks: { o1: 1, o2: 2 } },
      required: true,
      expect: ['err.too_few_selected'],
    },
    {
      fixture: 'top3_of_5',
      value: { ranks: { o1: 1, o2: 2, o3: 3, o4: 4 } },
      required: true,
      expect: ['err.too_many_selected'],
    },
  ],
  assertValidationSidesAgree: true,

  codec: {
    roundTrip: {
      minimal: [{ ranks: {} }, { ranks: { o1: 1 } }, { ranks: { o1: 2, o2: 1, o3: 3 } }],
      top3_of_5: [{ ranks: { o5: 1, o1: 2, o3: 3 } }],
    },
    extraHostileInputs: [
      // A tie: not a ranking, and every mean-rank downstream would be wrong.
      { ranks: { o1: 1, o2: 1 } },
      // A gap: 1,2,4 over three ranked items.
      { ranks: { o1: 1, o2: 2, o3: 4 } },
      { ranks: { o1: 0 } },
      { ranks: { o1: -1 } },
      { ranks: { o1: 1.5 } },
      { ranks: { o1: '1' } },
      { ranks: { ghost: 1 } },
      { ranks: [] },
      { ranks: 5 },
      { ranks: { o1: Number.NaN } },
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
    { fixture: 'top3_of_5', expect: [] },
    {
      fixture: 'minimal',
      mutate: (q) => ({ ...q, options: [item('o1', 1)] }),
      expect: ['too_few_items'],
    },
    {
      fixture: 'minimal',
      mutate: (q) => ({ ...q, config: { ...q.config, max_ranked: 9 } }),
      expect: ['max_ranked_exceeds_items'],
    },
    {
      fixture: 'minimal',
      mutate: (q) => ({ ...q, rows: [item('r1', 1)] }),
      expect: ['rows_ignored'],
    },
  ],

  composition: {
    // Not composable, and the snapshot above is why: the variables are named per ITEM, and a
    // matrix cell scope has no way to express "rank of item 3 within cell (row 2, column 1)".
    asChildOf: [],
    asParentOf: [],
    assertChildNamespacing: false,
    assertTrustCompatibility: true,
  },
});

/* -------------------------------------------------------------------------- */
/* Properties specific to this plugin                                         */
/* -------------------------------------------------------------------------- */

describe('isDenseRanking', () => {
  it('accepts 1..n in any order and the empty ranking', () => {
    expect(isDenseRanking([])).toBe(true);
    expect(isDenseRanking([1])).toBe(true);
    expect(isDenseRanking([2, 1, 3])).toBe(true);
    expect(isDenseRanking([3, 1, 2])).toBe(true);
  });

  it('rejects gaps, duplicates and rankings that do not start at 1', () => {
    expect(isDenseRanking([1, 2, 4])).toBe(false);
    expect(isDenseRanking([1, 1])).toBe(false);
    expect(isDenseRanking([2, 3])).toBe(false);
    expect(isDenseRanking([0, 1])).toBe(false);
  });
});

describe('ranking codec properties', () => {
  const question = fixtureQuestion('ranking', { config: base, options: three });
  const declarations = declareVariablesFor(ranking, question).declarations;
  const ctx = createCodecContext({ question, resolved: resolveQuestion(question, declarations) });

  it('round-trips every permutation of a full ranking exactly', () => {
    const refs = ['o1', 'o2', 'o3'];
    const permutations = [
      [1, 2, 3], [1, 3, 2], [2, 1, 3], [2, 3, 1], [3, 1, 2], [3, 2, 1],
    ];
    for (const perm of permutations) {
      const ranks = Object.fromEntries(refs.map((ref, i) => [ref, perm[i] as number]));
      const parsed = ranking.codec.parse({ ranks }, ctx);
      expect(parsed.ok, `rejected permutation ${JSON.stringify(perm)}`).toBe(true);
      const vars = ranking.codec.toVariables({ ranks }, ctx);
      expect(ranking.codec.fromVariables(vars, ctx)).toEqual({ ranks });
    }
  });

  it('writes null for an unranked item rather than omitting its column', () => {
    // The export shape must not depend on how much the respondent ranked.
    const vars = ranking.codec.toVariables({ ranks: { o2: 1 } }, ctx);

    expect(vars).toEqual({ Q1r1: null, Q1r2: 1, Q1r3: null });
  });

  it('rejects every tie, whatever the ranks involved', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 3 }), (rank) => {
        const parsed = ranking.codec.parse({ ranks: { o1: rank, o2: rank } }, ctx);
        expect(parsed.ok).toBe(false);
        if (!parsed.ok) expect(parsed.error.code).toBe('range');
      }),
      { numRuns: 20 },
    );
  });

  it('parse never throws on arbitrary garbage', () => {
    fc.assert(
      fc.property(fc.anything(), (raw) => {
        const result = ranking.codec.parse(raw, ctx);
        expect(typeof result.ok).toBe('boolean');
      }),
      { numRuns: 500 },
    );
  });
});
