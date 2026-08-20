/**
 * Compile diagnostics from a plugin.
 *
 * The shape is deliberately field-for-field identical to `@resscript/schema`'s `Diagnostic`
 * (`code`, `severity`, `message`, `path`, `detail`) so the studio's problem panel renders a
 * schema diagnostic and a plugin diagnostic through one component and CI allowlists key off
 * one field. The one thing that cannot be shared is the `code` type: schema's is a closed
 * union of `SCH-####` literals, and the plugin registry is open by design (F §7), so a plugin
 * code is a string.
 *
 * Deliverable F §2's sample writes `{ level: 'error', … }`. `severity` is used here instead,
 * because matching schema's shape is worth more than matching a sketch's field name, and a
 * studio component that has to branch on `level` vs `severity` is exactly the kind of small
 * incoherence that makes a "render both through one component" promise quietly false.
 */

import { pointer, type DiagnosticSeverity, type JsonValue } from '@resscript/schema';

export type { DiagnosticSeverity };
export { pointer };

export interface CompileDiagnostic {
  /**
   * Namespaced `QK-<pluginId>-<localCode>` by `namespaceDiagnostics` when the kit collects a
   * plugin's output, so two plugins can both use the code `no_options` and a CI allowlist can
   * still name one of them.
   */
  readonly code: string;
  readonly severity: DiagnosticSeverity;
  readonly message: string;
  /** RFC 6901 JSON Pointer. Relative to the question when a plugin emits it; absolute after. */
  readonly path: string;
  readonly detail?: { readonly [key: string]: JsonValue };
}

/**
 * What a plugin's `staticChecks` returns: the same thing minus the bookkeeping the kit can do
 * for it. `path` defaults to the question root, and the code is namespaced on collection.
 */
export interface PluginDiagnostic {
  readonly code: string;
  readonly severity: DiagnosticSeverity;
  readonly message: string;
  /** Pointer *relative to the question node*, e.g. `/config/other`. Defaults to `''`. */
  readonly path?: string;
  readonly detail?: { readonly [key: string]: JsonValue };
}

export function namespaceCode(pluginId: string, code: string): string {
  return `QK-${pluginId}-${code}`;
}

/**
 * Lift plugin-relative diagnostics into document-absolute ones.
 *
 * `basePath` is the pointer to the question node in the survey document; the compiler owns it,
 * because only the compiler knows where in the tree the question sits.
 */
export function namespaceDiagnostics(
  pluginId: string,
  basePath: string,
  diagnostics: readonly PluginDiagnostic[],
): readonly CompileDiagnostic[] {
  return diagnostics.map((d) => ({
    code: namespaceCode(pluginId, d.code),
    severity: d.severity,
    message: d.message,
    path: `${basePath}${d.path ?? ''}`,
    ...(d.detail === undefined ? {} : { detail: d.detail }),
  }));
}

export function hasErrors(diagnostics: readonly CompileDiagnostic[]): boolean {
  return diagnostics.some((d) => d.severity === 'error');
}
