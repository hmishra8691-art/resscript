// @vitest-environment jsdom
/**
 * `media_select` against the conformance harness.
 *
 * The tests that carry the weight are the STATIC CHECKS, because that is what distinguishes this
 * type from `single_select` with `display: 'image_grid'`. Three refusals:
 *
 *  - an option with no media, which a respondent cannot distinguish from an image that failed to
 *    load;
 *  - an image with no alt text, which is a question a screen-reader user cannot answer at all —
 *    an ERROR rather than a warning, because a warning is acknowledged once and then the survey
 *    fields with unanswerable options;
 *  - selection bounds in single mode, which are silently inert.
 *
 * The `multi` fixtures also pin the boolean fan-out: one column per tile, `false` for a tile that
 * was offered and not chosen, so the export shape does not depend on what the respondent picked.
 */

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { definePluginTests, item } from '../../testkit/index.js';
import { declareVariablesFor } from '../../declare.js';
import { createCodecContext, resolveQuestion } from '../../resolve.js';
import { fixtureQuestion } from '../../testkit/spec.js';
import { mediaSelect } from './react.js';
import { hasAlt, hasMedia, type MediaSelectConfig } from './core.js';

/** An option with a picture AND a text alternative — the only shape this plugin publishes. */
const pic = (ref: string, code: number) =>
  item(ref, code, { media: { imageAssetId: `ast_${ref}`, altKey: `alt.${ref}` } });

const three = [pic('o1', 1), pic('o2', 2), pic('o3', 3)];
const base: MediaSelectConfig = { mode: 'single', columns: 2 };
const multi: MediaSelectConfig = { mode: 'multi', columns: 2 };

definePluginTests(mediaSelect, {
  fixtures: {
    single: { config: base, options: three, required: true },
    single_no_labels: { config: { ...base, show_labels: false }, options: three },
    multi: { config: multi, options: three, required: true },
    multi_bounded: {
      config: { ...multi, min_selected: 1, max_selected: 2 },
      options: three,
      required: true,
    },
    excluded_from_export: { config: base, options: three, flags: { excludeFromExport: true } },
    flagged_pii: { config: base, options: three, flags: { pii: true } },
  },

  variableSnapshots: {
    expected: {
      single: ['Q1 response enum [1,2,3]'],
      single_no_labels: ['Q1 response enum [1,2,3]'],
      // The fan-out: one boolean per tile, so the export shape is fixed whatever is chosen.
      multi: ['Q1r1 response boolean', 'Q1r2 response boolean', 'Q1r3 response boolean'],
      multi_bounded: ['Q1r1 response boolean', 'Q1r2 response boolean', 'Q1r3 response boolean'],
      excluded_from_export: ['Q1 response enum [1,2,3] (unexported)'],
      flagged_pii: ['Q1 response enum [1,2,3] (pii)'],
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
      chosen: { value: { code: 2, codes: [] } },
      with_errors: {
        value: { code: null, codes: [] },
        issues: [{ variableName: 'Q1', messageKey: 'err.required', severity: 'error' }],
      },
    },
    assertSsrHydrationClean: true,
    // Grid flow comes from a column class, never an inline template with a direction in it.
    assertNoPhysicalDirectionLeak: true,
  },

  validation: [
    { fixture: 'single', value: undefined, required: true, expect: ['err.required'] },
    { fixture: 'single', value: { code: null, codes: [] }, required: true, expect: ['err.required'] },
    { fixture: 'single', value: { code: null, codes: [] }, required: false, expect: [] },
    { fixture: 'single', value: { code: 2, codes: [] }, required: true, expect: [] },
    { fixture: 'single', value: { code: 9, codes: [] }, required: true, expect: ['err.invalid_option'] },
    { fixture: 'multi', value: { code: null, codes: [] }, required: true, expect: ['err.required'] },
    { fixture: 'multi', value: { code: null, codes: [1, 3] }, required: true, expect: [] },
    {
      fixture: 'multi_bounded',
      value: { code: null, codes: [1, 2, 3] },
      required: true,
      expect: ['err.too_many_selected'],
    },
  ],
  assertValidationSidesAgree: true,

  codec: {
    roundTrip: {
      single: [{ code: null, codes: [] }, { code: 1, codes: [] }, { code: 3, codes: [] }],
      multi: [
        { code: null, codes: [] },
        { code: null, codes: [1] },
        { code: null, codes: [1, 2, 3] },
      ],
    },
    extraHostileInputs: [
      { code: 9 },
      { code: {} },
      { code: [] },
      { codes: 5 },
      { codes: {} },
      { codes: [9] },

      { codes: [null] },
      { codes: [{}] },
      { code: true },
    ],
    assertNoThrow: true,
    assertVariablesSubsetOfDeclared: true,
  },

  a11y: {
    // `multi` is a group of checkboxes, not a radiogroup — the same shape `multi_select`
    // declares. Overridden per fixture rather than widening the contract to the union, so a
    // single-mode question rendering checkboxes would still fail.
    rolesByFixture: {
      multi: ['group', 'checkbox'],
      multi_bounded: ['group', 'checkbox'],
    },
    assertContractRolesPresent: true,
    assertSingleTabStopPerGroup: true,
    assertTouchTargets: true,
    assertNoLocalLiveRegion: true,
    assertErrorWiring: true,
  },

  staticChecks: [
    { fixture: 'single', expect: [] },
    { fixture: 'multi_bounded', expect: [] },
    {
      fixture: 'single',
      mutate: (q) => ({ ...q, options: [] }),
      expect: ['no_options'],
    },
    {
      // The check `single_select` cannot make: a bare text option in a picture grid.
      fixture: 'single',
      mutate: (q) => ({ ...q, options: [...three, item('o4', 4)] }),
      expect: ['option_without_media'],
    },
    {
      // An image with no text alternative — unanswerable for a screen-reader user, so an error.
      fixture: 'single',
      mutate: (q) => ({
        ...q,
        options: [pic('o1', 1), item('o2', 2, { media: { imageAssetId: 'ast_o2' } })],
      }),
      expect: ['media_without_alt'],
    },
    {
      // An empty alt key claims the image is decorative, which for a choosable option it is not.
      fixture: 'single',
      mutate: (q) => ({
        ...q,
        options: [item('o1', 1, { media: { imageAssetId: 'ast_o1', altKey: '' } })],
      }),
      expect: ['media_without_alt'],
    },
    {
      fixture: 'single',
      mutate: (q) => ({ ...q, config: { ...q.config, min_selected: 2 } }),
      expect: ['selection_bounds_ignored'],
    },
    {
      fixture: 'multi',
      mutate: (q) => ({ ...q, config: { ...q.config, min_selected: 3, max_selected: 1 } }),
      expect: ['impossible_bounds'],
    },
    {
      fixture: 'multi',
      mutate: (q) => ({ ...q, config: { ...q.config, min_selected: 9 } }),
      expect: ['impossible_bounds'],
    },
    {
      fixture: 'single',
      mutate: (q) => ({ ...q, rows: [item('r1', 1)] }),
      expect: ['rows_ignored'],
    },
  ],

  composition: {
    // Not composable: `multi` fans out to one boolean per option and a cell scope cannot name a
    // fan-out. Making it depend on `mode` would be a configuration the studio offers and the
    // compiler then refuses, so the conservative answer covers both modes.
    asChildOf: [],
    asParentOf: [],
    assertChildNamespacing: false,
    assertTrustCompatibility: true,
  },
});

/* -------------------------------------------------------------------------- */
/* Properties specific to this plugin                                         */
/* -------------------------------------------------------------------------- */

describe('media and alt detection', () => {
  it('treats a present-but-empty asset as no media', () => {
    // `media: {}` is what a half-authored option looks like, and it must not read as "has a
    // picture" — otherwise the alt check runs on an option with nothing to describe.
    expect(hasMedia(item('o1', 1))).toBe(false);
    expect(hasMedia(item('o1', 1, { media: {} }))).toBe(false);
    expect(hasMedia(item('o1', 1, { media: { imageAssetId: '' } }))).toBe(false);
    expect(hasMedia(item('o1', 1, { media: { imageAssetId: 'ast_1' } }))).toBe(true);
  });

  it('treats an empty alt key as no alt, because it claims decorative', () => {
    expect(hasAlt(item('o1', 1, { media: { imageAssetId: 'a' } }))).toBe(false);
    expect(hasAlt(item('o1', 1, { media: { imageAssetId: 'a', altKey: '' } }))).toBe(false);
    expect(hasAlt(item('o1', 1, { media: { imageAssetId: 'a', altKey: 'alt.o1' } }))).toBe(true);
  });
});

describe('media_select codec properties', () => {
  function ctxFor(config: MediaSelectConfig) {
    const question = fixtureQuestion('media_select', { config, options: three });
    const declarations = declareVariablesFor(mediaSelect, question).declarations;
    return createCodecContext({ question, resolved: resolveQuestion(question, declarations) });
  }

  it('writes false for a tile that was offered and not chosen', () => {
    // The export shape must not depend on what the respondent picked.
    const ctx = ctxFor(multi);

    expect(mediaSelect.codec.toVariables({ code: null, codes: [2] }, ctx)).toEqual({
      Q1r1: false,
      Q1r2: true,
      Q1r3: false,
    });
  });

  it('normalizes codes to sorted and deduped, so one selection has one representation', () => {
    const ctx = ctxFor(multi);
    const parsed = mediaSelect.codec.parse({ codes: [3, 1, 3, 1] }, ctx);

    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.codes).toEqual([1, 3]);
  });

  it('round-trips every subset of the tiles in multi mode', () => {
    const ctx = ctxFor(multi);
    const all = [1, 2, 3];
    for (let mask = 0; mask < 8; mask += 1) {
      const codes = all.filter((_, i) => (mask & (1 << i)) !== 0);
      const answer = { code: null, codes };
      expect(mediaSelect.codec.parse(answer, ctx).ok, `rejected ${JSON.stringify(codes)}`).toBe(true);
      const vars = mediaSelect.codec.toVariables(answer, ctx);
      expect(mediaSelect.codec.fromVariables(vars, ctx)).toEqual(answer);
    }
  });

  it('bounds the array by the shared limit, not by the option count', () => {
    // A 10,000-entry payload costs a length comparison rather than 10,000 allocations. Bounding by
    // the OPTION count instead was the first attempt and it was wrong: honest clients send
    // duplicates (a double-tap, a resubmitted form) and the dedup handles them, so `[3,1,3,1]` on
    // a three-option question is a real selection and must be accepted.
    const ctx = ctxFor(multi);

    expect(mediaSelect.codec.parse({ codes: [3, 1, 3, 1] }, ctx).ok).toBe(true);
    const huge = mediaSelect.codec.parse(
      { codes: Array.from({ length: 1001 }, () => 1) },
      ctx,
    );
    expect(huge.ok).toBe(false);
    if (!huge.ok) expect(huge.error.code).toBe('too_large');
  });

  it('has exactly one empty answer in both modes', () => {
    // Two spellings of "nothing chosen" would fail the codec's own round-trip, which is why the
    // answer carries both fields in both modes rather than being a union.
    for (const config of [base, multi]) {
      const ctx = ctxFor(config);
      expect(mediaSelect.codec.emptyAnswer(ctx)).toEqual({ code: null, codes: [] });
      const parsed = mediaSelect.codec.parse(null, ctx);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.value).toEqual({ code: null, codes: [] });
    }
  });

  it('parse never throws on arbitrary garbage, in either mode', () => {
    for (const config of [base, multi]) {
      const ctx = ctxFor(config);
      fc.assert(
        fc.property(fc.anything(), (raw) => {
          const result = mediaSelect.codec.parse(raw, ctx);
          expect(typeof result.ok).toBe('boolean');
        }),
        { numRuns: 300 },
      );
    }
  });
});
