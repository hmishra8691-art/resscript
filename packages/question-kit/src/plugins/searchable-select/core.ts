/**
 * `searchable_select` — one answer from a long CLOSED list, found by typing (F §10, P2-05).
 *
 * **Why this is a separate type and not a `display` on `single_select`.** `single_select` has five
 * displays and could take a sixth, but the difference here is not presentational: a searchable
 * picker only makes sense over a list too long to read, and everything about it follows from that.
 * The a11y pattern is a combobox with a filtered listbox popup rather than a radiogroup (a
 * radiogroup of 250 countries is 250 things a screen reader must walk); `min_chars` exists because
 * rendering 250 options before the respondent types is the cost the control is avoiding; and the
 * static checks are about list SIZE, which no other select cares about.
 *
 * **The list stays closed — there is no "other".** `single_select` has one because a short list
 * legitimately misses a case. A searchable select is for countries, occupations, brands: lists that
 * are long precisely because they are meant to be exhaustive. If the list is genuinely open, the
 * right control is `text` with suggestions, which is a different question type with a `text` column
 * — and offering an "other" box here would produce a nominal column with 250 codes plus a verbatim,
 * which is the shape that makes an analyst reconcile two columns by hand.
 *
 * **Search is presentation, never data.** The filter runs on resolved labels in the browser and
 * nothing about it is recorded: the answer is the option's code, exactly as in `single_select`, and
 * what the respondent typed to find it is not a datum. Recording the query would look useful and be
 * a privacy liability — a partial free-text of what someone was looking for, in a nominal column.
 */

import {
  asOptionCode,
  asPlainObject,
  err,
  ok,
  type ResponseCodec,
} from '../../contract/codec.js';
import { itemCode } from '../../contract/items.js';
import { KIT_MESSAGE_KEYS, type ValidationIssue } from '../../contract/validate.js';
import type { PluginDiagnostic } from '../../contract/diagnostics.js';
import type { QuestionTypePluginCore } from '../../contract/plugin.js';
import type { A11yContract } from '../../contract/a11y.js';
import type { JsonSchema } from '../../json-schema.js';
import type { VariableDeclaration } from '../../contract/variables.js';
import type { OptionCode } from '../../contract/items.js';

/**
 * Below this, a searchable control is worse than a plain list: the respondent has to type to reach
 * options they could have read. Used only by `staticChecks` — a warning, never a hard rule, because
 * an author may have a reason (a list that grows between waves).
 */
export const SEARCH_WORTHWHILE_AT = 12;

export interface SearchableSelectConfig {
  /**
   * Characters to type before the list filters. `0` shows everything immediately.
   *
   * Not a performance knob dressed up as UX: at 250 options the initial render IS the cost, and a
   * respondent who does not know what they are looking for needs `0` while one picking a country
   * from 250 needs `1` or `2`.
   */
  readonly min_chars?: number;
  /** Cap on how many matches are shown at once. Presentational; the answer is unaffected. */
  readonly max_visible?: number;
  /** Match anywhere in the label, or only at the start. `contains` is the default. */
  readonly match?: 'contains' | 'prefix';
  readonly placeholderKey?: string | null;
}

export interface SearchableSelectAnswer {
  /** The chosen option's code, or `null`. Identical to `single_select`'s — see the header. */
  readonly code: OptionCode | null;
}

export const SEARCHABLE_SELECT_CONFIG_SCHEMA: JsonSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  required: [],
  properties: {
    min_chars: { type: 'integer', minimum: 0, maximum: 5, default: 0 },
    max_visible: { type: 'integer', minimum: 1, maximum: 500, default: 50 },
    match: { enum: ['contains', 'prefix'], default: 'contains' },
    placeholderKey: { type: ['string', 'null'], default: null },
  },
};

/**
 * The visible matches for a query.
 *
 * Exported because the renderer and the tests must agree on it, and because "which options does
 * typing `uni` show" is the question an author asks when a respondent reports not finding one.
 *
 * Case- and diacritic-insensitive: someone typing `espana` must find `España`, and someone typing
 * `UNITED` must find `United Kingdom`. Folding via `normalize('NFD')` and stripping combining marks
 * is the one thing that makes a long list usable in a market with accented names — a plain
 * `toLowerCase().includes()` fails exactly the respondents who are typing their own language.
 */
export function searchMatches<T extends { readonly labelKey: string }>(
  items: readonly T[],
  query: string,
  opts: { readonly match?: 'contains' | 'prefix'; readonly label: (item: T) => string },
): readonly T[] {
  const needle = fold(query);
  if (needle === '') return items;
  const prefix = opts.match === 'prefix';
  return items.filter((item) => {
    const hay = fold(opts.label(item));
    return prefix ? hay.startsWith(needle) : hay.includes(needle);
  });
}

/** Lowercase, decompose, strip combining marks. See `searchMatches`. */
export function fold(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

const codec: ResponseCodec<SearchableSelectConfig, SearchableSelectAnswer> = {
  parse(raw, ctx) {
    if (raw === null || raw === undefined) return ok({ code: null });
    const record = asPlainObject(raw);
    if (record === undefined) return err({ code: 'shape', message: 'expected an object' });

    const code = asOptionCode(record['code']);
    if (code === undefined) return err({ code: 'shape', message: 'code is not a code', path: '/code' });
    if (code === null) return ok({ code: null });

    // The domain check is a codec reject, not a validation message, exactly as in `single_select`:
    // the UI offers only authored options, so a code outside the domain is a forged payload. The
    // SEARCH does not widen the domain — that is the point of "search is presentation, never data".
    const domain = new Set<OptionCode>(ctx.question.options.map(itemCode));
    if (!domain.has(code)) {
      return err({ code: 'unknown_key', message: `no option with code ${String(code)}`, path: '/code' });
    }
    return ok({ code });
  },

  toVariables(answer, ctx) {
    return { [ctx.name.self()]: answer.code };
  },

  fromVariables(vars, ctx) {
    const value = vars[ctx.name.self()];
    return {
      code: typeof value === 'number' || typeof value === 'string' ? value : null,
    };
  },

  emptyAnswer: () => ({ code: null }),
};

export const searchableSelectCore: QuestionTypePluginCore<
  SearchableSelectConfig,
  SearchableSelectAnswer
> = {
  meta: {
    id: 'searchable_select',
    version: '1.0.0',
    displayName: 'qt.searchable_select.name',
    description: 'qt.searchable_select.desc',
    category: 'choice',
    icon: 'search',
    entitlementKey: null,
    trust: 'first_party',
    // Composable: one self-named enum variable, so a searchable cell in a mixed matrix is fully
    // covered by the scoped namer — the same argument `single_select` makes.
    composable: true,
    emitsData: true,
  },

  configSchema: SEARCHABLE_SELECT_CONFIG_SCHEMA,

  defaultConfig: () => ({ min_chars: 0, max_visible: 50, match: 'contains' }),

  declareVariables(ctx) {
    const declaration: VariableDeclaration = {
      name: ctx.name.self(),
      kind: 'response',
      type: 'enum',
      // Codes come from the authored option, NOT from an iteration index or from search order.
      // Reordering or filtering the list must not renumber the domain (F §1.1 rule 2).
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
      // `nominal`: a picked item from a long list is a category. Even where the list has a natural
      // order (a country list alphabetically), the CODES do not encode it.
      analysis: { measure: 'nominal' },
    };
    return [declaration];
  },

  validate(ctx) {
    const issues: ValidationIssue[] = [];
    const code = ctx.value?.code ?? null;
    const selfName = ctx.question.variables.self ?? null;

    if (ctx.required && code === null) {
      return [{ variableName: selfName, messageKey: KIT_MESSAGE_KEYS.required, severity: 'error' }];
    }
    if (code === null) return issues;

    // Defensive: the codec rejects an out-of-domain code first, and ADR-004 makes the server re-run
    // both. Reachable from a stale Answer held across a republish that removed an option.
    const visible = ctx.question.options.filter((option) => option.visible);
    if (!visible.some((option) => itemCode(option) === code)) {
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
    // Every code gets its label, which is what makes a 250-country column readable in SPSS. This
    // is the one place a long list pays off in the export rather than costing.
    valueLabels: (declaration, ctx) =>
      (declaration.enumDomain ?? []).map((entry) => ({
        code: entry.code,
        label: ctx.t(entry.labelKey),
      })),
  },

  a11y: {
    // A combobox, not a radiogroup: 250 radios is 250 stops a screen-reader user must walk past,
    // and the whole reason this control exists is that the list is too long to enumerate.
    interactionModel: 'listbox',
    requiredRoles: ['combobox'],
    // The full combobox key set. Escape closes the popup without clearing the choice, and
    // Home/End reach the ends of a filtered list without holding an arrow down.
    keys: ['Tab', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'Enter', 'Escape'],
    minTouchTargetPx: 44,
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
        message: 'a searchable select needs options to search',
        path: '/options',
      });
    } else if (ctx.options.length < SEARCH_WORTHWHILE_AT) {
      // The control costs the respondent a typing step. Below a dozen options that is a worse
      // experience than a plain list, so it is worth saying — as a warning, because an author may
      // know the list grows between waves.
      out.push({
        code: 'list_too_short_to_search',
        severity: 'warning',
        message:
          `${ctx.options.length} options is short enough to read: a searchable control makes the ` +
          'respondent type to reach items they could have seen. single_select is likely the ' +
          'better type here',
        path: '/options',
      });
    }
    if ((config.min_chars ?? 0) > 0 && ctx.options.length > 0) {
      // With `min_chars > 0` nothing is shown until the respondent types, so a respondent who does
      // not know what is in the list cannot browse it. Legitimate for a country list, wrong for
      // "which of our products have you heard of".
      out.push({
        code: 'hidden_until_typed',
        severity: 'warning',
        message:
          `min_chars is ${String(config.min_chars ?? 0)}, so the list is invisible until the ` +
          'respondent types — correct for an exhaustive list they know, wrong for one they need ' +
          'to browse',
        path: '/config/min_chars',
      });
    }
    if (
      config.max_visible !== undefined &&
      config.max_visible < ctx.options.length &&
      (config.min_chars ?? 0) === 0
    ) {
      // Showing 50 of 250 with no filter applied means the last 200 are unreachable until the
      // respondent guesses that typing helps.
      out.push({
        code: 'truncated_without_filter',
        severity: 'warning',
        message:
          `max_visible (${String(config.max_visible)}) is below the ${ctx.options.length} options ` +
          'and min_chars is 0, so options past the cap are only reachable by typing',
        path: '/config/max_visible',
      });
    }
    if (ctx.rows.length > 0) {
      out.push({
        code: 'rows_ignored',
        severity: 'warning',
        message: 'searchable_select searches its options; authored rows are ignored',
        path: '/rows',
      });
    }
    return out;
  },
};
