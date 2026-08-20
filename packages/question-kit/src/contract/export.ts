/**
 * Export contribution — Deliverable F §1.3.
 *
 * The exporter reads the *variable manifest* for columns and types; it never calls
 * `declareVariables`, because the manifest is that call's frozen output and a plugin upgrade
 * must not retroactively change a completed study's columns (F §7, ADR-002). What it does call
 * is this: labels, projection-time derived columns, and the sidecar declaration — resolved at
 * the plugin version recorded in the manifest, which is why that version is recorded.
 */

import type { JsonValue, VariableType } from '@resscript/schema';
import type { I18nKey } from './meta.js';
import type { ResolvedQuestion } from './validate.js';
import type { VariableDeclaration } from './variables.js';

export interface ExportContext<Config> {
  readonly question: ResolvedQuestion<Config>;
  readonly config: Config;
  /** The export language. One export is one language; labels are resolved through `t`. */
  readonly lang: string;
  /** Resolve an i18n key. Missing keys return the key, so a label is never blank. */
  t(key: I18nKey): string;
}

export interface DerivedExportColumn {
  readonly column: string;
  readonly label: string;
  readonly type: VariableType;
  /**
   * Computed at projection time, not stored. Pure and total: it runs over a flat variable map
   * for every response row, so a throw here is a failed export rather than a bad cell.
   */
  compute(vars: Readonly<Record<string, JsonValue | null>>): JsonValue | null;
}

export interface ExportSidecar {
  readonly format: 'json' | 'ndjson';
  readonly filenameSuffix: string;
}

export interface ExportContribution<Config> {
  /**
   * Column label for the label-mode export and for SPSS metadata. Defaults come from the
   * manifest; a plugin overrides only when it knows better (a matrix wants
   * "Q3r2 — Brand C: satisfaction", not "Q3r2").
   */
  columnLabel(v: VariableDeclaration, ctx: ExportContext<Config>): string;
  valueLabels(
    v: VariableDeclaration,
    ctx: ExportContext<Config>,
  ): readonly { readonly code: JsonValue; readonly label: string }[];
  /** Optional columns computed at projection time: a ranking's top-3 flags, region hits. */
  readonly derivedColumns?: readonly DerivedExportColumn[];
  /** Non-scalar payloads that must not go in a flat cell (F §4). */
  readonly sidecar?: ExportSidecar;
}
