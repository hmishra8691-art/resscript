/**
 * DSL diagnostics → Monaco markers. 09-ui §7.4's "setModelMarkers (LGC-* code, severity, span,
 * code href to docs)".
 *
 * ## Offsets
 *
 * `DslDiagnostic.span` carries **UTF-16 code-unit** offsets (rescript-dsl's diagnostics.ts header,
 * README open decision 17), which is exactly what Monaco counts: `model.getOffsetAt` /
 * `getPositionAt` walk the same units, and so does `String.prototype.slice`. So the conversion
 * below is a plain scan of the source with no encoding step — and `positionAt` is unit-tested
 * against text containing astral-plane characters, because that is where a byte-offset assumption
 * would show up as underlines drifting right by the number of preceding non-ASCII characters.
 *
 * A span's `line`/`col` are only given for `start`; `end` needs converting anyway, so this module
 * converts both from offsets rather than trusting one and computing the other. That also keeps it
 * correct for checker diagnostics, whose span is attached from the source map.
 *
 * ## Why the marker type is ours and not `monaco.editor.IMarkerData`
 *
 * `IMarkerData.code.target` is a `monaco.Uri`, and constructing one needs the live `monaco`
 * namespace — which would drag the editor into this module's entry graph for the sake of a URL.
 * So `code.target` is a string here and `register.ts` (which already holds `monaco`) parses it.
 * The rest of the shape is `IMarkerData`'s, structurally, so the adapter is a one-line map.
 */

import type * as monaco from 'monaco-editor';
import type { DslDiagnostic, Span } from '@resscript/rescript-dsl';
import type { LgcSeverity } from '@resscript/logic';

/**
 * Monaco's `MarkerSeverity` values, as numbers.
 *
 * Restated rather than imported because importing them means importing the editor (see the
 * header). `__tests__/monaco-enums.test.ts` reads the enum out of `monaco-editor`'s own `.d.ts`
 * and fails if these ever stop matching, so the copy cannot rot.
 */
export const MARKER_SEVERITY = {
  hint: 1,
  info: 2,
  warning: 4,
  error: 8,
} as const;

/** D §3.5 severities → Monaco's, per §7.4: error → Error, warn → Warning, info → Info. */
const SEVERITY_OF: { readonly [K in LgcSeverity]: number } = {
  error: MARKER_SEVERITY.error,
  warning: MARKER_SEVERITY.warning,
  info: MARKER_SEVERITY.info,
};

/** The `owner` string every ResScript marker set is written under, so one call can clear them. */
export const MARKER_OWNER = 'resscript';

/**
 * Where `[why?]` goes (§13.1). A studio-relative path rather than an absolute docs URL: the
 * diagnostic page substitutes the survey's own values, which only this app can do.
 */
export function docsUrlFor(code: string): string {
  return `/docs/diagnostics/${code}`;
}

export interface ResScriptMarker {
  readonly severity: number;
  readonly message: string;
  readonly startLineNumber: number;
  readonly startColumn: number;
  readonly endLineNumber: number;
  readonly endColumn: number;
  readonly code: { readonly value: string; readonly target: string };
  readonly source: string;
}

export interface EditorPosition {
  readonly lineNumber: number;
  readonly column: number;
}

/** 1-based line/column for a UTF-16 offset, Monaco's convention. */
export function positionAt(source: string, offset: number): EditorPosition {
  const clamped = Math.max(0, Math.min(offset, source.length));
  let lineNumber = 1;
  let lineStart = 0;
  for (let i = 0; i < clamped; i += 1) {
    if (source.charCodeAt(i) === 10 /* \n */) {
      lineNumber += 1;
      lineStart = i + 1;
    }
  }
  return { lineNumber, column: clamped - lineStart + 1 };
}

/** The inverse, so a caller holding a Monaco position can ask the DSL about that offset. */
export function offsetAt(source: string, position: EditorPosition): number {
  let offset = 0;
  let line = 1;
  while (line < position.lineNumber) {
    const next = source.indexOf('\n', offset);
    if (next === -1) return source.length;
    offset = next + 1;
    line += 1;
  }
  return Math.min(offset + Math.max(0, position.column - 1), source.length);
}

export interface MarkerRange {
  readonly startLineNumber: number;
  readonly startColumn: number;
  readonly endLineNumber: number;
  readonly endColumn: number;
}

export function spanToRange(source: string, span: Span): MarkerRange {
  const start = positionAt(source, span.start);
  const end = positionAt(source, Math.max(span.end, span.start));
  // A zero-width span (`RSL-0005` at the end of input, a missing token) would render as an
  // invisible marker, so it is widened by one COLUMN rather than by one offset — an offset past
  // the end of the document clamps back to the same place and the widening is lost, which is
  // exactly what "expected an expression, found the end of the input" produces.
  const widened = end.lineNumber === start.lineNumber && end.column === start.column;
  return {
    startLineNumber: start.lineNumber,
    startColumn: start.column,
    endLineNumber: end.lineNumber,
    endColumn: widened ? end.column + 1 : end.column,
  };
}

/**
 * Every diagnostic becomes a marker. A diagnostic with no span still becomes one, on line 1,
 * because `withSpan` leaves the span off when the checker names a node the source map does not
 * cover — and an error the author cannot see is an error nobody fixes (§13.1).
 */
export function toMarkers(
  source: string,
  diagnostics: readonly DslDiagnostic[],
): readonly ResScriptMarker[] {
  return diagnostics.map((diagnostic): ResScriptMarker => {
    const range =
      diagnostic.span === undefined
        ? spanToRange(source, { start: 0, end: firstLineEnd(source), line: 1, col: 1 })
        : spanToRange(source, diagnostic.span);
    return {
      ...range,
      severity: SEVERITY_OF[diagnostic.severity],
      message: diagnostic.message,
      code: { value: diagnostic.code, target: docsUrlFor(diagnostic.code) },
      source: MARKER_OWNER,
    };
  });
}

function firstLineEnd(source: string): number {
  const newline = source.indexOf('\n');
  return newline === -1 ? source.length : newline;
}

/** The adapter's half: our marker plus a real `monaco.Uri` for the docs link. */
export function toMonacoMarker(
  marker: ResScriptMarker,
  uri: (target: string) => monaco.Uri,
): monaco.editor.IMarkerData {
  return {
    severity: marker.severity as monaco.MarkerSeverity,
    message: marker.message,
    startLineNumber: marker.startLineNumber,
    startColumn: marker.startColumn,
    endLineNumber: marker.endLineNumber,
    endColumn: marker.endColumn,
    code: { value: marker.code.value, target: uri(marker.code.target) },
    source: marker.source,
  };
}
