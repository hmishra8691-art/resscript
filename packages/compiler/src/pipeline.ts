/**
 * The compile gate: one ordered pass from a stored authoring document to an addressed artifact,
 * or to the list of reasons there is no artifact (C §17, ADR-002, roadmap P1-08).
 *
 * Every other module in this package answers one question about a survey. This one decides the
 * *order* the questions are asked in, and the order is the whole design: it is what makes one
 * defect produce one diagnostic instead of three, and what makes "no artifact is written when
 * there is an error" a property of the code rather than of the caller's discipline.
 *
 * ## The order, and the three places it stops early
 *
 *     load → migrate → shape → structural │ flow → env → rules → logic │ analyses → emit → hash
 *
 * Three conditions stop the pass, all of them before the analyses, and every one is a case where
 * continuing would produce diagnostics describing the compiler's confusion rather than the author's
 * survey.
 *
 *  1. **A parse failure.** There is no `Survey` to analyse. Nothing downstream can run at all.
 *  2. **A structural error.** Every analysis in this package assumes ids resolve — `rules.ts`
 *     brands ids with `asQuestionId`, which *throws* on a bad prefix, and `registry.ts` says so
 *     in its header ("a throw means a caller skipped the gate"). Beyond the crash risk, a
 *     dangling `target_id` makes the forward-reference pass report a variable that is never
 *     written and the never-visible pass report a question on no page: two further diagnostics
 *     for one defect, neither naming the missing reference. `validateStructural` already named it.
 *  3. **A flow with no start node**, for the reason `flow.ts` gives for not storming `LGC-U001`
 *     in the same state: with no start, every page is unreachable and every read is a forward
 *     reference, so the analyses would bury `CMP-0001` under a diagnostic per question. (This one
 *     costs nothing to be careful about — `analyzeForwardReferences` and
 *     `analyzeUnreachableContent` both check for it themselves — but the quota and redirect passes
 *     do not, and the stop is what keeps that from mattering.)
 *
 * **After the last of those nothing stops.** All nine analyses run even when one has already
 * produced errors, because an author fixing a publish wants the whole list — a gate that reports
 * one item per attempt costs a round trip per defect, and the roadmap's acceptance criterion is a
 * diagnostic *list*, not a first failure. That is why the structural check has to be the last hard
 * stop over the document's contents: everything after it is designed to be safe on a document that
 * is merely wrong.
 *
 * ## What the pipeline itself decides, rather than delegating
 *
 * Four things are this file's own work, because nothing narrower knows enough to do them.
 *
 *  - **`optionDefaults`.** `OptionBehaviour`'s literal arms (schema §5.1) are the authored base
 *    state of an option's cell, and `compileLogic` takes them as an option rather than reading a
 *    document it cannot see. Deriving them here — and only here — is what stops `base_option` in
 *    the artifact from disagreeing with the base the checker reasoned about. The `condition` arm
 *    is deliberately *not* lowered: that is a rule, and inventing one would put a writer on a
 *    cell the author's rule list does not mention. It is named in the report as still open.
 *  - **`CMP-0800`.** The one integrity claim that belongs to no pass: `engine.ts` refuses to
 *    evaluate a program whose `topo` does not cover its cells (it throws `LogicInvariant`), so an
 *    artifact in that state is one that crashes the runtime instead of running the survey. It is
 *    emitted on exactly the condition the runtime guards on, and *not* on `compileFailed(logic)`
 *    generally: a rule with a type error already has its `LGC-T*` diagnostic, and adding "the
 *    cell graph has no evaluation order" on top of it would be both a second diagnostic for one
 *    defect and a false statement about the graph.
 *  - **`CMP-0801`.** A compile with no reachable page produces an artifact a respondent cannot
 *    be shown. It is not a stop, because the translation, asset and entitlement findings are
 *    still worth reporting in the same run.
 *  - **The diagnostic bookkeeping** below: suppressing the compiler's own noise, and repairing
 *    the two diagnostic paths that name an internal index rather than a place in the document.
 *
 * ## Suppressing `LGC-W030` on a synthesized mask rule
 *
 * `rules.ts` lowers each `QuestionNode.masks[]` entry into a `Rule` whose condition is the literal
 * `TRUE`, and it has to: a `Mask` carries no condition at all, because a mask always applies and
 * only its per-item predicate varies. `checkRule` then reports `LGC-W030` ("condition is provably
 * constant") for every one of them, correctly — the condition *is* constant — and that diagnostic
 * is filtered here.
 *
 * **Why suppressing a diagnostic is right here and would be wrong for an authored rule.** A
 * diagnostic exists to name something the author can change. For an authored rule, `LGC-W030` names
 * a real defect with a real fix: `IF TRUE THEN HIDE Q4` is either a debugging leftover or a rule
 * whose condition was lost, and the author edits the condition. For a synthesized mask rule there
 * is no condition to edit — the field the author filled in is `source` and `fallback`, the
 * constant is an artifact of this compiler's desugaring, and the only actions available are
 * "delete the mask" (which is not the defect) or "ignore this warning" (which is what the
 * acknowledgement flow would then be spent on). A warning nobody can act on is how a gate gets
 * switched off wholesale, taking the actionable warnings with it. So the rule is: the compiler
 * does not report to the author about its own desugaring. It is filtered by rule *identity*
 * (`synthesizedMaskRuleId`, matched against the masks actually present in the document) and not by
 * the code alone, so an authored rule that happens to be constant is still reported.
 *
 * That is the only self-inflicted diagnostic of this kind in the package today, and the search was
 * not by inspection alone: the other synthesizer is `derive.ts` (the multi-select set view and the
 * NPS band, which schema deliberately stores without an expression), and its trees are built to be
 * checkable — the set view folds `case … else {}` over set literals rather than nulls, so it draws
 * neither `LGC-W014` nor `LGC-W030`. `rules.ts`' other synthesized fields (`evaluation`,
 * `authored_in`, the derived `label`) are not conditions and nothing checks them. Should a future
 * desugaring draw a warning of its own, it belongs on this list with its own reason, not in a
 * widened code filter.
 *
 * ## Repairing two diagnostic paths
 *
 * `CompileDiagnostic.path` is documented as a JSON Pointer *into the authoring document*, and
 * `acknowledgementKey()` includes it precisely so that an acknowledgement dies when the thing it
 * was given for moves. `compileLogic` cannot honour that: it reports against `/rules/<i>`, where
 * `i` is the position in its own canonical `(order_key, id)` order, and `/variables/<id>/expression`
 * — neither of which is a location in the document, and the first of which *moves when an
 * unrelated rule is added*, silently invalidating every acknowledgement in the survey. Both are
 * remapped here to the pointers `validateStructural` and the analyses use for the same rows
 * (`rulePointers`, and the `variables` array index), keyed off `detail.rule_id`, which `rules.ts`
 * carries for exactly this reason. The pipeline is the only place that holds both index spaces.
 *
 * ## What this module refuses to do
 *
 * It does not analyse, emit, or validate anything itself beyond the four decisions above; every
 * finding in the returned list was produced by the module that owns that question. It reads no
 * clock and no entropy — `compiledAt` is an input (CONTEXT decision 3) — and it does not publish:
 * `ok: true` with a non-empty `unacknowledged` means "this compiled, and publish needs the author
 * to accept these warnings first". Who may accept them, and whether a publish proceeds, is the
 * caller's policy (P1-10), not the compiler's.
 */

import {
  migrateToCurrent,
  parseValue,
  validateStructural,
  pointer,
  type ConditionalValue,
  type JsonValue,
  type Survey,
} from '@resscript/schema';
import {
  compileLogic,
  optionKey,
  type LgcDiagnostic,
  type OptProp,
  type Rule,
} from '@resscript/logic';
import { FIRST_PARTY_CORES, createRegistry, type PluginRegistry } from '@resscript/question-kit';

import {
  acknowledgementKey,
  cmpDiagnostic,
  compileWarnings,
  fromLogicDiagnostic,
  fromSchemaDiagnostic,
  hasCompileErrors,
  sortCompileDiagnostics,
  type CompileDiagnostic,
} from './diagnostics.js';
import { buildFlowGraph } from './flow.js';
import { buildTypeEnvFor } from './registry.js';
import { buildRules, synthesizedMaskRuleId } from './rules.js';
import { analyzeAssets } from './analyses/assets.js';
import { analyzeCss } from './analyses/css.js';
import { analyzeLoops } from './analyses/loops.js';
import { analyzeTemplates } from './analyses/templates.js';
import { compileTheme } from './emit/theme.js';
import { analyzeEntitlements } from './analyses/entitlements.js';
import { analyzeForwardReferences, buildVariableSites } from './analyses/forward-ref.js';
import { analyzePlugins, resolvePlugins } from './analyses/plugins.js';
import { analyzeQuotas } from './analyses/quotas.js';
import { analyzeRedirects } from './analyses/redirects.js';
import { analyzeConditions, questionSites, rulePointers } from './analyses/solver.js';
import { analyzeTranslations } from './analyses/translations.js';
import { analyzeUnreachableContent } from './analyses/unreachable.js';
import { buildBundle, designsOf, scriptsOf } from './emit/bundle.js';
import { buildArtifactGraph } from './emit/graph.js';
import { buildI18n } from './emit/i18n.js';
import { buildArtifactLogic } from './emit/logic.js';
import { buildManifest } from './emit/manifest.js';
import { buildPages } from './emit/pages.js';
import type { CompileInput, CompileResult } from './types.js';

/* ========================================================================== */
/* 1. The gate                                                                 */
/* ========================================================================== */

export function compileSurvey(input: CompileInput): CompileResult {
  const diagnostics: CompileDiagnostic[] = [];

  /* ---- 1. load: migrate to the current schema version, then parse -------- */

  const loaded = loadSurvey(input.survey);
  diagnostics.push(...loaded.diagnostics);
  if (loaded.survey === undefined) return failed(diagnostics);
  const survey = loaded.survey;

  /* ---- 2. structural validation: the last stop over the document's contents */

  const structural = validateStructural(survey).map(fromSchemaDiagnostic);
  diagnostics.push(...structural);
  if (hasCompileErrors(structural)) return failed(diagnostics);

  /* ---- 3. the flow graph ------------------------------------------------- */

  const graph = buildFlowGraph(survey);
  diagnostics.push(...graph.diagnostics);
  // `start === ''` is `buildFlowGraph`'s no-start-node state, reported as `CMP-0001`.
  if (graph.start === '') return failed(diagnostics);

  if (graph.pageOrder.length === 0) {
    diagnostics.push(
      cmpDiagnostic(
        'CMP-0801',
        'The compile produced no pages: no reachable flow node lays out a page, so a respondent ' +
          'who starts this survey has nothing to be shown.',
        pointer('content'),
        { flow_node_count: graph.nodes.size, reachable_flow_node_count: graph.reachable.size },
      ),
    );
  }

  /* ---- 4. types, rules, and the cell graph ------------------------------- */

  const registryOptions = input.plugins === undefined ? {} : { plugins: input.plugins };
  const registry = buildTypeEnvFor(survey, registryOptions);
  diagnostics.push(...registry.diagnostics);

  const lowered = buildRules(survey, graph, registry.env);
  diagnostics.push(...lowered.diagnostics);

  const logic = compileLogic(lowered.rules, registry.env, {
    optionDefaults: optionDefaultsOf(survey),
    // `declaredVisible` is deliberately empty: schema carries no per-node visibility literal (only
    // `OptionBehaviour` has one), so the base is what `deriveBaseVisible` derives from the rule
    // set — a node is base-hidden exactly when a `show` rule targets it. Passing a guess here
    // would make the artifact's `base_visible` disagree with what the checker reasoned about.
  });
  diagnostics.push(...liftLogicDiagnostics(logic.diagnostics, survey));

  /* ---- 5. compile integrity --------------------------------------------- */

  if (logic.topo.length !== logic.cells.length) {
    diagnostics.push(
      cmpDiagnostic(
        'CMP-0800',
        `The cell graph has ${String(logic.cells.length)} cells and a topological order covering ` +
          `${String(logic.topo.length)} of them, so there is no order in which the program can be ` +
          'evaluated. The runtime refuses to evaluate a program in this state rather than ' +
          'producing a partial verdict, so the artifact cannot be published.',
        // The document itself: a cycle is a property of a *set* of rules, and `LGC-CYCLE` — which
        // `buildCellGraph` has already emitted — is the diagnostic that names them and prints the
        // path around the loop. This one says what follows for the artifact.
        '',
        { cell_count: logic.cells.length, ordered_cell_count: logic.topo.length },
      ),
    );
  }

  /* ---- 6. the static analyses: all of them, whatever else failed -------- */

  const rules: readonly Rule[] = lowered.rules;
  const env = registry.env;
  // Shared between the forward-reference and quota passes rather than built twice: `types.ts`'
  // `VariableSites` comment gives the reason — two indexes of the same fact can disagree about
  // where a variable is written, and both passes quote that position in a diagnostic.
  const sites = buildVariableSites(survey, graph, rules, env);
  // Resolved once, before the analyses, because `analyzeEntitlements` reads the resolution's
  // `entitlementKeys` (a plugin's declared requirement is the half of `CMP-0600` a document
  // cannot strip) and the emitters read its keys and versions. `analyzePlugins` resolves again
  // for its own diagnostics; the duplicate work is deliberate over widening its input, since
  // `resolvePlugins` is a pure function of the survey and the registry and the two cannot
  // disagree.
  const resolution = resolvePlugins(survey, input.plugins);

  diagnostics.push(
    ...analyzeForwardReferences({ survey, graph, rules, env, sites }),
    ...analyzeUnreachableContent({ survey, graph, rules, env }),
    ...analyzeConditions({ survey, graph, rules, env }),
    ...analyzeQuotas({ survey, graph, rules, env, sites }),
    ...analyzeTranslations({ survey }),
    ...analyzeRedirects({ survey, graph, rules }),
    ...analyzePlugins({ survey, plugins: input.plugins }),
    ...analyzeAssets({ survey }),
    // CMP-0503. Separate from analyzeAssets because CSS's dangerous constructs are its own — that
    // module's header says so explicitly and declined to guess at them. Until P2-12 nothing checked
    // author CSS at all, which made a stylesheet the one author-supplied surface with no gate.
    ...analyzeCss({ survey }),
    // CMP-0100 and the loop-spec checks. CMP-0100 has been DECLARED since P1-08 and emitted by
    // nothing, while derive.ts reasoned FROM its existence to justify keeping only the innermost
    // loop — so a nested loop compiled clean and silently emitted a fraction of its columns.
    ...analyzeLoops({ survey }),
    // CMP-0504. Structure only — that a page shell has a slot for the form. CMP-0500 owns whether
    // the markup is SAFE and this pass deliberately does not re-scan it: two scanners disagreeing
    // about one string is how a bypass gets a second opinion.
    ...analyzeTemplates({ survey }),
    ...analyzeEntitlements({ survey, entitlements: input.entitlements, plugins: resolution }),
  );

  /* ---- 7. the gate ------------------------------------------------------ */

  const all = sortCompileDiagnostics(diagnostics);
  // The roadmap's criterion, verbatim: "and no artifact is written". Returning a bundle beside an
  // error would let a caller that checks `bundle !== undefined` publish a survey the gate rejected.
  if (hasCompileErrors(all)) return { ok: false, diagnostics: all };

  /* ---- 8. emit and address ---------------------------------------------- */

  const manifest = buildManifest({
    survey,
    surveyVersionId: input.surveyVersionId,
    plugins: resolution,
  });
  // Sorted by ref, and each sheet labelled, so a browser's dev tools name the file an author has to
  // open. Concatenation rather than one file per sheet: they always load together and always in
  // this order, so N requests would buy nothing.
  const authorCss = [...(survey.assets?.css ?? [])]
    .sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0))
    .map((sheet) => `/* ${sheet.ref} */\n${sheet.source}`)
    .join('\n\n');

  // Author HTML templates, keyed by asset id — see BundleParts.htmlTemplates on why id and not ref.
  // Emitted at all is P2-12's last chain: these were declared, resolved and sanitized, and no
  // emitter put them in the artifact, so a page template silently did nothing.
  const htmlTemplates = Object.fromEntries(
    (survey.assets?.html_templates ?? []).map((t) => [String(t.id), t.source]),
  );

  const artifactGraph = buildArtifactGraph(graph, survey);
  const pages = buildPages({ survey, graph, logic, plugins: resolution });
  const artifactLogic = buildArtifactLogic({ survey, logic });
  const i18n = buildI18n(survey);
  const scripts = scriptsOf(survey);
  const designs = designsOf(survey);

  const bundle = buildBundle({
    manifest,
    graph: artifactGraph,
    logic: artifactLogic,
    ...(survey.vendors && survey.vendors.length > 0 ? { vendors: survey.vendors } : {}),
    pages: pages.byLanguage,
    baseLanguage: pages.baseLanguage,
    i18n,
    compiledAt: input.compiledAt,
    ...(survey.quotas === undefined || survey.quotas === null ? {} : { quotas: survey.quotas }),
    ...(survey.redirects === undefined || survey.redirects === null
      ? {}
      : { redirects: survey.redirects }),
    ...(designs === undefined ? {} : { designs }),
    ...(scripts === undefined ? {} : { scripts }),
    // ALWAYS a stylesheet. Explicit bytes win; otherwise the theme is compiled from tokens, and a
    // survey that pins no theme still gets the default — which is what makes `.rs-target` exist.
    // The previous behaviour (emit nothing when `themeCss` was unset, which was always) shipped
    // every survey without the class its own a11y contract is built around.
    themeCss:
      input.themeCss === undefined || input.themeCss === null
        ? compileTheme({ layers: input.themeTokens ?? [] }).css
        : input.themeCss,
    // Author stylesheets, concatenated in REF order so the cascade does not depend on the order
    // rows came back from the database. Reaching the artifact at all is P2-12's second half: these
    // were declared in the schema, resolved by `validateStructural`, scanned by the sanitizer since
    // this commit's predecessor — and emitted by nothing, so an author's stylesheet was stored,
    // checked, and then silently dropped.
    ...(authorCss === '' ? {} : { authorCss }),
    ...(Object.keys(htmlTemplates).length === 0 ? {} : { htmlTemplates }),
  });

  return {
    ok: true,
    bundle,
    diagnostics: all,
    unacknowledged: unacknowledgedOf(all, input.acknowledgedWarnings ?? []),
  };
}

function failed(diagnostics: readonly CompileDiagnostic[]): CompileResult {
  return { ok: false, diagnostics: sortCompileDiagnostics(diagnostics) };
}

/* ========================================================================== */
/* 2. Loading                                                                  */
/* ========================================================================== */

interface Loaded {
  /** Absent when the document did not migrate or did not parse. */
  readonly survey?: Survey;
  readonly diagnostics: readonly CompileDiagnostic[];
}

/**
 * Migrate, then re-check the shape.
 *
 * The `Survey` type says `schema_version: number`, not `2`, so a v1 document is a `Survey` to the
 * type system and this is where it stops being one in fact: a stored survey is migrated forward in
 * memory on load (C §18) and a compile that skipped the step would type-check against fields the
 * document does not have. `migrateToCurrent` is idempotent, so a document already at the current
 * version costs one field read.
 *
 * `parseValue` is called with `structural: false` and the structural half is run separately by the
 * caller. Not to save work — `parseValue` would run the same function — but because the two halves
 * have different consequences: a shape failure means there is no `Survey` at all, while a
 * structural error means there is one and it is worth reporting *every* structural finding against.
 * Collapsing them would hide which of the two happened behind one `ok: false`.
 */
function loadSurvey(document: Survey): Loaded {
  const migrated = migrateToCurrent(document);
  const lifted = migrated.diagnostics.map(fromSchemaDiagnostic);
  if (!migrated.ok) return { diagnostics: lifted };

  const parsed = parseValue(migrated.document, { structural: false });
  const diagnostics = [...lifted, ...parsed.diagnostics.map(fromSchemaDiagnostic)];
  if (!parsed.ok) return { diagnostics };
  return { survey: parsed.survey, diagnostics };
}

/* ========================================================================== */
/* 3. Authored option defaults                                                 */
/* ========================================================================== */

/**
 * `OptionBehaviour`'s literal arms, keyed the way `compileLogic` reads them.
 *
 * Only the `literal` arm. A `condition` arm is a *rule* — it makes the option's state depend on a
 * respondent's answers — and lowering one here would create a cell writer that appears in no rule
 * list, so nothing would report a conflict between it and an authored `option_state` rule and no
 * trace would explain why the option vanished. Left for the pass that owns rules; named in the
 * report as open.
 *
 * All three axes, because an option, a row and a column all carry `behaviour` and all three have
 * `opt(...)` cells.
 */
function optionDefaultsOf(survey: Survey): { readonly [key: string]: boolean } {
  const out: { [key: string]: boolean } = {};
  const put = (optionId: string, prop: OptProp, value: unknown): void => {
    if (typeof value !== 'boolean') return;
    out[optionKey(optionId, prop)] = value;
  };

  for (const site of questionSites(survey)) {
    const question = site.question;
    const items = [
      ...(question.options ?? []),
      ...(question.rows ?? []),
      ...(question.columns ?? []),
    ];
    for (const item of items) {
      const behaviour = item.behaviour;
      if (behaviour === undefined) continue;
      put(item.id, 'visible', literalOf(behaviour.visible));
      put(item.id, 'enabled', literalOf(behaviour.enabled));
      put(item.id, 'preselected', literalOf(behaviour.preselected));
      put(item.id, 'auto_select', literalOf(behaviour.auto_select));
      put(item.id, 'prioritized', literalOf(behaviour.prioritized));
      put(item.id, 'deprioritized', literalOf(behaviour.deprioritized));
      // `required_if` is an `Expr` and not a `ConditionalValue`, so it has no literal arm to read:
      // schema §5.1 states per-item requiredness as a condition or not at all.
    }
  }
  return out;
}

function literalOf(value: ConditionalValue<boolean> | null | undefined): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  return 'literal' in value ? value.literal : undefined;
}

/* ========================================================================== */
/* 4. Diagnostic bookkeeping                                                   */
/* ========================================================================== */

/**
 * Lift `compileLogic`'s diagnostics: drop the compiler's own noise, and put every path back in the
 * document's own coordinates. See the header for both.
 */
function liftLogicDiagnostics(
  diagnostics: readonly LgcDiagnostic[],
  survey: Survey,
): readonly CompileDiagnostic[] {
  const synthesized = synthesizedMaskRuleIds(survey);
  const rulePaths = rulePointers(survey);
  const variablePaths = variablePointers(survey);
  const out: CompileDiagnostic[] = [];

  for (const raw of diagnostics) {
    const lifted = fromLogicDiagnostic(raw);
    const ruleId = stringDetail(lifted, 'rule_id');
    if (lifted.code === 'LGC-W030' && ruleId !== undefined && synthesized.has(ruleId)) continue;
    out.push(relocate(lifted, ruleId, rulePaths, variablePaths));
  }
  return out;
}

/** Every rule id `rules.ts` synthesizes from a `QuestionNode.masks[]` entry in this document. */
function synthesizedMaskRuleIds(survey: Survey): ReadonlySet<string> {
  const out = new Set<string>();
  for (const site of questionSites(survey)) {
    for (const mask of site.question.masks ?? []) out.add(synthesizedMaskRuleId(mask.id));
  }
  return out;
}

/** Variable id → `/variables/<index>`, the pointer `validateStructural` reports against. */
function variablePointers(survey: Survey): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  survey.variables.forEach((variable, index) => {
    if (!out.has(variable.id)) out.set(variable.id, pointer('variables', index));
  });
  return out;
}

/** `/rules/<i>` and `/variables/<id>` are internal indexes. Both become document pointers. */
const LOGIC_RULE_PATH = /^\/rules\/\d+(?<rest>\/.*)?$/;
const LOGIC_VARIABLE_PATH = /^\/variables\/(?<id>[^/]+)(?<rest>\/.*)?$/;

function relocate(
  diagnostic: CompileDiagnostic,
  ruleId: string | undefined,
  rulePaths: ReadonlyMap<string, string>,
  variablePaths: ReadonlyMap<string, string>,
): CompileDiagnostic {
  const rule = LOGIC_RULE_PATH.exec(diagnostic.path);
  if (rule !== null) {
    // Keyed on `detail.rule_id` and not on the index in the path, because the index is the thing
    // being repaired. A diagnostic with no `rule_id` keeps the internal path rather than being
    // pointed at the wrong row.
    const base = ruleId === undefined ? undefined : rulePaths.get(ruleId);
    if (base === undefined) return diagnostic;
    return { ...diagnostic, path: `${base}${rule.groups?.['rest'] ?? ''}` };
  }

  const variable = LOGIC_VARIABLE_PATH.exec(diagnostic.path);
  if (variable !== null) {
    const id = variable.groups?.['id'] ?? '';
    const base = variablePaths.get(id);
    if (base === undefined) return diagnostic;
    return { ...diagnostic, path: `${base}${variable.groups?.['rest'] ?? ''}` };
  }

  return diagnostic;
}

function stringDetail(diagnostic: CompileDiagnostic, key: string): string | undefined {
  const value: JsonValue | undefined = diagnostic.detail?.[key];
  return typeof value === 'string' ? value : undefined;
}

/**
 * The warnings the author has not accepted yet.
 *
 * Acknowledged warnings stay in `diagnostics` — the publish record must show what was accepted, and
 * a diagnostic that vanished when it was acknowledged would make the stored
 * `compile_diagnostics` disagree with the compile that produced it — and drop out of this list
 * only. `acknowledgementKey` is the identity, not the message: see its comment.
 */
function unacknowledgedOf(
  diagnostics: readonly CompileDiagnostic[],
  acknowledged: readonly string[],
): readonly CompileDiagnostic[] {
  if (acknowledged.length === 0) return compileWarnings(diagnostics);
  const accepted = new Set(acknowledged);
  return compileWarnings(diagnostics).filter((d) => !accepted.has(acknowledgementKey(d)));
}

/* ========================================================================== */
/* 5. The default registry                                                     */
/* ========================================================================== */

/**
 * The first-party plugin set, as a registry the caller passes in `CompileInput.plugins`.
 *
 * **Not a default applied inside `compileSurvey`**, and the distinction is deliberate enough to
 * need stating. `types.ts` describes the field as "defaults to the first-party registry", but
 * every module in this package documents the opposite semantics for an absent registry — "absent
 * means 'no registry in this process': `CMP-0400` and `CMP-0401` then say nothing"
 * (`analyses/plugins.ts`) — and in Phase 1 the modules are right: `FIRST_PARTY_CORES` holds three
 * cores (`single_select`, `multi_select`, `nps`) while schema's `BUILTIN_SCALAR_TYPES` names a
 * dozen question types, so a compile that silently resolved against the first-party set would
 * reject every survey containing a `numeric` or `text` question with `CMP-0400` — a publish
 * blocker manufactured by a default rather than by the survey. Substituting a registry the caller
 * did not choose is also the thing `FIRST_PARTY_CORES`' own comment refuses ("handing out a
 * pre-populated registry would make `first_party` the default for anything anyone added to it"),
 * since `register` assigns trust from the source.
 *
 * So the resolution is a named export rather than a hidden default: a publish worker passes this,
 * a fixture omits the field, and which of the two happened is visible at the call site. The
 * discrepancy with `types.ts`' comment is recorded in this milestone's report rather than edited
 * into a contract file.
 */
export function firstPartyRegistry(): PluginRegistry {
  const registry = createRegistry();
  for (const core of FIRST_PARTY_CORES) registry.register(core, { trust: 'first_party' });
  return registry;
}
