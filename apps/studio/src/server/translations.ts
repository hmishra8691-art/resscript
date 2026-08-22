/**
 * Translation summaries and the flat-file round trip (roadmap P1-12), pure.
 *
 * Pure over the repo's rows for the same reason `src/server/redirects.ts` is pure over
 * redirect rows: the completeness math is the contract the language manager renders and the
 * tests assert, and a function of plain data can be asserted without a store.
 *
 * ## The one definition of "translated"
 *
 * A string counts toward the gauge when its state is `translated` or `reviewed` — the exact
 * complement of 0007's `i18n_incomplete_idx` predicate (`state IN ('missing','machine')`),
 * so the studio's gauge and the publish gate's incompleteness scan can never disagree about
 * which rows are the problem. `machine` is deliberately NOT progress: C §16 keeps it a
 * distinct state precisely so machine output cannot silently satisfy a completeness gate.
 *
 * ## The denominator is the BASE language's key set
 *
 * Everywhere: the gauge, the flat export (every base key appears, `''` where untranslated —
 * the translator receives the whole worklist, not just the done part), and the import's
 * validation (a key outside the set is a 422 naming it — a translator's typo'd key must not
 * silently become a row nothing reads). A stray non-base row under a key the base lacks is
 * drift, and it is neither exported nor counted.
 */

import type { I18nStringRow, LanguageRow, UpsertStringInput } from './repo/types.js';

/** States that count toward the completeness gauge. See the header. */
const DONE_STATES: readonly I18nStringRow['state'][] = ['translated', 'reviewed'];

export interface LanguageSummary {
  readonly lang: string;
  readonly is_base: boolean;
  readonly rtl: boolean;
  readonly on_missing: string;
  readonly block_publish_if_incomplete: boolean;
  readonly total_keys: number;
  readonly translated: number;
  readonly reviewed: number;
  readonly machine: number;
  readonly missing: number;
  /** `translated + reviewed` over `total_keys`, 0–100, floored. 100 when there are no keys. */
  readonly complete_pct: number;
}

export interface StringDetail {
  readonly key: string;
  readonly value: string | null;
  readonly state: I18nStringRow['state'];
}

export interface TranslationSummary {
  readonly totalKeys: number;
  readonly languages: readonly LanguageSummary[];
  /** Present only when `detailLang` named a language the version carries. */
  readonly strings?: readonly StringDetail[];
}

/** The base language's key set — the denominator of everything. Sorted for stable rendering. */
export function baseKeysOf(strings: readonly I18nStringRow[], baseLang: string): readonly string[] {
  return strings
    .filter((s) => s.lang === baseLang)
    .map((s) => s.key)
    .sort();
}

export function summarizeTranslations(input: {
  readonly languages: readonly LanguageRow[];
  readonly strings: readonly I18nStringRow[];
  readonly baseLang: string;
  readonly detailLang?: string | null;
}): TranslationSummary {
  const baseKeys = baseKeysOf(input.strings, input.baseLang);
  const keySet = new Set(baseKeys);

  const languages = input.languages.map((language): LanguageSummary => {
    const rows = new Map(
      input.strings.filter((s) => s.lang === language.lang && keySet.has(s.key)).map((s) => [s.key, s]),
    );
    let translated = 0;
    let reviewed = 0;
    let machine = 0;
    for (const row of rows.values()) {
      if (row.state === 'reviewed') reviewed += 1;
      else if (row.state === 'translated') translated += 1;
      else if (row.state === 'machine') machine += 1;
    }
    const done = translated + reviewed;
    // A key with NO row is `missing` — 0007 does not require every language to materialize
    // every key, so absence and `state = 'missing'` are the same fact and are counted as one.
    const missing = baseKeys.length - done - machine;
    return {
      lang: language.lang,
      is_base: language.is_base,
      rtl: language.rtl,
      on_missing: language.on_missing,
      block_publish_if_incomplete: language.block_publish_if_incomplete,
      total_keys: baseKeys.length,
      translated,
      reviewed,
      machine,
      missing,
      complete_pct: baseKeys.length === 0 ? 100 : Math.floor((done / baseKeys.length) * 100),
    };
  });

  const detail = input.detailLang;
  const known = detail != null && input.languages.some((l) => l.lang === detail);
  if (!known) return { totalKeys: baseKeys.length, languages };

  const rows = new Map(input.strings.filter((s) => s.lang === detail).map((s) => [s.key, s]));
  const strings = baseKeys.map((key): StringDetail => {
    const row = rows.get(key);
    return row === undefined
      ? { key, value: null, state: 'missing' }
      : { key, value: row.value, state: row.state };
  });
  return { totalKeys: baseKeys.length, languages, strings };
}

/**
 * The flat export: every BASE key, in sorted order, `''` where the language has no completed
 * value. `''` and not the machine draft, deliberately: the file is the translator's worklist,
 * and shipping machine output as if it were the current value invites re-importing it
 * unreviewed — which would launder `machine` into `translated` through a round trip.
 */
export function flatTranslationFile(
  strings: readonly I18nStringRow[],
  baseLang: string,
  lang: string,
): Readonly<Record<string, string>> {
  const rows = new Map(strings.filter((s) => s.lang === lang).map((s) => [s.key, s]));
  const file: Record<string, string> = {};
  for (const key of baseKeysOf(strings, baseLang)) {
    const row = rows.get(key);
    file[key] = row !== undefined && DONE_STATES.includes(row.state) ? row.value ?? '' : '';
  }
  return file;
}

export interface ImportPlan {
  readonly rows: readonly UpsertStringInput[];
  /** Keys in the body that the BASE language does not carry — a 422, never a silent write. */
  readonly unknownKeys: readonly string[];
}

/**
 * Body → upsert rows. A non-empty value imports as `translated` (a human sent this file; the
 * `reviewed` promotion is a state change the editor makes deliberately, not an import
 * side-effect). `''` clears the string back to `missing` with a NULL value — the table's own
 * encoding (`i18n_missing_has_no_value`) — which is what makes export-then-import a no-op.
 */
export function planImport(
  body: Readonly<Record<string, string>>,
  baseKeys: readonly string[],
): ImportPlan {
  const keySet = new Set(baseKeys);
  const unknownKeys = Object.keys(body).filter((key) => !keySet.has(key)).sort();
  const rows = Object.entries(body)
    .filter(([key]) => keySet.has(key))
    .map(
      ([key, value]): UpsertStringInput =>
        value === ''
          ? { key, value: null, state: 'missing' }
          : { key, value, state: 'translated' },
    );
  return { rows, unknownKeys };
}
