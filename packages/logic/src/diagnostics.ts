/**
 * The `LGC-####` diagnostic catalogue — D §3.5, plus the codes the analyses in D §8 need.
 *
 * The *shape* mirrors `packages/schema/src/diagnostics.ts` deliberately (machine code, human
 * message, RFC 6901 pointer, machine-readable detail, deterministic sort) so the studio can
 * render `SCH-####` and `LGC-####` through one component. It is a superset in exactly one
 * respect: severity adds `'info'`, because D §3.5 requires `LGC-I002` ("`ON UNKNOWN`
 * override present") and schema has no informational severity. Everything else is identical
 * on purpose — two diagnostic shapes in one UI is how one of them stops being rendered.
 *
 * Codes are append-only and never re-used: UI copy, docs links and CI allowlists key off
 * them (same contract as schema's).
 *
 * Codes marked EXTENSION are not literally in D §3.5's table, which the document calls
 * "representative". They exist because the checker cannot report a real failure without
 * them; each one names the rule from D §3.3 that it enforces.
 */

export const LGC_DIAGNOSTIC_CODES = {
  /* ---- types (D §3.5) -------------------------------------------------- */
  'LGC-T001': 'Unknown variable id, or a reference that resolves to nothing.',
  'LGC-T002': 'Unknown AST node kind. EXTENSION: closes the AST_KINDS registry at runtime.',
  'LGC-T003': 'Comparison between incompatible types.',
  'LGC-T004': 'A boolean was required. EXTENSION: enforces the and/or/not rule of D §3.3.',
  'LGC-T005': 'Arithmetic on a non-numeric operand. EXTENSION: enforces `arith : num*`.',
  'LGC-T006': 'Wrong argument count for this operator. EXTENSION: arity is part of the union.',
  'LGC-T007': 'Enum comparison across different domains.',
  'LGC-T008': 'A string operation on a non-text operand. EXTENSION: enforces `str : text`.',
  'LGC-T009': 'Ordered comparison on a non-ordinal enum domain.',
  'LGC-T010': 'A date operation on a non-date operand. EXTENSION: enforces `date : date`.',
  'LGC-T011': 'A set operation on a non-set operand. EXTENSION: enforces the set rules.',
  'LGC-T012': 'item / item_attr used outside an aggregation or a per-item mask.',
  'LGC-T013':
    'An item meta key is absent from the group, or carries different types on different items. ' +
    'EXTENSION: schema declares item meta as free-form JSON, so the checker infers its type ' +
    'from the group and needs a code for the inconsistent case.',
  'LGC-T014': 'case branches have non-unifiable types.',
  'LGC-T015': 'coalesce arguments have non-unifiable types. EXTENSION: same rule as T014.',
  'LGC-T016': 'A probe target does not exist. EXTENSION: probes reference ids like everything else.',
  'LGC-T018': 'An aggregation group resolves to zero variables.',
  'LGC-T019': 'An aggregation function is applied to an unsupported element type. EXTENSION.',
  'LGC-T021': 'A set operand domain differs from the element domain.',
  'LGC-T025': 'A regex literal fails to compile, or is not provably linear-time.',
  'LGC-T030': 'A set_variable target is not writable (kind response / system).',
  'LGC-T031': 'A set_variable value type does not match the target variable. EXTENSION.',
  'LGC-T032': 'A mask rule has no fallback.when_empty. EXTENSION of D §4.2 into a code.',
  'LGC-T033': 'A rule condition is not boolean-typed. EXTENSION: the rule-boundary form of T004.',
  'LGC-T034': 'A rule effect references a target of the wrong kind. EXTENSION.',
  /* ---- warnings (D §3.5) ----------------------------------------------- */
  'LGC-W014': 'A case with `else: null` feeds a comparison.',
  'LGC-W021': 'A terminate condition can be UNKNOWN on a reachable path.',
  'LGC-W030': 'A condition is provably constant.',
  'LGC-W031': 'A condition is provably unsatisfiable.',
  'LGC-W040': 'An option can never be shown.',
  /* ---- flow analyses (D §8.1, §8.2) ------------------------------------ */
  'LGC-F001': 'Forward reference: no path sets this variable before the rule reads it.',
  'LGC-F002': 'Conditionally unset: some paths set the variable, some do not.',
  'LGC-U001': 'A flow node is unreachable from start. EXTENSION of D §8.2 into a code.',
  'LGC-U002': 'A question is provably never visible. EXTENSION of D §8.2 into a code.',
  'LGC-U003': 'A required question is provably never visible. EXTENSION of D §8.2.',
  /* ---- ordering (D §4.5, §4.6) ----------------------------------------- */
  'LGC-CYCLE': 'A rule dependency cycle.',
  'LGC-CONFLICT': 'Two rules write the same non-lattice cell.',
  /* ---- quotas (D §8.5) ------------------------------------------------- */
  'LGC-Q001': 'A quota cell can never be filled.',
  'LGC-Q002': 'Quota targets are arithmetically inconsistent with the plan total.',
  'LGC-Q003': 'A quota dimension reads a variable collected after the gate.',
  /* ---- info (D §3.5) --------------------------------------------------- */
  'LGC-I002': 'An ON UNKNOWN override is present.',
} as const;

export type LgcCode = keyof typeof LGC_DIAGNOSTIC_CODES;

export const ALL_LGC_CODES: readonly LgcCode[] = Object.keys(LGC_DIAGNOSTIC_CODES) as readonly LgcCode[];

export type LgcSeverity = 'error' | 'warning' | 'info';

/**
 * Severity is a property of the code, not of the call site. D §3.5 states it per code
 * ("errors block publish; warnings require acknowledgement"), so a rule that emitted the
 * same code at two severities would make the publish gate depend on which branch found it.
 */
export const LGC_SEVERITY: { readonly [K in LgcCode]: LgcSeverity } = {
  'LGC-T001': 'error',
  'LGC-T002': 'error',
  'LGC-T003': 'error',
  'LGC-T004': 'error',
  'LGC-T005': 'error',
  'LGC-T006': 'error',
  'LGC-T007': 'error',
  'LGC-T008': 'error',
  'LGC-T009': 'error',
  'LGC-T010': 'error',
  'LGC-T011': 'error',
  'LGC-T012': 'error',
  'LGC-T013': 'error',
  'LGC-T014': 'error',
  'LGC-T015': 'error',
  'LGC-T016': 'error',
  'LGC-T018': 'error',
  'LGC-T019': 'error',
  'LGC-T021': 'error',
  'LGC-T025': 'error',
  'LGC-T030': 'error',
  'LGC-T031': 'error',
  'LGC-T032': 'error',
  'LGC-T033': 'error',
  'LGC-T034': 'error',
  'LGC-W014': 'warning',
  'LGC-W021': 'warning',
  'LGC-W030': 'warning',
  'LGC-W031': 'warning',
  'LGC-W040': 'warning',
  'LGC-F001': 'error',
  'LGC-F002': 'warning',
  'LGC-U001': 'error',
  'LGC-U002': 'warning',
  'LGC-U003': 'error',
  'LGC-CYCLE': 'error',
  'LGC-CONFLICT': 'error',
  'LGC-Q001': 'error',
  'LGC-Q002': 'warning',
  'LGC-Q003': 'error',
  'LGC-I002': 'info',
};

/** JSON-safe detail payload. Mirrors schema's `JsonValue` without importing it (ADR-010). */
export type LgcJsonValue =
  | string
  | number
  | boolean
  | null
  | readonly LgcJsonValue[]
  | { readonly [key: string]: LgcJsonValue };

export interface LgcDiagnostic {
  readonly code: LgcCode;
  readonly severity: LgcSeverity;
  readonly message: string;
  /** RFC 6901 JSON Pointer into the authoring document. `''` means the document itself. */
  readonly path: string;
  /** Machine-readable specifics: the two domains, the cycle path, the offending code. */
  readonly detail?: { readonly [key: string]: LgcJsonValue };
}

/** Build a JSON Pointer from path segments, escaping per RFC 6901. Same as schema's. */
export function pointer(...segments: readonly (string | number)[]): string {
  if (segments.length === 0) return '';
  return `/${segments.map((s) => String(s).replaceAll('~', '~0').replaceAll('/', '~1')).join('/')}`;
}

export function diagnostic(
  code: LgcCode,
  message: string,
  path: string,
  detail?: { readonly [key: string]: LgcJsonValue },
): LgcDiagnostic {
  return detail === undefined
    ? { code, severity: LGC_SEVERITY[code], message, path }
    : { code, severity: LGC_SEVERITY[code], message, path, detail };
}

/**
 * Deterministic order: code, then path, then message — byte-identical to schema's
 * `sortDiagnostics`, so a combined list sorts as one list. Diagnostics end up in CI logs and
 * golden files; a stable order is what keeps a diff meaningful.
 */
export function sortDiagnostics(diagnostics: readonly LgcDiagnostic[]): readonly LgcDiagnostic[] {
  return [...diagnostics].sort(
    (a, b) =>
      a.code.localeCompare(b.code) ||
      a.path.localeCompare(b.path) ||
      a.message.localeCompare(b.message),
  );
}

export function hasErrors(diagnostics: readonly LgcDiagnostic[]): boolean {
  return diagnostics.some((d) => d.severity === 'error');
}

export function errorsOnly(diagnostics: readonly LgcDiagnostic[]): readonly LgcDiagnostic[] {
  return diagnostics.filter((d) => d.severity === 'error');
}
