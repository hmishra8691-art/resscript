/**
 * `media_select` — choose by picture, not by text: `Q : enum` or `Qr1..Qrn : boolean` (P2-05).
 *
 * **Why this is not `single_select` with `display: 'image_grid'`.** That configuration exists and
 * renders images, and for a question whose options happen to have pictures it is the right tool.
 * The difference here is not the layout — it is what the plugin REFUSES to publish.
 *
 * A media select's options are chosen by looking at them, so:
 *
 *  1. **Every option must have media.** A grid of five pictures and one bare text option is not a
 *     media question; it is a broken one, and the respondent cannot tell whether the sixth image
 *     failed to load. `single_select` cannot enforce this — media is optional there by design —
 *     so a survey built that way ships and the defect surfaces as a support ticket about a missing
 *     image.
 *  2. **Every option must have alt text.** For a text option the label IS the alternative; for an
 *     image option there is nothing else, so an image with no alt is a question a screen-reader
 *     user cannot answer at all. This is the one static check in the kit that exists purely for
 *     accessibility, and it is an ERROR rather than a warning for that reason: a warning here is
 *     acknowledged once and then the survey fields with unanswerable options.
 *  3. **The media should be of one kind.** A grid mixing images with video tiles asks the
 *     respondent to compare things presented differently, which is a measurement problem rather
 *     than a rendering one. Warned, not blocked — a legitimate design occasionally wants it.
 *
 * **One plugin, both selection modes.** `mode: 'single' | 'multi'` rather than two plugins, because
 * everything above is identical either way and the variable shape is the only difference — an enum
 * for single, a boolean fan-out for multi, exactly as `single_select` and `multi_select` declare
 * them. Two plugins would duplicate three static checks and a media renderer to vary one field.
 */

import {
  CODEC_LIMITS,
  asOptionCode,
  asPlainObject,
  err,
  ok,
  type ResponseCodec,
} from '../../contract/codec.js';
import { itemCode, type AuthoredItem } from '../../contract/items.js';
import { KIT_MESSAGE_KEYS, type ValidationIssue } from '../../contract/validate.js';
import type { PluginDiagnostic } from '../../contract/diagnostics.js';
import type { QuestionTypePluginCore } from '../../contract/plugin.js';
import type { A11yContract } from '../../contract/a11y.js';
import type { JsonSchema } from '../../json-schema.js';
import type { VariableDeclaration } from '../../contract/variables.js';
import type { OptionCode } from '../../contract/items.js';

export type MediaSelectMode = 'single' | 'multi';

export interface MediaSelectConfig {
  readonly mode: MediaSelectMode;
  readonly columns: 1 | 2 | 3 | 4;
  /** Show each option's label under its tile. Off means the picture must speak for itself. */
  readonly show_labels?: boolean;
  /** For `multi`: bounds on how many tiles may be chosen. `0` means unbounded. */
  readonly min_selected?: number;
  readonly max_selected?: number;
}

export interface MediaSelectAnswer {
  /**
   * For `single`: the chosen code, or `null`.
   *
   * Present in both modes and unused in `multi`, rather than a discriminated union, because the
   * codec must have exactly ONE empty answer — a union would give it two spellings of "nothing
   * chosen" and fail its own round-trip.
   */
  readonly code: OptionCode | null;
  /** For `multi`: the chosen codes, sorted and deduped. Empty in `single`. */
  readonly codes: readonly OptionCode[];
}

export const MEDIA_SELECT_CONFIG_SCHEMA: JsonSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  required: ['mode', 'columns'],
  properties: {
    mode: { enum: ['single', 'multi'], default: 'single' },
    columns: { type: 'integer', minimum: 1, maximum: 4, default: 2 },
    show_labels: { type: 'boolean', default: true },
    min_selected: { type: 'integer', minimum: 0, default: 0 },
    max_selected: { type: 'integer', minimum: 0, default: 0 },
  },
};

/** Does this item carry a usable picture? `media` present is not enough — the URL/asset is. */
export function hasMedia(item: AuthoredItem): boolean {
  const asset = item.media?.imageAssetId;
  return asset !== undefined && asset !== null && asset !== '';
}

/** Does it carry a text alternative? An empty key claims the image is decorative, which it is not. */
export function hasAlt(item: AuthoredItem): boolean {
  const alt = item.media?.altKey;
  return alt !== undefined && alt !== null && alt !== '';
}

const codec: ResponseCodec<MediaSelectConfig, MediaSelectAnswer> = {
  parse(raw, ctx) {
    const empty = { code: null, codes: [] };
    if (raw === null || raw === undefined) return ok(empty);
    const record = asPlainObject(raw);
    if (record === undefined) return err({ code: 'shape', message: 'expected an object' });

    const domain = new Set<OptionCode>(ctx.question.options.map(itemCode));

    if (ctx.config.mode === 'single') {
      const code = asOptionCode(record['code']);
      if (code === undefined) {
        return err({ code: 'shape', message: 'code is not a code', path: '/code' });
      }
      if (code === null) return ok(empty);
      if (!domain.has(code)) {
        // The UI offers only authored options, so a code outside the domain is a forged payload.
        return err({
          code: 'unknown_key',
          message: `no option with code ${String(code)}`,
          path: '/code',
        });
      }
      return ok({ code, codes: [] });
    }

    const rawCodes = record['codes'];
    if (rawCodes === undefined || rawCodes === null) return ok(empty);
    if (!Array.isArray(rawCodes)) {
      return err({ code: 'shape', message: 'codes must be an array', path: '/codes' });
    }
    // Checked BEFORE the loop, so a 10,000-entry payload costs a length comparison rather than
    // 10,000 allocations (F §9's hostile input list) — the shared limit `multi_select` uses.
    //
    // Bounded by `maxItems` and NOT by the option count, which was the first attempt: honest
    // clients do send duplicates (a double-tap, a resubmitted form), the Set below dedups them,
    // and rejecting `[3,1,3,1]` on a three-option question would refuse a selection the respondent
    // legitimately made.
    if (rawCodes.length > CODEC_LIMITS.maxItems) {
      return err({ code: 'too_large', message: 'too many selections', path: '/codes' });
    }
    const seen = new Set<OptionCode>();
    for (const entry of rawCodes) {
      const code = asOptionCode(entry);
      if (code === undefined || code === null) {
        return err({ code: 'shape', message: 'codes must be codes', path: '/codes' });
      }
      if (!domain.has(code)) {
        return err({
          code: 'unknown_key',
          message: `no option with code ${String(code)}`,
          path: '/codes',
        });
      }
      seen.add(code);
    }
    // Sorted and deduped, so one selection has exactly one representation — the same normalization
    // the engine's `set` values get (D §2.2), and what makes the round-trip property hold.
    const codes = [...seen].sort((a, b) => (String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0));
    return ok({ code: null, codes });
  },

  toVariables(answer, ctx) {
    if (ctx.config.mode === 'single') {
      return { [ctx.name.self()]: answer.code };
    }
    const chosen = new Set(answer.codes);
    const out: Record<string, boolean> = {};
    for (const option of ctx.question.options) {
      // Every option gets a boolean, including `false`: "offered and not chosen" and "never
      // offered" are different facts, and an absent key is how the second is represented.
      out[ctx.name.option(option.code)] = chosen.has(itemCode(option));
    }
    return out;
  },

  fromVariables(vars, ctx) {
    if (ctx.config.mode === 'single') {
      const value = vars[ctx.name.self()];
      return {
        code: typeof value === 'number' || typeof value === 'string' ? value : null,
        codes: [],
      };
    }
    const codes: OptionCode[] = [];
    for (const option of ctx.question.options) {
      if (vars[ctx.name.option(option.code)] === true) codes.push(itemCode(option));
    }
    return { code: null, codes };
  },

  emptyAnswer: () => ({ code: null, codes: [] }),
};

export const mediaSelectCore: QuestionTypePluginCore<MediaSelectConfig, MediaSelectAnswer> = {
  meta: {
    id: 'media_select',
    version: '1.0.0',
    displayName: 'qt.media_select.name',
    description: 'qt.media_select.desc',
    category: 'media',
    icon: 'image',
    entitlementKey: null,
    trust: 'first_party',
    // NOT composable. In `single` mode one enum would fit a cell, but `multi` fans out to one
    // boolean per option and a cell scope cannot name a fan-out — and a plugin whose composability
    // depended on a config field would be a configuration the studio offers and the compiler then
    // refuses. One answer for both modes, and it is the conservative one.
    composable: false,
    emitsData: true,
  },

  configSchema: MEDIA_SELECT_CONFIG_SCHEMA,

  defaultConfig: () => ({ mode: 'single', columns: 2, show_labels: true }),

  declareVariables(ctx) {
    if (ctx.config.mode === 'single') {
      const declaration: VariableDeclaration = {
        name: ctx.name.self(),
        kind: 'response',
        type: 'enum',
        // Codes come from the authored option, never from grid position: reordering the tiles must
        // not renumber the domain (F §1.1 rule 2).
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
        analysis: { measure: 'nominal' },
      };
      return [declaration];
    }

    const out: VariableDeclaration[] = [];
    for (const option of ctx.options) {
      out.push({
        name: ctx.name.option(option.code),
        kind: 'response',
        type: 'boolean',
        source: { part: { kind: 'option', optionRef: option.ref } },
        export: {
          include: !ctx.flags.excludeFromExport,
          column: ctx.name.option(option.code),
          labelKey: option.labelKey,
          // Order from the code, never the loop index — the same rule as the domain above.
          order: option.code,
        },
        pii: ctx.flags.pii,
        persist: true,
        // A battery: the tiles are one instrument, and SPSS metadata groups them so the analyst
        // sees the grid rather than n orphan columns.
        analysis: { measure: 'nominal', batteryRef: ctx.ref },
      });
    }
    return out;
  },

  validate(ctx) {
    const issues: ValidationIssue[] = [];
    const config = ctx.question.config;
    const selfName = ctx.question.variables.self ?? null;
    const visible = ctx.question.options.filter((option) => option.visible);

    if (config.mode === 'single') {
      const code = ctx.value?.code ?? null;
      if (ctx.required && code === null) {
        return [{ variableName: selfName, messageKey: KIT_MESSAGE_KEYS.required, severity: 'error' }];
      }
      if (code === null) return issues;
      // Defensive: the codec rejects an out-of-domain code first. Reachable from a stale Answer
      // held across a republish that removed a tile.
      if (!visible.some((option) => itemCode(option) === code)) {
        issues.push({
          variableName: selfName,
          messageKey: KIT_MESSAGE_KEYS.invalidOption,
          severity: 'error',
        });
      }
      return issues;
    }

    const codes = ctx.value?.codes ?? [];
    if (codes.length === 0) {
      return ctx.required
        ? [{ variableName: null, messageKey: KIT_MESSAGE_KEYS.required, severity: 'error' }]
        : issues;
    }
    const min = config.min_selected ?? 0;
    const max = config.max_selected ?? 0;
    if (min > 0 && codes.length < min) {
      issues.push({
        variableName: null,
        messageKey: KIT_MESSAGE_KEYS.tooFewSelected,
        params: { min },
        severity: 'error',
      });
    }
    if (max > 0 && codes.length > max) {
      issues.push({
        variableName: null,
        messageKey: KIT_MESSAGE_KEYS.tooManySelected,
        params: { max },
        severity: 'error',
      });
    }
    return issues;
  },

  codec,

  exportContribution: {
    columnLabel: (declaration, ctx) =>
      declaration.source.part.kind === 'option'
        ? `${ctx.t(ctx.question.label)} — ${ctx.t(declaration.export.labelKey)}`
        : ctx.t(ctx.question.label),
    // For `single` the domain's labels make the column readable; for `multi` each boolean column
    // is already named by its option, and labelling true/false would add nothing.
    valueLabels: (declaration, ctx) =>
      (declaration.enumDomain ?? []).map((entry) => ({
        code: entry.code,
        label: ctx.t(entry.labelKey),
      })),
  },

  a11y: {
    // The tiles are radios or checkboxes with a picture as their label — not a custom widget. A
    // `listbox` of images would be a bespoke pattern to reimplement what the platform gives.
    //
    // The declared roles are the SINGLE-mode ones. `multi` renders a `group` of `checkbox`es (the
    // shape `multi_select` declares), and the test spec overrides per fixture via `rolesByFixture`
    // rather than this list being widened to the union: a union would let a single-mode question
    // pass while rendering checkboxes, which is the failure the contract exists to catch.
    interactionModel: 'radiogroup',
    requiredRoles: ['radiogroup', 'radio'],
    keys: ['Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'Space'],
    // Bigger than the floor: the target IS the picture, and a 44px tile is not a picture anyone
    // chooses between. Declared here so the harness holds the plugin to its own claim.
    minTouchTargetPx: 64,
    pointerDependent: false,
    rtlSafe: true,
  } satisfies A11yContract,

  staticChecks(ctx) {
    const out: PluginDiagnostic[] = [];
    const config = ctx.config;

    if (ctx.options.length === 0) {
      out.push({
        code: 'no_options',
        severity: 'error',
        message: 'a media select needs options to show',
        path: '/options',
      });
    }

    // The three checks this plugin exists for — see the header.
    for (const [i, option] of ctx.options.entries()) {
      if (!hasMedia(option)) {
        out.push({
          code: 'option_without_media',
          severity: 'error',
          message:
            `option ${option.ref} has no media: a respondent choosing by picture cannot tell a ` +
            'missing image from an option that was meant to be text',
          path: `/options/${String(i)}/media`,
        });
        continue;
      }
      if (!hasAlt(option)) {
        // An ERROR, not a warning: an image with no text alternative is a question a
        // screen-reader user cannot answer, and a warning here is acknowledged once and then the
        // survey fields with unanswerable options.
        out.push({
          code: 'media_without_alt',
          severity: 'error',
          message:
            `option ${option.ref} has an image with no alt text: for a text option the label is ` +
            'the alternative, but here there is nothing else to read',
          path: `/options/${String(i)}/media/altKey`,
        });
      }
    }

    if (config.mode === 'single') {
      if ((config.min_selected ?? 0) > 0 || (config.max_selected ?? 0) > 0) {
        out.push({
          code: 'selection_bounds_ignored',
          severity: 'warning',
          message: 'single mode chooses exactly one tile; min_selected/max_selected are ignored',
          path: '/config/min_selected',
        });
      }
    } else {
      const min = config.min_selected ?? 0;
      const max = config.max_selected ?? 0;
      if (min > 0 && max > 0 && min > max) {
        out.push({
          code: 'impossible_bounds',
          severity: 'error',
          message: `min_selected (${min}) exceeds max_selected (${max}), so no answer can validate`,
          path: '/config/min_selected',
        });
      }
      if (min > ctx.options.length) {
        out.push({
          code: 'impossible_bounds',
          severity: 'error',
          message: `min_selected (${min}) exceeds the ${ctx.options.length} tiles offered`,
          path: '/config/min_selected',
        });
      }
    }

    if (ctx.rows.length > 0) {
      out.push({
        code: 'rows_ignored',
        severity: 'warning',
        message: 'media_select shows its options; authored rows are ignored',
        path: '/rows',
      });
    }
    return out;
  },
};
