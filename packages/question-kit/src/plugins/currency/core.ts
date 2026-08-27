/**
 * `currency` — an amount of money: `Q : number` plus a `Q_cur : text` companion (F §10, P2-05).
 *
 * **Why the currency code is a SEPARATE variable and not baked into the label.** A `numeric` box
 * with a "€" prefix stores a bare number, and the currency lives only in the question text. That is
 * fine until any of the three things that always happen:
 *
 *  - a multi-market study fields the same instrument in six countries, and the analyst receives six
 *    files of numbers whose units are recorded nowhere machine-readable;
 *  - a respondent in a multi-currency market is offered a choice, and the answer is meaningless
 *    without which one they picked;
 *  - someone converts to a common currency two years later and has to reconstruct the unit from the
 *    survey's translated label.
 *
 * So the amount and its unit travel together. The companion is emitted for a FIXED currency too,
 * not only a respondent-chosen one: the point is that the file is self-describing, and a column
 * that exists only sometimes is one the analyst's script cannot rely on.
 *
 * **`minor_units` is the grid, and it comes from the currency, not from the author.** JPY has no
 * minor unit, KWD has three, most have two. An author who sets "2 decimals" for a yen study has
 * created a question that accepts ¥100.25 — an amount that cannot exist. The decimals are therefore
 * derived from the currency code through `MINOR_UNITS`, and `staticChecks` reports a currency the
 * table does not know rather than silently assuming two.
 *
 * The numeric machinery is `numeric`'s, imported rather than reimplemented (`readGridNumber`,
 * `onDecimalGrid`) so "what is an acceptable number" has one definition — two copies drift on
 * exactly the payload nobody hand-tests.
 */

import { asPlainObject, err, ok, type ResponseCodec } from '../../contract/codec.js';
import { KIT_MESSAGE_KEYS, type ValidationIssue } from '../../contract/validate.js';
import type { PluginDiagnostic } from '../../contract/diagnostics.js';
import type { QuestionTypePluginCore } from '../../contract/plugin.js';
import type { A11yContract } from '../../contract/a11y.js';
import type { JsonSchema } from '../../json-schema.js';
import type { VariableDeclaration } from '../../contract/variables.js';
import { MAX_NUMERIC_MAGNITUDE, onDecimalGrid, readGridNumber } from '../numeric/core.js';

/**
 * Minor-unit exponents for the currencies a survey is realistically fielded in (ISO 4217).
 *
 * Deliberately a small table rather than a dependency: `packages/question-kit` ships to every
 * respondent, and pulling a full ISO 4217 dataset in for an exponent would cost more than the
 * feature. A currency absent from here is a `staticChecks` error, not a silent default of 2 — see
 * the header on why assuming 2 for JPY produces an impossible amount.
 */
export const MINOR_UNITS: { readonly [code: string]: number } = {
  AED: 2, AUD: 2, BHD: 3, BRL: 2, CAD: 2, CHF: 2, CLP: 0, CNY: 2, COP: 2, CZK: 2,
  DKK: 2, EUR: 2, GBP: 2, HKD: 2, HUF: 2, IDR: 2, ILS: 2, INR: 2, ISK: 0, JOD: 3,
  JPY: 0, KRW: 0, KWD: 3, MXN: 2, MYR: 2, NOK: 2, NZD: 2, OMR: 3, PHP: 2, PLN: 2,
  RON: 2, RUB: 2, SAR: 2, SEK: 2, SGD: 2, THB: 2, TND: 3, TRY: 2, TWD: 2, USD: 2,
  VND: 0, ZAR: 2,
};

/** The decimal grid a currency's amounts live on, or `undefined` for an unknown code. */
export function minorUnitsOf(code: string): number | undefined {
  return MINOR_UNITS[code.toUpperCase()];
}

export interface CurrencyConfig {
  /**
   * ISO 4217 code. When `allow_choice` lists codes this is the DEFAULT; otherwise it is the fixed
   * currency for every respondent.
   */
  readonly currency: string;
  /**
   * Codes the respondent may choose between. Absent or empty means the currency is fixed.
   *
   * The multi-currency market case: a study in Switzerland offering CHF and EUR.
   */
  readonly allow_choice?: readonly string[];
  readonly min?: number;
  readonly max?: number;
}

export interface CurrencyAnswer {
  /** `null` when blank. Always present, so the codec has exactly one empty state. */
  readonly amount: number | null;
  /**
   * The ISO code this amount is in. `null` only when the amount is blank — an amount without a
   * unit is the defect this plugin exists to prevent, so the codec refuses that pairing.
   */
  readonly currency: string | null;
}

export const CURRENCY_CONFIG_SCHEMA: JsonSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  required: ['currency'],
  properties: {
    // Pattern, not an enum of the table's keys: an unknown code is a `staticChecks` error with a
    // readable message, which is more useful to an author than a schema rejection listing 42 codes.
    currency: { type: 'string', pattern: '^[A-Za-z]{3}$' },
    allow_choice: { type: 'array', items: { type: 'string', pattern: '^[A-Za-z]{3}$' } },
    min: { type: 'number', minimum: 0 },
    max: { type: 'number' },
  },
};

/** The codes a respondent may answer in: the choice list when present, else the fixed one. */
export function allowedCurrencies(config: CurrencyConfig): readonly string[] {
  const choice = config.allow_choice ?? [];
  return choice.length > 0
    ? choice.map((code) => code.toUpperCase())
    : [config.currency.toUpperCase()];
}

const codec: ResponseCodec<CurrencyConfig, CurrencyAnswer> = {
  parse(raw, ctx) {
    const empty = { amount: null, currency: null };
    if (raw === null || raw === undefined) return ok(empty);
    const record = asPlainObject(raw);
    if (record === undefined) return err({ code: 'shape', message: 'expected an object' });

    const allowed = allowedCurrencies(ctx.config);
    const rawCurrency = record['currency'];
    let currency: string | null = null;
    if (typeof rawCurrency === 'string' && rawCurrency !== '') {
      const upper = rawCurrency.toUpperCase();
      if (!allowed.includes(upper)) {
        // A code the question does not offer is a forged payload: the UI renders only the allowed
        // list. Accepting it would put an amount in the file labelled with a unit the study never
        // fielded.
        return err({ code: 'unknown_key', message: `currency ${upper} is not offered`, path: '/currency' });
      }
      currency = upper;
    } else if (rawCurrency !== null && rawCurrency !== undefined) {
      return err({ code: 'shape', message: 'currency must be a string', path: '/currency' });
    }

    // The grid comes from the currency the answer is actually in, defaulting to the configured one
    // — a KWD amount is checked to 3 decimals even in a study whose default is EUR.
    const decimals = minorUnitsOf(currency ?? ctx.config.currency) ?? 2;
    const read = readGridNumber(record['amount'], decimals, '/amount');
    if (!read.ok) return read;
    const amount = read.value;

    if (amount !== null && currency === null) {
      // The pairing this plugin exists to guarantee. An amount with no unit is exactly the datum
      // the header argues against, so it is refused rather than defaulted — defaulting would put a
      // guessed unit in the file and look identical to a real one.
      return err({ code: 'shape', message: 'an amount requires a currency', path: '/currency' });
    }
    // A currency with no amount is harmless (the respondent picked a unit and has not typed yet)
    // and is normalized away so the empty answer has one representation.
    if (amount === null) return ok(empty);
    return ok({ amount, currency });
  },

  toVariables(answer, ctx) {
    return {
      [ctx.name.self()]: answer.amount,
      [ctx.name.suffixed('cur')]: answer.currency,
    };
  },

  fromVariables(vars, ctx) {
    const amount = vars[ctx.name.self()];
    const currency = vars[ctx.name.suffixed('cur')];
    if (typeof amount !== 'number' || !Number.isFinite(amount)) {
      return { amount: null, currency: null };
    }
    return {
      amount,
      currency: typeof currency === 'string' && currency !== '' ? currency : null,
    };
  },

  emptyAnswer: () => ({ amount: null, currency: null }),
};

export const currencyCore: QuestionTypePluginCore<CurrencyConfig, CurrencyAnswer> = {
  meta: {
    id: 'currency',
    version: '1.0.0',
    displayName: 'qt.currency.name',
    description: 'qt.currency.desc',
    category: 'numeric',
    icon: 'coins',
    entitlementKey: null,
    trust: 'first_party',
    /**
     * NOT composable, and the compose machinery is the authority on why rather than my judgement.
     *
     * A currency cell inside a matrix would declare two names per cell: the amount at the cell
     * itself (`P1r1`) and the code as a suffix on it (`P1r1_cur`). The name is inside its scope, so
     * rule 5 is satisfied — but `declareVariablesFor` refuses it anyway with
     * `compose_unnameable_part`: "a composed child in a row scope cannot name the suffix 'cur': no
     * schema §4 variable part describes it, so the name could not survive a round-trip through the
     * variable registry."
     *
     * That is the correct refusal and it is a deeper constraint than naming. Schema §4's part union
     * has no arm for "a suffix on a cell", so the variable could be declared but never rebuilt from
     * the registry — the column would exist in an export and be unreconstructable from the survey
     * model. A currency cell in a matrix therefore needs a schema change (a `cell_suffix` part), not
     * a plugin flag, and claiming `composable: true` here would let the studio offer a
     * configuration that fails at publish with a message about variable parts.
     */
    composable: false,
    emitsData: true,
  },

  configSchema: CURRENCY_CONFIG_SCHEMA,

  defaultConfig: () => ({ currency: 'USD' }),

  declareVariables(ctx) {
    const config = ctx.config;
    const decimals = minorUnitsOf(config.currency) ?? 2;
    const amount: VariableDeclaration = {
      name: ctx.name.self(),
      kind: 'response',
      type: 'number',
      numericDomain: {
        ...(config.min === undefined ? {} : { min: config.min }),
        ...(config.max === undefined ? {} : { max: config.max }),
        decimals,
      },
      source: { part: { kind: 'self' } },
      export: {
        include: !ctx.flags.excludeFromExport,
        column: ctx.name.self(),
        labelKey: `${ctx.ref}.label`,
        order: 0,
      },
      pii: ctx.flags.pii,
      persist: true,
      // `scale`: money is averaged and differenced.
      analysis: { measure: 'scale' },
    };
    const unit: VariableDeclaration = {
      name: ctx.name.suffixed('cur'),
      kind: 'response',
      type: 'text',
      // A `meta` part: schema's `{ kind: 'suffix' }` component plus the human provenance the
      // studio shows. There is no `companion` part kind — `suffixed` + `meta` is the contract's
      // way of naming a second variable off one question, the same shape `nps` uses for its band.
      source: { part: { kind: 'meta', label: 'currency_code', suffix: 'cur' } },
      export: {
        include: !ctx.flags.excludeFromExport,
        column: ctx.name.suffixed('cur'),
        labelKey: `${ctx.ref}.currency`,
        order: 1,
      },
      // Never pii, even when the amount is flagged: an ISO currency code identifies a market, not
      // a person, and flagging it would strip the unit out of a pii-redacted export and leave the
      // amounts unitless — the exact failure this companion exists to prevent.
      pii: false,
      persist: true,
      // `nominal`: a currency code is a category with no order. Declaring `scale` would offer an
      // analyst the mean of a set of ISO codes.
      analysis: { measure: 'nominal' },
    };
    return [amount, unit];
  },

  validate(ctx) {
    const issues: ValidationIssue[] = [];
    const amount = ctx.value?.amount ?? null;
    const currency = ctx.value?.currency ?? null;
    const selfName = ctx.question.variables.self ?? null;
    const config = ctx.question.config;
    const decimals = minorUnitsOf(currency ?? config.currency) ?? 2;

    if (ctx.required && amount === null) {
      return [{ variableName: selfName, messageKey: KIT_MESSAGE_KEYS.required, severity: 'error' }];
    }
    if (amount === null) return issues;

    // Defensive; the codec rejects these first (see `numeric/core.ts` on why a grid violation is
    // `err.not_numeric` rather than `err.out_of_range`).
    if (
      typeof amount !== 'number' ||
      !Number.isFinite(amount) ||
      Math.abs(amount) > MAX_NUMERIC_MAGNITUDE ||
      !onDecimalGrid(amount, decimals)
    ) {
      return [
        {
          variableName: selfName,
          messageKey: KIT_MESSAGE_KEYS.notNumeric,
          params: { decimals },
          severity: 'error',
        },
      ];
    }
    if (
      (config.min !== undefined && amount < config.min) ||
      (config.max !== undefined && amount > config.max)
    ) {
      issues.push({
        variableName: selfName,
        messageKey: KIT_MESSAGE_KEYS.outOfRange,
        params: {
          ...(config.min === undefined ? {} : { min: config.min }),
          ...(config.max === undefined ? {} : { max: config.max }),
        },
        severity: 'error',
      });
    }
    // Defensive, same reasoning: the codec already refuses an amount with no unit.
    if (currency === null || !allowedCurrencies(config).includes(currency)) {
      issues.push({
        variableName: selfName,
        messageKey: KIT_MESSAGE_KEYS.invalidOption,
        severity: 'error',
      });
    }
    return issues;
  },

  codec,

  exportContribution: {
    columnLabel: (declaration, ctx) =>
      declaration.source.part.kind === 'meta'
        ? `${ctx.t(ctx.question.label)} — currency`
        : ctx.t(ctx.question.label),
    // The amount column has no value labels. The currency column could label each code with its
    // name, and deliberately does not: an ISO code is already the analyst's canonical identifier,
    // and a localized name would make the same file read differently per language.
    valueLabels: () => [],
  },

  a11y: {
    interactionModel: 'spinbutton',
    requiredRoles: ['spinbutton'],
    keys: ['Tab', 'ArrowUp', 'ArrowDown'],
    minTouchTargetPx: 44,
    pointerDependent: false,
    rtlSafe: true,
  } satisfies A11yContract,

  staticChecks(ctx) {
    const out: PluginDiagnostic[] = [];
    const config = ctx.config;
    const codes = [config.currency, ...(config.allow_choice ?? [])];

    for (const [i, code] of codes.entries()) {
      if (minorUnitsOf(code) === undefined) {
        out.push({
          code: 'unknown_currency',
          severity: 'error',
          message:
            `currency ${code} is not in the minor-unit table, so the number of decimals its ` +
            'amounts allow is unknown — assuming 2 would accept impossible amounts in a ' +
            'zero-decimal currency',
          path: i === 0 ? '/config/currency' : `/config/allow_choice/${String(i - 1)}`,
        });
      }
    }
    const choice = config.allow_choice ?? [];
    if (choice.length > 0 && !allowedCurrencies(config).includes(config.currency.toUpperCase())) {
      out.push({
        code: 'default_not_offered',
        severity: 'error',
        message: `the default currency ${config.currency} is not in allow_choice`,
        path: '/config/currency',
      });
    }
    // Mixed minor units in one choice list means one column holding amounts on two different
    // grids. It is legitimate (a CHF/JPY study is a real thing) but the analyst must know.
    const units = new Set(
      allowedCurrencies(config)
        .map((code) => minorUnitsOf(code))
        .filter((u): u is number => u !== undefined),
    );
    if (units.size > 1) {
      out.push({
        code: 'mixed_minor_units',
        severity: 'warning',
        message:
          'the offered currencies have different minor units, so this column holds amounts on ' +
          'more than one decimal grid — correct, but the analyst must read the currency column',
        path: '/config/allow_choice',
      });
    }
    if (
      config.min !== undefined &&
      config.max !== undefined &&
      config.min > config.max
    ) {
      out.push({
        code: 'impossible_bounds',
        severity: 'error',
        message: `min (${config.min}) exceeds max (${config.max}), so no answer can validate`,
        path: '/config/min',
      });
    }
    if (ctx.options.length > 0) {
      out.push({
        code: 'options_ignored',
        severity: 'warning',
        message: 'currency declares its domain in config; authored options are ignored',
        path: '/options',
      });
    }
    return out;
  },
};
