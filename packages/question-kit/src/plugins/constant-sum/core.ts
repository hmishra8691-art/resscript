/**
 * `constant_sum` — allocate a fixed budget across items: `Qr1..Qrn : number` (F §10, P2-05).
 *
 * **Why this is not just `numeric_list` with `sum.equals` set.** That configuration exists and
 * works, and a survey programmer can build a 100-point allocation with it today. Three things are
 * different here, and the third is the one that matters:
 *
 *  1. **The total is required, not optional.** `numeric_list.sum` is one of several ways to
 *     constrain a battery of boxes. Here it IS the question: "allocate 100 points" has no meaning
 *     without the 100, so `total` is required by the config schema rather than checked for.
 *  2. **The remaining budget is part of the control.** A respondent allocating across eight items
 *     needs to see what is left as they type; that is a live counter the renderer owns, and it is
 *     the whole usability difference between this and eight numeric boxes with a validation message
 *     at the end.
 *  3. **`allow_partial` distinguishes "not finished" from "wrong".** An allocation that adds to 80
 *     of 100 is INCOMPLETE, not invalid — the respondent is mid-task. An allocation that adds to
 *     120 is over budget and is a genuine error. `numeric_list`'s single `equals` check reports both
 *     identically, which is the right call for a general battery and the wrong one for a control
 *     whose job is to help someone reach a target.
 *
 * The arithmetic is the same as `numeric_list`'s and for the same reason: sums are computed in
 * grid-scaled integers, because `25.5 + 25.5 + 24.5 + 24.5` in doubles is not reliably 100 and an
 * allocation grid that rejects a correct allocation over float dust is a support ticket per wave.
 * Every value is already on the declared grid (the codec enforced it), so `Math.round(v * 10^d)` is
 * exact and integer addition is associative.
 */

import { asPlainObject, err, ok, type ResponseCodec } from '../../contract/codec.js';
import { KIT_MESSAGE_KEYS, type ValidationIssue } from '../../contract/validate.js';
import type { PluginDiagnostic } from '../../contract/diagnostics.js';
import type { QuestionTypePluginCore } from '../../contract/plugin.js';
import type { A11yContract } from '../../contract/a11y.js';
import type { JsonSchema } from '../../json-schema.js';
import type { VariableDeclaration } from '../../contract/variables.js';
// Shared with `numeric` so "what is an acceptable number" has exactly one definition, on the same
// grounds `numeric_list` gives for the same import.
import { MAX_NUMERIC_MAGNITUDE, onDecimalGrid, readGridNumber } from '../numeric/core.js';

export interface ConstantSumConfig {
  /** The budget to allocate. Required — see the header, decision 1. */
  readonly total: number;
  /** The shared data grid for every box. `0` = integers. */
  readonly decimals: number;
  /** Per-box ceiling. Defaults to `total`: no single item can exceed the whole budget. */
  readonly max_per_item?: number;
  /** Show the running remainder beside the boxes. On by default — it is the point of the type. */
  readonly show_remaining?: boolean;
  /** Render the budget as a percentage rather than as points. Presentational only. */
  readonly unit?: 'points' | 'percent';
  /**
   * Accept a partial allocation. Default `false`.
   *
   * When false a short allocation is an error; when true it is accepted as-is, which is what a
   * "distribute any spare capacity" question wants.
   */
  readonly allow_partial?: boolean;
}

export interface ConstantSumAnswer {
  /**
   * Keyed by *row ref*, because that is what the renderer has; names come from codes. A row with no
   * entry is a blank box — distinct from an entry of `0`, which is a real allocation ("none to
   * this one"). Conflating them would make "allocated nothing" and "has not got to it yet"
   * the same datum.
   */
  readonly values: Readonly<Record<string, number>>;
}

export const CONSTANT_SUM_CONFIG_SCHEMA: JsonSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  required: ['total', 'decimals'],
  properties: {
    total: { type: 'number', exclusiveMinimum: 0 },
    decimals: { type: 'integer', minimum: 0, maximum: 6, default: 0 },
    max_per_item: { type: 'number', exclusiveMinimum: 0 },
    show_remaining: { type: 'boolean', default: true },
    unit: { enum: ['points', 'percent'], default: 'points' },
    allow_partial: { type: 'boolean', default: false },
  },
};

/**
 * The allocated total and what is left, both exact.
 *
 * Exported because the renderer's live counter and the validator's check must agree to the last
 * grid unit — two implementations of "what is left" is how a control tells a respondent they are
 * done while the validator disagrees.
 */
export function allocation(
  values: Readonly<Record<string, number>>,
  refs: readonly string[],
  config: Pick<ConstantSumConfig, 'total' | 'decimals'>,
): { readonly allocated: number; readonly remaining: number; readonly answered: number } {
  const factor = 10 ** config.decimals;
  let scaled = 0;
  let answered = 0;
  for (const ref of refs) {
    const value = values[ref];
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    // Integer arithmetic on the grid: see the header.
    scaled += Math.round(value * factor);
    answered += 1;
  }
  return {
    allocated: scaled / factor,
    remaining: (Math.round(config.total * factor) - scaled) / factor,
    answered,
  };
}

const codec: ResponseCodec<ConstantSumConfig, ConstantSumAnswer> = {
  parse(raw, ctx) {
    if (raw === null || raw === undefined) return ok({ values: {} });
    const record = asPlainObject(raw);
    if (record === undefined) return err({ code: 'shape', message: 'expected an object' });

    const rawValues = record['values'];
    if (rawValues === undefined || rawValues === null) return ok({ values: {} });
    // `asPlainObject` also rejects a >1000-key payload and an own `__proto__` before anything
    // below allocates per entry (F §9's hostile list).
    const map = asPlainObject(rawValues);
    if (map === undefined) {
      return err({ code: 'shape', message: 'values must be an object', path: '/values' });
    }

    const known = new Set(ctx.question.rows.map((row) => row.ref));
    const values: Record<string, number> = {};
    for (const [ref, entry] of Object.entries(map)) {
      if (!known.has(ref)) {
        // A fabricated ref is a forged payload: the UI renders only authored rows. Rejecting keeps
        // `toVariables` unable to write a column that was never declared (ADR-005 threat 3).
        return err({ code: 'unknown_key', message: `no row ${ref}`, path: `/values` });
      }
      const read = readGridNumber(entry, ctx.config.decimals, `/values/${ref}`);
      if (!read.ok) return read;
      if (read.value === null) continue;
      if (read.value < 0) {
        // A negative allocation is not a respondent mistake the UI can produce — the boxes have a
        // floor of zero — so it is a forged payload and the codec is the right place to stop it.
        // (An over-budget TOTAL is a real respondent error and belongs in `validate`.)
        return err({ code: 'range', message: 'an allocation cannot be negative', path: `/values/${ref}` });
      }
      values[ref] = read.value;
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

export const constantSumCore: QuestionTypePluginCore<ConstantSumConfig, ConstantSumAnswer> = {
  meta: {
    id: 'constant_sum',
    version: '1.0.0',
    displayName: 'qt.constant_sum.name',
    description: 'qt.constant_sum.desc',
    category: 'numeric',
    icon: 'divide',
    entitlementKey: null,
    trust: 'first_party',
    // NOT composable: the constraint spans the whole row set, and a matrix cell holds one control.
    // A per-cell constant sum would need a budget per cell, which is a different question type.
    composable: false,
    emitsData: true,
  },

  configSchema: CONSTANT_SUM_CONFIG_SCHEMA,

  defaultConfig: () => ({ total: 100, decimals: 0, show_remaining: true, unit: 'points' }),

  declareVariables(ctx) {
    const config = ctx.config;
    const out: VariableDeclaration[] = [];
    for (const row of ctx.rows) {
      out.push({
        name: ctx.name.row(row.code),
        kind: 'response',
        type: 'number',
        numericDomain: {
          min: 0,
          max: config.max_per_item ?? config.total,
          decimals: config.decimals,
        },
        source: { part: { kind: 'row', rowRef: row.ref } },
        export: {
          include: !ctx.flags.excludeFromExport,
          column: ctx.name.row(row.code),
          labelKey: row.labelKey,
          // Order from the *code*, never the loop index: dragging a row up the list must not shift
          // export columns (F §1.1 rule 2).
          order: row.code,
        },
        pii: ctx.flags.pii,
        persist: true,
        // A battery: the rows are one instrument ("allocate this budget across them"), and SPSS
        // metadata groups them so the analyst sees the allocation rather than n orphan columns.
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
    const perItemMax = config.max_per_item ?? config.total;
    const { allocated, answered } = allocation(
      values,
      rows.map((row) => row.ref),
      config,
    );

    if (answered === 0) {
      // Untouched: one message, not one per box — n "required" errors on a question the respondent
      // has not started reads as the form shouting.
      return ctx.required
        ? [{ variableName: null, messageKey: KIT_MESSAGE_KEYS.required, severity: 'error' }]
        : issues;
    }

    for (const row of rows) {
      const value = values[row.ref];
      if (value === undefined) continue; // a blank box is not itself an error; the total decides
      const variableName = ctx.question.variables.byRow[row.ref] ?? null;
      // Defensive; the codec rejects these first (see `numeric/core.ts` on why a grid violation is
      // `err.not_numeric` rather than `err.out_of_range`).
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
      if (value < 0 || value > perItemMax) {
        issues.push({
          variableName,
          messageKey: KIT_MESSAGE_KEYS.outOfRange,
          params: { min: 0, max: perItemMax },
          severity: 'error',
          focus: { rowRef: row.ref },
        });
      }
    }

    /**
     * The budget check, only once the boxes are individually clean — a total computed from a
     * garbage box is meaningless, and a sum error stacked on a box error makes the respondent fix
     * the box and then re-read a stale total. Same ordering `numeric_list` uses.
     *
     * `err.out_of_range` is reused deliberately: `KIT_MESSAGE_KEYS` is the i18n bundle's contract
     * and a plugin may not add a key. `params` carry `max` (the budget) and `sum` (what the boxes
     * currently add to), attached to the question rather than to a box because no single entry is
     * the culprit — which is also why `allow_partial` can distinguish under- from over-allocation
     * without a second key.
     */
    if (issues.length === 0) {
      const factor = 10 ** config.decimals;
      const scaledAllocated = Math.round(allocated * factor);
      const scaledTotal = Math.round(config.total * factor);
      const over = scaledAllocated > scaledTotal;
      const short = scaledAllocated < scaledTotal;
      if (over || (short && config.allow_partial !== true)) {
        issues.push({
          variableName: null,
          messageKey: KIT_MESSAGE_KEYS.outOfRange,
          params: { max: config.total, sum: allocated },
          severity: 'error',
        });
      }
    }
    return issues;
  },

  codec,

  exportContribution: {
    columnLabel: (declaration, ctx) =>
      `${ctx.t(ctx.question.label)} — ${ctx.t(declaration.export.labelKey)}`,
    // An allocation column is a quantity, not a category. Value labels would invent categories.
    valueLabels: () => [],
  },

  a11y: {
    // Native number inputs: spinbuttons in the accessibility tree, whatever the boxes look like.
    interactionModel: 'spinbutton',
    requiredRoles: ['spinbutton'],
    keys: ['Tab', 'ArrowUp', 'ArrowDown'],
    minTouchTargetPx: 44,
    pointerDependent: false,
    rtlSafe: true,
  } satisfies A11yContract,

  staticChecks(ctx) {
    const out: PluginDiagnostic[] = [];
    const { total, decimals, max_per_item: perItem } = ctx.config;

    if (ctx.rows.length < 2) {
      out.push({
        code: 'too_few_rows',
        severity: 'error',
        message: 'a constant sum needs at least two rows to allocate across',
        path: '/rows',
      });
    }
    if (!onDecimalGrid(total, decimals)) {
      // A budget the boxes cannot express: with 0 decimals and a total of 99.5, no combination of
      // integer entries reaches it, so the question can never validate.
      out.push({
        code: 'total_off_grid',
        severity: 'error',
        message: `total (${total}) is not reachable on the declared ${decimals}-decimal grid`,
        path: '/config/total',
      });
    }
    if (perItem !== undefined && perItem * ctx.rows.length < total) {
      out.push({
        code: 'unreachable_total',
        severity: 'error',
        message:
          `max_per_item (${perItem}) across ${ctx.rows.length} rows caps the allocation at ` +
          `${perItem * ctx.rows.length}, below the total of ${total}`,
        path: '/config/max_per_item',
      });
    }
    if (ctx.options.length > 0) {
      out.push({
        code: 'options_ignored',
        severity: 'warning',
        message: 'constant_sum allocates across rows; authored options are ignored',
        path: '/options',
      });
    }
    return out;
  },
};
