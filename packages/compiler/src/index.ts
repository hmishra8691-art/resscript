/**
 * `@resscript/compiler` — the authoring model to the compiled artifact, and the static gate that
 * decides whether there is one. Deliverable C §17, ADR-002, milestone P1-08.
 *
 * `compileSurvey` is the whole product: a `Survey` in, an addressed `ArtifactBundle` and a
 * diagnostic list out, with no artifact produced when any diagnostic is an error. Everything else
 * exported here is exported for a named second caller, not for completeness — exports are explicit
 * rather than `export *`, the rule `packages/schema/src/index.ts` follows, so that adding a name to
 * the public API is a deliberate line in this file and removing one is a visible break.
 *
 * Three groups, and why each is public:
 *
 *  1. **The gate.** `compileSurvey` plus the input and output types. `apps/worker`'s publish job
 *     (P1-10) is the caller, and it stores `diagnostics` in `survey_versions.compile_diagnostics`,
 *     `bundle.files` in object storage under `bundle.hash`, and decides — from `unacknowledged` —
 *     whether the author still has warnings to accept.
 *  2. **The diagnostic surface.** A publish dialog groups by severity, links a path and records an
 *     acknowledgement; all four operations are functions here rather than logic re-implemented in
 *     the studio, because a UI that decided severity for itself would eventually disagree with the
 *     gate that blocked the publish.
 *  3. **The stages.** `buildFlowGraph`, `buildTypeEnvFor`, `buildRules` and the six emitters.
 *     `apps/studio`'s editor path type-checks one rule per keystroke and must not run a whole
 *     compile to do it, and the QA suite (P3-02) drives the emitters directly to assert a property
 *     of one artifact file. Both would otherwise reach into `src/` past this file, which is how a
 *     package's internals become its API by accident.
 *
 * What is deliberately *not* exported: the nine analyses. They are steps of the gate, not
 * questions a caller asks — every one of them takes a `FlowGraph`, a `TypeEnv` and a lowered rule
 * list that only `compileSurvey` assembles in the right order, and a caller running one on its own
 * would get an answer conditioned on a state the gate never allows. `resolvePlugins` is the one
 * exception, because the emitters take a `PluginResolution` and a caller driving them needs one.
 */

/* ---- the gate ----------------------------------------------------------- */

export { compileSurvey, firstPartyRegistry } from './pipeline.js';

export { ARTIFACT_SCHEMA_VERSION, dominates } from './types.js';
export type {
  ArtifactBundle,
  ArtifactFile,
  CompileInput,
  CompileResult,
  FlowGraph,
  VariableSites,
} from './types.js';

/* ---- diagnostics -------------------------------------------------------- */

export {
  ALL_CMP_CODES,
  CMP_DIAGNOSTIC_CODES,
  CMP_SEVERITY,
  acknowledgementKey,
  cmpDiagnostic,
  compileErrors,
  compileWarnings,
  fromLogicDiagnostic,
  fromSchemaDiagnostic,
  hasCompileErrors,
  sortCompileDiagnostics,
} from './diagnostics.js';
export type { CmpCode, CompileDiagnostic, CompileSeverity } from './diagnostics.js';

/* ---- the stages, for the studio's editor path and the QA suite ---------- */

export { blockPathOf, buildFlowGraph, flowNodeOfNode, pageOfQuestion } from './flow.js';

export {
  ORDERED_SCALE_QUESTION_TYPES,
  buildRegistryInput,
  buildTypeEnvFor,
  synthesizedDomainId,
} from './registry.js';
export type { BuildRegistryOptions, RegistryInputResult, TypeEnvResult } from './registry.js';

export {
  AUTHORED_ORDER_SLOT,
  ORDER_KEY_SITE_STRIDE,
  UNSCOPED_ORDER_SITE,
  buildRules,
  synthesizedMaskRuleId,
} from './rules.js';
export type { BuildRulesOptions, BuildRulesResult } from './rules.js';

export { resolvePlugins } from './analyses/plugins.js';
export type { PluginResolution } from './analyses/plugins.js';

/* ---- the emitters ------------------------------------------------------- */

export {
  BASE_OPTION_DEFAULT,
  BASE_VISIBLE_DEFAULT,
  HASH_PREAMBLE,
  MASK_AXES,
  OPT_PROPS,
  UNRESOLVED_AT_STORE,
  artifactLanguages,
  buildArtifactGraph,
  buildArtifactLogic,
  buildBundle,
  buildI18n,
  buildManifest,
  buildPages,
  cellIndexOf,
  cellsWrittenBy,
  compiledRuleOf,
  designsOf,
  pagePath,
  rehydrate,
  ruleOf,
  scriptsOf,
  stringResolver,
  treeHash,
  variableManifest,
} from './emit/index.js';
export type {
  BundleParts,
  EmitLogicInput,
  ManifestInput,
  PagesInput,
  PagesResult,
  RehydratedLogic,
  StringResolver,
} from './emit/index.js';
