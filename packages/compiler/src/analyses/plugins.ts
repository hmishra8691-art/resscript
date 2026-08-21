/**
 * Plugin resolution: `CMP-0400` (unknown question type), `CMP-0401` (config that does not satisfy
 * the plugin's schema), `CMP-0402` (a recorded major that is gone) and `CMP-0102` (a question that
 * collects nothing) — Deliverable F §5, roadmap P1-08.
 *
 * ## Why resolution is a pass and not four lookups
 *
 * F §5's publish sequence is: resolve every `question_type` against the registry, record the exact
 * version, and write `${id}@${major}` into the compiled page. Three consumers need the answer — the
 * config check, the entitlement check, and the artifact writer — and if each resolves for itself
 * then a registry whose two lookups can disagree (a `resolveForCompile` that picks the latest major
 * while a later call passes an explicit one) produces an artifact whose `question_type` is not the
 * plugin its config was validated against. So `resolvePlugins` resolves once and hands out the map;
 * nothing downstream calls the registry again.
 *
 * `ArtifactManifest` has no plugin field in this schema version — `script_hashes`,
 * `csp_directives`, `variable_manifest` and `entitlements`, and that is all — so the place the
 * majors are actually recorded is `CompiledQuestion.question_type`, per F §5.3's `"matrix@3"`.
 * `PluginResolution.keys` is exactly that string per question, and `versions` carries the exact
 * version per key for whatever records provenance next.
 *
 * ## CMP-0402 with no field to read
 *
 * A `Survey` records no plugin major: `QuestionNode.question_type` is documented as "Plugin
 * identifier … Not an enum: the plugin registry is open", and there is no sibling `question_major`
 * column anywhere in the model. So nothing is invented — but the field that exists is a *string*,
 * and `parsePluginKey` accepts `matrix@3` in it. A document that carries the keyed form (one
 * round-tripped out of an artifact, or written by hand against F §5.3) *has* recorded a major, and
 * a major that no longer resolves while the bare id does is precisely `CMP-0402`: the plugin is
 * installed, the pinned major is not, and rendering the survey against a different major would
 * change a live instrument. A bare id is never `CMP-0402`, and if no document ever carries the
 * keyed form this code is simply never emitted. That is the intended outcome, not a gap.
 *
 * ## CMP-0102: a question that emits nothing
 *
 * "Emits nothing" is read off the variable registry, not off the plugin: `QuestionNode.emits` is
 * stored, and `registry.ts`' `fallbackEmits` reconstructs it from `variables[].source.question_id`
 * when it is absent, so the same two-step is used here rather than a third derivation. What makes
 * the warning correct is the *exemption*, and the authoritative source for it is the plugin:
 * `PluginMeta.emitsData` is documented as "Does this type render anything the respondent answers?
 * `false` for content nodes", so a resolved plugin answers for itself. The name list below is only
 * the fallback for a type no registry in this process has, and it deliberately mirrors schema's own
 * `planQuestionEmissions`, which returns `[]` for exactly `display_text`, `text_display` and
 * `instruction` — plus the two names the roadmap uses (`content_text`, `content_media`), because a
 * content plugin shipped under either would otherwise be reported for doing its job. A `text` node
 * is not a question at all and never reaches this check.
 *
 * ## What this module refuses to do
 *
 * It does not run a plugin's `staticChecks` (those are `QK-*` diagnostics, namespaced by
 * `namespaceDiagnostics`, and belong to whatever collects plugin output), does not check
 * composition trust (`declareVariablesFor` throws on it, with its own error type), and does not
 * check entitlements — `entitlements.ts` owns `CMP-0600` and reads this pass's output.
 *
 * `@resscript/question-kit` exports a type named `CompileDiagnostic` too. It is imported aliased,
 * per CONTEXT, so the one in scope here is always the compiler's.
 */

import {
  pointer,
  type JsonObject,
  type JsonValue,
  type QuestionNode,
  type Survey,
} from '@resscript/schema';
import {
  applySchemaDefaults,
  parsePluginKey,
  type CompileDiagnostic as PluginCompileDiagnostic,
  type ConfigIssue,
  type JsonSchema,
  type PluginRegistry,
} from '@resscript/question-kit';

import { cmpDiagnostic, sortCompileDiagnostics, type CompileDiagnostic } from '../diagnostics.js';
import { questionSites, type QuestionSite } from './solver.js';

/**
 * The kit's own diagnostic type, aliased on import and re-exported under a name that cannot be
 * confused with `../diagnostics.js`' `CompileDiagnostic`.
 *
 * Nothing in this file returns one — a plugin's `staticChecks` output is namespaced `QK-*` and
 * belongs to whatever collects plugin output — but the two types are structurally similar and
 * differ in exactly the field that matters (`code` is open on one side and `string` on both, while
 * `severity` is the kit's `DiagnosticSeverity`), so the alias is kept rather than the import
 * dropped: the next file to want a plugin diagnostic should reach for this name.
 */
export type KitCompileDiagnostic = PluginCompileDiagnostic;

/**
 * Question types that legitimately emit no variables.
 *
 * A fallback for a type no registry answers for; `PluginMeta.emitsData` wins whenever a plugin
 * resolves. The first three are schema's own list (`planQuestionEmissions` returns `[]` for
 * exactly these), the last two are the roadmap's spellings for the same thing. Adding to this list
 * is the wrong fix for a false positive on a *registered* plugin — set `emitsData: false` on the
 * plugin, where the claim belongs.
 */
export const CONTENT_ONLY_QUESTION_TYPES: readonly string[] = [
  'display_text',
  'text_display',
  'instruction',
  'content_text',
  'content_media',
];

/** How many schema issues one `CMP-0401` lists. A config with 200 issues has one cause. */
const MAX_LISTED_ISSUES = 20;

export interface PluginsInput {
  readonly survey: Survey;
  /** Absent means "no registry in this process": `CMP-0400` and `CMP-0401` then say nothing. */
  readonly plugins?: PluginRegistry | undefined;
}

/* ========================================================================== */
/* 1. Resolution                                                               */
/* ========================================================================== */

export interface PluginResolution {
  /** Question id → the `"matrix@3"` key a compiled page carries. Absent when unresolved. */
  readonly keys: ReadonlyMap<string, string>;
  /** Plugin key → the exact resolved version, for provenance. */
  readonly versions: ReadonlyMap<string, string>;
  /**
   * Question id → the entitlement key its plugin requires, for questions whose plugin declares
   * one. `entitlements.ts` reads this; it is here because only this pass resolved the plugin.
   */
  readonly entitlementKeys: ReadonlyMap<string, string>;
  readonly diagnostics: readonly CompileDiagnostic[];
}

/**
 * Resolve every question's plugin once.
 *
 * Insertion order is document order for `keys` and sorted for `versions`, so both are stable under
 * anything that does not change the survey — the artifact writer serializes them and the hash is
 * the whole point.
 */
export function resolvePlugins(survey: Survey, registry?: PluginRegistry): PluginResolution {
  const keys = new Map<string, string>();
  const versions = new Map<string, string>();
  const entitlementKeys = new Map<string, string>();
  const diagnostics: CompileDiagnostic[] = [];

  for (const site of questionSites(survey)) {
    const question = site.question;
    if (registry === undefined) continue;
    const requested = parseRequest(question.question_type);
    const resolved =
      requested.major === undefined
        ? registry.resolveForCompile(requested.id)
        : registry.resolveForCompile(requested.id, requested.major);

    if (resolved === undefined) {
      diagnostics.push(unresolved(question, site, requested, registry));
      continue;
    }

    keys.set(question.id, resolved.key);
    versions.set(resolved.key, resolved.version);
    if (resolved.meta.entitlementKey !== null) {
      entitlementKeys.set(question.id, resolved.meta.entitlementKey);
    }

    const configIssues = validateConfig(registry, resolved.key, question.config);
    if (configIssues !== undefined && configIssues.length > 0) {
      diagnostics.push(configFailure(question, site, resolved.key, resolved.version, configIssues));
    }

    // A mixed matrix's per-row control is a second `question_type`, resolved through the same
    // registry (`declareVariablesFor` resolves it too — and *throws* a `PluginComposeError` when
    // it cannot, which would take the whole publish job with it). Reporting it here is what turns
    // that crash into a diagnostic naming the row.
    (question.cells ?? []).forEach((cell, cellIndex) => {
      const control = parseRequest(cell.control.question_type);
      const child =
        control.major === undefined
          ? registry.resolveForCompile(control.id)
          : registry.resolveForCompile(control.id, control.major);
      if (child !== undefined) {
        versions.set(child.key, child.version);
        return;
      }
      diagnostics.push(
        cmpDiagnostic(
          'CMP-0400',
          `Cell control ${JSON.stringify(cell.control.question_type)} on row ${cell.row_ref} of ` +
            `question ${question.ref} resolves to no plugin, so the row cannot be rendered and ` +
            'the variable it would emit has no type.',
          pointer(...site.segments, 'cells', cellIndex, 'control', 'question_type'),
          {
            question_id: question.id,
            question_ref: question.ref,
            question_type: cell.control.question_type,
            plugin_id: control.id,
            requested_major: control.major ?? null,
            row_ref: cell.row_ref,
            column_ref: cell.control.use_columns === true ? null : (cell.column_ref ?? null),
            reason: 'cell_control',
          },
        ),
      );
    });
  }

  return {
    keys,
    versions: new Map([...versions.entries()].sort((a, b) => a[0].localeCompare(b[0]))),
    entitlementKeys,
    diagnostics: sortCompileDiagnostics(diagnostics),
  };
}

interface Request {
  readonly id: string;
  /** Present only when the document itself pinned one, in the `id@major` form. */
  readonly major: number | undefined;
}

function parseRequest(questionType: string): Request {
  const parsed = parsePluginKey(questionType);
  return parsed === undefined
    ? { id: questionType, major: undefined }
    : { id: parsed.id, major: parsed.major };
}

/**
 * `CMP-0402` when the document pinned a major the registry no longer has but the plugin itself is
 * present; `CMP-0400` otherwise. The distinction is the author's next action: install the missing
 * major, or fix a typo.
 */
function unresolved(
  question: QuestionNode,
  site: QuestionSite,
  requested: Request,
  registry: PluginRegistry,
): CompileDiagnostic {
  const path = pointer(...site.segments, 'question_type');
  const available = registry
    .entries()
    .filter((entry) => entry.meta.id === requested.id)
    .map((entry) => entry.key);

  if (requested.major !== undefined && available.length > 0) {
    return cmpDiagnostic(
      'CMP-0402',
      `Question ${question.ref} is pinned to ${question.question_type}, and major ` +
        `${String(requested.major)} of ${requested.id} is no longer available. Rendering it ` +
        'against another major would change a live instrument, so the compile stops here rather ' +
        'than substituting one.',
      path,
      {
        question_id: question.id,
        question_ref: question.ref,
        question_type: question.question_type,
        plugin_id: requested.id,
        requested_major: requested.major,
        available_keys: available,
      },
    );
  }

  return cmpDiagnostic(
    'CMP-0400',
    `Question ${question.ref} declares question_type ${JSON.stringify(question.question_type)}, ` +
      'which no plugin in the registry resolves. Nothing can render it and nothing can say what ' +
      'variables it emits.',
    path,
    {
      question_id: question.id,
      question_ref: question.ref,
      question_type: question.question_type,
      plugin_id: requested.id,
      requested_major: requested.major ?? null,
    },
  );
}

/**
 * Validate a config against the plugin's compiled schema.
 *
 * Defaults are applied first, and that is not cosmetic: F §5 promises that adding an optional field
 * with a default is a backward-compatible change, which is only true if the top-up happens on the
 * path that validates. `declare.ts` does the same, in the same order, for the same reason.
 *
 * `undefined` means "no schema to check against" — a registry whose `resolveEntry` cannot find a
 * key its own `resolveForCompile` returned. That is a registry bug, not a survey defect, and
 * reporting it as `CMP-0401` would send the author to their config.
 */
function validateConfig(
  registry: PluginRegistry,
  key: string,
  config: JsonObject | undefined,
): readonly ConfigIssue[] | undefined {
  const entry = registry.resolveEntry(key);
  if (entry === undefined) return undefined;
  const compiled = registry.configSchemaFor(entry);
  const withDefaults = applySchemaDefaults(entry.plugin.configSchema as JsonSchema, config ?? {});
  return compiled.validate(withDefaults).issues;
}

function configFailure(
  question: QuestionNode,
  site: QuestionSite,
  key: string,
  version: string,
  issues: readonly ConfigIssue[],
): CompileDiagnostic {
  return cmpDiagnostic(
    'CMP-0401',
    `The config of question ${question.ref} does not satisfy the config schema of ${key} ` +
      `(version ${version}): ${issues
        .slice(0, MAX_LISTED_ISSUES)
        .map((issue) => `${issue.path === '' ? '/' : issue.path} ${issue.message}`)
        .join('; ')}`,
    pointer(...site.segments, 'config'),
    {
      question_id: question.id,
      question_ref: question.ref,
      question_type: question.question_type,
      plugin_key: key,
      plugin_version: version,
      issue_count: issues.length,
      truncated: issues.length > MAX_LISTED_ISSUES,
      // Rebuilt as anonymous records rather than passed through: `ConfigIssue` is an interface,
      // so it has no implicit index signature and is not a `JsonValue` even though its fields
      // are. Same reasoning as `registry.ts`' domain-entry detail.
      issues: issues.slice(0, MAX_LISTED_ISSUES).map((issue) => ({
        path: issue.path,
        keyword: issue.keyword,
        message: issue.message,
      })),
    },
  );
}

/* ========================================================================== */
/* 2. The analysis                                                             */
/* ========================================================================== */

export function analyzePlugins(input: PluginsInput): readonly CompileDiagnostic[] {
  const resolution = resolvePlugins(input.survey, input.plugins);
  return sortCompileDiagnostics([
    ...resolution.diagnostics,
    ...questionsThatEmitNothing(input),
  ]);
}

function questionsThatEmitNothing(input: PluginsInput): readonly CompileDiagnostic[] {
  const emitted = new Map<string, number>();
  for (const variable of input.survey.variables) {
    const questionId = variable.source?.question_id;
    if (questionId === undefined) continue;
    emitted.set(questionId, (emitted.get(questionId) ?? 0) + 1);
  }

  const out: CompileDiagnostic[] = [];
  for (const site of questionSites(input.survey)) {
    const question = site.question;
    const declared = question.emits?.length ?? 0;
    if (declared > 0 || (emitted.get(question.id) ?? 0) > 0) continue;

    const resolved = input.plugins?.resolveForCompile(parseRequest(question.question_type).id);
    // The plugin's own answer, when there is one. `emitsData: false` is the content-node claim.
    if (resolved !== undefined && !resolved.meta.emitsData) continue;
    if (resolved === undefined && CONTENT_ONLY_QUESTION_TYPES.includes(question.question_type)) {
      continue;
    }

    out.push(
      cmpDiagnostic(
        'CMP-0102',
        `Question ${question.ref} emits no variables and its type ` +
          `(${question.question_type}) is not a content-only type, so it renders a control that ` +
          'collects nothing: no column appears in the export and no rule can read an answer.',
        site.path,
        {
          question_id: question.id,
          question_ref: question.ref,
          question_type: question.question_type,
          emits_declared: declared,
          plugin_resolved: resolved !== undefined,
          plugin_emits_data: resolved?.meta.emitsData ?? null,
        } satisfies { readonly [key: string]: JsonValue },
      ),
    );
  }
  return out;
}
