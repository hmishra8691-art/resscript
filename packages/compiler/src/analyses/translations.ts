/**
 * Translation completeness: `CMP-0200` (publish is blocked on it) and `CMP-0201` (it will fall
 * back) — C §16, roadmap P1-08.
 *
 * ## The one thing this checks, and the thing it deliberately does not
 *
 * `validateStructural` already answers "does every i18n key *referenced by content* exist in the
 * base bundle" (`SCH-1008`, from `checkI18nKey`, on every label, title, instruction, message key
 * and design item). That is the *authoring* direction and it is not re-checked here. This file
 * answers the other direction: **does every key the base bundle declares exist in each declared
 * language's bundle.** The two are independent — a survey can pass the first and be 40% translated
 * — and only the second can gate publish on a translation vendor's delivery.
 *
 * Whether a bundle exists for a language *declared in `available`* is `SCH-1011`'s neighbour but
 * not its business: `checkLanguages` reports a bundle with no `available` entry, not an `available`
 * entry with no bundle. A declared language with no bundle at all is therefore reported here, as
 * the limit case of incompleteness (`detail.bundle_present: false`), rather than left silent.
 *
 * ## One diagnostic per language, never per key
 *
 * A 12-language study with 400 untranslated keys is 4,800 rows under the naive shape, which is not
 * a publish dialog, it is a denial of service on the author's attention — and every row would
 * carry the same remedy. So the unit is the language: one diagnostic, the count, and the first
 * `MAX_LISTED_KEYS` keys in sorted order so the author can recognize *what* is missing (a whole
 * block? one new question?) without opening an export. Sorted rather than document-ordered because
 * the array is written to `survey_versions.compile_diagnostics` and compared byte-for-byte by the
 * republish-is-a-no-op test.
 *
 * ## Which code, and why `on_missing: 'block'` overrides the policy flag
 *
 * `LanguagePolicy` carries two independent fields and the interesting case is when they disagree.
 *
 *  - `block_publish_if_incomplete: true` → **`CMP-0200`** (error). The author asked for the gate.
 *  - `on_missing: 'block'` → **`CMP-0200`** (error) *even when the flag is false*. `block` is a
 *    runtime behaviour: a respondent who reaches a page with an untranslated key is stopped dead,
 *    with no fallback and no way forward. Shipping a survey that is known to contain that dead end
 *    is the same defect as shipping a survey with an unreachable required question, and both are
 *    errors. Treating it as an acknowledgeable warning would make the acknowledgement mean "I
 *    accept that some respondents cannot finish", which is not a trade an author makes knowingly.
 *  - `on_missing: 'fallback_to_base'` → **`CMP-0201`** (warning). The respondent sees the base
 *    language for that string. Degraded, legitimate mid-translation, acknowledgeable.
 *  - `on_missing: 'show_key'` → **`CMP-0201`** (warning). The respondent sees `q4.label` in raw
 *    form: worse than a fallback and unmistakably a bug in field, but the survey is completable, so
 *    it is not the publish-blocking class. `detail.on_missing` distinguishes it from the fallback
 *    case for anyone who wants to escalate it later.
 *
 * ## What counts as missing
 *
 * A key absent from the bundle. **Not** a key present with an empty string: an author or a
 * translation vendor blanking a string is a deliberate act (an optional instruction that a locale
 * does not need), the runtime renders it as nothing rather than falling back, and reporting it
 * would make "complete" unreachable for any study that legitimately empties one. Keys the base
 * bundle does not declare but a translation does are also not reported — a stale key in a
 * translation bundle is dead weight, not a defect a respondent can reach.
 */

import { pointer, type JsonValue, type StringBundle, type Survey } from '@resscript/schema';

import { cmpDiagnostic, sortCompileDiagnostics, type CompileDiagnostic } from '../diagnostics.js';

/** How many missing keys a single diagnostic lists. See the header. */
export const MAX_LISTED_KEYS = 20;

export interface TranslationsInput {
  readonly survey: Survey;
}

export function analyzeTranslations(input: TranslationsInput): readonly CompileDiagnostic[] {
  const languages = input.survey.languages;
  const base = languages.base;
  const baseBundle: StringBundle = languages.bundles[base] ?? {};
  const baseKeys = Object.keys(baseBundle).sort();
  // No base keys means nothing can be missing. It is also the shape of a fixture, and a study
  // with no strings at all is `SCH-1008`'s problem the moment any content references a key.
  if (baseKeys.length === 0) return [];

  const policy = languages.policy;
  const out: CompileDiagnostic[] = [];

  for (const language of languages.available) {
    if (language.code === base) continue;
    const bundle = languages.bundles[language.code];
    const present = bundle === undefined ? new Set<string>() : new Set(Object.keys(bundle));
    const missing = baseKeys.filter((key) => !present.has(key));
    if (missing.length === 0) continue;

    const blocking = policy.block_publish_if_incomplete || policy.on_missing === 'block';
    const detail: { readonly [key: string]: JsonValue } = {
      language: language.code,
      base_language: base,
      bundle_present: bundle !== undefined,
      base_key_count: baseKeys.length,
      missing_count: missing.length,
      missing_keys: missing.slice(0, MAX_LISTED_KEYS),
      truncated: missing.length > MAX_LISTED_KEYS,
      on_missing: policy.on_missing,
      block_publish_if_incomplete: policy.block_publish_if_incomplete,
      reason: policy.block_publish_if_incomplete
        ? 'publish_blocked_by_policy'
        : policy.on_missing === 'block'
          ? 'runtime_hard_stop'
          : policy.on_missing,
    };

    // The pointer is the *bundle*, present or not: it is where the author fixes this, and a
    // pointer is a location rather than an assertion that something is there.
    const path = pointer('languages', 'bundles', language.code);
    const label = language.label ?? language.code;

    out.push(
      blocking
        ? cmpDiagnostic(
            'CMP-0200',
            `The ${label} bundle is missing ${String(missing.length)} of the ` +
              `${String(baseKeys.length)} keys the ${base} bundle declares, and ` +
              (policy.block_publish_if_incomplete
                ? 'languages.policy.block_publish_if_incomplete is set, so publish is blocked ' +
                  'until the bundle is complete.'
                : "languages.policy.on_missing is 'block', so a respondent who reaches one of " +
                  'those strings is stopped with no fallback and cannot finish the survey.'),
            path,
            detail,
          )
        : cmpDiagnostic(
            'CMP-0201',
            `The ${label} bundle is missing ${String(missing.length)} of the ` +
              `${String(baseKeys.length)} keys the ${base} bundle declares. ` +
              (policy.on_missing === 'show_key'
                ? "languages.policy.on_missing is 'show_key', so respondents in that language see " +
                  'the raw key (for example "' +
                  (missing[0] ?? '') +
                  '") where the text should be.'
                : `Respondents in that language see the ${base} text for those strings.`),
            path,
            detail,
          ),
    );
  }

  return sortCompileDiagnostics(out);
}
