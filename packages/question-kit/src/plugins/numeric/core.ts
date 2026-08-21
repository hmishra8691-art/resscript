/**
 * `numeric` — one box, one number: `Q : number` with a config-declared domain (F §10).
 *
 * The plugin looks trivial next to the fan-outs, and the two decisions worth stating are both
 * about *rejection*, because a numeric column is where silent coercion does the most damage:
 *
 *  1. **The codec rejects off-grid decimals; it never rounds.** A payload carrying `7.25` into a
 *     0-decimal question is either a forged request or a UI bug — the renderer's input steps on
 *     the declared grid — and rounding it would store a number the respondent never entered.
 *     Rounding is also unfalsifiable after the fact: the stored `7` looks exactly like a real
 *     answer, and no export can tell the difference. The reject uses code `'range'`, because
 *     `decimals` is part of `DeclaredNumericDomain` — the value is the right kind of thing and
 *     outside the declared numeric domain, which is precisely what `contract/codec.ts` says
 *     `'range'` means. (`'shape'` stays reserved for "not a finite number at all", matching nps.)
 *  2. **Author bounds are validation, not codec rejects.** nps rejects an out-of-range score in
 *     the codec because 0–10 is intrinsic to the type; here `min`/`max` are authored soft bounds,
 *     and a respondent typing 150 into an "age" box is a respondent mistake, not an attacker.
 *     Rejecting the page would lose their other answers; accepting and reporting
 *     `err.out_of_range` from `validate` shows them the message next to the box instead.
 */

import { asPlainObject, err, ok, type CodecError, type ResponseCodec, type Result } from '../../contract/codec.js';
import { KIT_MESSAGE_KEYS, type ValidationIssue } from '../../contract/validate.js';
import type { PluginDiagnostic } from '../../contract/diagnostics.js';
import type { QuestionTypePluginCore } from '../../contract/plugin.js';
import type { A11yContract } from '../../contract/a11y.js';
import type { JsonSchema } from '../../json-schema.js';
import type { VariableDeclaration } from '../../contract/variables.js';

/**
 * The magnitude ceiling for any stored number, applied before the decimal-grid check.
 *
 * Above `Number.MAX_SAFE_INTEGER` a double cannot even represent adjacent integers, so "how many
 * decimals does this value have" stops being answerable — `1e308 * 100` is `Infinity` and every
 * arithmetic path downstream (sum checks, SPSS F-format widths, Parquet decimals) degrades
 * silently. No real instrument measures anything at 2^53; a payload up there is forged.
 */
export const MAX_NUMERIC_MAGNITUDE = Number.MAX_SAFE_INTEGER;

/**
 * Is `value` exactly representable on the declared decimal grid?
 *
 * Round-trip through the grid rather than string inspection: `Math.round(v * 10^d) / 10^d === v`
 * asks "is this value the nearest double to some grid point", which is the only question that
 * makes sense for doubles. String parsing gets `1e-7` wrong; naive `Number.isInteger(v * 100)`
 * gets `1.15` wrong (`1.15 * 100 === 114.99999999999999`, yet 1.15 *is* the 2-decimal grid point).
 * Callers must bound the magnitude first (`MAX_NUMERIC_MAGNITUDE`) so the scaling stays finite.
 */
export function onDecimalGrid(value: number, decimals: number): boolean {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor === value;
}

/**
 * Read one untrusted numeric field: finite, bounded, on the declared grid.
 *
 * Shared with `numeric_list` (which reads one of these per row) so "what is an acceptable
 * number" has one definition — two copies of this check would drift on exactly the payload
 * nobody hand-tests, which is the hostile one.
 */
export function readGridNumber(
  raw: unknown,
  decimals: number,
  path: string,
): Result<number | null, CodecError> {
  if (raw === null || raw === undefined) return ok(null);
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    // NaN/Infinity land here too: JSON cannot carry them, so their presence means an in-process
    // forgery rather than a respondent, and 'shape' is the honest label.
    return err({ code: 'shape', message: 'expected a finite number', path });
  }
  if (Math.abs(raw) > MAX_NUMERIC_MAGNITUDE) {
    return err({ code: 'range', message: 'magnitude exceeds the storable range', path });
  }
  if (!onDecimalGrid(raw, decimals)) {
    return err({ code: 'range', message: `more than ${decimals} decimals`, path });
  }
  return ok(raw);
}

export interface NumericUnit {
  readonly labelKey: string;
  /**
   * Logical, not physical: `prefix` renders before the input in reading order and `suffix`
   * after, whichever direction the page reads. "€ before the number" survives RTL because the
   * renderer never says left or right (F §8).
   */
  readonly position: 'prefix' | 'suffix';
}

export interface NumericConfig {
  readonly display: 'input' | 'stepper';
  /** The data grid. `0` = integers. Distinct from `step`, which is a UI increment only. */
  readonly decimals: number;
  readonly min?: number;
  readonly max?: number;
  /** Stepper/arrow increment. Never a validation rule: a typed value only owes the grid. */
  readonly step?: number;
  readonly unit?: NumericUnit;
}

export interface NumericAnswer {
  /** Always present, `null` when blank — `exactOptionalPropertyTypes` makes "absent" a second
   * empty state, and a codec with two empty answers fails its own round-trip. */
  readonly value: number | null;
}

export const NUMERIC_CONFIG_SCHEMA: JsonSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  required: ['display', 'decimals'],
  properties: {
    display: { enum: ['input', 'stepper'], default: 'input' },
    // Capped at 6: beyond that the grid check runs out of double precision for realistic
    // magnitudes, and no survey measures anything at nano-resolution.
    decimals: { type: 'integer', minimum: 0, maximum: 6, default: 0 },
    min: { type: 'number' },
    max: { type: 'number' },
    step: { type: 'number', exclusiveMinimum: 0 },
    unit: {
      type: 'object',
      additionalProperties: false,
      required: ['labelKey', 'position'],
      properties: {
        labelKey: { type: 'string', minLength: 1 },
        position: { enum: ['prefix', 'suffix'] },
      },
    },
  },
};

const codec: ResponseCodec<NumericConfig, NumericAnswer> = {
  parse(raw, ctx) {
    if (raw === null || raw === undefined) return ok({ value: null });
    const record = asPlainObject(raw);
    if (record === undefined) return err({ code: 'shape', message: 'expected an object' });
    const read = readGridNumber(record['value'], ctx.config.decimals, '/value');
    if (!read.ok) return read;
    return ok({ value: read.value });
  },

  toVariables(answer, ctx) {
    return { [ctx.name.self()]: answer.value };
  },

  fromVariables(vars, ctx) {
    const value = vars[ctx.name.self()];
    return { value: typeof value === 'number' && Number.isFinite(value) ? value : null };
  },

  emptyAnswer: () => ({ value: null }),
};

export const numericCore: QuestionTypePluginCore<NumericConfig, NumericAnswer> = {
  meta: {
    id: 'numeric',
    version: '1.0.0',
    displayName: 'qt.numeric.name',
    description: 'qt.numeric.desc',
    category: 'numeric',
    icon: 'hash',
    entitlementKey: null,
    trust: 'first_party',
    // Composable, and it is the plugin composition exists for: a numeric row in a mixed matrix
    // ("How many? / How much?") is one self-named variable, so the scoped namer covers it
    // completely. No companions, no fan-out, nothing a cell scope cannot name.
    composable: true,
    emitsData: true,
  },

  configSchema: NUMERIC_CONFIG_SCHEMA,

  defaultConfig: () => ({ display: 'input', decimals: 0 }),

  declareVariables(ctx) {
    const config = ctx.config;
    const declaration: VariableDeclaration = {
      name: ctx.name.self(),
      kind: 'response',
      type: 'number',
      numericDomain: {
        ...(config.min === undefined ? {} : { min: config.min }),
        ...(config.max === undefined ? {} : { max: config.max }),
        decimals: config.decimals,
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
      // `scale`: a typed-in quantity is averaged and differenced, which is the measure level that
      // decides which analyses SPSS offers over the column.
      analysis: { measure: 'scale' },
    };
    return [declaration];
  },

  validate(ctx) {
    const issues: ValidationIssue[] = [];
    const value = ctx.value?.value ?? null;
    const selfName = ctx.question.variables.self ?? null;
    const config = ctx.question.config;

    if (ctx.required && value === null) {
      return [{ variableName: selfName, messageKey: KIT_MESSAGE_KEYS.required, severity: 'error' }];
    }
    if (value === null) return issues;

    // Defensive: reachable only via a tampered or stale Answer — the codec rejects these first
    // (ADR-004 makes the server re-run both). `err.not_numeric` rather than `err.out_of_range`
    // for the grid violation, because the respondent-facing fix is "enter a valid number", not
    // "enter a smaller one".
    if (
      typeof value !== 'number' ||
      !Number.isFinite(value) ||
      Math.abs(value) > MAX_NUMERIC_MAGNITUDE ||
      !onDecimalGrid(value, config.decimals)
    ) {
      return [
        {
          variableName: selfName,
          messageKey: KIT_MESSAGE_KEYS.notNumeric,
          params: { decimals: config.decimals },
          severity: 'error',
        },
      ];
    }

    if (
      (config.min !== undefined && value < config.min) ||
      (config.max !== undefined && value > config.max)
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
    return issues;
  },

  codec,

  exportContribution: {
    columnLabel: (_declaration, ctx) => ctx.t(ctx.question.label),
    // A numeric column has no value labels; fabricating any would put fake categories in SPSS.
    valueLabels: () => [],
  },

  a11y: {
    // A native number input is a spinbutton in the accessibility tree whatever the `display`
    // setting looks like; the stepper's buttons are conveniences layered on the same pattern,
    // not a different one. Declaring `textbox` would commit the renderer to a role its own
    // markup does not produce.
    interactionModel: 'spinbutton',
    requiredRoles: ['spinbutton'],
    keys: ['Tab', 'ArrowUp', 'ArrowDown'],
    minTouchTargetPx: 44,
    pointerDependent: false,
    rtlSafe: true,
  } satisfies A11yContract,

  staticChecks(ctx) {
    const out: PluginDiagnostic[] = [];
    const { min, max } = ctx.config;
    if (min !== undefined && max !== undefined && min > max) {
      out.push({
        code: 'impossible_bounds',
        severity: 'error',
        message: `min (${min}) exceeds max (${max}), so no answer can validate`,
        path: '/config/min',
      });
    }
    if (ctx.options.length > 0) {
      out.push({
        code: 'options_ignored',
        severity: 'warning',
        message: 'numeric declares its domain in config; authored options are ignored',
        path: '/options',
      });
    }
    return out;
  },
};
