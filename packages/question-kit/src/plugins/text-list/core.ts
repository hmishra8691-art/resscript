/**
 * `text_list` — n labelled open-end boxes, one `Qr1..Qrn : text` variable per authored item
 * (F §10's catalogue: the "brand you use / brand you'd switch to" battery, the top-3 mentions).
 *
 * Structurally this is `multi_select`'s fan-out with text where the booleans were: every authored
 * option is one box, every box is one variable named by the option's **code** through
 * `ctx.name.option(...)`, and reordering the list must not move a single column (F §1.1 rule 2).
 * There is no derived set view — a collection of verbatims has no membership fact to collect — so
 * the fan-out is the whole declaration.
 *
 * `pii` is hard `true` on every box, same argument as `text`: the boolean flags view cannot say
 * "the author explicitly cleared it", and an unmarked open end is an incident where an over-marked
 * one is an annoyance.
 */

import { itemCode } from '../../contract/items.js';
import {
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
import type { VariableDeclaration } from '../../contract/variables.js';

/** Keys only this plugin emits — see `../textarea/core.ts` for why they are not in the kit list. */
export const TEXT_LIST_MESSAGE_KEYS = {
  tooFewAnswered: 'qt.text_list.err.too_few_answered',
} as const;

export interface TextListConfig {
  /** Per box. */
  readonly maxLen: number;
  /** `0` = no floor. "At least N boxes filled", checked only when there is any answer at all. */
  readonly minAnswered: number;
}

export interface TextListAnswer {
  /**
   * Keyed by *option ref*, because that is what the renderer has; variable names come from codes
   * at the codec boundary. Blank boxes are absent, never `''` — one empty state, not two.
   */
  readonly texts: Readonly<Record<string, string>>;
}

export const TEXT_LIST_CONFIG_SCHEMA: JsonSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  properties: {
    maxLen: { type: 'integer', minimum: 1, maximum: 4000, default: 200 },
    minAnswered: { type: 'integer', minimum: 0, default: 0 },
  },
};

const codec: ResponseCodec<TextListConfig, TextListAnswer> = {
  parse(raw, ctx) {
    if (raw === null || raw === undefined) return ok({ texts: {} });
    const record = asPlainObject(raw);
    if (record === undefined) return err({ code: 'shape', message: 'expected an object' });

    const texts: Record<string, string> = {};
    const rawTexts = record['texts'];
    if (rawTexts !== undefined && rawTexts !== null) {
      const map = asPlainObject(rawTexts);
      if (map === undefined) {
        return err({ code: 'shape', message: 'texts must be an object', path: '/texts' });
      }
      for (const [ref, value] of Object.entries(map)) {
        if (!ctx.question.options.some((option) => option.ref === ref)) {
          // A key outside the authored items is a forged payload, not a respondent mistake: the
          // UI renders one box per item and cannot produce another. Rejecting keeps `toVariables`
          // unable to write a column that was never declared (ADR-005 threat 3).
          return err({ code: 'unknown_key', message: `no item ${ref}`, path: '/texts' });
        }
        const read = readBoundedText(value, ctx.config.maxLen);
        if (!read.ok) {
          return err({
            code: read.code,
            message:
              read.code === 'shape' ? 'texts values must be strings' : 'a texts value is too large',
            path: '/texts',
          });
        }
        if (read.value !== null && read.value !== '') texts[ref] = read.value;
      }
    }
    return ok({ texts });
  },

  toVariables(answer, ctx) {
    const out: Record<string, string | null> = {};
    for (const option of ctx.question.options) {
      // Every box gets a value, including `null`. "Left blank" and "never shown" are different
      // facts, and an absent key is how the second one is represented.
      const value = answer.texts[option.ref];
      out[ctx.name.option(option.code)] = value === undefined || value === '' ? null : value;
    }
    return out;
  },

  fromVariables(vars, ctx) {
    const texts: Record<string, string> = {};
    for (const option of ctx.question.options) {
      const value = vars[ctx.name.option(option.code)];
      if (typeof value === 'string' && value !== '') texts[option.ref] = value;
    }
    return { texts };
  },

  emptyAnswer: () => ({ texts: {} }),
};

export const textListCore: QuestionTypePluginCore<TextListConfig, TextListAnswer> = {
  meta: {
    id: 'text_list',
    version: '1.0.0',
    displayName: 'qt.text_list.name',
    description: 'qt.text_list.desc',
    category: 'text',
    icon: 'list',
    entitlementKey: null,
    trust: 'first_party',
    /**
     * Not composable, and the reason is the fan-out rather than a policy — the same wall
     * `multi_select` documents: a cell control names itself through the scoped namer, whose
     * `option()` throws `compose_unnameable_part` because no schema §4 part describes `Q5r3r2`.
     * A grid of open-end boxes is `matrix` with a `text` cell control, not this.
     */
    composable: false,
    emitsData: true,
  },

  configSchema: TEXT_LIST_CONFIG_SCHEMA,

  defaultConfig: () => ({ maxLen: 200, minAnswered: 0 }),

  declareVariables(ctx) {
    return ctx.options.map(
      (option): VariableDeclaration => ({
        name: ctx.name.option(option.code),
        kind: 'response',
        type: 'text',
        source: { part: { kind: 'option', optionRef: option.ref } },
        export: {
          include: !ctx.flags.excludeFromExport,
          column: ctx.name.option(option.code),
          labelKey: option.labelKey,
          // Order from the *code*, never from the loop index: the export column order must not
          // move when the author drags a box up the list (F §1.1 rule 2).
          order: option.code,
        },
        // Hard `true`, deliberately not `ctx.flags.pii` — see the file header.
        pii: true,
        persist: true,
        analysis: { measure: 'nominal', batteryRef: ctx.ref },
      }),
    );
  },

  validate(ctx) {
    const issues: ValidationIssue[] = [];
    const texts = ctx.value?.texts ?? {};
    const config = ctx.question.config;

    // A key outside the authored items is only reachable via a tampered payload; the codec
    // normally rejects first, but the server-side validate must not trust that it ran (ADR-004).
    for (const ref of Object.keys(texts)) {
      if (!ctx.question.options.some((option) => option.ref === ref)) {
        return [{ variableName: null, messageKey: KIT_MESSAGE_KEYS.invalidOption, severity: 'error' }];
      }
    }

    const answered = ctx.question.options.filter(
      (option) => (texts[option.ref] ?? '').trim() !== '',
    );
    if (ctx.required && answered.length === 0) {
      return [{ variableName: null, messageKey: KIT_MESSAGE_KEYS.required, severity: 'error' }];
    }
    if (answered.length > 0 && config.minAnswered > 0 && answered.length < config.minAnswered) {
      issues.push({
        variableName: null,
        messageKey: TEXT_LIST_MESSAGE_KEYS.tooFewAnswered,
        params: { min: config.minAnswered },
        severity: 'error',
      });
    }

    for (const option of ctx.question.options) {
      const text = texts[option.ref] ?? '';
      if ([...text].length > config.maxLen) {
        issues.push({
          variableName: ctx.question.variables.byRow[option.ref] ?? null,
          messageKey: KIT_MESSAGE_KEYS.tooLong,
          params: { max: config.maxLen },
          severity: 'error',
          focus: { optionRef: option.ref },
        });
      }
    }
    return issues;
  },

  codec,

  exportContribution: {
    columnLabel: (declaration, ctx) =>
      declaration.source.part.kind === 'option'
        ? `${ctx.t(ctx.question.label)} — ${ctx.t(declaration.export.labelKey)}`
        : ctx.t(ctx.question.label),
    valueLabels: () => [],
  },

  a11y: {
    // n independent text boxes inside a labelled group: each box is legitimately its own tab
    // stop (there is no composite-widget pattern for a list of inputs), so `keys` is Tab alone.
    interactionModel: 'textbox',
    requiredRoles: ['group', 'textbox'],
    keys: ['Tab'],
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
        message: 'text_list requires at least one item: each authored item is one box',
        path: '/options',
      });
    }
    if (ctx.config.minAnswered > ctx.options.length) {
      out.push({
        code: 'impossible_answer_floor',
        severity: 'error',
        message: `minAnswered (${ctx.config.minAnswered}) exceeds the item count (${ctx.options.length}), so no answer can validate`,
        path: '/config/minAnswered',
      });
    }
    if (ctx.options.some((option) => option.exclusive === true || option.otherSpecify === true)) {
      out.push({
        code: 'item_flags_ignored',
        severity: 'warning',
        message: 'exclusive/otherSpecify have no effect on a text_list: every item is already a verbatim',
        path: '/options',
      });
    }
    return out;
  },
};
