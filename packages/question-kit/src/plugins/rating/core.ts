/**
 * `rating` — a labelled scale (radio / stars / numeric buttons): `Q : enum` over the authored
 * scale points (F §10).
 *
 * Two decisions carry the plugin, and both are about what a rating is *not*:
 *
 *  1. **It is an enum, not a number.** The scale points are authored options with codes and
 *     labels ("Very dissatisfied" … "Very satisfied"), so the export column is a labelled
 *     category set — codes from the authored option, never from an iteration index (F §1.1
 *     rule 2). NPS is the contrast: its 0–10 is intrinsic to the type, so it declares a number
 *     and no options at all.
 *  2. **The measure is `ordinal`, not `scale`.** The points are ranked but the distances between
 *     them are not asserted — nobody established that "somewhat satisfied" sits exactly midway —
 *     and SPSS's measure level decides which analyses the tool offers over the column. `scale`
 *     would invite means over intervals the instrument never measured; `nominal` would hide the
 *     ranking that is the whole point. (NPS declares `scale` because the NPS literature *defines*
 *     the score as a mean; no such definition exists for an arbitrary rating.)
 *
 * Anchors are optional here, unlike NPS's required pair: a radio scale carries a full label on
 * every point, so anchors add nothing. The moment the display drops the labels ('stars',
 * 'buttons'), an unanchored scale becomes a different question to each respondent — which is a
 * static-check warning, not a schema rule, because only the display decides whether it matters.
 */

import { itemCode } from '../../contract/items.js';
import { asOptionCode, asPlainObject, err, ok, type ResponseCodec } from '../../contract/codec.js';
import { KIT_MESSAGE_KEYS, type ValidationIssue } from '../../contract/validate.js';
import type { PluginDiagnostic } from '../../contract/diagnostics.js';
import type { QuestionTypePluginCore } from '../../contract/plugin.js';
import type { A11yContract } from '../../contract/a11y.js';
import type { JsonSchema } from '../../json-schema.js';
import type { OptionCode } from '../../contract/items.js';
import type { VariableDeclaration } from '../../contract/variables.js';

export interface RatingConfig {
  readonly display: 'radio' | 'stars' | 'buttons';
  /** Anchor labels. `null` rather than absent while unset: `exactOptionalPropertyTypes` makes
   * "absent" and "null" different values, and a config with two spellings of "no anchor" would
   * make two identical questions compare unequal. */
  readonly lowLabelKey: string | null;
  readonly highLabelKey: string | null;
  /** Show the point's code alongside its visual ("4" under the fourth star). */
  readonly showNumbers: boolean;
}

export interface RatingAnswer {
  /** The selected scale point's code, `null` when unanswered. */
  readonly code: OptionCode | null;
}

export const RATING_CONFIG_SCHEMA: JsonSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  properties: {
    display: { enum: ['radio', 'stars', 'buttons'], default: 'radio' },
    lowLabelKey: { type: ['string', 'null'], default: null },
    highLabelKey: { type: ['string', 'null'], default: null },
    showNumbers: { type: 'boolean', default: true },
  },
};

const codec: ResponseCodec<RatingConfig, RatingAnswer> = {
  parse(raw) {
    if (raw === null || raw === undefined) return ok({ code: null });
    const record = asPlainObject(raw);
    if (record === undefined) return err({ code: 'shape', message: 'expected an object' });
    const code = asOptionCode(record['code']);
    if (code === undefined) {
      return err({ code: 'shape', message: 'code must be a scalar or null', path: '/code' });
    }
    // Same split as single-select: the codec rejects the wrong kind of thing, `validate` rejects
    // a scalar outside the authored domain, and ADR-004 runs both on both sides.
    return ok({ code });
  },

  toVariables(answer, ctx) {
    return { [ctx.name.self()]: answer.code };
  },

  fromVariables(vars, ctx) {
    const code = vars[ctx.name.self()];
    return { code: typeof code === 'number' || typeof code === 'string' ? code : null };
  },

  emptyAnswer: () => ({ code: null }),
};

export const ratingCore: QuestionTypePluginCore<RatingConfig, RatingAnswer> = {
  meta: {
    id: 'rating',
    version: '1.0.0',
    displayName: 'qt.rating.name',
    description: 'qt.rating.desc',
    category: 'scale',
    icon: 'star',
    entitlementKey: null,
    // Advisory only: `registry.register` overwrites this with the tier of the source (F §6).
    trust: 'first_party',
    // One self-named enum, no companions — a rating cell in a matrix ("Rate each brand") is the
    // other canonical composed control besides numeric, and the scoped namer covers it entirely.
    composable: true,
    emitsData: true,
  },

  configSchema: RATING_CONFIG_SCHEMA,

  defaultConfig: () => ({
    display: 'radio',
    lowLabelKey: null,
    highLabelKey: null,
    showNumbers: true,
  }),

  declareVariables(ctx) {
    const declaration: VariableDeclaration = {
      name: ctx.name.self(),
      kind: 'response',
      type: 'enum',
      // Codes come from the authored scale point, NOT from an iteration index. Reversing the
      // scale in the editor must not renumber the domain (F §1.1 rule 2) — that is a relabelling
      // of the instrument and shows up as such, not as a silent column-value flip.
      enumDomain: ctx.options.map((option) => ({
        code: itemCode(option),
        labelKey: option.labelKey,
        ...(option.meta === undefined ? {} : { meta: option.meta }),
      })),
      source: { part: { kind: 'self' } },
      export: {
        include: !ctx.flags.excludeFromExport,
        column: ctx.name.self(),
        labelKey: `${ctx.ref}.label`,
        order: 0,
      },
      pii: ctx.flags.pii,
      persist: true,
      // `ordinal` — see the file header. Ranked, distances not asserted.
      analysis: { measure: 'ordinal' },
    };
    return [declaration];
  },

  validate(ctx) {
    const issues: ValidationIssue[] = [];
    const selected = ctx.value?.code ?? null;
    const selfName = ctx.question.variables.self ?? null;

    if (ctx.required && selected === null) {
      return [{ variableName: selfName, messageKey: KIT_MESSAGE_KEYS.required, severity: 'error' }];
    }
    if (selected === null) return issues;

    const domain = new Set<OptionCode>(ctx.question.options.map(itemCode));
    if (!domain.has(selected)) {
      // Only reachable via a tampered payload; the rendered points cannot produce it.
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
    columnLabel: (_declaration, ctx) => ctx.t(ctx.question.label),
    valueLabels: (declaration, ctx) =>
      declaration.type === 'enum'
        ? (declaration.enumDomain ?? []).map((entry) => ({
            code: entry.code,
            label: ctx.t(entry.labelKey),
          }))
        : [],
  },

  a11y: {
    // N mutually exclusive points are a radiogroup whatever they look like — stars included (see
    // nps's contract for the argument). Crucially NOT pointer-dependent: a star widget that only
    // responds to hover-and-click has no keyboard path, so the stars here are radios with arrows
    // moving the rating, direction-aware in RTL.
    interactionModel: 'radiogroup',
    requiredRoles: ['radiogroup', 'radio'],
    keys: ['Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'Space'],
    minTouchTargetPx: 44,
    pointerDependent: false,
    rtlSafe: true,
  } satisfies A11yContract,

  staticChecks(ctx) {
    const out: PluginDiagnostic[] = [];
    if (ctx.options.length === 0) {
      out.push({
        code: 'no_options',
        severity: 'error',
        message: 'rating requires at least one authored scale point',
        path: '/options',
      });
    }
    if (
      (ctx.config.display === 'stars' || ctx.config.display === 'buttons') &&
      ctx.config.lowLabelKey === null &&
      ctx.config.highLabelKey === null
    ) {
      // A warning, not an error: the survey still runs, it just measures something fuzzier than
      // the author thinks. "5 stars out of what?" is answered differently by every respondent,
      // and the disagreement is invisible in the data — which is why it is flagged at authoring
      // time, the only moment anyone can still fix it.
      out.push({
        code: 'unanchored_scale',
        severity: 'warning',
        message:
          `display "${ctx.config.display}" hides the point labels; without anchor labels the ` +
          'scale direction and meaning are left to each respondent',
        path: '/config/display',
      });
    }
    return out;
  },
};
