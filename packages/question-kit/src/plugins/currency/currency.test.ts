// @vitest-environment jsdom
/**
 * `currency` against the conformance harness, plus the two properties that make a money column
 * usable two years later.
 *
 * **The unit travels with the amount.** `variableSnapshots` pins a second `text` column holding the
 * ISO code, for a FIXED currency as well as a chosen one. If that column ever becomes conditional
 * this file fails, which is the point: a column that exists only sometimes is one an analyst's
 * script cannot rely on, and a bare number whose unit lives in a translated question label is not
 * recoverable.
 *
 * **The decimal grid comes from the currency, not the author.** JPY has no minor unit, KWD has
 * three. A question that accepted ¥100.25 would store an amount that cannot exist, so the grid is
 * derived and an unknown code is a publish error rather than a silent assumption of 2.
 */

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { definePluginTests, item, testParentCore } from '../../testkit/index.js';
import { createRegistry } from '../../registry.js';
import type { AnyPluginCore } from '../../contract/plugin.js';
import type { AuthoredQuestion } from '../../contract/authored.js';
import type { TestParentConfig } from '../../testkit/parent.js';
import { declareVariablesFor } from '../../declare.js';
import { createCodecContext, resolveQuestion } from '../../resolve.js';
import { fixtureQuestion } from '../../testkit/spec.js';
import { currency } from './react.js';
import { allowedCurrencies, minorUnitsOf, type CurrencyConfig } from './core.js';

const base: CurrencyConfig = { currency: 'USD', min: 0 };

definePluginTests(currency, {
  fixtures: {
    minimal: { config: base, required: true },
    yen: { config: { currency: 'JPY' }, required: true },
    dinar: { config: { currency: 'KWD' }, required: true },
    choice: { config: { currency: 'CHF', allow_choice: ['CHF', 'EUR'] }, required: true },
    bounded: { config: { currency: 'GBP', min: 1, max: 1000 }, required: true },
    looped: {
      config: base,
      loop: { iterationVariableRef: 'BRAND', naming: '{ref}_{iteration}', iteration: 2 },
    },
    excluded_from_export: { config: base, flags: { excludeFromExport: true } },
    flagged_pii: { config: base, flags: { pii: true } },
  },

  variableSnapshots: {
    expected: {
      // Two columns, always: the amount and its unit. See the header.
      minimal: ['Q1 response number', 'Q1_cur response text'],
      yen: ['Q1 response number', 'Q1_cur response text'],
      dinar: ['Q1 response number', 'Q1_cur response text'],
      choice: ['Q1 response number', 'Q1_cur response text'],
      bounded: ['Q1 response number', 'Q1_cur response text'],
      // The loop template wraps each name WHOLE, so the companion of `Q1_cur` at iteration 2 is
      // `Q1_cur_2` — the same shape `numeric_list` gets for its rows (`Q1r1` -> `Q1r1_2`).
      looped: ['Q1_2 response number', 'Q1_cur_2 response text'],
      excluded_from_export: [
        'Q1 response number (unexported)',
        'Q1_cur response text (unexported)',
      ],
      // The amount is pii; the CODE is not. Flagging an ISO currency code would strip the unit out
      // of a redacted export and leave the amounts unitless — the failure this companion prevents.
      flagged_pii: ['Q1 response number (pii)', 'Q1_cur response text'],
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
      partial: { value: { amount: 25, currency: 'USD' } },
      complete: { value: { amount: 1999.99, currency: 'USD' } },
      with_errors: {
        value: { amount: null, currency: null },
        issues: [{ variableName: 'Q1', messageKey: 'err.required', severity: 'error' }],
      },
    },
    assertSsrHydrationClean: true,
    // The currency symbol/code is placed in reading order, never with a physical offset.
    assertNoPhysicalDirectionLeak: true,
  },

  validation: [
    { fixture: 'minimal', value: undefined, required: true, expect: ['err.required'] },
    {
      fixture: 'minimal',
      value: { amount: null, currency: null },
      required: false,
      expect: [],
    },
    { fixture: 'minimal', value: { amount: 10.5, currency: 'USD' }, required: true, expect: [] },
    // USD has two minor units, so three decimals is off the grid.
    {
      fixture: 'minimal',
      value: { amount: 10.555, currency: 'USD' },
      required: true,
      expect: ['err.not_numeric'],
    },
    // JPY has none: any fraction is impossible.
    { fixture: 'yen', value: { amount: 100, currency: 'JPY' }, required: true, expect: [] },
    {
      fixture: 'yen',
      value: { amount: 100.25, currency: 'JPY' },
      required: true,
      expect: ['err.not_numeric'],
    },
    // KWD has three, so three decimals is exactly right.
    { fixture: 'dinar', value: { amount: 10.125, currency: 'KWD' }, required: true, expect: [] },
    { fixture: 'bounded', value: { amount: 0.5, currency: 'GBP' }, required: true, expect: ['err.out_of_range'] },
    { fixture: 'bounded', value: { amount: 2000, currency: 'GBP' }, required: true, expect: ['err.out_of_range'] },
    // A chosen currency from the offered list.
    { fixture: 'choice', value: { amount: 50, currency: 'EUR' }, required: true, expect: [] },
    // An amount with no unit is the defect the plugin exists to prevent.
    {
      fixture: 'minimal',
      value: { amount: 10, currency: null },
      required: true,
      expect: ['err.invalid_option'],
    },
  ],
  assertValidationSidesAgree: true,

  codec: {
    roundTrip: {
      minimal: [
        { amount: null, currency: null },
        { amount: 0, currency: 'USD' },
        { amount: 1999.99, currency: 'USD' },
      ],
      choice: [{ amount: 50, currency: 'EUR' }, { amount: 50, currency: 'CHF' }],
      dinar: [{ amount: 10.125, currency: 'KWD' }],
    },
    extraHostileInputs: [
      // A currency the question does not offer.
      { amount: 10, currency: 'BTC' },
      { amount: 10, currency: 'EUR' },
      { amount: 10, currency: 5 },
      // An amount with no unit.
      { amount: 10 },
      { amount: '10', currency: 'USD' },
      { amount: Number.NaN, currency: 'USD' },
      { amount: Number.POSITIVE_INFINITY, currency: 'USD' },
      { amount: 1e308, currency: 'USD' },
      { amount: 10.555, currency: 'USD' },
      { amount: {}, currency: 'USD' },
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
    { fixture: 'yen', expect: [] },
    {
      fixture: 'minimal',
      mutate: (q) => ({ ...q, config: { ...q.config, currency: 'XYZ' } }),
      expect: ['unknown_currency'],
    },
    {
      fixture: 'choice',
      mutate: (q) => ({ ...q, config: { ...q.config, currency: 'GBP' } }),
      expect: ['default_not_offered'],
    },
    {
      // CHF (2) and JPY (0) in one choice list: one column on two grids. Legitimate, but the
      // analyst has to read the currency column, so it is a warning rather than silence.
      fixture: 'choice',
      mutate: (q) => ({ ...q, config: { ...q.config, allow_choice: ['CHF', 'JPY'] } }),
      expect: ['mixed_minor_units'],
    },
    {
      fixture: 'minimal',
      mutate: (q) => ({ ...q, config: { ...q.config, min: 100, max: 10 } }),
      expect: ['impossible_bounds'],
    },
    {
      fixture: 'minimal',
      mutate: (q) => ({ ...q, options: [item('o1', 1)] }),
      expect: ['options_ignored'],
    },
  ],

  composition: {
    // Not composable — and the reason is in `core.ts`' `composable` note: the compose machinery
    // refuses a suffixed companion in a cell scope with `compose_unnameable_part`, because schema
    // §4 has no part describing "a suffix on a cell" and the variable could not round-trip through
    // the registry. `refuses composition` below asserts that refusal directly, so the constraint is
    // pinned rather than merely respected.
    asChildOf: [],
    asParentOf: [],
    assertChildNamespacing: false,
    assertTrustCompatibility: true,
  },
});

/* -------------------------------------------------------------------------- */
/* Properties specific to this plugin                                         */
/* -------------------------------------------------------------------------- */

describe('minor units', () => {
  it('knows the zero-decimal currencies, which is the case that produces impossible amounts', () => {
    expect(minorUnitsOf('JPY')).toBe(0);
    expect(minorUnitsOf('KRW')).toBe(0);
    expect(minorUnitsOf('CLP')).toBe(0);
    expect(minorUnitsOf('VND')).toBe(0);
  });

  it('knows the three-decimal currencies', () => {
    expect(minorUnitsOf('KWD')).toBe(3);
    expect(minorUnitsOf('BHD')).toBe(3);
    expect(minorUnitsOf('TND')).toBe(3);
  });

  it('is case-insensitive, so an author typing lowercase is not an error', () => {
    expect(minorUnitsOf('usd')).toBe(2);
    expect(minorUnitsOf('jpy')).toBe(0);
  });

  it('answers undefined for an unknown code rather than assuming two', () => {
    // The whole reason `unknown_currency` is an error: assuming 2 for a zero-decimal currency
    // accepts amounts that cannot exist.
    expect(minorUnitsOf('XYZ')).toBeUndefined();
    expect(minorUnitsOf('')).toBeUndefined();
  });
});

describe('allowedCurrencies', () => {
  it('is the choice list when one is offered', () => {
    expect(allowedCurrencies({ currency: 'CHF', allow_choice: ['CHF', 'EUR'] })).toEqual(['CHF', 'EUR']);
  });

  it('is the single configured currency otherwise', () => {
    expect(allowedCurrencies({ currency: 'usd' })).toEqual(['USD']);
    expect(allowedCurrencies({ currency: 'USD', allow_choice: [] })).toEqual(['USD']);
  });
});

describe('currency codec properties', () => {
  function ctxFor(config: CurrencyConfig) {
    const question = fixtureQuestion('currency', { config });
    const declarations = declareVariablesFor(currency, question).declarations;
    return createCodecContext({ question, resolved: resolveQuestion(question, declarations) });
  }

  it('checks the amount against the grid of the currency the ANSWER is in', () => {
    // A KWD amount is checked to 3 decimals even in a study whose default is EUR — the grid
    // follows the answer, not the config.
    const ctx = ctxFor({ currency: 'EUR', allow_choice: ['EUR', 'KWD'] });

    expect(currency.codec.parse({ amount: 10.125, currency: 'KWD' }, ctx).ok).toBe(true);
    // The same value in EUR is off a 2-decimal grid.
    expect(currency.codec.parse({ amount: 10.125, currency: 'EUR' }, ctx).ok).toBe(false);
  });

  it('normalizes a currency with no amount to the empty answer', () => {
    // A respondent who picked a unit and has not typed yet. Harmless, and normalized so the empty
    // answer has exactly one representation — a codec with two empty answers fails round-trip.
    const ctx = ctxFor(base);
    const parsed = currency.codec.parse({ amount: null, currency: 'USD' }, ctx);

    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value).toEqual({ amount: null, currency: null });
  });

  it('accepts a lowercase code and stores it uppercased', () => {
    const ctx = ctxFor(base);
    const parsed = currency.codec.parse({ amount: 5, currency: 'usd' }, ctx);

    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.currency).toBe('USD');
  });

  it('round-trips every whole-cent amount exactly', () => {
    const ctx = ctxFor(base);
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1_000_000 }), (cents) => {
        const amount = cents / 100;
        const answer = { amount, currency: 'USD' };
        expect(currency.codec.parse(answer, ctx).ok, `rejected ${amount}`).toBe(true);
        const vars = currency.codec.toVariables(answer, ctx);
        expect(currency.codec.fromVariables(vars, ctx)).toEqual(answer);
      }),
      { numRuns: 300 },
    );
  });

  it('parse never throws on arbitrary garbage', () => {
    const ctx = ctxFor(base);
    fc.assert(
      fc.property(fc.anything(), (raw) => {
        const result = currency.codec.parse(raw, ctx);
        expect(typeof result.ok).toBe('boolean');
      }),
      { numRuns: 500 },
    );
  });
});

describe('composition', () => {
  /**
   * Pinning the refusal, not the capability.
   *
   * A currency cell would need two variables per cell — the amount and its code — and the second
   * has no schema §4 part that can describe it. The machinery says so explicitly; this test holds
   * that line, so a later change that made `currency` composable without adding the schema part
   * would fail here rather than at a customer's publish.
   */
  it('refuses composition, naming the unnameable part', () => {
    const registry = createRegistry<AnyPluginCore>();
    registry.register(currency, { trust: 'first_party' });
    registry.register(testParentCore, { trust: 'first_party' });

    const parent: AuthoredQuestion<TestParentConfig> = {
      ref: 'P1',
      questionType: 'test_parent',
      label: 'P1.label',
      instruction: null,
      required: false,
      config: { childType: 'currency', useColumns: false, childConfig: { currency: 'USD' } },
      options: [],
      rows: [{ ref: 'r1', code: 1, labelKey: 'row.r1', position: 1 }],
      columns: [],
      cells: [],
      flags: { pii: false, excludeFromExport: false },
      loop: null,
    };

    const result = declareVariablesFor(testParentCore, parent, { registry });

    // No partial variable set: a composition that cannot name a variable declares none.
    expect(result.declarations).toEqual([]);
    const codes = result.diagnostics.map((d) => d.code);
    // `composable: false` is caught first, which is the honest error for an author.
    expect(codes.some((code) => code.includes('compose'))).toBe(true);
    expect(result.diagnostics.every((d) => d.severity === 'error')).toBe(true);
  });
});

describe('minor units', () => {
  it('knows the zero-decimal currencies, which is the case that produces impossible amounts', () => {
    expect(minorUnitsOf('JPY')).toBe(0);
    expect(minorUnitsOf('KRW')).toBe(0);
    expect(minorUnitsOf('CLP')).toBe(0);
    expect(minorUnitsOf('VND')).toBe(0);
  });

  it('knows the three-decimal currencies', () => {
    expect(minorUnitsOf('KWD')).toBe(3);
    expect(minorUnitsOf('BHD')).toBe(3);
    expect(minorUnitsOf('TND')).toBe(3);
  });

  it('is case-insensitive, so an author typing lowercase is not an error', () => {
    expect(minorUnitsOf('usd')).toBe(2);
    expect(minorUnitsOf('jpy')).toBe(0);
  });

  it('answers undefined for an unknown code rather than assuming two', () => {
    // The whole reason `unknown_currency` is an error: assuming 2 for a zero-decimal currency
    // accepts amounts that cannot exist.
    expect(minorUnitsOf('XYZ')).toBeUndefined();
    expect(minorUnitsOf('')).toBeUndefined();
  });
});

describe('allowedCurrencies', () => {
  it('is the choice list when one is offered', () => {
    expect(allowedCurrencies({ currency: 'CHF', allow_choice: ['CHF', 'EUR'] })).toEqual(['CHF', 'EUR']);
  });

  it('is the single configured currency otherwise', () => {
    expect(allowedCurrencies({ currency: 'usd' })).toEqual(['USD']);
    expect(allowedCurrencies({ currency: 'USD', allow_choice: [] })).toEqual(['USD']);
  });
});

describe('currency codec properties', () => {
  function ctxFor(config: CurrencyConfig) {
    const question = fixtureQuestion('currency', { config });
    const declarations = declareVariablesFor(currency, question).declarations;
    return createCodecContext({ question, resolved: resolveQuestion(question, declarations) });
  }

  it('checks the amount against the grid of the currency the ANSWER is in', () => {
    // A KWD amount is checked to 3 decimals even in a study whose default is EUR — the grid
    // follows the answer, not the config.
    const ctx = ctxFor({ currency: 'EUR', allow_choice: ['EUR', 'KWD'] });

    expect(currency.codec.parse({ amount: 10.125, currency: 'KWD' }, ctx).ok).toBe(true);
    // The same value in EUR is off a 2-decimal grid.
    expect(currency.codec.parse({ amount: 10.125, currency: 'EUR' }, ctx).ok).toBe(false);
  });

  it('normalizes a currency with no amount to the empty answer', () => {
    // A respondent who picked a unit and has not typed yet. Harmless, and normalized so the empty
    // answer has exactly one representation — a codec with two empty answers fails round-trip.
    const ctx = ctxFor(base);
    const parsed = currency.codec.parse({ amount: null, currency: 'USD' }, ctx);

    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value).toEqual({ amount: null, currency: null });
  });

  it('accepts a lowercase code and stores it uppercased', () => {
    const ctx = ctxFor(base);
    const parsed = currency.codec.parse({ amount: 5, currency: 'usd' }, ctx);

    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.currency).toBe('USD');
  });

  it('round-trips every whole-cent amount exactly', () => {
    const ctx = ctxFor(base);
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1_000_000 }), (cents) => {
        const amount = cents / 100;
        const answer = { amount, currency: 'USD' };
        expect(currency.codec.parse(answer, ctx).ok, `rejected ${amount}`).toBe(true);
        const vars = currency.codec.toVariables(answer, ctx);
        expect(currency.codec.fromVariables(vars, ctx)).toEqual(answer);
      }),
      { numRuns: 300 },
    );
  });

  it('parse never throws on arbitrary garbage', () => {
    const ctx = ctxFor(base);
    fc.assert(
      fc.property(fc.anything(), (raw) => {
        const result = currency.codec.parse(raw, ctx);
        expect(typeof result.ok).toBe('boolean');
      }),
      { numRuns: 500 },
    );
  });
});

