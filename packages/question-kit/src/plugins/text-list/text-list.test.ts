// @vitest-environment jsdom
/**
 * `text_list` against the conformance harness.
 *
 * The load-bearing assertions are in `expected`: one `text` variable per authored item, named by
 * *code* through the option part, `(pii)` on every one of them (an open end is PII by default —
 * see `core.ts`), and no derived view — a collection of verbatims has no membership fact to
 * collect. The order-independence gate is what proves the per-item pattern was inherited from
 * `multi_select` correctly: dragging a box up the list must not move a column.
 */

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { definePluginTests, item } from '../../testkit/index.js';
import { declareVariablesFor } from '../../declare.js';
import { fixtureQuestion } from '../../testkit/spec.js';
import { textList } from './react.js';
import { TEXT_LIST_MESSAGE_KEYS, type TextListConfig } from './core.js';

const base: TextListConfig = { maxLen: 200, minAnswered: 0 };

const three = [item('o1', 1), item('o2', 2), item('o3', 3)];

definePluginTests(textList, {
  fixtures: {
    minimal: { config: base, options: three, required: true },
    bounded: { config: { ...base, minAnswered: 2 }, options: three, required: true },
    looped: {
      config: base,
      options: three,
      loop: { iterationVariableRef: 'BRAND', naming: '{ref}_{iteration}', iteration: 2 },
    },
    excluded_from_export: { config: base, options: three, flags: { excludeFromExport: true } },
    // Same declaration as `minimal`: the boxes are already PII by the plugin's own default.
    flagged_pii: { config: base, options: three, flags: { pii: true } },
    masked: { config: base, options: three, itemStates: { o2: { visible: false } } },
  },

  variableSnapshots: {
    expected: {
      minimal: [
        'Q1r1 response text (pii)',
        'Q1r2 response text (pii)',
        'Q1r3 response text (pii)',
      ],
      bounded: [
        'Q1r1 response text (pii)',
        'Q1r2 response text (pii)',
        'Q1r3 response text (pii)',
      ],
      looped: [
        'Q1r1_2 response text (pii)',
        'Q1r2_2 response text (pii)',
        'Q1r3_2 response text (pii)',
      ],
      excluded_from_export: [
        'Q1r1 response text (unexported,pii)',
        'Q1r2 response text (unexported,pii)',
        'Q1r3 response text (unexported,pii)',
      ],
      flagged_pii: [
        'Q1r1 response text (pii)',
        'Q1r2 response text (pii)',
        'Q1r3 response text (pii)',
      ],
      // Masks are runtime facts; the declaration is a compile-time fact and must not see them.
      masked: [
        'Q1r1 response text (pii)',
        'Q1r2 response text (pii)',
        'Q1r3 response text (pii)',
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
      partial: { value: { texts: { o1: 'first mention' } } },
      complete: { value: { texts: { o1: 'a', o2: 'b', o3: 'c' } } },
      with_errors: {
        value: { texts: {} },
        issues: [{ variableName: null, messageKey: 'err.required', severity: 'error' }],
      },
      disabled_boxes: { itemStates: { o2: { enabled: false } } },
      masked: { itemStates: { o3: { visible: false } } },
    },
    assertSsrHydrationClean: true,
    assertNoPhysicalDirectionLeak: true,
  },

  validation: [
    { fixture: 'minimal', value: undefined, required: true, expect: ['err.required'] },
    { fixture: 'minimal', value: { texts: {} }, required: true, expect: ['err.required'] },
    // Whitespace is not an answer.
    { fixture: 'minimal', value: { texts: { o1: '   ' } }, required: true, expect: ['err.required'] },
    { fixture: 'minimal', value: { texts: {} }, required: false, expect: [] },
    { fixture: 'minimal', value: { texts: { o2: 'fine' } }, required: true, expect: [] },
    {
      fixture: 'bounded',
      value: { texts: { o1: 'only one' } },
      required: true,
      expect: [TEXT_LIST_MESSAGE_KEYS.tooFewAnswered],
    },
    { fixture: 'bounded', value: { texts: { o1: 'a', o3: 'c' } }, required: true, expect: [] },
    // The floor is "when answered at all": leaving the whole battery blank on an optional
    // question is allowed, half-answering it is not.
    { fixture: 'bounded', value: { texts: {} }, required: false, expect: [] },
    {
      fixture: 'minimal',
      value: { texts: { o2: 'x'.repeat(201) } },
      required: true,
      expect: ['err.too_long'],
      expectFocus: { optionRef: 'o2' },
    },
    // Only reachable via a tampered payload; the codec normally rejects first (ADR-004).
    {
      fixture: 'minimal',
      value: { texts: { forged: 'x' } },
      required: false,
      expect: ['err.invalid_option'],
    },
  ],
  assertValidationSidesAgree: true,

  codec: {
    roundTrip: {
      minimal: [
        { texts: {} },
        { texts: { o1: 'a mention' } },
        { texts: { o1: 'a', o3: 'c' } },
        { texts: { o1: 'a', o2: 'b', o3: 'c' } },
      ],
    },
    extraHostileInputs: [
      { texts: 'not an object' },
      { texts: ['not', 'an', 'object'] },
      { texts: { unknown_ref: 'x' } },
      { texts: { o1: 42 } },
      { texts: { o1: 'x'.repeat(1_000_000) } },
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
    { fixture: 'minimal', mutate: (q) => ({ ...q, options: [] }), expect: ['no_options'] },
    {
      fixture: 'minimal',
      mutate: (q) => ({ ...q, config: { ...q.config, minAnswered: 9 } }),
      expect: ['impossible_answer_floor'],
    },
    {
      fixture: 'minimal',
      mutate: (q) => ({ ...q, options: [item('o1', 1, { exclusive: true }), item('o2', 2)] }),
      expect: ['item_flags_ignored'],
    },
  ],

  composition: {
    // Not composable: the fan-out inside a cell would need a `Q5r3r2` name, which schema §4's
    // part model does not describe. A grid of open-end boxes is `matrix` with a `text` cell
    // control — see `core.ts`.
    asChildOf: [],
    asParentOf: [],
    assertChildNamespacing: false,
    assertTrustCompatibility: false,
  },
});

/* -------------------------------------------------------------------------- */
/* The per-item fan-out, as a property                                         */
/* -------------------------------------------------------------------------- */

describe('text_list fan-out', () => {
  it('any authored item set declares one pii text variable per item, named and ordered by code', () => {
    fc.assert(
      fc.property(
        fc
          .uniqueArray(fc.integer({ min: 1, max: 500 }), { minLength: 1, maxLength: 40 })
          .map((codes) => codes.map((code, index) => item(`o${index}_${code}`, code))),
        (options) => {
          const shuffled = [...options].reverse();
          const result = declareVariablesFor(
            textList,
            fixtureQuestion('text_list', { config: base, options: shuffled }),
          );
          expect(result.diagnostics).toEqual([]);
          expect(result.declarations.length).toBe(options.length);
          // Declarations come out in code order whatever the authored order was, every one a
          // pii text response whose export order is its code.
          const sortedCodes = [...options.map((option) => option.code)].sort((a, b) => a - b);
          result.declarations.forEach((declaration, index) => {
            expect(declaration.name).toBe(`Q1r${sortedCodes[index]}`);
            expect(declaration.kind).toBe('response');
            expect(declaration.type).toBe('text');
            expect(declaration.pii).toBe(true);
            expect(declaration.export.order).toBe(sortedCodes[index]);
          });
        },
      ),
      { numRuns: 200 },
    );
  });
});
