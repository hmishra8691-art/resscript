/**
 * `date` — `Q : date`, with a range mode that emits `Q_from` / `Q_to` (F §10's catalogue line).
 *
 * Two decisions carry this file:
 *
 *  1. **Calendar validity is a pure arithmetic check, never `Date` parsing.** JavaScript's
 *     `new Date('2026-02-30')` does not reject the 30th of February — it silently rolls over to
 *     March 2nd, which is the worst possible behaviour for a codec: a forged or fat-fingered
 *     payload becomes a *different, plausible* date, and no export can tell it from a real
 *     answer. (`Date.parse` adds timezone traps on top: the same string is a different instant
 *     depending on the host's zone.) A date-only value has no timezone and no instant; it is a
 *     triple of integers with month-length rules, so it is validated as one.
 *  2. **The stored form is ISO 8601 `YYYY-MM-DD`, and comparisons are string comparisons.**
 *     Fixed-width ISO dates order lexicographically exactly as they order chronologically, so
 *     bounds checks and the from ≤ to rule need no parsing at all — which also means they cannot
 *     disagree with the calendar check about what a date "is".
 *
 * Range mode declares its two ends via `ctx.name.suffixed('from'/'to')` — the same `meta`-part
 * mechanism as nps's band, and it has the same composition consequence (see `meta.composable`).
 */

import { asPlainObject, err, ok, type CodecError, type ResponseCodec, type Result } from '../../contract/codec.js';
import { KIT_MESSAGE_KEYS, type ValidationIssue } from '../../contract/validate.js';
import type { PluginDiagnostic } from '../../contract/diagnostics.js';
import type { QuestionTypePluginCore } from '../../contract/plugin.js';
import type { A11yContract } from '../../contract/a11y.js';
import type { JsonSchema } from '../../json-schema.js';
import type { VariableDeclaration } from '../../contract/variables.js';

export const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function daysInMonth(year: number, month: number): number {
  switch (month) {
    case 1: case 3: case 5: case 7: case 8: case 10: case 12:
      return 31;
    case 4: case 6: case 9: case 11:
      return 30;
    case 2: {
      // The full Gregorian rule, not just %4: 1900-02-29 did not happen, 2000-02-29 did, and a
      // birth-date question meets both.
      const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
      return leap ? 29 : 28;
    }
    default:
      return 0;
  }
}

/** Is `text` a real Gregorian calendar date in ISO `YYYY-MM-DD` form? Pure, no `Date` anywhere. */
export function isCalendarDate(text: string): boolean {
  if (!ISO_DATE_PATTERN.test(text)) return false;
  const year = Number(text.slice(0, 4));
  const month = Number(text.slice(5, 7));
  const day = Number(text.slice(8, 10));
  if (month < 1 || month > 12) return false;
  return day >= 1 && day <= daysInMonth(year, month);
}

export interface DateConfig {
  readonly mode: 'date' | 'range';
  /** Inclusive ISO bounds, shared by both ends in range mode. */
  readonly min?: string;
  readonly max?: string;
}

export interface DateAnswer {
  /** The single-mode value. Always present, `null` when blank or in range mode — see
   * `single-select/core.ts` on why "absent" may not be a second empty state. */
  readonly date: string | null;
  readonly from: string | null;
  readonly to: string | null;
}

export const DATE_CONFIG_SCHEMA: JsonSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  required: ['mode'],
  properties: {
    mode: { enum: ['date', 'range'], default: 'date' },
    // The pattern gates shape only; calendar validity (2026-02-30) is `staticChecks`' job,
    // because a JSON-Schema pattern cannot count the days of February.
    min: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
    max: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
  },
};

const EMPTY: DateAnswer = { date: null, from: null, to: null };

function readDateField(raw: unknown, path: string): Result<string | null, CodecError> {
  if (raw === null || raw === undefined) return ok(null);
  if (typeof raw !== 'string') return err({ code: 'shape', message: 'expected an ISO date string', path });
  // Length first: a megabyte string fails on one comparison, before the regex walks it.
  if (raw.length !== 10 || !ISO_DATE_PATTERN.test(raw)) {
    return err({ code: 'shape', message: 'expected YYYY-MM-DD', path });
  }
  if (!isCalendarDate(raw)) {
    // Right shape, not a value that exists in the domain of dates — `domain`, matching the
    // unknown-option-code case. Never rolled forward; see the file header.
    return err({ code: 'domain', message: 'not a real calendar date', path });
  }
  return ok(raw);
}

const codec: ResponseCodec<DateConfig, DateAnswer> = {
  parse(raw, ctx) {
    if (raw === null || raw === undefined) return ok(EMPTY);
    const record = asPlainObject(raw);
    if (record === undefined) return err({ code: 'shape', message: 'expected an object' });
    // The other mode's fields are forced to null rather than echoed: `toVariables` writes only
    // the declared names anyway, and an Answer carrying an un-storable field would fail its own
    // round-trip (fromVariables could never bring it back).
    if (ctx.config.mode === 'date') {
      const date = readDateField(record['date'], '/date');
      if (!date.ok) return date;
      return ok({ date: date.value, from: null, to: null });
    }
    const from = readDateField(record['from'], '/from');
    if (!from.ok) return from;
    const to = readDateField(record['to'], '/to');
    if (!to.ok) return to;
    // from > to is accepted here and reported by `validate`: it is a respondent mistake the UI
    // allows mid-entry (they pick the end first), not a forged payload.
    return ok({ date: null, from: from.value, to: to.value });
  },

  toVariables(answer, ctx) {
    if (ctx.config.mode === 'date') return { [ctx.name.self()]: answer.date };
    return {
      [ctx.name.suffixed('from')]: answer.from,
      [ctx.name.suffixed('to')]: answer.to,
    };
  },

  fromVariables(vars, ctx) {
    const readBack = (value: unknown): string | null =>
      typeof value === 'string' && isCalendarDate(value) ? value : null;
    if (ctx.config.mode === 'date') {
      return { date: readBack(vars[ctx.name.self()]), from: null, to: null };
    }
    return {
      date: null,
      from: readBack(vars[ctx.name.suffixed('from')]),
      to: readBack(vars[ctx.name.suffixed('to')]),
    };
  },

  emptyAnswer: () => EMPTY,
};

export const dateCore: QuestionTypePluginCore<DateConfig, DateAnswer> = {
  meta: {
    id: 'date',
    version: '1.0.0',
    displayName: 'qt.date.name',
    description: 'qt.date.desc',
    // The 'numeric' family: an ordered scalar the respondent types, grouped with the other
    // data-entry types in the palette. There is no date-specific category and inventing one is
    // not this plugin's call — `PLUGIN_CATEGORIES` is a closed list.
    category: 'numeric',
    icon: 'calendar',
    entitlementKey: null,
    trust: 'first_party',
    /**
     * Not composable, and — like nps — this is a contract limitation stated honestly rather
     * than a product decision: range mode names its ends `Q_from`/`Q_to` through the suffix
     * part, and there is no schema §4 part that names `Q5r3_from`, so the scoped namer throws
     * `compose_unnameable_part`. Single-date mode *would* compose (it is one self-named
     * variable), but `composable` is static metadata read without loading the config, so it has
     * to be false until either the part model gains a composite (row + suffix) form or the
     * modes split into two plugins.
     */
    composable: false,
    emitsData: true,
  },

  configSchema: DATE_CONFIG_SCHEMA,

  defaultConfig: () => ({ mode: 'date' }),

  declareVariables(ctx) {
    const config = ctx.config;
    const shared = {
      pii: ctx.flags.pii,
      persist: true,
      // `scale`: dates are differenced and averaged (tenure, recency), which is the measure
      // level that decides what SPSS offers over the column.
      analysis: { measure: 'scale' as const, batteryRef: ctx.ref },
    };
    if (config.mode === 'date') {
      const declaration: VariableDeclaration = {
        name: ctx.name.self(),
        kind: 'response',
        type: 'date',
        source: { part: { kind: 'self' } },
        export: {
          include: !ctx.flags.excludeFromExport,
          column: ctx.name.self(),
          labelKey: `${ctx.ref}.label`,
          order: 0,
        },
        ...shared,
        analysis: { measure: 'scale' },
      };
      return [declaration];
    }
    // Two ends, two columns, one battery. Suffixes over the `meta` part, exactly like nps's
    // band, so a rename recomputes both names and interop files them as schema `suffix` parts.
    return (['from', 'to'] as const).map((end, index): VariableDeclaration => ({
      name: ctx.name.suffixed(end),
      kind: 'response',
      type: 'date',
      source: { part: { kind: 'meta', label: `range_${end}`, suffix: end } },
      export: {
        include: !ctx.flags.excludeFromExport,
        column: ctx.name.suffixed(end),
        labelKey: `${ctx.ref}.${end}.label`,
        // A constant per end, never a loop artifact: `from` is column 0 and `to` is column 1 for
        // the life of the study.
        order: index,
      },
      ...shared,
    }));
  },

  validate(ctx) {
    const issues: ValidationIssue[] = [];
    const config = ctx.question.config;
    const boundsIssue = (value: string, variableName: string | null): ValidationIssue | null => {
      if (
        (config.min !== undefined && value < config.min) ||
        (config.max !== undefined && value > config.max)
      ) {
        return {
          variableName,
          messageKey: KIT_MESSAGE_KEYS.outOfRange,
          params: {
            ...(config.min === undefined ? {} : { min: config.min }),
            ...(config.max === undefined ? {} : { max: config.max }),
          },
          severity: 'error',
        };
      }
      return null;
    };
    // Defensive; the codec rejects malformed dates first (ADR-004 runs both on the server). The
    // renderer stores raw keystrokes, though, so `on_change` validation legitimately sees a
    // half-typed "2026-0" here. `err.invalid_option` is the reuse: "not a value this question
    // offers" is the closest key the bundle guarantees, and this plugin may not add keys.
    const checkOne = (
      value: string | null,
      variableName: string | null,
    ): ValidationIssue | null => {
      if (value === null) return null;
      if (typeof value !== 'string' || !isCalendarDate(value)) {
        return {
          variableName,
          messageKey: KIT_MESSAGE_KEYS.invalidOption,
          severity: 'error',
        };
      }
      return boundsIssue(value, variableName);
    };

    if (config.mode === 'date') {
      const date = ctx.value?.date ?? null;
      const selfName = ctx.question.variables.self ?? null;
      if (ctx.required && date === null) {
        return [{ variableName: selfName, messageKey: KIT_MESSAGE_KEYS.required, severity: 'error' }];
      }
      const issue = checkOne(date, selfName);
      return issue === null ? issues : [issue];
    }

    // Range. The two ends were declared through `meta` parts, which `indexVariables` files
    // under `meta:<suffix>` — never string-build `Q1_from` here (F §1.2).
    const from = ctx.value?.from ?? null;
    const to = ctx.value?.to ?? null;
    const fromName = ctx.question.variables.byRow['meta:from'] ?? null;
    const toName = ctx.question.variables.byRow['meta:to'] ?? null;

    if (ctx.required && from === null && to === null) {
      // Untouched: one message on the question, not one per end.
      return [{ variableName: null, messageKey: KIT_MESSAGE_KEYS.required, severity: 'error' }];
    }
    if (ctx.required && from === null) {
      issues.push({ variableName: fromName, messageKey: KIT_MESSAGE_KEYS.required, severity: 'error' });
    }
    if (ctx.required && to === null) {
      issues.push({ variableName: toName, messageKey: KIT_MESSAGE_KEYS.required, severity: 'error' });
    }
    const fromIssue = checkOne(from, fromName);
    if (fromIssue !== null) issues.push(fromIssue);
    const toIssue = checkOne(to, toName);
    if (toIssue !== null) issues.push(toIssue);

    // from ≤ to, only once both ends are individually clean — an order error over a date that is
    // itself invalid would have the respondent fixing the wrong thing first. Lexicographic
    // comparison is chronological for fixed-width ISO dates. The reuse of `err.out_of_range` on
    // the `to` end (with `min` = the from date) is deliberate: "this date is too early" is
    // exactly the out-of-range message, and the key set is closed.
    if (
      from !== null &&
      to !== null &&
      fromIssue === null &&
      toIssue === null &&
      isCalendarDate(from) &&
      isCalendarDate(to) &&
      from > to
    ) {
      issues.push({
        variableName: toName,
        messageKey: KIT_MESSAGE_KEYS.outOfRange,
        params: { min: from },
        severity: 'error',
      });
    }
    return issues;
  },

  codec,

  exportContribution: {
    columnLabel: (declaration, ctx) => {
      const part = declaration.source.part;
      const label = ctx.t(ctx.question.label);
      // The suffix is the provenance: `from`/`to` are this plugin's only meta parts.
      return part.kind === 'meta' ? `${label} — ${part.suffix}` : label;
    },
    // A date column has no value labels.
    valueLabels: () => [],
  },

  a11y: {
    /**
     * A text box with a declared format, not `<input type="date">`, for two reasons that are
     * both contract-level: the native date input maps to *no* ARIA role (so this contract could
     * not name a role the harness can assert), and its picker UI is the browser's — unlocalizable
     * per-survey, untestable for the RTL and touch-target rules everything else here is held to.
     * The design layer (P1-09) may progressively enhance; the contract floor is the textbox.
     */
    interactionModel: 'textbox',
    requiredRoles: ['textbox'],
    keys: ['Tab'],
    minTouchTargetPx: 44,
    pointerDependent: false,
    rtlSafe: true,
  } satisfies A11yContract,

  staticChecks(ctx) {
    const out: PluginDiagnostic[] = [];
    const { min, max } = ctx.config;
    for (const [bound, value] of [['min', min], ['max', max]] as const) {
      if (value !== undefined && !isCalendarDate(value)) {
        out.push({
          code: 'invalid_bound',
          severity: 'error',
          message: `${bound} (${JSON.stringify(value)}) is not a real calendar date`,
          path: `/config/${bound}`,
        });
      }
    }
    if (
      min !== undefined &&
      max !== undefined &&
      isCalendarDate(min) &&
      isCalendarDate(max) &&
      min > max
    ) {
      out.push({
        code: 'impossible_bounds',
        severity: 'error',
        message: `min (${min}) is after max (${max}), so no answer can validate`,
        path: '/config/min',
      });
    }
    if (ctx.options.length > 0) {
      out.push({
        code: 'options_ignored',
        severity: 'warning',
        message: 'date has no options; authored options are ignored',
        path: '/options',
      });
    }
    return out;
  },
};
