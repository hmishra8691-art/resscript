/**
 * The compiler's diagnostic type, and the codes only the compiler can emit.
 *
 * WHY A THIRD DIAGNOSTIC TYPE. `packages/schema` and `packages/logic` each own a *closed* code
 * union — `DiagnosticCode` is exactly the `SCH-*` set, `LgcCode` is exactly the `LGC-*` set —
 * and both are deliberately closed so that a typo in a code is a compile error rather than a
 * diagnostic nobody ever sees. The compile gate has to report all three families in one list
 * (a publish dialog shows the user one list, not three), so this module widens `code` to
 * `string` at exactly one place and re-narrows it per family through the three constructors.
 * Nothing here re-declares a `SCH-` or `LGC-` code; those are imported and lifted.
 *
 * WHY `CMP-*` CODES EXIST AT ALL. Ten of the checks the roadmap assigns to P1-08 already have
 * codes reserved in `packages/logic`'s catalogue (`LGC-F001`/`F002`, `U001`–`U003`, `W014`,
 * `W031`, `W040`, `Q001`–`Q003`) and this compiler emits those under their reserved codes — it
 * does not invent parallel ones. What is left over is the work that is not logic analysis at
 * all: flow-graph wellformedness, translation completeness, redirect coverage, plugin
 * resolution, HTML sanitization, entitlements. Those get `CMP-*`.
 *
 * Codes are append-only and never re-used, the same rule both other catalogues follow. A
 * removed check leaves its code retired rather than freeing it, because a code appears in
 * `survey_versions.compile_diagnostics` rows that outlive the build that wrote them.
 */

import {
  hasErrors as schemaHasErrors,
  sortDiagnostics as sortSchemaDiagnostics,
  type Diagnostic as SchemaDiagnostic,
  type JsonValue,
} from '@resscript/schema';
import type { LgcDiagnostic } from '@resscript/logic';

/**
 * The compiler-owned codes.
 *
 * Grouped by hundred so the group is readable from the code alone in a log line where the
 * message has been truncated: 00xx flow wellformedness, 01xx content, 02xx i18n, 03xx
 * dispositions, 04xx plugins, 05xx assets and security, 06xx entitlements, 07xx contract gaps,
 * 08xx compile integrity.
 */
export const CMP_DIAGNOSTIC_CODES = {
  'CMP-0001': 'the flow declares no start node, so no page is reachable',
  'CMP-0002': 'the flow declares more than one start node',
  'CMP-0003': 'a branch node has no else arm, or its else arm is not last',
  'CMP-0004': 'a flow node points at content the compiler cannot lay out as pages',
  'CMP-0005': 'a flow edge names a node that does not exist',
  'CMP-0006': 'a skip rule targets content no flow node lays out, so the skip has nothing to write',

  'CMP-0100': 'nested loops are not supported at this schema version',
  'CMP-0104': 'a loop is configured to iterate zero times',
  'CMP-0105': 'a loop allows an unusually large number of iterations',
  'CMP-0106': 'a loop variable-naming template omits {iteration}',
  'CMP-0107': 'a loop lists duplicate item refs or codes',
  'CMP-0108': 'a derived per-iteration page id collides with an existing id',
  'CMP-0101': 'a loop reads a variable that cannot enumerate iterations',
  'CMP-0102': 'a question emits no variables and is not a content-only type',
  'CMP-0103': 'a derived variable has neither an expression nor a synthesizable structure',

  'CMP-0200': 'a language bundle is incomplete and publish is blocked on completeness',
  'CMP-0201': 'a language bundle is incomplete and will fall back to the base language',

  'CMP-0300': 'a reachable termination has no configured redirect for its disposition',
  'CMP-0301': 'a redirect template interpolates a variable flagged as personal data',

  'CMP-0400': 'the question type is not present in the plugin registry',
  'CMP-0401': 'the question config does not satisfy the plugin config schema',
  'CMP-0402': 'the plugin major recorded for this question is no longer available',

  'CMP-0500': 'author HTML did not survive sanitization',
  'CMP-0501': 'a script asset declares no execution target, or an incompatible one',
  'CMP-0502': 'a media or template asset referenced by content does not exist',
  'CMP-0503': 'author CSS contains a construct that can execute, fetch or exfiltrate',
  'CMP-0504': 'a page HTML template has no slot for the questions',

  'CMP-0600': 'the survey requires an entitlement the plan does not include',

  'CMP-0700': 'a rule uses ON UNKNOWN, which the current authoring schema cannot persist',
  'CMP-0701': 'an enum domain has no stable identity, so cross-question set logic is unprovable',
  'CMP-0702': 'a rule effect has no counterpart in the logic engine effect union',

  'CMP-0800': 'the cell graph has no evaluation order, so the program cannot be published',
  'CMP-0801': 'the compile produced no pages',
} as const;

export type CmpCode = keyof typeof CMP_DIAGNOSTIC_CODES;
export const ALL_CMP_CODES: readonly CmpCode[] = Object.keys(
  CMP_DIAGNOSTIC_CODES,
) as readonly CmpCode[];

export type CompileSeverity = 'error' | 'warning' | 'info';

/**
 * Severity is a property of the CODE, not of the call site — the same rule the other two
 * catalogues follow, and the reason a publish dialog can group by severity without asking the
 * emitter what it meant.
 */
export const CMP_SEVERITY: { readonly [K in CmpCode]: CompileSeverity } = {
  'CMP-0001': 'error',
  'CMP-0002': 'error',
  'CMP-0003': 'error',
  'CMP-0004': 'error',
  'CMP-0005': 'error',
  'CMP-0006': 'error',

  'CMP-0100': 'error',
  // Zero iterations and duplicate items are ERRORS: neither survey has behaviour anybody can
  // state. A large iteration count and a naming template without {iteration} are WARNINGS: both
  // have perfectly definite behaviour that is probably not what was meant, which is the line this
  // codebase draws everywhere else.
  'CMP-0104': 'error',
  'CMP-0105': 'warning',
  'CMP-0106': 'warning',
  'CMP-0107': 'error',
  'CMP-0108': 'error',
  'CMP-0101': 'error',
  'CMP-0102': 'warning',
  'CMP-0103': 'error',

  'CMP-0200': 'error',
  'CMP-0201': 'warning',

  'CMP-0300': 'error',
  'CMP-0301': 'error',

  'CMP-0400': 'error',
  'CMP-0401': 'error',
  'CMP-0402': 'error',

  'CMP-0500': 'error',
  'CMP-0501': 'error',
  'CMP-0502': 'error',
  'CMP-0503': 'error',
  'CMP-0504': 'error',

  'CMP-0600': 'error',

  'CMP-0700': 'error',
  'CMP-0701': 'warning',
  'CMP-0702': 'error',

  'CMP-0800': 'error',
  'CMP-0801': 'error',
};

/** The compile gate's diagnostic. `code` spans `SCH-*`, `LGC-*` and `CMP-*`. */
export interface CompileDiagnostic {
  readonly code: string;
  readonly severity: CompileSeverity;
  readonly message: string;
  /** RFC 6901 JSON Pointer into the authoring document; `''` means the document itself. */
  readonly path: string;
  readonly detail?: { readonly [key: string]: JsonValue };
}

export function cmpDiagnostic(
  code: CmpCode,
  message: string,
  path: string,
  detail?: { readonly [key: string]: JsonValue },
): CompileDiagnostic {
  return {
    code,
    severity: CMP_SEVERITY[code],
    message,
    path,
    ...(detail === undefined ? {} : { detail }),
  };
}

/** Lift a `packages/schema` structural diagnostic. Severity and path carry over unchanged. */
export function fromSchemaDiagnostic(d: SchemaDiagnostic): CompileDiagnostic {
  return {
    code: d.code,
    severity: d.severity,
    message: d.message,
    path: d.path,
    ...(d.detail === undefined ? {} : { detail: d.detail }),
  };
}

/**
 * Lift a `packages/logic` diagnostic. `LgcDiagnostic.detail` is typed over logic's own
 * `LgcJsonValue`, which is structurally the same shape as schema's `JsonValue`; the cast is the
 * one place that equivalence is asserted rather than re-proved per call site.
 */
export function fromLogicDiagnostic(d: LgcDiagnostic): CompileDiagnostic {
  return {
    code: d.code,
    severity: d.severity,
    message: d.message,
    path: d.path,
    ...(d.detail === undefined
      ? {}
      : { detail: d.detail as { readonly [key: string]: JsonValue } }),
  };
}

/**
 * Total order: code, then path, then message. Deterministic, and it groups a family together
 * so a reviewer reading `compile_diagnostics` sees all the forward references at once.
 *
 * This must stay a *total* order with no tie left to input order, because the diagnostics array
 * is written to `survey_versions.compile_diagnostics` and compared byte-for-byte by the
 * republish-is-a-no-op test.
 */
export function sortCompileDiagnostics(
  diagnostics: readonly CompileDiagnostic[],
): readonly CompileDiagnostic[] {
  return [...diagnostics].sort(
    (a, b) =>
      a.code.localeCompare(b.code) ||
      a.path.localeCompare(b.path) ||
      a.message.localeCompare(b.message),
  );
}

export function hasCompileErrors(diagnostics: readonly CompileDiagnostic[]): boolean {
  return diagnostics.some((d) => d.severity === 'error');
}

export function compileErrors(
  diagnostics: readonly CompileDiagnostic[],
): readonly CompileDiagnostic[] {
  return diagnostics.filter((d) => d.severity === 'error');
}

export function compileWarnings(
  diagnostics: readonly CompileDiagnostic[],
): readonly CompileDiagnostic[] {
  return diagnostics.filter((d) => d.severity === 'warning');
}

/**
 * The identity a warning acknowledgement is recorded against.
 *
 * Not the message — messages carry ids and positions and change when the survey is edited, and
 * an acknowledgement that survives an unrelated edit is an acknowledgement the author never
 * gave. Code plus path plus the sorted detail is stable under reformatting and unstable under
 * anything that changes what the warning is about, which is exactly the wanted behaviour.
 */
export function acknowledgementKey(d: CompileDiagnostic): string {
  const detail = d.detail === undefined ? '' : stableDetail(d.detail);
  return `${d.code} ${d.path} ${detail}`;
}

function stableDetail(detail: { readonly [key: string]: JsonValue }): string {
  const keys = Object.keys(detail).sort();
  const parts = keys.map((k) => `${k}=${JSON.stringify(detail[k] ?? null)}`);
  return parts.join('');
}

/** Re-exported so callers do not need a second import for the schema half of the gate. */
export { schemaHasErrors, sortSchemaDiagnostics };
