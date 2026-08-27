/**
 * `slider` — a bounded numeric scale dragged along a track: `Q : number` (F §10, roadmap P2-05).
 *
 * A slider looks like `numeric` with a different control, and treating it that way is how sliders
 * produce biased data. Three decisions separate them, and all three are about the same problem.
 *
 *  1. **BOUNDS ARE REQUIRED, not optional.** `numeric`'s `min`/`max` are authored soft bounds and a
 *     numeric box without them is a perfectly good question. A slider without them has no track —
 *     there is no such thing as a thumb position on an unbounded line — so they are required by the
 *     config schema and `staticChecks` rejects a degenerate range rather than rendering a control
 *     with one reachable value.
 *
 *  2. **AN UNTOUCHED SLIDER IS UNANSWERED, and that is the whole methodological point.** Every
 *     slider has to put the thumb somewhere, and the naive choice — the midpoint — silently records
 *     an opinion for every respondent who skipped the question. The bias is invisible in the data:
 *     a pile of exactly-midpoint answers looks like genuine centrism, and no export can distinguish
 *     it from the real thing. So `value` stays `null` until the respondent acts, the renderer marks
 *     the untouched state (`data-untouched`, no `aria-valuenow`), and `required` catches a slider
 *     nobody moved. `resting_position` decides where the thumb *sits* while unanswered and is
 *     explicitly NOT a default answer — the two are different fields and this file will not conflate
 *     them.
 *
 *  3. **The grid is the data contract; `step` is the UI's stride.** Same split as `numeric`, and the
 *     same functions enforce it (`readGridNumber`, `onDecimalGrid`, imported rather than
 *     reimplemented — two definitions of "an acceptable number" drift on exactly the payload nobody
 *     hand-tests). A slider whose `step` walked off the declared decimal grid would build values its
 *     own codec rejects.
 *
 * Direction is left to the platform: a native `range` input is mirrored by the browser in RTL, so
 * the renderer never positions anything itself. See the note in `view.tsx`.
 */

import { asPlainObject, err, ok, type ResponseCodec } from '../../contract/codec.js';
import { KIT_MESSAGE_KEYS, type ValidationIssue } from '../../contract/validate.js';
import type { PluginDiagnostic } from '../../contract/diagnostics.js';
import type { QuestionTypePluginCore } from '../../contract/plugin.js';
import type { A11yContract } from '../../contract/a11y.js';
import type { JsonSchema } from '../../json-schema.js';
import type { VariableDeclaration } from '../../contract/variables.js';
import { MAX_NUMERIC_MAGNITUDE, onDecimalGrid, readGridNumber } from '../numeric/core.js';

/** Where the thumb rests while the question is UNANSWERED. Never an answer — see the header. */
export type SliderRestingPosition = 'min' | 'midpoint' | 'max';

export interface SliderTick {
  /** A value on the track to mark. Must lie within `[min, max]` and on the decimal grid. */
  readonly value: number;
  readonly labelKey: string;
}

export interface SliderConfig {
  readonly min: number;
  readonly max: number;
  /** UI stride. Defaults to one grid unit so the arrows never leave the grid the codec enforces. */
  readonly step?: number;
  /** The data grid. `0` = integers. */
  readonly decimals: number;
  /**
   * Where the thumb sits before the respondent touches it. **Not a default answer**: the variable
   * stays null until they act, whatever this says. It exists because the thumb must be drawn
   * somewhere and "which end" is an authoring choice (a 0–100 spend slider rests at min; a
   * -50..+50 sentiment slider rests at midpoint).
   */
  readonly resting_position?: SliderRestingPosition;
  /** Show the numeric value next to the track. Off by default: it invites anchoring. */
  readonly show_value?: boolean;
  /** Marks along the track. Purely presentational — they do not constrain the answer. */
  readonly ticks?: readonly SliderTick[];
  /** End labels, e.g. "Not at all likely" / "Extremely likely". */
  readonly min_label_key?: string;
  readonly max_label_key?: string;
}

export interface SliderAnswer {
  /**
   * `null` means UNTOUCHED, and that is load-bearing rather than merely tidy: it is what keeps a
   * skipped slider out of the data as a midpoint opinion. See the header.
   */
  readonly value: number | null;
}

export const SLIDER_CONFIG_SCHEMA: JsonSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  // min/max REQUIRED: a slider without a track is not a slider (header, decision 1).
  required: ['min', 'max', 'decimals'],
  properties: {
    min: { type: 'number' },
    max: { type: 'number' },
    step: { type: 'number', exclusiveMinimum: 0 },
    // Capped at 6 for the same reason `numeric` caps it: beyond that the grid check runs out of
    // double precision at realistic magnitudes.
    decimals: { type: 'integer', minimum: 0, maximum: 6, default: 0 },
    resting_position: { enum: ['min', 'midpoint', 'max'], default: 'min' },
    show_value: { type: 'boolean', default: false },
    min_label_key: { type: 'string', minLength: 1 },
    max_label_key: { type: 'string', minLength: 1 },
    ticks: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['value', 'labelKey'],
        properties: {
          value: { type: 'number' },
          labelKey: { type: 'string', minLength: 1 },
        },
      },
    },
  },
};

/** One grid unit — the smallest stride that cannot leave the declared decimal grid. */
export function gridUnit(decimals: number): number {
  return decimals === 0 ? 1 : 10 ** -decimals;
}

/**
 * Where the thumb is drawn while unanswered.
 *
 * Exported so the renderer and the tests agree on it without either re-deriving the midpoint, and
 * so it is obvious this function is never consulted when a value exists.
 */
export function restingValue(config: SliderConfig): number {
  switch (config.resting_position ?? 'min') {
    case 'max':
      return config.max;
    case 'midpoint': {
      const mid = config.min + (config.max - config.min) / 2;
      // Snapped to the grid: an odd-width range would otherwise rest the thumb between two
      // reachable values, and the first arrow key would appear to jump.
      const factor = 10 ** config.decimals;
      return Math.round(mid * factor) / factor;
    }
    default:
      return config.min;
  }
}

const codec: ResponseCodec<SliderConfig, SliderAnswer> = {
  parse(raw, ctx) {
    if (raw === null || raw === undefined) return ok({ value: null });
    const record = asPlainObject(raw);
    if (record === undefined) return err({ code: 'shape', message: 'expected an object' });
    const read = readGridNumber(record['value'], ctx.config.decimals, '/value');
    if (!read.ok) return read;
    // Off-track values are rejected here rather than reported by `validate`, which is the opposite
    // of `numeric`'s choice and follows from decision 1: a slider's bounds are the CONTROL's
    // extent, not an authored opinion about acceptable answers, so a payload outside them could not
    // have come from the rendered widget. `numeric`'s min/max are soft bounds a respondent can
    // genuinely overshoot by typing, which is why that plugin validates instead of rejecting.
    const value = read.value;
    if (value !== null && (value < ctx.config.min || value > ctx.config.max)) {
      return err({ code: 'range', message: 'outside the slider track', path: '/value' });
    }
    return ok({ value });
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

export const sliderCore: QuestionTypePluginCore<SliderConfig, SliderAnswer> = {
  meta: {
    id: 'slider',
    version: '1.0.0',
    displayName: 'qt.slider.name',
    description: 'qt.slider.desc',
    category: 'scale',
    icon: 'sliders',
    entitlementKey: null,
    trust: 'first_party',
    // Composable: one self-named variable, so a slider row in a mixed matrix is fully covered by
    // the scoped namer — the same argument `numeric` makes.
    composable: true,
    emitsData: true,
  },

  configSchema: SLIDER_CONFIG_SCHEMA,

  defaultConfig: () => ({ min: 0, max: 100, decimals: 0, resting_position: 'min' }),

  declareVariables(ctx) {
    const config = ctx.config;
    const declaration: VariableDeclaration = {
      name: ctx.name.self(),
      kind: 'response',
      type: 'number',
      numericDomain: { min: config.min, max: config.max, decimals: config.decimals },
      source: { part: { kind: 'self' } },
      export: {
        include: !ctx.flags.excludeFromExport,
        column: ctx.name.self(),
        labelKey: `${ctx.ref}.label`,
        order: 0,
      },
      pii: ctx.flags.pii,
      persist: true,
      // `scale`: a slider position is averaged and differenced. Declaring `ordinal` would deny
      // SPSS the analyses this question exists to support.
      analysis: { measure: 'scale' },
    };
    return [declaration];
  },

  validate(ctx) {
    const issues: ValidationIssue[] = [];
    const value = ctx.value?.value ?? null;
    const selfName = ctx.question.variables.self ?? null;
    const config = ctx.question.config;

    // The point of tracking untouched separately: this is the branch that catches a respondent who
    // never moved the thumb, which a midpoint default would have silently answered for them.
    if (ctx.required && value === null) {
      return [{ variableName: selfName, messageKey: KIT_MESSAGE_KEYS.required, severity: 'error' }];
    }
    if (value === null) return issues;

    // Defensive, reachable only via a tampered or stale Answer — the codec rejects all of this
    // first, and ADR-004 makes the server re-run both sides.
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
    if (value < config.min || value > config.max) {
      issues.push({
        variableName: selfName,
        messageKey: KIT_MESSAGE_KEYS.outOfRange,
        params: { min: config.min, max: config.max },
        severity: 'error',
      });
    }
    return issues;
  },

  codec,

  exportContribution: {
    columnLabel: (_declaration, ctx) => ctx.t(ctx.question.label),
    // A slider column is a scale, not a set of categories. Emitting the end labels as value labels
    // would put two fake categories in SPSS and make a 0–100 column look like a 2-point scale.
    valueLabels: () => [],
  },

  a11y: {
    interactionModel: 'slider',
    requiredRoles: ['slider'],
    // Home/End matter more here than anywhere else: they are the only non-pointer way to reach an
    // endpoint of a long track without holding an arrow key down.
    keys: ['Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'],
    minTouchTargetPx: 44,
    // A native range input is fully keyboard-operable, so dragging is a convenience and not the
    // only path. Declaring `true` here would oblige the contract to document an alternative that
    // the platform already provides.
    pointerDependent: false,
    rtlSafe: true,
  } satisfies A11yContract,

  staticChecks(ctx) {
    const out: PluginDiagnostic[] = [];
    const { min, max, step, decimals, ticks } = ctx.config;

    if (min >= max) {
      out.push({
        code: 'impossible_bounds',
        severity: 'error',
        message: `min (${min}) must be below max (${max}); a slider needs a track to move along`,
        path: '/config/min',
      });
    }
    if (step !== undefined && !onDecimalGrid(step, decimals)) {
      // A stride finer than the grid produces positions the codec rejects — the widget would build
      // answers its own plugin refuses, which is the worst kind of authoring bug because it only
      // appears for respondents who touch that part of the track.
      out.push({
        code: 'step_off_grid',
        severity: 'error',
        message: `step (${step}) is finer than the declared ${decimals}-decimal grid`,
        path: '/config/step',
      });
    }
    if (step !== undefined && step > max - min) {
      out.push({
        code: 'step_exceeds_range',
        severity: 'error',
        message: `step (${step}) is wider than the whole range, so only ${min} is reachable`,
        path: '/config/step',
      });
    }
    for (const [i, tick] of (ticks ?? []).entries()) {
      if (tick.value < min || tick.value > max) {
        out.push({
          code: 'tick_off_track',
          severity: 'warning',
          message: `tick ${tick.value} is outside [${min}, ${max}] and will not be drawn`,
          path: `/config/ticks/${String(i)}/value`,
        });
      }
    }
    if (ctx.options.length > 0) {
      out.push({
        code: 'options_ignored',
        severity: 'warning',
        message: 'slider declares its domain in config; authored options are ignored',
        path: '/options',
      });
    }
    return out;
  },
};
