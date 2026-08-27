/**
 * `formatted_text` — an open end that must match a shape: `Q : text` (F §10, P2-05).
 *
 * `text`'s header names this plugin as the place real format validation belongs, and explains what
 * it must not do: rendering `type="email"` enrols the browser's own validity rules, which the
 * server does not run, and that client/server disagreement is exactly what ADR-004's divergence
 * metric exists to catch. So the format is checked by THIS plugin's `validate`, which runs
 * identically on both sides, and the input stays `type="text"` with `inputMode` as a keyboard hint
 * only.
 *
 * **A format failure is validation, never a codec reject.** A respondent typing `john@` is making a
 * correctable mistake mid-entry, and rejecting the page would lose their other answers. The codec
 * therefore checks only what a respondent cannot cause — length, and text that is not text — and
 * `validate` reports the format with a message beside the box. This is the same split
 * `numeric` draws between its grid (codec) and its author bounds (validate).
 *
 * **`normalize` is opt-in and never silent.** Trimming whitespace is safe and always on. Case
 * folding an email is NOT, because it changes the datum: `John@X.com` and `john@x.com` are the same
 * mailbox in practice but a client matching against a CRM may disagree, and a plugin that quietly
 * lowercased every address would make that undebuggable. So `normalize: 'lower'` exists, defaults
 * off, and is visible in the config.
 *
 * **`pii` is hard `true`, exactly as in `text`.** A format-constrained open end is more identifying
 * than a free one, not less: emails, phone numbers and postcodes are the canonical direct
 * identifiers. `QuestionFlagsView.pii` cannot distinguish "author cleared it" from "author never
 * thought about it", and the safe reading of that ambiguity for a verbatim is PII.
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

/** The named formats. `custom` defers to `pattern`. */
export const TEXT_FORMATS = ['email', 'tel', 'url', 'postcode_uk', 'postcode_us', 'custom'] as const;
export type TextFormat = (typeof TEXT_FORMATS)[number];

/**
 * The patterns behind the named formats.
 *
 * Deliberately PERMISSIVE, and that is the whole design of this table. A survey's job is to collect
 * a contactable address, not to adjudicate RFC 5322 — and every strict email regex in circulation
 * rejects addresses that genuinely deliver (`user+tag@`, new TLDs, quoted locals, IDN). A false
 * rejection here is a respondent who cannot proceed and abandons, which costs a complete; a false
 * acceptance is one row an analyst cleans. The asymmetry says: check the shape, not the standard.
 *
 * Every pattern is anchored, linear-time, and free of nested quantifiers — see `patternProblem`.
 */
export const FORMAT_PATTERNS: { readonly [K in Exclude<TextFormat, 'custom'>]: string } = {
  // One @, something before it, a dot-bearing domain after. Nothing more.
  email: '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$',
  // Digits, spaces and the punctuation phone numbers are written with, 6-20 of them. Not a
  // country-aware check: E.164 validation belongs in a worker against a real dataset, not in a
  // regex that would reject a legitimate national format.
  tel: '^[+()\\-. 0-9]{6,20}$',
  url: '^https?://[^\\s/]+\\.[^\\s]*$',
  // Anchored to the structure, not to the live postcode file: outward + inward, one space.
  postcode_uk: '^[A-Za-z]{1,2}[0-9][0-9A-Za-z]? ?[0-9][A-Za-z]{2}$',
  postcode_us: '^[0-9]{5}(-[0-9]{4})?$',
};

export type TextNormalize = 'none' | 'trim' | 'lower';

export interface FormattedTextConfig {
  readonly format: TextFormat;
  /** Required when `format: 'custom'`. A `RegExp` source, anchored by the author. */
  readonly pattern?: string;
  /** Regex flags. `g`/`y` are rejected — see `patternProblem`. */
  readonly flags?: string;
  readonly maxLen: number;
  /** Placeholder label key. `null` while unset — a key, never respondent copy (schema §16). */
  readonly placeholderKey?: string | null;
  /**
   * Whitespace/case handling. `'trim'` is the default and is always safe; `'lower'` changes the
   * datum and is therefore opt-in and visible. See the header.
   */
  readonly normalize?: TextNormalize;
  /** Virtual-keyboard hint only, never `type=`. See the header and `text`'s. */
  readonly inputMode?: 'text' | 'email' | 'tel' | 'url';
}

export interface FormattedTextAnswer {
  /** `null` when blank. `''` never reaches storage — see the codec. */
  readonly text: string | null;
}

export const FORMATTED_TEXT_CONFIG_SCHEMA: JsonSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  required: ['format', 'maxLen'],
  properties: {
    format: { enum: [...TEXT_FORMATS], default: 'email' },
    pattern: { type: 'string', minLength: 1 },
    flags: { type: 'string' },
    maxLen: { type: 'integer', minimum: 1, maximum: 4000, default: 200 },
    placeholderKey: { type: ['string', 'null'], default: null },
    normalize: { enum: ['none', 'trim', 'lower'], default: 'trim' },
    inputMode: { enum: ['text', 'email', 'tel', 'url'], default: 'text' },
  },
};

/**
 * Is this pattern safe to run on respondent input?
 *
 * **A deliberate duplication of `packages/logic`'s `regexDiagnosis` (LGC-T025), across a package
 * boundary.** `question-kit` depends only on `@resscript/schema`; taking a dependency on
 * `@resscript/logic` for one function would put the whole engine in the bundle that ships to every
 * respondent. The two checks enforce the same two rules for the same reasons, stated once there and
 * mirrored here — and the honest cost is that they could drift. Making them one implementation means
 * moving the function into `schema` (which both already depend on); that is the fix if a third
 * caller ever appears, and it is not worth a package move for two.
 *
 * The rules, and why each:
 *
 *  - **`g` and `y` are rejected outright.** Both make a `RegExp` stateful through `lastIndex`, so a
 *    cached pattern returns different answers for identical inputs on successive calls. That is an
 *    unreproducible verdict — precisely the impurity ADR-004's divergence detector exists to catch.
 *  - **A quantifier applied to an already-quantified group is rejected** (`(a+)+`). This is the
 *    shape behind essentially every reported catastrophic-backtracking incident, and a respondent's
 *    open end is attacker-controlled input. The check is narrow rather than aggressive on purpose: a
 *    false positive blocks a publish, and a diagnostic that blocks a valid survey gets deleted.
 */
export function patternProblem(pattern: string, flags?: string): string | undefined {
  if (flags !== undefined) {
    for (const flag of flags) {
      if (flag === 'g' || flag === 'y') {
        return `the ${flag} flag makes the pattern stateful (lastIndex), so the same input can ` +
          'produce different verdicts on successive evaluations';
      }
      if (!'imsu'.includes(flag)) return `unsupported regex flag ${JSON.stringify(flag)}`;
    }
  }
  try {
    new RegExp(pattern, flags);
  } catch (error: unknown) {
    return `does not compile: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (hasNestedQuantifier(pattern)) {
    return 'contains a quantifier applied to a group that is itself quantified, which can ' +
      'backtrack exponentially';
  }
  return undefined;
}

/** `(...)`-then-quantifier where the group body already contains one. Mirrors LGC-T025's shape. */
function hasNestedQuantifier(pattern: string): boolean {
  for (let i = 0; i < pattern.length; i += 1) {
    if (pattern[i] !== '(') continue;
    if (pattern[i - 1] === '\\') continue;
    let depth = 0;
    let body = '';
    let j = i;
    for (; j < pattern.length; j += 1) {
      const ch = pattern[j];
      if (pattern[j - 1] === '\\') {
        body += ch ?? '';
        continue;
      }
      if (ch === '(') depth += 1;
      else if (ch === ')') {
        depth -= 1;
        if (depth === 0) break;
      }
      if (depth >= 1) body += ch ?? '';
    }
    const after = pattern[j + 1];
    const quantified = after === '+' || after === '*' || after === '{';
    if (quantified && /[+*]|\{[0-9]/.test(body)) return true;
  }
  return false;
}

/** The effective pattern for a config, or `undefined` when `custom` has none. */
export function patternFor(config: FormattedTextConfig): string | undefined {
  if (config.format !== 'custom') return FORMAT_PATTERNS[config.format];
  return config.pattern;
}

/** Apply the configured normalization. `trim` by default; never case-folds unless asked. */
export function normalizeText(raw: string, normalize: TextNormalize | undefined): string {
  switch (normalize ?? 'trim') {
    case 'none':
      return raw;
    case 'lower':
      return raw.trim().toLowerCase();
    default:
      return raw.trim();
  }
}

const codec: ResponseCodec<FormattedTextConfig, FormattedTextAnswer> = {
  parse(raw, ctx) {
    if (raw === null || raw === undefined) return ok({ text: null });
    const record = asPlainObject(raw);
    if (record === undefined) return err({ code: 'shape', message: 'expected an object' });
    // Length and type only. The FORMAT is `validate`'s — a respondent typing `john@` is making a
    // correctable mistake, and rejecting the page would lose their other answers.
    const read = readBoundedText(record['text'], ctx.config.maxLen);
    if (!read.ok) {
      return err({
        code: read.code,
        message: read.code === 'shape' ? 'text must be a string' : 'text is too large',
        path: '/text',
      });
    }
    if (read.value === null) return ok({ text: null });
    const normalized = normalizeText(read.value, ctx.config.normalize);
    // `''` never reaches storage: a whitespace-only entry is a blank, and storing it as an empty
    // string would make "answered with nothing" indistinguishable from "answered".
    return ok({ text: normalized === '' ? null : normalized });
  },

  toVariables(answer, ctx) {
    return { [ctx.name.self()]: answer.text };
  },

  fromVariables(vars, ctx) {
    const value = vars[ctx.name.self()];
    return { text: typeof value === 'string' && value !== '' ? value : null };
  },

  emptyAnswer: () => ({ text: null }),
};

export const formattedTextCore: QuestionTypePluginCore<FormattedTextConfig, FormattedTextAnswer> = {
  meta: {
    id: 'formatted_text',
    version: '1.0.0',
    displayName: 'qt.formatted_text.name',
    description: 'qt.formatted_text.desc',
    category: 'text',
    icon: 'at-sign',
    entitlementKey: null,
    trust: 'first_party',
    // Composable: one self-named variable, so a formatted cell in a mixed matrix is fully covered
    // by the scoped namer — the same argument `numeric` and `text` make.
    composable: true,
    emitsData: true,
  },

  configSchema: FORMATTED_TEXT_CONFIG_SCHEMA,

  defaultConfig: () => ({ format: 'email', maxLen: 200, normalize: 'trim', inputMode: 'email' }),

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
      // Hard `true`, exactly as in `text`, and more clearly right here: emails, phone numbers and
      // postcodes are the canonical direct identifiers. See the header.
      pii: true,
      persist: true,
      // `nominal`: a formatted string is an identifier, not a quantity or an order.
      analysis: { measure: 'nominal' },
    };
    return [declaration];
  },

  validate(ctx) {
    const issues: ValidationIssue[] = [];
    const text = ctx.value?.text ?? null;
    const selfName = ctx.question.variables.self ?? null;
    const config = ctx.question.config;

    if (ctx.required && (text === null || text === '')) {
      return [{ variableName: selfName, messageKey: KIT_MESSAGE_KEYS.required, severity: 'error' }];
    }
    if (text === null || text === '') return issues;

    // Defensive: the codec caps length first, and ADR-004 makes the server re-run both.
    if (text.length > config.maxLen) {
      return [
        {
          variableName: selfName,
          messageKey: KIT_MESSAGE_KEYS.tooLong,
          params: { max: config.maxLen },
          severity: 'error',
        },
      ];
    }

    const pattern = patternFor(config);
    if (pattern === undefined) {
      // `custom` with no pattern. `staticChecks` blocks publishing this, so reaching it means a
      // hand-edited artifact — and the safe direction is to accept the answer rather than to hold a
      // respondent on a question whose rule is missing.
      return issues;
    }
    if (patternProblem(pattern, config.flags) !== undefined) {
      // Same reasoning: an unsafe pattern is a publish error, and running it anyway is the one
      // outcome worse than not checking.
      return issues;
    }
    if (!new RegExp(pattern, config.flags).test(text)) {
      // `err.invalid_option` is reused deliberately: `KIT_MESSAGE_KEYS` is the i18n bundle's
      // contract and a plugin may not add a key. `params.format` is what makes the rendered message
      // specific ("that does not look like an email address").
      issues.push({
        variableName: selfName,
        messageKey: KIT_MESSAGE_KEYS.invalidOption,
        params: { format: config.format },
        severity: 'error',
      });
    }
    return issues;
  },

  codec,

  exportContribution: {
    columnLabel: (_declaration, ctx) => ctx.t(ctx.question.label),
    // A verbatim column has no value labels; fabricating any would put fake categories in SPSS.
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
    const config = ctx.config;

    if (config.format === 'custom' && (config.pattern ?? '') === '') {
      out.push({
        code: 'missing_pattern',
        severity: 'error',
        message: 'format "custom" requires a pattern; without one the question checks nothing',
        path: '/config/pattern',
      });
    }
    const pattern = patternFor(config);
    if (pattern !== undefined) {
      const problem = patternProblem(pattern, config.flags);
      if (problem !== undefined) {
        out.push({
          code: 'unsafe_pattern',
          severity: 'error',
          message: `the pattern ${problem}`,
          path: config.format === 'custom' ? '/config/pattern' : '/config/flags',
        });
      } else if (config.format === 'custom' && !(pattern.startsWith('^') && pattern.endsWith('$'))) {
        // An unanchored pattern matches a SUBSTRING, so `[0-9]{5}` accepts
        // "my zip is 12345 thanks". Almost never what an author means, and silent when wrong.
        out.push({
          code: 'unanchored_pattern',
          severity: 'warning',
          message:
            'the pattern is not anchored with ^ and $, so it matches anywhere in the answer — ' +
            '"12345" would also accept "my zip is 12345 thanks"',
          path: '/config/pattern',
        });
      }
    }
    if (config.format !== 'custom' && config.pattern !== undefined) {
      out.push({
        code: 'pattern_ignored',
        severity: 'warning',
        message: `format "${config.format}" uses its own pattern; the authored one is ignored`,
        path: '/config/pattern',
      });
    }
    if (ctx.options.length > 0) {
      out.push({
        code: 'options_ignored',
        severity: 'warning',
        message: 'formatted_text declares its format in config; authored options are ignored',
        path: '/options',
      });
    }
    return out;
  },
};
