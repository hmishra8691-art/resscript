/**
 * `content_media` — an image/video/audio stimulus (F §10's content node; roadmap P1-05).
 *
 * A content block like `content_text`, with one twist that makes it worth its own file:
 * `trackExposure` turns "declares nothing" into "declares two telemetry variables",
 * `Q_viewed : boolean` and `Q_dwell_s : number`.
 *
 * ## Why the telemetry variables are `kind: 'response'`, stated in full
 *
 * They are runtime-measured paradata, not respondent-entered answers, and the honest schema
 * kind would be `system` — but F §6 reserves `system`/`quota`/`design` for the platform, so the
 * kit's `DeclarationKind` offers a plugin exactly `response` and `derived`. `derived` is a lie
 * twice over (there is no sibling to derive from, and both `Derivation` shapes require one), so
 * `response` it is: "a variable the respondent's *session* writes", read slightly wider than
 * "the respondent's answer". The consequence to know about: `response` variables must persist
 * (`verifyDeclarations` rule 5), which is also what exposure telemetry needs — a dwell time
 * recomputable from nothing is a dwell time lost. The runtime writes both variables; this
 * plugin's codec never does (same posture as `consent`'s timestamp, and for the same ADR-006
 * reason — the codec has no clock and must not want one).
 *
 * ## Why `emitsData` is `false` even though the plugin *can* declare variables
 *
 * The flag's one consumer that branches on it (the compiler's CMP-0102 pass) reads it as "is an
 * empty emission list this type doing its job?" — and only consults it when the emission list
 * is actually empty. For this plugin, empty is the untracked common case and is correct, so
 * `false` is the value that stops every plain image from being warned about; when
 * `trackExposure` is on, the declared variables short-circuit the check before the flag is
 * read. Setting `true` would misfire the warning on exactly the configurations that are fine.
 */

import { asPlainObject, err, ok, type ResponseCodec } from '../../contract/codec.js';
import type { PluginDiagnostic } from '../../contract/diagnostics.js';
import type { QuestionTypePluginCore } from '../../contract/plugin.js';
import type { A11yContract } from '../../contract/a11y.js';
import type { JsonSchema } from '../../json-schema.js';
import type { VariableDeclaration } from '../../contract/variables.js';

export interface ContentMediaConfig {
  readonly kind: 'image' | 'video' | 'audio';
  /**
   * The asset reference. An id at authoring time; the runtime resolves it to a URL before the
   * config reaches a renderer, because plugins never resolve assets (F §6 — the same rule that
   * puts `imageUrl`, not `imageAssetId`, on `ResolvedItem`).
   */
  readonly assetRef: string;
  /** Alt text (image) / accessible name (video, audio). Required for images — see staticChecks. */
  readonly altKey?: string;
  readonly autoplay: boolean;
  /** Declare and collect `Q_viewed` / `Q_dwell_s` exposure telemetry. */
  readonly trackExposure: boolean;
}

/** A stimulus has no answer — one inhabitant, one empty state (see `content-text/core.ts`). */
export type ContentMediaAnswer = null;

export const CONTENT_MEDIA_CONFIG_SCHEMA: JsonSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'assetRef'],
  properties: {
    kind: { enum: ['image', 'video', 'audio'] },
    // The empty string is schema-legal so `defaultConfig` can insert a not-yet-picked stimulus
    // (the `single_select` `optionRef: null` mid-edit pattern); `staticChecks` is what blocks
    // publishing one.
    assetRef: { type: 'string', maxLength: 512 },
    altKey: { type: 'string', minLength: 1 },
    autoplay: { type: 'boolean', default: false },
    trackExposure: { type: 'boolean', default: false },
  },
};

/** The empty codec, byte-for-byte the `content_text` posture: emptiness in, emptiness out. */
const codec: ResponseCodec<ContentMediaConfig, ContentMediaAnswer> = {
  parse(raw) {
    if (raw === null || raw === undefined) return ok(null);
    const record = asPlainObject(raw);
    if (record === undefined) return err({ code: 'shape', message: 'a stimulus takes no answer' });
    if (Object.keys(record).length > 0) {
      // Includes a payload claiming `{ viewed: true }`: exposure is measured by the runtime,
      // never asserted by the client — a respondent-writable "I saw it" is worthless telemetry.
      return err({ code: 'unknown_key', message: 'a stimulus takes no answer' });
    }
    return ok(null);
  },
  toVariables: () => ({}),
  fromVariables: () => null,
  emptyAnswer: () => null,
};

export const contentMediaCore: QuestionTypePluginCore<ContentMediaConfig, ContentMediaAnswer> = {
  meta: {
    id: 'content_media',
    version: '1.0.0',
    displayName: 'qt.content_media.name',
    description: 'qt.content_media.desc',
    category: 'media',
    icon: 'image',
    entitlementKey: null,
    trust: 'first_party',
    /**
     * Not composable, twice over. The product reason: a stimulus in a grid cell is not a
     * control — a cell is somewhere the respondent answers, and there is nothing to answer.
     * The contract reason (which would bite even if the product said yes): `trackExposure`
     * names its variables through the suffix part, and no schema §4 part names `Q5r3_viewed` —
     * the same `compose_unnameable_part` wall as nps's band.
     */
    composable: false,
    // See the file header: `false` because the *empty* emission list is this type doing its
    // job; the tracked configuration bypasses the flag by actually declaring variables.
    emitsData: false,
  },

  configSchema: CONTENT_MEDIA_CONFIG_SCHEMA,

  defaultConfig: () => ({ kind: 'image', assetRef: '', autoplay: false, trackExposure: false }),

  declareVariables(ctx) {
    if (!ctx.config.trackExposure) return [];
    const shared = {
      kind: 'response' as const, // the honest kind is `system`; see the file header
      pii: ctx.flags.pii,
      persist: true,
    };
    const viewed: VariableDeclaration = {
      name: ctx.name.suffixed('viewed'),
      ...shared,
      type: 'boolean',
      source: { part: { kind: 'meta', label: 'exposure_viewed', suffix: 'viewed' } },
      export: {
        include: !ctx.flags.excludeFromExport,
        column: ctx.name.suffixed('viewed'),
        labelKey: `${ctx.ref}.viewed.label`,
        order: 0,
      },
      analysis: { measure: 'nominal', batteryRef: ctx.ref },
    };
    const dwell: VariableDeclaration = {
      name: ctx.name.suffixed('dwell_s'),
      ...shared,
      type: 'number',
      // No max: capping dwell would fabricate attention. `decimals` left unset — the runtime
      // measures, the runtime rounds.
      numericDomain: { min: 0 },
      source: { part: { kind: 'meta', label: 'exposure_dwell_seconds', suffix: 'dwell_s' } },
      export: {
        include: !ctx.flags.excludeFromExport,
        column: ctx.name.suffixed('dwell_s'),
        labelKey: `${ctx.ref}.dwell_s.label`,
        order: 1,
      },
      analysis: { measure: 'scale', batteryRef: ctx.ref },
    };
    return [viewed, dwell];
  },

  // Nothing to validate: the respondent contributes nothing, and the telemetry is written by
  // the runtime on a path that never passes through plugin validation.
  validate: () => [],

  codec,

  exportContribution: {
    columnLabel: (declaration, ctx) => {
      const part = declaration.source.part;
      const label = ctx.t(ctx.question.label);
      // The suffix is the provenance (the `date` plugin's convention for its meta parts).
      return part.kind === 'meta' ? `${label} — ${part.suffix}` : label;
    },
    valueLabels: () => [],
  },

  a11y: {
    /**
     * `custom_documented`, because the honest role depends on `kind`: an image is `img`, while
     * `<video>`/`<audio>` map to no ARIA role at all (the same "the native element has no role
     * the harness can assert" problem `date/core.ts` documents for the native date input). The
     * documented model: zero plugin-owned tab stops and zero keys handled — the media element's
     * *native* controls are the browser's, exactly like its date picker would have been. The
     * per-kind role assertion lives in the test spec's `rolesByFixture`.
     */
    interactionModel: 'custom_documented',
    requiredRoles: [],
    keys: ['Tab'],
    minTouchTargetPx: 44,
    pointerDependent: false,
    rtlSafe: true,
  } satisfies A11yContract,

  staticChecks(ctx) {
    const out: PluginDiagnostic[] = [];
    if (ctx.config.assetRef.trim() === '') {
      out.push({
        code: 'missing_asset',
        severity: 'error',
        message: 'no asset is selected; a stimulus with nothing to show is an empty page section',
        path: '/config/assetRef',
      });
    }
    if (ctx.config.kind === 'image' && (ctx.config.altKey === undefined || ctx.config.altKey.trim() === '')) {
      // An ERROR, not a warning: an unlabelled stimulus fails every a11y audit, and "the image
      // the whole question is about" is the worst possible place for a screen reader to go
      // silent. Video/audio degrade to their own media; an image degrades to nothing.
      out.push({
        code: 'missing_alt',
        severity: 'error',
        message: 'an image stimulus must declare altKey: without it the stimulus does not exist for a screen-reader respondent',
        path: '/config/altKey',
      });
    }
    if (ctx.config.autoplay && (ctx.config.kind === 'video' || ctx.config.kind === 'audio')) {
      out.push({
        code: 'autoplay_discouraged',
        severity: 'warning',
        message: 'autoplaying media with sound fails WCAG 1.4.2 and gets the survey muted or closed; prefer respondent-initiated playback',
        path: '/config/autoplay',
      });
    }
    if (ctx.options.length > 0) {
      out.push({
        code: 'options_ignored',
        severity: 'warning',
        message: 'content_media renders no control; authored options are ignored',
        path: '/options',
      });
    }
    if (ctx.required) {
      out.push({
        code: 'required_ignored',
        severity: 'warning',
        message: 'a stimulus collects nothing the respondent enters, so required can never be satisfied and is ignored',
        path: '/required',
      });
    }
    return out;
  },
};
