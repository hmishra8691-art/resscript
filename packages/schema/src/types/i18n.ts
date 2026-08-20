/**
 * Internationalization — Deliverable C §16.
 *
 * All user-visible strings are `{ key }` references; the survey carries per-language bundles.
 * Separating keys from structure buys three things that are otherwise retrofits: translation
 * becomes an export/import of a flat key-value file (what translation vendors actually
 * accept), completeness is computable and can gate publish, and the compiled artifact ships
 * only the respondent's language — which materially reduces payload on a 12-language study.
 */

export interface LanguageDef {
  /** BCP-47-ish code. Matched case-sensitively against bundle keys and `?lang=`. */
  readonly code: string;
  readonly label?: string | null;
  /** Right-to-left. Drives the compiled theme direction, so it must be data, not a guess. */
  readonly rtl?: boolean;
}

export const MISSING_STRING_POLICIES = ['fallback_to_base', 'show_key', 'block'] as const;
export type MissingStringPolicy = (typeof MISSING_STRING_POLICIES)[number];

export interface LanguagePolicy {
  readonly on_missing: MissingStringPolicy;
  /** Translation completeness is computable, so it can be a publish gate rather than a hope. */
  readonly block_publish_if_incomplete: boolean;
}

export interface StringBundle {
  readonly [key: string]: string;
}

export interface Languages {
  /** The authoring language. Every key must exist here; other bundles may be partial. */
  readonly base: string;
  readonly available: readonly LanguageDef[];
  readonly bundles: { readonly [languageCode: string]: StringBundle };
  readonly policy: LanguagePolicy;
}
