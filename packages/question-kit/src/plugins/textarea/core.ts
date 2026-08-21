/**
 * `textarea` — the essay open end. One question, one `Q : text` variable, plus word bounds.
 *
 * The same two contract decisions as `text` (hard `pii: true`; length limits enforced by the
 * codec, reported by `validate`), and two of its own:
 *
 *  1. **Word counting is whitespace-delimited, and that is a stated limitation.** "At least 20
 *     words" is a fieldwork instruction to a respondent, so the count has to be the one a
 *     respondent can predict — runs of whitespace between visible chunks. It undercounts for
 *     scripts that do not use spaces (CJK); an instrument that needs a floor there should bound
 *     characters via `maxLen`/`minWords: 0` rather than pretend this function segments Chinese.
 *     Whatever its flaws, it is the SAME function on both sides of ADR-004, which is the property
 *     that actually matters.
 *  2. **The word-bound message keys are plugin-local, not `KIT_MESSAGE_KEYS`.** The kit's list is
 *     the set every translation bundle must provide because any plugin may emit them; a key only
 *     this plugin can emit belongs to this plugin's own `qt.textarea.*` namespace, where its
 *     bundle contribution already lives. Promoting a key to the kit list is a deliberate act,
 *     not a side effect of shipping a plugin.
 */

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

/** Keys only this plugin emits. See the file header for why they are not in `KIT_MESSAGE_KEYS`. */
export const TEXTAREA_MESSAGE_KEYS = {
  tooFewWords: 'qt.textarea.err.too_few_words',
  tooManyWords: 'qt.textarea.err.too_many_words',
} as const;

export interface TextareaConfig {
  readonly maxLen: number;
  /** Rendered height in text rows. Display only — never a data bound. */
  readonly rows: number;
  /** `0` = no floor. Mirrors `multi_select.minSelected`'s convention. */
  readonly minWords: number;
  /** `0` = no ceiling. */
  readonly maxWords: number;
  /** Show the live character count under the box. */
  readonly showCounter: boolean;
}

export interface TextareaAnswer {
  readonly text: string | null;
}

export const TEXTAREA_CONFIG_SCHEMA: JsonSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  properties: {
    maxLen: { type: 'integer', minimum: 1, maximum: 32000, default: 2000 },
    rows: { type: 'integer', minimum: 2, maximum: 20, default: 4 },
    minWords: { type: 'integer', minimum: 0, default: 0 },
    maxWords: { type: 'integer', minimum: 0, default: 0 },
    showCounter: { type: 'boolean', default: false },
  },
};

/** Whitespace-delimited word count. Both sides of ADR-004 run exactly this — see the header. */
export function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed === '' ? 0 : trimmed.split(/\s+/).length;
}

const codec: ResponseCodec<TextareaConfig, TextareaAnswer> = {
  parse(raw, ctx) {
    if (raw === null || raw === undefined) return ok({ text: null });
    const record = asPlainObject(raw);
    if (record === undefined) return err({ code: 'shape', message: 'expected an object' });
    const text = readBoundedText(record['text'], ctx.config.maxLen);
    if (!text.ok) {
      return err({
        code: text.code,
        message: text.code === 'shape' ? 'text must be a string' : 'text is too large',
        path: '/text',
      });
    }
    return ok({ text: text.value === '' ? null : text.value });
  },

  toVariables(answer, ctx) {
    // `''` stores as `null` for the same reason as `text`: one empty state, not two spellings.
    return { [ctx.name.self()]: answer.text === '' ? null : answer.text };
  },

  fromVariables(vars, ctx) {
    const text = vars[ctx.name.self()];
    return { text: typeof text === 'string' && text !== '' ? text : null };
  },

  emptyAnswer: () => ({ text: null }),
};

export const textareaCore: QuestionTypePluginCore<TextareaConfig, TextareaAnswer> = {
  meta: {
    id: 'textarea',
    version: '1.0.0',
    displayName: 'qt.textarea.name',
    description: 'qt.textarea.desc',
    category: 'text',
    icon: 'text_area',
    entitlementKey: null,
    trust: 'first_party',
    // Composable for the same reason as `text`: one `self` declaration, one response variable per
    // cell. An essay in a grid cell is a strange instrument, but that is the author's judgement
    // call — the naming contract has no objection, so the plugin records none.
    composable: true,
    emitsData: true,
  },

  configSchema: TEXTAREA_CONFIG_SCHEMA,

  defaultConfig: () => ({ maxLen: 2000, rows: 4, minWords: 0, maxWords: 0, showCounter: false }),

  declareVariables(ctx) {
    const declaration: VariableDeclaration = {
      name: ctx.name.self(),
      kind: 'response',
      type: 'text',
      source: { part: { kind: 'self' } },
      export: {
        include: !ctx.flags.excludeFromExport,
        column: ctx.name.self(),
        labelKey: `${ctx.ref}.label`,
        order: 0,
      },
      // Hard `true`, deliberately not `ctx.flags.pii` — an essay is the most identifying column a
      // survey collects. See `../text/core.ts` for the full argument.
      pii: true,
      persist: true,
      analysis: { measure: 'nominal' },
    };
    return [declaration];
  },

  validate(ctx) {
    const text = ctx.value?.text ?? null;
    const selfName = ctx.question.variables.self ?? null;
    const config = ctx.question.config;

    if (ctx.required && (text === null || text.trim() === '')) {
      return [{ variableName: selfName, messageKey: KIT_MESSAGE_KEYS.required, severity: 'error' }];
    }
    if (text === null || text.trim() === '') return [];

    // One error per field (the single-select precedent): a 40k-character paste is over the length
    // bound AND over the word ceiling, and a respondent shown both messages has to guess which one
    // to fix first. Length wins because fixing it changes the word count anyway.
    if ([...text].length > config.maxLen) {
      return [
        {
          variableName: selfName,
          messageKey: KIT_MESSAGE_KEYS.tooLong,
          params: { max: config.maxLen },
          severity: 'error',
        },
      ];
    }

    const words = countWords(text);
    if (config.minWords > 0 && words < config.minWords) {
      return [
        {
          variableName: selfName,
          messageKey: TEXTAREA_MESSAGE_KEYS.tooFewWords,
          params: { min: config.minWords },
          severity: 'error',
        },
      ];
    }
    if (config.maxWords > 0 && words > config.maxWords) {
      return [
        {
          variableName: selfName,
          messageKey: TEXTAREA_MESSAGE_KEYS.tooManyWords,
          params: { max: config.maxWords },
          severity: 'error',
        },
      ];
    }
    return [];
  },

  codec,

  exportContribution: {
    columnLabel: (_declaration, ctx) => ctx.t(ctx.question.label),
    valueLabels: () => [],
  },

  a11y: {
    interactionModel: 'textbox',
    requiredRoles: ['textbox'],
    keys: ['Tab'],
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
        message: 'textarea has no options; authored options are ignored',
        path: '/options',
      });
    }
    const { minWords, maxWords, maxLen } = ctx.config;
    if (maxWords > 0 && minWords > maxWords) {
      out.push({
        code: 'impossible_word_bounds',
        severity: 'error',
        message: `minWords (${minWords}) exceeds maxWords (${maxWords}), so no answer can validate`,
        path: '/config/minWords',
      });
    }
    // n words need at least n single-character chunks plus n-1 separators. A floor the length
    // limit cannot physically hold is an answer no respondent can give.
    if (minWords > 0 && minWords * 2 - 1 > maxLen) {
      out.push({
        code: 'word_floor_exceeds_length',
        severity: 'error',
        message: `minWords (${minWords}) cannot fit inside maxLen (${maxLen}), so no answer can validate`,
        path: '/config/minWords',
      });
    }
    return out;
  },
};
