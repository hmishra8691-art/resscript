/**
 * `single_select` — Deliverable F §2, the reference implementation.
 *
 * Included in full because it is the plugin every other plugin is read against, and because the
 * interesting parts are already here: the set-free enum domain, codes versus positions, and the
 * `_other` companion variable.
 */

import { itemCode, type AuthoredItem } from '../../contract/items.js';
import {
  asOptionCode,
  asPlainObject,
  err,
  ok,
  readBoundedText,
  type ResponseCodec,
} from '../../contract/codec.js';
import { KIT_MESSAGE_KEYS, type ValidationIssue } from '../../contract/validate.js';
import type { PluginDiagnostic } from '../../contract/diagnostics.js';
import type { QuestionTypePluginCore } from '../../contract/plugin.js';
import type { A11yContract } from '../../contract/a11y.js';
import type { JsonSchema } from '../../json-schema.js';
import type { OptionCode } from '../../contract/items.js';
import type { VariableDeclaration } from '../../contract/variables.js';

export interface SingleSelectOtherConfig {
  readonly enabled: boolean;
  /** Which authored option opens the verbatim box. `null` while the author is mid-edit. */
  readonly optionRef: string | null;
  readonly maxLen: number;
  readonly required: boolean;
}

export interface SingleSelectConfig {
  readonly display: 'vertical' | 'horizontal' | 'dropdown' | 'button_group' | 'image_grid';
  readonly columns: 1 | 2 | 3 | 4;
  readonly other: SingleSelectOtherConfig;
  readonly allowDeselect: boolean;
}

export interface SingleSelectAnswer {
  readonly code: OptionCode | null;
  /** Always present, `null` when empty: `exactOptionalPropertyTypes` makes "absent" and "null"
   * different values, and a codec that can return either has two empty answers. */
  readonly otherText: string | null;
}

export const SINGLE_SELECT_CONFIG_SCHEMA: JsonSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  required: ['display', 'other'],
  properties: {
    display: { enum: ['vertical', 'horizontal', 'dropdown', 'button_group', 'image_grid'] },
    columns: { type: 'integer', minimum: 1, maximum: 4, default: 1 },
    other: {
      type: 'object',
      additionalProperties: false,
      required: ['enabled'],
      properties: {
        enabled: { type: 'boolean', default: false },
        optionRef: { type: ['string', 'null'], default: null },
        maxLen: { type: 'integer', minimum: 1, maximum: 4000, default: 200 },
        required: { type: 'boolean', default: true },
      },
    },
    allowDeselect: { type: 'boolean', default: false },
  },
};

const codec: ResponseCodec<SingleSelectConfig, SingleSelectAnswer> = {
  parse(raw, ctx) {
    if (raw === null || raw === undefined) return ok({ code: null, otherText: null });
    const record = asPlainObject(raw);
    if (record === undefined) return err({ code: 'shape', message: 'expected an object' });
    const code = asOptionCode(record['code']);
    if (code === undefined) {
      return err({ code: 'shape', message: 'code must be a scalar or null', path: '/code' });
    }
    const text = readBoundedText(record['otherText'], ctx.config.other.maxLen);
    if (!text.ok) {
      return err({
        code: text.code,
        message: text.code === 'shape' ? 'otherText must be a string' : 'otherText is too large',
        path: '/otherText',
      });
    }
    return ok({ code, otherText: text.value });
  },

  toVariables(answer, ctx) {
    const out: Record<string, OptionCode | null> = { [ctx.name.self()]: answer.code };
    if (ctx.config.other.enabled) out[ctx.name.other()] = answer.otherText;
    return out;
  },

  fromVariables(vars, ctx) {
    const code = vars[ctx.name.self()];
    const text = ctx.config.other.enabled ? vars[ctx.name.other()] : null;
    return {
      code: typeof code === 'number' || typeof code === 'string' ? code : null,
      otherText: typeof text === 'string' ? text : null,
    };
  },

  emptyAnswer: () => ({ code: null, otherText: null }),
};

/** Is the currently selected code the author's designated "other, specify" option? */
function otherIsSelected(
  optionRef: string | null,
  selected: OptionCode | null,
  refOf: (code: OptionCode) => string | undefined,
): boolean {
  if (optionRef === null || selected === null) return false;
  return refOf(selected) === optionRef;
}

export const singleSelectCore: QuestionTypePluginCore<SingleSelectConfig, SingleSelectAnswer> = {
  meta: {
    id: 'single_select',
    version: '1.0.0',
    displayName: 'qt.single_select.name',
    description: 'qt.single_select.desc',
    category: 'choice',
    icon: 'radio',
    entitlementKey: null,
    // Advisory only: `registry.register` overwrites this with the tier of the source (F §6).
    trust: 'first_party',
    composable: true,
    emitsData: true,
  },

  configSchema: SINGLE_SELECT_CONFIG_SCHEMA,

  defaultConfig: (ctx) => ({
    // A cell control inside a grid gets a dropdown: a 7-across button group in a table cell is
    // unanswerable on a phone, and the mobile layout decision belongs to the plugin (F §8).
    display: ctx.asCellControl ? 'dropdown' : 'vertical',
    columns: 1,
    other: { enabled: false, optionRef: null, maxLen: 200, required: true },
    allowDeselect: false,
  }),

  declareVariables(ctx) {
    const out: VariableDeclaration[] = [
      {
        name: ctx.name.self(),
        kind: 'response',
        type: 'enum',
        // Codes come from the authored option, NOT from an iteration index. Reordering the list
        // must not renumber the domain (F §1.1 rule 2).
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
      },
    ];

    if (ctx.config.other.enabled) {
      out.push({
        name: ctx.name.other(),
        kind: 'response',
        type: 'text',
        source: { part: { kind: 'other_specify' } },
        export: {
          include: !ctx.flags.excludeFromExport,
          column: ctx.name.other(),
          labelKey: `${ctx.ref}.other.label`,
          // A constant, not `out.length`: `export.order` is part of the export contract, and a
          // value derived from how many variables happened to come first is a position in
          // disguise.
          order: 1,
        },
        // An open-end is PII by default. The author may clear it; they may not accidentally leave
        // it unset — a column wrongly marked PII is an annoyance, one wrongly unmarked is an
        // incident.
        pii: true,
        persist: true,
        analysis: { measure: 'nominal' },
      });
    }
    return out;
  },

  validate(ctx) {
    const issues: ValidationIssue[] = [];
    const selected = ctx.value?.code ?? null;
    const selfName = ctx.question.variables.self ?? null;

    if (ctx.required && selected === null) {
      // One error per field: piling "required" and "too long" onto the same control makes the
      // respondent read two messages to fix one thing.
      return [{ variableName: selfName, messageKey: KIT_MESSAGE_KEYS.required, severity: 'error' }];
    }
    if (selected === null) return issues;

    const domain = new Set<OptionCode>(ctx.question.options.map(itemCode));
    if (!domain.has(selected)) {
      // Only reachable via a tampered payload; the codec normally rejects first.
      issues.push({
        variableName: selfName,
        messageKey: KIT_MESSAGE_KEYS.invalidOption,
        severity: 'error',
      });
      return issues;
    }

    const otherName = ctx.question.variables.other ?? null;
    const isOther = otherIsSelected(ctx.question.config.other.optionRef, selected, (code) =>
      ctx.question.optionRefOf(code),
    );
    const text = ctx.value?.otherText ?? '';
    if (isOther && ctx.question.config.other.required && text.trim() === '') {
      issues.push({
        variableName: otherName,
        messageKey: KIT_MESSAGE_KEYS.otherRequired,
        severity: 'error',
      });
    }
    if ([...text].length > ctx.question.config.other.maxLen) {
      issues.push({
        variableName: otherName,
        messageKey: KIT_MESSAGE_KEYS.tooLong,
        params: { max: ctx.question.config.other.maxLen },
        severity: 'error',
      });
    }
    return issues;
  },

  codec,

  exportContribution: {
    columnLabel: (declaration, ctx) =>
      declaration.source.part.kind === 'other_specify'
        ? `${ctx.t(ctx.question.label)} — other (specify)`
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
    interactionModel: 'radiogroup',
    requiredRoles: ['radiogroup', 'radio'],
    keys: ['Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'Space'],
    minTouchTargetPx: 44,
    pointerDependent: false,
    rtlSafe: true,
  } satisfies A11yContract,

  staticChecks(ctx) {
    const out: PluginDiagnostic[] = [];
    if (ctx.config.other.enabled && ctx.config.other.optionRef === null) {
      out.push({
        code: 'other_option_unset',
        severity: 'error',
        message: 'other.enabled is true but no option is designated as "other, specify"',
        path: '/config/other/optionRef',
      });
    }
    if (
      ctx.config.other.optionRef !== null &&
      !ctx.options.some((option: AuthoredItem) => option.ref === ctx.config.other.optionRef)
    ) {
      out.push({
        code: 'other_option_missing',
        severity: 'error',
        message: `other.optionRef points at ${JSON.stringify(ctx.config.other.optionRef)}, which is not an option`,
        path: '/config/other/optionRef',
      });
    }
    if (ctx.options.length === 0) {
      out.push({
        code: 'no_options',
        severity: 'error',
        message: 'single_select requires at least one option',
        path: '/options',
      });
    }
    if (ctx.options.some((option) => option.exclusive === true)) {
      out.push({
        code: 'exclusive_on_single',
        severity: 'warning',
        message: 'option.exclusive has no effect on a single-select',
        path: '/options',
      });
    }
    if (ctx.config.display === 'dropdown' && ctx.options.length > 60) {
      out.push({
        code: 'long_dropdown',
        severity: 'warning',
        message: 'dropdowns above ~60 options measurably depress data quality',
        path: '/config/display',
      });
    }
    return out;
  },
};
