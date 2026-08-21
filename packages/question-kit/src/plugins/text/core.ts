/**
 * `text` — the single-line open end. One question, one `Q : text` variable (F §10's catalogue).
 *
 * Two decisions are worth stating up front, because both look like omissions until the reason is
 * on the record:
 *
 *  1. **`pii` is hard `true`, not `ctx.flags.pii`.** `QuestionFlagsView.pii` is a plain boolean,
 *     so "the author explicitly cleared it" and "the author never thought about it" are the same
 *     value — and for a verbatim the safe reading of that ambiguity is the one the `_other`
 *     companion already takes (F §2): an open-end is PII by default. A column wrongly marked PII
 *     is an annoyance; one wrongly unmarked is an incident. When the flags view learns to carry
 *     an explicit tri-state, this is the line that reads it.
 *  2. **`inputMode` is a keyboard hint, not validation.** `'email'` here changes which virtual
 *     keyboard a phone shows and nothing else. Rendering `type="email"` instead would enrol the
 *     browser's own validity rules, which the server-side `validate` does not run — exactly the
 *     client/server disagreement ADR-004's divergence metric exists to catch. Real format
 *     validation is `formatted_text`, which is Phase 2.
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

export type TextInputMode = 'text' | 'email' | 'tel' | 'url';

export interface TextConfig {
  readonly maxLen: number;
  /** Placeholder label key. `null` while unset — a key, never respondent copy (schema §16). */
  readonly placeholderKey: string | null;
  /** Virtual-keyboard hint only. See the file header for why it is not `type=`. */
  readonly inputMode: TextInputMode;
}

export interface TextAnswer {
  /** `null` when blank. `''` never reaches storage — see the codec. */
  readonly text: string | null;
}

export const TEXT_CONFIG_SCHEMA: JsonSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  properties: {
    maxLen: { type: 'integer', minimum: 1, maximum: 4000, default: 200 },
    placeholderKey: { type: ['string', 'null'], default: null },
    inputMode: { enum: ['text', 'email', 'tel', 'url'], default: 'text' },
  },
};

const codec: ResponseCodec<TextConfig, TextAnswer> = {
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
    // `''` is stored as `null`: "shown and left blank" is one fact, and letting it have two
    // stored spellings would make `Q1 == null` logic quietly miss half its cases.
    return { [ctx.name.self()]: answer.text === '' ? null : answer.text };
  },

  fromVariables(vars, ctx) {
    const text = vars[ctx.name.self()];
    return { text: typeof text === 'string' && text !== '' ? text : null };
  },

  emptyAnswer: () => ({ text: null }),
};

export const textCore: QuestionTypePluginCore<TextConfig, TextAnswer> = {
  meta: {
    id: 'text',
    version: '1.0.0',
    displayName: 'qt.text.name',
    description: 'qt.text.desc',
    category: 'text',
    icon: 'text_field',
    entitlementKey: null,
    trust: 'first_party',
    // Composable, and cheaply so: the only declaration is `self`, which the scoped namer maps to
    // the cell's own name, and one response variable per cell is exactly F §3.1 rule 6's budget.
    // A verbatim column inside a mixed matrix is the canonical use.
    composable: true,
    emitsData: true,
  },

  configSchema: TEXT_CONFIG_SCHEMA,

  defaultConfig: () => ({ maxLen: 200, placeholderKey: null, inputMode: 'text' }),

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
      // Hard `true`, deliberately not `ctx.flags.pii` — see the file header.
      pii: true,
      persist: true,
      analysis: { measure: 'nominal' },
    };
    return [declaration];
  },

  validate(ctx) {
    const issues: ValidationIssue[] = [];
    const text = ctx.value?.text ?? null;
    const selfName = ctx.question.variables.self ?? null;

    if (ctx.required && (text === null || text.trim() === '')) {
      return [{ variableName: selfName, messageKey: KIT_MESSAGE_KEYS.required, severity: 'error' }];
    }
    // Code points, not UTF-16 units: `maxLength` in the renderer counts what a respondent sees as
    // characters closely enough, and counting units here would reject an emoji-dense answer the
    // UI said was fine.
    if (text !== null && [...text].length > ctx.question.config.maxLen) {
      issues.push({
        variableName: selfName,
        messageKey: KIT_MESSAGE_KEYS.tooLong,
        params: { max: ctx.question.config.maxLen },
        severity: 'error',
      });
    }
    return issues;
  },

  codec,

  exportContribution: {
    columnLabel: (_declaration, ctx) => ctx.t(ctx.question.label),
    // A verbatim has no code list; fabricating value labels for free text would put fiction in
    // the SPSS metadata.
    valueLabels: () => [],
  },

  a11y: {
    interactionModel: 'textbox',
    requiredRoles: ['textbox'],
    // Tab only: a single-line input has no composite-widget keyboard pattern, and declaring keys
    // the renderer does not intercept would commit it to behaviour it does not have.
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
        message: 'text has no options; authored options are ignored',
        path: '/options',
      });
    }
    return out;
  },
};
