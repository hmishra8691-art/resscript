/**
 * The artifact writer — `Survey` plus the analyses' output to `ArtifactBundle` (C §17, ADR-002,
 * roadmap P1-08).
 *
 * Six modules, in the order the compile gate calls them: `manifest`, `graph`, `pages`, `logic`,
 * `i18n`, then `bundle` to assemble. Re-exported here rather than reached for individually so that
 * the gate has one import and so that the boundary of what this directory owns is a file rather
 * than a convention.
 *
 * Two invariants hold across all six and are worth stating once, since each module states only its
 * own half:
 *
 *  1. **Nothing here reads a clock, a random source, or the registry.** `compiledAt` is an input
 *     (CONTEXT decision 3) and every plugin was resolved once by `analyses/plugins.ts`, for the
 *     reason that pass's header gives. A writer that resolved a plugin for itself could produce an
 *     artifact whose `question_type` is not the plugin its config was validated against.
 *  2. **Every `.json` file is `stableStringify`'d** (CONTEXT decision 2). That is the whole reason
 *     the artifact hash is a function of the survey rather than of the order rows came back from
 *     Postgres in, and it is why the in-memory records built here sort their own keys too — an
 *     in-memory comparison and a byte comparison must not be able to disagree.
 */

export {
  HASH_PREAMBLE,
  buildBundle,
  designsOf,
  scriptsOf,
  treeHash,
  type BundleParts,
} from './bundle.js';

export { buildArtifactGraph } from './graph.js';

export { artifactLanguages, buildI18n, stringResolver, type StringResolver } from './i18n.js';

export {
  MASK_AXES,
  OPT_PROPS,
  buildArtifactLogic,
  compiledRuleOf,
  type EmitLogicInput,
} from './logic.js';

export {
  UNRESOLVED_AT_STORE,
  buildManifest,
  variableManifest,
  type ManifestInput,
} from './manifest.js';

export {
  buildPages,
  cellIndexOf,
  pagePath,
  type PagesInput,
  type PagesResult,
} from './pages.js';
