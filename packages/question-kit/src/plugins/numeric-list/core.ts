/**
 * `numeric_list` — one numeric box per authored row: `Qr1..Qrn : number` (F §10).
 *
 * The per-item pattern is `multi_select`'s, but the item list is **rows**, not options — that is
 * schema's word, not a taste call: `planQuestionEmissions`' builtin table plans `numeric_list`
 * over `rows` with a `row` part ("one variable per matrix row / numeric-list row: `Q3r1`"), and a
 * plugin that fanned out over options would declare parts the interop layer maps onto the wrong
 * schema `VariablePart`. Names are identical either way (rows and options share the r-namespace,
 * schema §3); provenance is not.
 *
 * The reason this type exists at all is the `sum` constraint — "allocate 100 points", "these
 * must add to your household size". Two decisions there:
 *
 *  1. **The sum check lives in `validate`, not the codec.** A wrong sum is a respondent mistake
 *     the UI cannot prevent mid-entry (the boxes are individually fine until the last one), so it
 *     has to come back as a message next to the question, not as a rejected page.
 *  2. **The sum is computed in grid-scaled integers.** `25.5 + 25.5 + 24.5 + 24.5` in doubles is
 *     not reliably `100`, and an allocation grid that rejects a correct allocation over float
 *     dust is a support ticket per wave. Each value is already on the declared grid (the codec
 *     enforced it), so `Math.round(v * 10^d)` is exact and integer addition is associative.
 */

import { asPlainObject, err, ok, type ResponseCodec } from '../../contract/codec.js';
import { KIT_MESSAGE_KEYS, type ValidationIssue } from '../../contract/validate.js';
import type { PluginDiagnostic } from '../../contract/diagnostics.js';
import type { QuestionTypePluginCore } from '../../contract/plugin.js';
import type { A11yContract } from '../../contract/a11y.js';
import type { JsonSchema } from '../../json-schema.js';
import type { VariableDeclaration } from '../../contract/variables.js';
// Shared with `numeric` so "what is an acceptable number" has exactly one definition. The import
// is core-to-core (React-free), so it costs the worker nothing; duplicating the grid check here
// would drift on precisely the hostile payload nobody hand-tests.
import { MAX_NUMERIC_MAGNITUDE, onDecimalGrid, readGridNumber } from '../numeric/core.js';

export interface NumericListSum {
  /** The allocation case: the row values must add to exactly this. */
  readonly equals?: number;
  readonly min?: number;
  readonly max?: number;
}

export interface NumericListConfig {
  /** The shared data grid for every box. `0` = integers. */
  readonly decimals: number;
  /** Per-box bounds, shared by every row. */
  readonly min?: number;
  readonly max?: number;
  readonly sum?: NumericListSum;
}

export interface NumericListAnswer {
  /**
   * Keyed by *row ref*, because that is what the renderer has; names come from codes. A row with
   * no entry is a blank box — distinct from an entry of `0`, which is an answer ("zero of these").
   */
  readonly values: Readonly<Record<string, number>>;
}

export const NUMERIC_LIST_CONFIG_SCHEMA: JsonSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  required: ['decimals'],
  properties: {
    decimals: { type: 'integer', minimum: 0, maximum: 6, default: 0 },
    min: { type: 'number' },
    max: { type: 'number' },
    sum: {
      type: 'object',
      additionalProperties: false,
      properties: {
        equals: { type: 'number' },
        min: { type: 'number' },
        max: { type: 'number' },
      },
    },
  },
};

const codec: ResponseCodec<NumericListConfig, NumericListAnswer> = {
  parse(raw, ctx) {
    if (raw === null || raw === undefined) return ok({ values: {} });
    const record = asPlainObject(raw);
    if (record === undefined) return err({ code: 'shape', message: 'expected an object' });

    const rawValues = record['values'];
    if (rawValues === undefined || rawValues === null) return ok({ values: {} });
    // `asPlainObject` also rejects a >1000-key payload and an own `__proto__` before anything
    // below allocates per entry (F §9's hostile list).
    const map = asPlainObject(rawValues);
    if (map === undefined) return err({ code: 'shape', message: 'values must be an object', path: '/values' });

    const known = new Set(ctx.question.rows.map((row) => row.ref));
    const values: Record<string, number> = {};
    for (const [ref, entry] of Object.entries(map)) {
      if (!known.has(ref)) {
        // A fabricated ref is a forged payload: the UI renders only authored rows. Rejecting
        // keeps `toVariables` unable to write a column that was never declared (ADR-005 threat 3).
        return err({ code: 'unknown_key', message: `no row ${ref}`, path: '/values' });
      }
      const read = readGridNumber(entry, ctx.config.decimals, `/values/${ref}`);
      if (!read.ok) return read;
      if (read.value !== null) values[ref] = read.value;
    }
    return ok({ values });
  },

  toVariables(answer, ctx) {
    const out: Record<string, number | null> = {};
    for (const row of ctx.question.rows) {
      // Every row gets a value, including `null` for a blank box: "shown and left blank" and
      // "never shown" are different facts, and an absent key is how the second is represented.
      out[ctx.name.row(row.code)] = answer.values[row.ref] ?? null;
    }
    return out;
  },

  fromVariables(vars, ctx) {
    const values: Record<string, number> = {};
    for (const row of ctx.question.rows) {
      const value = vars[ctx.name.row(row.code)];
      if (typeof value === 'number' && Number.isFinite(value)) values[row.ref] = value;
    }
    return { values };
  },

  emptyAnswer: () => ({ values: {} }),
};

export const numericListCore: QuestionTypePluginCore<NumericListConfig, NumericListAnswer> = {
  meta: {
    id: 'numeric_list',
    version: '1.0.0',
    displayName: 'qt.numeric_list.name',
    description: 'qt.numeric_list.desc',
    category: 'numeric',
    icon: 'list-ordered',
    entitlementKey: null,
    trust: 'first_party',
    /**
     * Not composable, for `multi_select`'s reason: a fan-out inside a cell would need a `Q5r3r2`
     * name, which no schema §4 part describes. A numeric list inside a grid is a numeric-column
     * matrix, which is `matrix` composing `numeric` per cell — that is what `numeric` being
     * composable is for.
     */
    composable: false,
    emitsData: true,
  },

  configSchema: NUMERIC_LIST_CONFIG_SCHEMA,

  defaultConfig: () => ({ decimals: 0 }),

  declareVariables(ctx) {
    const config = ctx.config;
    const out: VariableDeclaration[] = [];
    for (const row of ctx.rows) {
      out.push({
        name: ctx.name.row(row.code),
        kind: 'response',
        type: 'number',
        numericDomain: {
          ...(config.min === undefined ? {} : { min: config.min }),
          ...(config.max === undefined ? {} : { max: config.max }),
          decimals: config.decimals,
        },
        source: { part: { kind: 'row', rowRef: row.ref } },
        export: {
          include: !ctx.flags.excludeFromExport,
          column: ctx.name.row(row.code),
          labelKey: row.labelKey,
          // Order from the *code*, never the loop index: dragging a row up the list must not
          // shift export columns (F §1.1 rule 2).
          order: row.code,
        },
        pii: ctx.flags.pii,
        persist: true,
        // A battery: the rows are one instrument ("allocate 100 across these"), and SPSS
        // metadata groups them so the analyst sees the grid rather than n orphan columns.
        analysis: { measure: 'scale', batteryRef: ctx.ref },
      });
    }
    return out;
  },

  validate(ctx) {
    const issues: ValidationIssue[] = [];
    const values = ctx.value?.values ?? {};
    const config = ctx.question.config;
    const rows = ctx.question.rows.filter((row) => row.visible);
    const answered = rows.filter((row) => typeof values[row.ref] === 'number');

    if (ctx.required && answered.length === 0) {
      // Untouched question: one message, not one per box — n "required" errors on a question the
      // respondent has not reached yet reads as the form shouting.
      return [{ variableName: null, messageKey: KIT_MESSAGE_KEYS.required, severity: 'error' }];
    }

    for (const row of rows) {
      const value = values[row.ref];
      const variableName = ctx.question.variables.byRow[row.ref] ?? null;
      if (value === undefined) {
        // Partially answered and required: every box owes a value (an allocation with a blank
        // row is not interpretable as an allocation), and the error points at the blank box.
        if (ctx.required && answered.length > 0) {
          issues.push({
            variableName,
            messageKey: KIT_MESSAGE_KEYS.required,
            severity: 'error',
            focus: { rowRef: row.ref },
          });
        }
        continue;
      }
      // Defensive; the codec rejects these first (see `numeric/core.ts` on why grid violations
      // are `err.not_numeric` rather than `err.out_of_range`).
      if (
        typeof value !== 'number' ||
        !Number.isFinite(value) ||
        Math.abs(value) > MAX_NUMERIC_MAGNITUDE ||
        !onDecimalGrid(value, config.decimals)
      ) {
        issues.push({
          variableName,
          messageKey: KIT_MESSAGE_KEYS.notNumeric,
          params: { decimals: config.decimals },
          severity: 'error',
          focus: { rowRef: row.ref },
        });
        continue;
      }
      if (
        (config.min !== undefined && value < config.min) ||
        (config.max !== undefined && value > config.max)
      ) {
        issues.push({
          variableName,
          messageKey: KIT_MESSAGE_KEYS.outOfRange,
          params: {
            ...(config.min === undefined ? {} : { min: config.min }),
            ...(config.max === undefined ? {} : { max: config.max }),
          },
          severity: 'error',
          focus: { rowRef: row.ref },
        });
      }
    }

    /**
     * The page-scope sum check. Runs only when the boxes are individually clean: a sum error on
     * top of a per-box error makes the respondent fix the box and then re-read a stale total,
     * and a garbage box would poison the arithmetic anyway.
     *
     * `err.out_of_range` is reused deliberately — KIT_MESSAGE_KEYS has no sum-specific key and
     * this plugin may not add one (the key set is the i18n bundle's contract). The params make
     * the message renderable: `min`/`max` carry the target (both equal for `equals`) and `sum`
     * carries what the boxes currently add to, attached to the question (`variableName: null`)
     * because no single box is the culprit.
     */
    if (config.sum !== undefined && issues.length === 0 && answered.length > 0) {
      const factor = 10 ** config.decimals;
      const total = answered.reduce(
        (acc, row) => acc + Math.round((values[row.ref] as number) * factor),
        0,
      );
      const sum = total / factor;
      const { equals, min, max } = config.sum;
      if (equals !== undefined && total !== Math.round(equals * factor)) {
        issues.push({
          variableName: null,
          messageKey: KIT_MESSAGE_KEYS.outOfRange,
          params: { min: equals, max: equals, sum },
          severity: 'error',
        });
      } else if (min !== undefined && total < Math.round(min * factor)) {
        issues.push({
          variableName: null,
          messageKey: KIT_MESSAGE_KEYS.outOfRange,
          params: { min, sum },
          severity: 'error',
        });
      } else if (max !== undefined && total > Math.round(max * factor)) {
        issues.push({
          variableName: null,
          messageKey: KIT_MESSAGE_KEYS.outOfRange,
          params: { max, sum },
          severity: 'error',
        });
      }
    }
    return issues;
  },

  codec,

  exportContribution: {
    columnLabel: (declaration, ctx) =>
      declaration.source.part.kind === 'row'
        ? `${ctx.t(ctx.question.label)} — ${ctx.t(declaration.export.labelKey)}`
        : ctx.t(ctx.question.label),
    valueLabels: () => [],
  },

  a11y: {
    // Each box is a native number input (a spinbutton); the group wraps them so a screen reader
    // announces the battery's label once rather than per box.
    interactionModel: 'spinbutton',
    requiredRoles: ['group', 'spinbutton'],
    keys: ['Tab', 'ArrowUp', 'ArrowDown'],
    minTouchTargetPx: 44,
    pointerDependent: false,
    rtlSafe: true,
  } satisfies A11yContract,

  staticChecks(ctx) {
    const out: PluginDiagnostic[] = [];
    if (ctx.rows.length === 0) {
      out.push({
        code: 'no_rows',
        severity: 'error',
        message: 'numeric_list requires at least one row',
        path: '/rows',
      });
    }
    const { min, max, sum } = ctx.config;
    if (min !== undefined && max !== undefined && min > max) {
      out.push({
        code: 'impossible_bounds',
        severity: 'error',
        message: `min (${min}) exceeds max (${max}), so no box can validate`,
        path: '/config/min',
      });
    }
    if (sum !== undefined) {
      if (sum.min !== undefined && sum.max !== undefined && sum.min > sum.max) {
        out.push({
          code: 'impossible_sum_bounds',
          severity: 'error',
          message: `sum.min (${sum.min}) exceeds sum.max (${sum.max}), so no answer can validate`,
          path: '/config/sum/min',
        });
      }
      if (sum.equals !== undefined && (sum.min !== undefined || sum.max !== undefined)) {
        // `equals` alongside min/max: an error when they contradict (nothing could ever
        // validate), a warning when they merely overlap (`equals` decides and the bounds add
        // nothing — almost always a leftover from switching constraint styles mid-edit).
        const contradicts =
          (sum.min !== undefined && sum.equals < sum.min) ||
          (sum.max !== undefined && sum.equals > sum.max);
        out.push(
          contradicts
            ? {
                code: 'impossible_sum_bounds',
                severity: 'error',
                message: `sum.equals (${sum.equals}) lies outside sum.min/sum.max, so no answer can validate`,
                path: '/config/sum/equals',
              }
            : {
                code: 'redundant_sum_bounds',
                severity: 'warning',
                message: 'sum.equals is set, so sum.min/sum.max are never consulted',
                path: '/config/sum/equals',
              },
        );
      }
      if (
        sum.equals !== undefined &&
        max !== undefined &&
        ctx.rows.length > 0 &&
        ctx.rows.length * max < sum.equals
      ) {
        out.push({
          code: 'impossible_sum_bounds',
          severity: 'error',
          message:
            `${ctx.rows.length} boxes capped at ${max} cannot reach sum.equals (${sum.equals})`,
          path: '/config/sum/equals',
        });
      }
    }
    return out;
  },
};
