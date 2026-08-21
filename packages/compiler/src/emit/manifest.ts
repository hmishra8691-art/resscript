/**
 * `ArtifactManifest` — the fixed part of the artifact: what it is, what it was compiled from,
 * what the export columns are, and what the browser is allowed to execute (C §17, F §5,
 * ADR-002, ADR-005, roadmap P1-08).
 *
 * ## The two empty fields
 *
 * `artifact_hash` and `compiled_at` are emitted as `''` here, always. That is not an oversight and
 * it is not this module's decision to revisit — `types.ts`' `ArtifactBundle` comment states the
 * addressing rule and `bundle.ts` implements it: the *stored* manifest carries both as empty
 * strings so the hash is neither self-referential nor time-dependent, and `buildBundle` fills them
 * in the in-memory copy. A caller wanting the filled manifest reads `bundle.artifact.manifest`.
 *
 * ## Variable manifest order is the export contract
 *
 * `variable_manifest` is `survey.variables` in **document order**, unsorted, unfiltered. Not
 * sorted by name, not sorted by id, not partitioned by kind, not filtered to
 * `export.include`. That order *is* the export column order — `buildVariableRegistry`'s own
 * comment says so ("Order is the export column order … document order for everything a question
 * emits, then the authored hidden/derived/system/quota variables") — and a client's analysis
 * scripts index columns positionally. Reordering it between two versions of one tracker silently
 * rewrites every downstream script, and the failure is discovered by the client's statistician
 * rather than by us. `export_include: false` entries stay in the list because the manifest is the
 * *contract*, not the file: dropping them would renumber every column after the first excluded
 * one, which is the same defect with an extra step.
 *
 * Nothing here recomputes a name or a column. `deriveVariableName` already ran (it is what wrote
 * `Variable.name`), and `VariableExport.column` is authored precisely so a client can pin a legacy
 * tracker layout; re-deriving either would overwrite the override.
 *
 * ## Plugin majors
 *
 * `plugin_versions` is a field this milestone added to `ArtifactManifest` (append-only — the
 * declaration in `packages/schema/src/types/artifact.ts` says so and why). `analyses/plugins.ts`
 * observes that before it existed the only record of a resolved plugin was
 * `CompiledQuestion.question_type`, which carries a major and not a version and says nothing at
 * all about a matrix's per-cell controls. F §5 pins a published survey to the plugin version it
 * compiled against, so the record has to be somewhere, and the manifest is where the runtime
 * already looks once per session.
 *
 * ## What this module refuses to do
 *
 * It resolves nothing. `resolvePlugins` resolved every question's plugin exactly once, for the
 * reason its own header gives — two registry lookups that can disagree produce an artifact whose
 * `question_type` is not the plugin its config was validated against — so this file takes the
 * resolution as an input and never calls the registry. Same for `scriptHashes`, `cspDirectives`
 * and `collectEntitlements`: each is the single derivation of its field and is called, not
 * reimplemented.
 */

import type {
  ArtifactManifest,
  Iso8601,
  Survey,
  Variable,
  VariableManifestEntry,
  ScriptBindingEntry,
} from '@resscript/schema';

import { collectEntitlements } from '../analyses/entitlements.js';
import { cspDirectives, scriptHashes } from '../analyses/assets.js';
import type { PluginResolution } from '../analyses/plugins.js';
import { ARTIFACT_SCHEMA_VERSION } from '../types.js';
import { artifactLanguages } from './i18n.js';

/** The value both volatile manifest fields carry in the stored bytes. See the header. */
export const UNRESOLVED_AT_STORE = '';

export interface ManifestInput {
  readonly survey: Survey;
  readonly surveyVersionId: string;
  /** `resolvePlugins`' output. Absent-resolution is a legal state: a fixture with no registry. */
  readonly plugins: PluginResolution;
}

export function buildManifest(input: ManifestInput): ArtifactManifest {
  const survey = input.survey;
  const hashes = scriptHashes(survey);
  // The dispatch table (artifact.ts's ScriptBindingEntry): ref-sorted for canonical bytes,
  // last-wins on a duplicate ref — the same tie-break scriptsOf and scriptHashes make, so the
  // binding always describes the source that shipped.
  const bindingByRef = new Map<string, ScriptBindingEntry>();
  for (const a of survey.assets?.scripts ?? []) {
    bindingByRef.set(a.ref, { ref: a.ref, scope: a.scope, hooks: a.hooks, runs_on: a.runs_on });
  }
  const bindings = [...bindingByRef.values()].sort((x, y) => (x.ref < y.ref ? -1 : 1));
  return {
    artifact_schema_version: ARTIFACT_SCHEMA_VERSION,
    survey_id: survey.meta.id,
    survey_version_id: input.surveyVersionId,
    artifact_hash: UNRESOLVED_AT_STORE,
    compiled_at: UNRESOLVED_AT_STORE as Iso8601,
    base_language: survey.languages.base,
    languages: artifactLanguages(survey),
    script_hashes: hashes,
    ...(bindings.length > 0 ? { script_bindings: bindings } : {}),
    csp_directives: cspDirectives(hashes),
    variable_manifest: variableManifest(survey),
    entitlements: collectEntitlements(survey, input.plugins),
    plugin_versions: Object.fromEntries(input.plugins.versions),
  };
}

/**
 * `survey.variables` → `VariableManifestEntry[]`, in document order. See the header.
 *
 * Exported separately because the exporter (P1-12) wants the column contract without the rest of
 * the manifest, and because this is the one function in the file whose ordering is a promise to a
 * third party rather than an implementation detail.
 */
export function variableManifest(survey: Survey): readonly VariableManifestEntry[] {
  return survey.variables.map(entryOf);
}

function entryOf(variable: Variable): VariableManifestEntry {
  const domain = variable.enum_domain;
  return {
    id: variable.id,
    name: variable.name,
    kind: variable.kind,
    type: variable.type,
    export_column: variable.export.column,
    export_include: variable.export.include,
    // `null` and absent are both legal in the contract and they mean the same thing here, so the
    // absent form is emitted: a `null` domain on a numeric variable is a key in every stored
    // artifact for no information. An enum with no domain is `SCH-1007`, not a shape this fixes.
    ...(domain === undefined || domain === null ? {} : { enum_domain: domain }),
    pii: variable.pii,
    persist: variable.persist,
  };
}
