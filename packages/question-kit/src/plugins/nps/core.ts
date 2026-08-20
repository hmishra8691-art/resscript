/**
 * `nps` — 0–10 with anchors, plus an automatically banded companion variable.
 *
 * The plugin that exercises derived variables (F §10: "`Q : number` + derived `Q_band : enum`").
 * Two things about it are worth stating, because both are easy to get wrong in a way nobody
 * notices for a year:
 *
 *  1. **The band has no expression.** It is a table lookup over three closed intervals, so
 *     `derivation.kind` is `'structural'`. Deliverable D's AST could express a three-way
 *     comparison, but writing it as an authorable expression would make the band *editable* —
 *     and "detractor" means 0–6 by definition in the NPS literature, not by local preference.
 *     A client who redefines the bands has not computed NPS. This is also the case
 *     `packages/schema`'s SCH-1015 exception exists for.
 *  2. **The band domain comes from `@resscript/schema`'s `NPS_BAND_DOMAIN`.** Schema ships that
 *     constant for its own builtin emission table, and two definitions of "code 1 is detractor"
 *     would be two definitions of the export contract. One of them would eventually be wrong in a
 *     way that only shows up as a cross-tab that does not add up.
 */

import { NPS_BAND_DOMAIN } from '@resscript/schema';
import { asPlainObject, err, ok, type ResponseCodec } from '../../contract/codec.js';
import { KIT_MESSAGE_KEYS, type ValidationIssue } from '../../contract/validate.js';
import type { PluginDiagnostic } from '../../contract/diagnostics.js';
import type { QuestionTypePluginCore } from '../../contract/plugin.js';
import type { A11yContract } from '../../contract/a11y.js';
import type { JsonSchema } from '../../json-schema.js';
import type { NumericBand, VariableDeclaration } from '../../contract/variables.js';

export const NPS_MIN_SCORE = 0;
export const NPS_MAX_SCORE = 10;

/**
 * The canonical bands. Codes match `NPS_BAND_DOMAIN`'s ordering (1 detractor, 2 passive,
 * 3 promoter) because that constant is the domain these codes are read against.
 */
export const NPS_BANDS: readonly NumericBand[] = [
  { code: 1, from: 0, to: 6 },
  { code: 2, from: 7, to: 8 },
  { code: 3, from: 9, to: 10 },
];

export interface NpsConfig {
  /** Anchor labels. Required: an unlabelled 0–10 row is a different question to each respondent. */
  readonly lowLabelKey: string;
  readonly highLabelKey: string;
  readonly display: 'buttons' | 'radio';
}

export interface NpsAnswer {
  readonly score: number | null;
}

export const NPS_CONFIG_SCHEMA: JsonSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  required: ['lowLabelKey', 'highLabelKey'],
  properties: {
    lowLabelKey: { type: 'string', minLength: 1 },
    highLabelKey: { type: 'string', minLength: 1 },
    display: { enum: ['buttons', 'radio'], default: 'buttons' },
  },
};

const codec: ResponseCodec<NpsConfig, NpsAnswer> = {
  parse(raw) {
    if (raw === null || raw === undefined) return ok({ score: null });
    const record = asPlainObject(raw);
    if (record === undefined) return err({ code: 'shape', message: 'expected an object' });
    const score = record['score'];
    if (score === null || score === undefined) return ok({ score: null });
    if (typeof score !== 'number' || !Number.isInteger(score)) {
      return err({ code: 'shape', message: 'score must be an integer', path: '/score' });
    }
    if (score < NPS_MIN_SCORE || score > NPS_MAX_SCORE) {
      // `range`, not `domain`: the value is the right kind of thing and outside the declared
      // numeric domain, and the API turns those two codes into different responses.
      return err({ code: 'range', message: 'score must be 0..10', path: '/score' });
    }
    return ok({ score });
  },

  toVariables(answer, ctx) {
    // Only the score. The band is derived — writing it here would store a second copy of the
    // same fact, and the copy is what goes stale when the band table is corrected.
    return { [ctx.name.self()]: answer.score };
  },

  fromVariables(vars, ctx) {
    const score = vars[ctx.name.self()];
    return { score: typeof score === 'number' ? score : null };
  },

  emptyAnswer: () => ({ score: null }),
};

export const npsCore: QuestionTypePluginCore<NpsConfig, NpsAnswer> = {
  meta: {
    id: 'nps',
    version: '1.0.0',
    displayName: 'qt.nps.name',
    description: 'qt.nps.desc',
    category: 'scale',
    icon: 'gauge',
    entitlementKey: null,
    trust: 'first_party',
    /**
     * **Not composable, and this is a contract limitation rather than a product decision.**
     *
     * A cell control names itself through the scoped namer, and there is no variable part in
     * schema §4 that names `Q5r3_band`: the `suffix` part produces `{ref}_{suffix}`, so the band
     * of a cell would have to be called `Q5_r3_band`, which is not the cell's namespace. A plugin
     * that declares companion variables therefore cannot be a cell control until the part model
     * gains a composite (row + suffix) form. Recorded on the plugin because the alternative is
     * discovering it as a `compose_unnameable_part` at publish time.
     */
    composable: false,
    emitsData: true,
  },

  configSchema: NPS_CONFIG_SCHEMA,

  defaultConfig: () => ({
    lowLabelKey: 'qt.nps.anchor_low',
    highLabelKey: 'qt.nps.anchor_high',
    display: 'buttons',
  }),

  declareVariables(ctx) {
    const score: VariableDeclaration = {
      name: ctx.name.self(),
      kind: 'response',
      type: 'number',
      numericDomain: { min: NPS_MIN_SCORE, max: NPS_MAX_SCORE, decimals: 0 },
      source: { part: { kind: 'self' } },
      export: {
        include: !ctx.flags.excludeFromExport,
        column: ctx.name.self(),
        labelKey: `${ctx.ref}.label`,
        order: 0,
      },
      pii: ctx.flags.pii,
      persist: true,
      // `scale`, not `ordinal`: NPS is averaged and differenced (the score is a mean of a
      // -100..100 transform), and SPSS's measure level decides which analyses the tool offers.
      analysis: { measure: 'scale', batteryRef: ctx.ref },
    };

    const band: VariableDeclaration = {
      name: ctx.name.suffixed('band'),
      kind: 'derived',
      type: 'enum',
      enumDomain: NPS_BAND_DOMAIN.map((entry) => ({
        code: entry.code,
        labelKey: entry.label_key,
      })),
      source: { part: { kind: 'meta', label: 'nps_band', suffix: 'band' } },
      export: {
        include: !ctx.flags.excludeFromExport,
        column: ctx.name.suffixed('band'),
        labelKey: `${ctx.ref}.band.label`,
        order: 1,
      },
      pii: ctx.flags.pii,
      // Persisted, unlike a multi-select's set view: the band is what banners and quotas point
      // at, and recomputing it per page for every historical response in an export projection is
      // work with no benefit — the inputs cannot change after submission.
      persist: true,
      derivation: {
        kind: 'structural',
        structural: { computation: 'numeric_band', source: ctx.name.self(), bands: NPS_BANDS },
      },
      analysis: { measure: 'nominal', batteryRef: ctx.ref },
    };

    return [score, band];
  },

  validate(ctx) {
    const issues: ValidationIssue[] = [];
    const score = ctx.value?.score ?? null;
    const selfName = ctx.question.variables.self ?? null;

    if (ctx.required && score === null) {
      return [{ variableName: selfName, messageKey: KIT_MESSAGE_KEYS.required, severity: 'error' }];
    }
    if (score === null) return issues;
    if (!Number.isInteger(score) || score < NPS_MIN_SCORE || score > NPS_MAX_SCORE) {
      issues.push({
        variableName: selfName,
        messageKey: KIT_MESSAGE_KEYS.outOfRange,
        params: { min: NPS_MIN_SCORE, max: NPS_MAX_SCORE },
        severity: 'error',
      });
    }
    return issues;
  },

  codec,

  exportContribution: {
    columnLabel: (declaration, ctx) =>
      declaration.source.part.kind === 'meta'
        ? `${ctx.t(ctx.question.label)} — NPS band`
        : ctx.t(ctx.question.label),
    valueLabels: (declaration, ctx) =>
      declaration.type === 'enum'
        ? (declaration.enumDomain ?? []).map((entry) => ({
            code: entry.code,
            label: ctx.t(entry.labelKey),
          }))
        : [],
  },

  a11y: {
    // 0–10 is eleven mutually exclusive choices, so it is a radiogroup whatever it looks like.
    // Declaring `slider` because it renders as a row of buttons would commit the renderer to the
    // slider keyboard pattern, which is not what respondents get.
    interactionModel: 'radiogroup',
    requiredRoles: ['radiogroup', 'radio'],
    keys: ['Tab', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'Space'],
    minTouchTargetPx: 44,
    pointerDependent: false,
    rtlSafe: true,
  } satisfies A11yContract,

  staticChecks(ctx) {
    const out: PluginDiagnostic[] = [];
    if (ctx.options.length > 0) {
      out.push({
        code: 'options_ignored',
        severity: 'warning',
        message: 'nps has a fixed 0–10 domain; authored options are ignored',
        path: '/options',
      });
    }
    if (ctx.config.lowLabelKey === ctx.config.highLabelKey) {
      out.push({
        code: 'identical_anchors',
        severity: 'warning',
        message: 'both anchor labels are the same key, so the scale has no stated direction',
        path: '/config/highLabelKey',
      });
    }
    return out;
  },
};
