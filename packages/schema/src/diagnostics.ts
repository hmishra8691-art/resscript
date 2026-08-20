/**
 * Diagnostics.
 *
 * Every problem this package can find is reported, never thrown: the callers are an editor
 * that must show all the errors at once, a CI gate that wants a machine-readable list, and an
 * importer that has to explain why a file was rejected. An exception gives all three the first
 * error and nothing else.
 *
 * A diagnostic carries three things:
 *  - `code` — stable and machine-matchable (`SCH-1003`). UI copy, docs links and CI
 *    allowlists key off this, so codes are append-only and never re-used.
 *  - `message` — for a human, naming the actual offending value.
 *  - `path` — an RFC 6901 JSON Pointer to the offending node, so the studio can focus the
 *    exact field rather than "somewhere in your survey".
 */

import type { JsonValue } from './types/common.js';

export const DIAGNOSTIC_CODES = {
  /* Document-level */
  'SCH-0001': 'The document is not valid JSON.',
  'SCH-0002': 'The document root is not a survey object.',
  /* Shape (derived from the schema descriptor) */
  'SCH-0100': 'A required field is missing.',
  'SCH-0101': 'A field has the wrong type.',
  'SCH-0102': 'An unknown field is present.',
  'SCH-0103': 'A field value is outside its allowed set.',
  'SCH-0104': 'A field value does not match its required pattern.',
  /* Structural */
  'SCH-1001': 'A ref or variable name is used more than once within the version.',
  'SCH-1002': 'An id is malformed or carries the wrong prefix.',
  'SCH-1003': 'A variable name collides with the reserved system namespace.',
  'SCH-1004': 'A reference points at an id that does not exist.',
  'SCH-1005': 'A mask is missing fallback.when_empty.',
  'SCH-1006': 'Two items of one question share an option code.',
  'SCH-1007': 'An enum or set variable has an empty domain.',
  'SCH-1008': 'A referenced i18n key is missing from the base language bundle.',
  'SCH-1009': 'An id is used by more than one node.',
  'SCH-1010': 'A variable name does not match the derivation rule for its source.',
  'SCH-1011': 'A language is referenced but not declared in languages.available.',
  'SCH-1012': 'The quota policy is missing an explicit counter_scope.',
  'SCH-1013': 'Two exported variables claim the same export column.',
  'SCH-1014': 'A ref does not match the required format.',
  'SCH-1015': 'A variable has an expression without kind "derived", or vice versa.',
} as const;

export type DiagnosticCode = keyof typeof DIAGNOSTIC_CODES;

export const ALL_DIAGNOSTIC_CODES: readonly DiagnosticCode[] = Object.keys(
  DIAGNOSTIC_CODES,
) as readonly DiagnosticCode[];

export type DiagnosticSeverity = 'error' | 'warning';

export interface Diagnostic {
  readonly code: DiagnosticCode;
  readonly severity: DiagnosticSeverity;
  readonly message: string;
  /** RFC 6901 JSON Pointer into the survey document. `''` means the document itself. */
  readonly path: string;
  /** Machine-readable specifics (the colliding name, the expected value, …). */
  readonly detail?: { readonly [key: string]: JsonValue };
}

/** Build a JSON Pointer from path segments, escaping per RFC 6901. */
export function pointer(...segments: readonly (string | number)[]): string {
  if (segments.length === 0) return '';
  return `/${segments
    .map((s) => String(s).replaceAll('~', '~0').replaceAll('/', '~1'))
    .join('/')}`;
}

/**
 * Deterministic order: code, then path, then message. Diagnostics end up in CI logs and
 * golden files, so a stable order is what keeps a diff meaningful.
 */
export function sortDiagnostics(diagnostics: readonly Diagnostic[]): readonly Diagnostic[] {
  return [...diagnostics].sort(
    (a, b) =>
      a.code.localeCompare(b.code) || a.path.localeCompare(b.path) || a.message.localeCompare(b.message),
  );
}

export function hasErrors(diagnostics: readonly Diagnostic[]): boolean {
  return diagnostics.some((d) => d.severity === 'error');
}
