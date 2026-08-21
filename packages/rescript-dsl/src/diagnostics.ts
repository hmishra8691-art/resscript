/**
 * Positioned diagnostics for the DSL — the `RSL-####` family, plus the machinery that carries
 * `packages/logic`'s `LGC-####` catalogue out to a source span.
 *
 * WHY a second code family and not a second catalogue: D §3.5's codes are all *semantic* — they
 * are about a tree that already exists (unknown variable, incompatible comparison, non-ordinal
 * `<`). There is no `LGC` code for "you wrote `THEN` where a target was expected", because the
 * logic engine never sees text. So the split is by phase, not by taste: everything the lexer and
 * the parser find is `RSL-####`, and everything about a resolved tree is reported by
 * `packages/logic`'s checker under its own code, unchanged, with a span attached. The alternative
 * — restating LGC codes here — is exactly the drift ADR-010 exists to prevent, and it would put
 * two spellings of "unknown variable" in one editor gutter.
 *
 * Codes are append-only and never re-used: UI copy, docs links and CI allowlists key off them
 * (the same contract `SCH-####` and `LGC-####` have).
 *
 * The offsets are **UTF-16 code-unit offsets**, not bytes. The milestone brief says "byte
 * offsets"; every consumer named in the design (Monaco's `model.getOffsetAt`, the API's
 * `source_span`, `String.prototype.slice`) counts UTF-16 code units, and a diagnostic whose
 * offset disagrees with the editor's underlines by the number of preceding non-ASCII characters
 * is worse than useless in a multi-language survey. Recorded rather than silently reinterpreted.
 */

import type { LgcCode, LgcDiagnostic, LgcJsonValue, LgcSeverity } from '@resscript/logic';

export const RSL_DIAGNOSTIC_CODES = {
  'RSL-0001': 'Unexpected token.',
  'RSL-0002': 'Unterminated string literal.',
  'RSL-0003': 'Unterminated block comment.',
  'RSL-0004': 'Malformed number literal.',
  'RSL-0005': 'Unexpected end of input.',
  'RSL-0006': 'Unknown clause in this position.',
  'RSL-0007': 'QUOTA blocks are not supported until milestone P2-06.',
  'RSL-0008': 'This grammar form is recognized but not implemented in this milestone.',
  'RSL-0010': 'Unknown function.',
  'RSL-0011': 'Wrong argument count for this function.',
  'RSL-0012': 'A page or block reference could not be resolved to a stable id.',
  'RSL-0013': 'Malformed date literal.',
  'RSL-0014': 'Unknown symbolic option reference.',
  'RSL-0015': 'Stray character.',
  'RSL-0016': 'Duplicate clause.',
  'RSL-0020': 'An aggregation group does not name a question or a variable list.',
  'RSL-0021': 'The option domain of a code list cannot be inferred in this position.',
  'RSL-0022': 'An option or item reference does not exist on this question.',
  'RSL-0099':
    'Internal invariant: the input was parsed but could not be resolved. ' +
    'Reported as a diagnostic rather than thrown, because P8 (D §6.4) is absolute.',
} as const;

export type RslCode = keyof typeof RSL_DIAGNOSTIC_CODES;

export const ALL_RSL_CODES: readonly RslCode[] = Object.keys(RSL_DIAGNOSTIC_CODES) as readonly RslCode[];

/**
 * Severity is a property of the code, not of the call site — same rule as
 * `packages/logic/src/diagnostics.ts`, and for the same reason: a code that could be reported at
 * two severities would make the publish gate depend on which branch found it.
 *
 * `RSL-0012` is a warning, not an error, and that is the interesting one. `logic`'s `PageDecl`
 * and `BlockDecl` carry no `ref` (only questions do), so `SKIP TO P7` or `RANDOMIZE BLOCK MAIN`
 * cannot be resolved to an id from the type environment at all. The DSL keeps the author's text
 * and says so; the compiler (P1-08), which has the content tree, resolves it. Making it an error
 * would block publish on a perfectly valid statement.
 */
export const RSL_SEVERITY: { readonly [K in RslCode]: LgcSeverity } = {
  'RSL-0001': 'error',
  'RSL-0002': 'error',
  'RSL-0003': 'error',
  'RSL-0004': 'error',
  'RSL-0005': 'error',
  'RSL-0006': 'error',
  'RSL-0007': 'error',
  'RSL-0008': 'error',
  'RSL-0010': 'error',
  'RSL-0011': 'error',
  'RSL-0012': 'warning',
  'RSL-0013': 'error',
  'RSL-0014': 'error',
  'RSL-0015': 'error',
  'RSL-0016': 'error',
  'RSL-0020': 'error',
  'RSL-0021': 'error',
  'RSL-0022': 'error',
  'RSL-0099': 'error',
};

export type DslCode = RslCode | LgcCode;

/** A half-open source range plus the 1-based line/column of `start`, for editor consumers. */
export interface Span {
  readonly start: number;
  readonly end: number;
  readonly line: number;
  readonly col: number;
}

export interface DslDiagnostic {
  readonly code: DslCode;
  readonly severity: LgcSeverity;
  readonly message: string;
  /** RFC 6901 pointer, when the diagnostic came from the checker. `''` for source diagnostics. */
  readonly path: string;
  /** Absent only when a checker diagnostic named a node the source map does not cover. */
  readonly span?: Span;
  readonly detail?: { readonly [key: string]: LgcJsonValue };
}

export function rslDiagnostic(
  code: RslCode,
  message: string,
  span: Span,
  detail?: { readonly [key: string]: LgcJsonValue },
): DslDiagnostic {
  return {
    code,
    severity: RSL_SEVERITY[code],
    message,
    path: '',
    span,
    ...(detail === undefined ? {} : { detail }),
  };
}

/** Re-emit a checker diagnostic with a source span. The code, severity and message are unchanged. */
export function withSpan(diagnostic: LgcDiagnostic, span: Span | undefined): DslDiagnostic {
  return span === undefined ? { ...diagnostic } : { ...diagnostic, span };
}

/**
 * Source order, not code order.
 *
 * `packages/logic` sorts by code because its diagnostics have no position and a golden file needs
 * a stable order. These have positions, and both consumers — Monaco's problems pane and a
 * programmer reading a terminal — want them in the order they appear in the file. Ties break on
 * code then message so the order is still total, which is what keeps a golden file usable.
 */
export function sortDslDiagnostics(diagnostics: readonly DslDiagnostic[]): readonly DslDiagnostic[] {
  return [...diagnostics].sort(
    (a, b) =>
      (a.span?.start ?? -1) - (b.span?.start ?? -1) ||
      (a.span?.end ?? -1) - (b.span?.end ?? -1) ||
      a.code.localeCompare(b.code) ||
      a.message.localeCompare(b.message),
  );
}

export function hasDslErrors(diagnostics: readonly DslDiagnostic[]): boolean {
  return diagnostics.some((d) => d.severity === 'error');
}

/** True when `offset` falls inside `span`, treating a zero-width span as covering its point. */
export function spanCovers(span: Span, offset: number): boolean {
  return span.end === span.start ? offset === span.start : offset >= span.start && offset < span.end;
}
