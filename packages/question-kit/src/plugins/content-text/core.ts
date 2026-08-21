/**
 * `content_text` — a text/instruction block (F §10's content node; roadmap P1-05).
 *
 * The first plugin with `emitsData: false`, which makes it the plugin that proves the contract
 * holds for questions that are not questions: `declareVariables` returns `[]` (the compiler's
 * CMP-0102 "emits nothing" warning reads `emitsData` as the exemption, so an empty list here is
 * a claim, not an accident), the codec is the empty codec, and `validate` is constantly `[]`.
 * None of those are omissions — each one is the honest value of a required contract member, and
 * writing them out is what keeps "every plugin satisfies the whole interface" true without a
 * content-node special case anywhere downstream.
 *
 * Two decisions worth stating:
 *
 *  1. **The codec accepts only emptiness.** `null`/`undefined`/`{}` all decode to the one Answer
 *     value; a payload carrying any key is rejected with `unknown_key`. A content block takes no
 *     answer, so a payload that *says* something against it is a forged payload (ADR-005
 *     threat 3), not a lenient client — and silently discarding it would hide the forgery from
 *     the API's rejection metrics.
 *  2. **`interactionModel: 'custom_documented'`.** Every other member of the union names a
 *     widget the respondent operates, and this block has none; claiming `textbox` or
 *     `radiogroup` would commit the renderer to a keyboard pattern that must not exist here.
 *     The documented custom model is: one `role="note"` region, zero tab stops, zero keys
 *     handled. (`keys` still lists `Tab` because `checkA11yContract` requires it of every
 *     contract — a floor written for interactive types; for this one it records "Tab passes
 *     through", which is exactly what a non-interactive block must do with it.)
 */

import { asPlainObject, err, ok, type ResponseCodec } from '../../contract/codec.js';
import type { PluginDiagnostic } from '../../contract/diagnostics.js';
import type { QuestionTypePluginCore } from '../../contract/plugin.js';
import type { A11yContract } from '../../contract/a11y.js';
import type { JsonSchema } from '../../json-schema.js';

export interface ContentTextConfig {
  /** The i18n key of the block's body copy. The *content* lives in the language bundle. */
  readonly bodyKey: string;
  /** Presentation only — never read by anything that touches data. */
  readonly variant?: 'body' | 'callout' | 'legal';
}

/**
 * A content block has no answer, and the type says so: one inhabitant, so there is exactly one
 * empty state (the `single-select` rule about "absent" vs "null", taken to its limit).
 */
export type ContentTextAnswer = null;

export const CONTENT_TEXT_CONFIG_SCHEMA: JsonSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  required: ['bodyKey'],
  properties: {
    bodyKey: { type: 'string', minLength: 1 },
    variant: { enum: ['body', 'callout', 'legal'], default: 'body' },
  },
};

/**
 * The empty codec. Strict about emptiness on purpose — see the file header: a keyed payload
 * against a block that takes no answer is a forgery, and `unknown_key` is the code the API
 * already turns into the right rejection.
 */
const codec: ResponseCodec<ContentTextConfig, ContentTextAnswer> = {
  parse(raw) {
    if (raw === null || raw === undefined) return ok(null);
    const record = asPlainObject(raw);
    if (record === undefined) return err({ code: 'shape', message: 'a content block takes no answer' });
    if (Object.keys(record).length > 0) {
      return err({ code: 'unknown_key', message: 'a content block takes no answer' });
    }
    return ok(null);
  },
  // No keys at all — the subset-of-declared property holds because both sides are empty.
  toVariables: () => ({}),
  fromVariables: () => null,
  emptyAnswer: () => null,
};

export const contentTextCore: QuestionTypePluginCore<ContentTextConfig, ContentTextAnswer> = {
  meta: {
    id: 'content_text',
    version: '1.0.0',
    displayName: 'qt.content_text.name',
    description: 'qt.content_text.desc',
    category: 'content',
    icon: 'paragraph',
    entitlementKey: null,
    trust: 'first_party',
    // A product decision, not a naming limitation (contrast nps): a cell control is something
    // the respondent answers, and a paragraph in a grid cell is a row label wearing the wrong
    // type. The matrix already has label keys for that.
    composable: false,
    // THE claim this plugin exists to make. The compiler's CMP-0102 pass reads it as "an empty
    // emission list is this type doing its job", instead of warning on every instruction page.
    emitsData: false,
  },

  configSchema: CONTENT_TEXT_CONFIG_SCHEMA,

  defaultConfig: (ctx) => ({
    // A per-question key template, not a shared constant: two instruction blocks on one page
    // must not fight over one bundle entry. The ref is used, never stored (schema §3).
    bodyKey: `${ctx.ref}.body`,
    variant: 'body',
  }),

  // `[]` is the declaration: this block owns no columns, so a survey full of instructions adds
  // nothing to the export. `verifyDeclarations([])` is explicitly legal for exactly this case.
  declareVariables: () => [],

  // Always clean — there is nothing a respondent could get wrong. `required` is diagnosed at
  // compile time (`required_ignored` below) rather than silently enforced against nothing here,
  // because a validation error nobody can fix is a survey nobody can finish.
  validate: () => [],

  codec,

  exportContribution: {
    // Reachable only if a manifest ever carries a declaration for this type, which would itself
    // be a bug; the honest label is still the block's own.
    columnLabel: (_declaration, ctx) => ctx.t(ctx.question.label),
    valueLabels: () => [],
  },

  a11y: {
    // See the file header for the full argument; the documented model is a non-interactive
    // `note` region with zero tab stops.
    interactionModel: 'custom_documented',
    requiredRoles: ['note'],
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
        message: 'content_text renders no control; authored options are ignored',
        path: '/options',
      });
    }
    if (ctx.required) {
      // A warning, not an error: the flag is harmless because `validate` ignores it — but an
      // author who set it believes something about their instrument that is not true, and that
      // belief is worth correcting while it is still an edit.
      out.push({
        code: 'required_ignored',
        severity: 'warning',
        message: 'a content block collects nothing, so required can never be satisfied and is ignored',
        path: '/required',
      });
    }
    return out;
  },
};
