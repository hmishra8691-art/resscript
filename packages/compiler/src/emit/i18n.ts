/**
 * The per-language string bundles, and the compile-time resolution of an `I18nRef` into the
 * respondent's own text — C §16, C §17, roadmap P1-08.
 *
 * ## Why one file per language and not one blob
 *
 * C §16's third claim is the load-bearing one: "the compiled artifact ships **only** the
 * respondent's language — which materially reduces payload on a 12-language study." That is only
 * true if the languages are separately addressable, so the bundles are emitted as
 * `i18n/<code>.json` and the runtime fetches exactly one. Emitting `CompiledArtifact.i18n` as a
 * single object in a single file would put twelve languages on the wire to render one, which is
 * the cost §16 exists to avoid; the in-memory `i18n` record still carries them all, because a
 * caller holding a `CompiledArtifact` (a test, the studio preview, an export of the artifact) is
 * not paying per-language bandwidth.
 *
 * ## Bundles are emitted verbatim, not merged with the base
 *
 * A partially translated bundle is **not** topped up from the base language. Two reasons, and the
 * second is the one that matters. Merging would duplicate the base bundle into every language
 * file, which is the payload §16 is about — a 12-language study with 3 translated languages would
 * ship 12 copies of the English strings. And merging would make `CMP-0201` ("this bundle falls
 * back to base") unobservable in the artifact: the bytes would claim a complete translation that
 * the document does not have, so nothing downstream could tell a translated string from a
 * fallback. The base bundle is always in the tree under its own path, so a runtime fallback is one
 * fetch away and is a decision the runtime makes explicitly.
 *
 * ## Which languages the artifact carries
 *
 * The union of `languages.base`, every `languages.available[].code`, and every key of
 * `languages.bundles` — base first, then the rest in code-point order. The union rather than
 * `available` alone because the artifact hash must cover every byte the document declares: a
 * bundle for a language nobody can select is dead weight, but it is dead weight that
 * distinguishes two documents, and a hash that ignored it would make two different surveys
 * content-addressed to the same object. `validateStructural`'s `SCH-1011` already reports that
 * bundle, so the divergence between this list and `available` only exists on a document that
 * cannot be published.
 *
 * ## What this module refuses to do
 *
 * It does not report missing keys. `analyses/translations.ts` owns `CMP-0200`/`CMP-0201` and
 * `validateStructural` owns `SCH-1008` (a content-referenced key absent from the base bundle);
 * resolution here is the *rendering* decision that follows those checks, and reporting a third
 * time under a third code is what `flow.ts` and `registry.ts` both decline to do. It also does not
 * sanitize: `analyses/assets.ts` scans every string in every bundle for HTML that does not survive
 * the allowlist, and a rewriting pass here would make the stored document and the shipped artifact
 * disagree (ADR-003).
 */

import type { I18nRef, MissingStringPolicy, StringBundle, Survey } from '@resscript/schema';

/**
 * Every language the artifact stores a bundle for, base first.
 *
 * Base first and not sorted: the order is what a reader of `manifest.languages` sees, and the
 * base language is the one fact about that list a human needs first. Everything after it is in
 * code-point order, because a language list that moved when `available` was reordered would move
 * the manifest bytes and therefore the artifact hash.
 */
export function artifactLanguages(survey: Survey): readonly string[] {
  const base = survey.languages.base;
  const rest = new Set<string>();
  for (const language of survey.languages.available) {
    if (language.code !== base) rest.add(language.code);
  }
  for (const code of Object.keys(survey.languages.bundles)) {
    if (code !== base) rest.add(code);
  }
  return [base, ...[...rest].sort()];
}

/**
 * `language code → the bundle stored for it`.
 *
 * A declared language with no bundle gets `{}` rather than being dropped, so
 * `i18n/<code>.json` exists for every code in `manifest.languages` and a runtime fetch is never a
 * 404 it has to distinguish from a network failure. The emptiness is already reported
 * (`CMP-0200`/`CMP-0201` with `bundle_present: false`).
 */
export function buildI18n(survey: Survey): { readonly [languageCode: string]: StringBundle } {
  const out: { [languageCode: string]: StringBundle } = {};
  for (const code of artifactLanguages(survey)) {
    out[code] = survey.languages.bundles[code] ?? {};
  }
  return out;
}

/**
 * One language's view of the bundles, resolved once per compiled page tree.
 *
 * A closure over pre-built lookups rather than a function taking the survey, because page
 * emission calls it once per label, instruction and item of every question in the survey: on a
 * 2,000-question tracker that is tens of thousands of calls, and re-deriving the base bundle and
 * the policy on each is the kind of accidental quadratic that only shows up on the largest
 * customer's publish.
 */
export interface StringResolver {
  readonly language: string;
  /** `undefined`/`null` in, `null` out — an absent label is absent, not the empty string. */
  readonly resolve: (ref: I18nRef | null | undefined) => string | null;
  /** The raw form, for a key that is not carried as an `I18nRef` (a `message_key`). */
  readonly resolveKey: (key: string) => string;
}

export function stringResolver(survey: Survey, language: string): StringResolver {
  const languages = survey.languages;
  const bundle: StringBundle = languages.bundles[language] ?? {};
  const base: StringBundle = languages.bundles[languages.base] ?? {};
  const policy: MissingStringPolicy = languages.policy.on_missing;

  const resolveKey = (key: string): string => {
    const own = bundle[key];
    // Present-but-empty is a deliberate act — a locale that legitimately has no instruction — and
    // `analyses/translations.ts` says so explicitly. It resolves to the empty string, not to a
    // fallback, so the two cannot be confused by a reader of the compiled page.
    if (own !== undefined) return own;
    return missing(key, base, policy);
  };

  return {
    language,
    resolve: (ref) => (ref === undefined || ref === null ? null : resolveKey(ref.key)),
    resolveKey,
  };
}

/**
 * What a key absent from this language's bundle renders as.
 *
 * `fallback_to_base` is the only arm that reads another bundle. `show_key` renders the key, which
 * is what the policy names. `block` renders the key **too**, and that is not the policy's runtime
 * behaviour being ignored: `block` means the respondent is stopped dead at that string, and
 * `analyses/translations.ts` makes an incomplete bundle under `block` a publish-blocking
 * `CMP-0200` for exactly that reason. So a compiled artifact with a `block` policy and a missing
 * key does not exist outside a fixture, and rendering the key there is the choice that keeps this
 * function total without inventing a fourth policy. The runtime's hard stop is the runtime's, and
 * it has `manifest` plus the shipped bundle to decide it from.
 *
 * A key missing from the *base* bundle as well is `SCH-1008` and equally unpublishable; the key
 * itself is the honest rendering, since the alternative — the empty string — is indistinguishable
 * from a deliberately blanked translation.
 */
function missing(key: string, base: StringBundle, policy: MissingStringPolicy): string {
  switch (policy) {
    case 'fallback_to_base':
      return base[key] ?? key;
    case 'show_key':
    case 'block':
      return key;
    default: {
      const never: never = policy;
      throw new Error(`Unhandled missing-string policy: ${JSON.stringify(never)}`);
    }
  }
}
