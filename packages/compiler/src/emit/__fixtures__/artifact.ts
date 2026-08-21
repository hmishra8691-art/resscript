/**
 * One survey, compiled all the way to an `ArtifactBundle`, for the six emit test files.
 *
 * A shared fixture rather than six local ones because the properties being pinned are *global*:
 * "the same survey hashes identically twice" and "reordering object keys in the input does not move
 * the hash" are claims about the whole pipeline, and six slightly different surveys would let one
 * of them hold for a reason the others do not share. It also keeps each test file about its own
 * module — `logic.test.ts` should assert the round trip, not rebuild a type environment.
 *
 * The survey is deliberately the smallest one that exercises every branch the emitters have:
 *
 *  - **two pages**, so `inline_rules` has something to exclude — a rule whose trigger is on page 1
 *    and whose target is on page 2 must not be inlined on either.
 *  - **two languages** with a partially translated bundle, so page trees differ and the
 *    missing-key policy is on a real path.
 *  - **a fan-out question** (`multi_select`), so there are option-sourced variables, a `set_view`
 *    derived variable and an `items` cell.
 *  - **a mask** on that question, so a synthesized mask rule and its `items` cell exist.
 *  - **a hidden variable** written by a `set` rule, so a cell with no page exists and the rule that
 *    writes it is inlinable nowhere.
 *  - **non-default option and visibility bases**, so the sparse `base_option` / `base_visible`
 *    encodings emit something rather than being vacuously empty.
 *
 * `deterministicIds` seeds the id factory, so every id — and therefore every hash — is stable
 * across runs. That is what lets a test assert two hashes are equal without asserting what they
 * are.
 */

import {
  applyVariableRegistry,
  type ArtifactGraph,
  type ArtifactLogic,
  type ArtifactManifest,
  type BlockId,
  type ContentNode,
  type Expr as SchemaExpr,
  type IdFactory,
  type JsonObject,
  type LogicRule,
  type Mask,
  type PageNode,
  type QuestionItem,
  type QuestionNode,
  type StringBundle,
  type Survey,
  type Variable,
} from '@resscript/schema';
import {
  asVariableId,
  astBuilder,
  compileLogic,
  optionKey,
  type CompiledLogic,
  type TypeEnv,
} from '@resscript/logic';

import { FIRST_PARTY_CORES, createRegistry, type PluginRegistry } from '@resscript/question-kit';

import { deterministicIds, makeMiniSurvey } from '../../../../schema/src/__fixtures__/mini.js';
import { resolvePlugins, type PluginResolution } from '../../analyses/plugins.js';
import { buildFlowGraph } from '../../flow.js';
import { buildTypeEnvFor } from '../../registry.js';
import { buildRules } from '../../rules.js';
import type { ArtifactBundle, FlowGraph } from '../../types.js';
import { buildBundle, designsOf, scriptsOf } from '../bundle.js';
import { buildArtifactGraph } from '../graph.js';
import { buildI18n } from '../i18n.js';
import { buildArtifactLogic } from '../logic.js';
import { buildManifest } from '../manifest.js';
import { buildPages, type PagesResult } from '../pages.js';

/** The compiled-at instant. A constant, because CONTEXT decision 3 makes it an input. */
export const COMPILED_AT = '2026-03-01T12:00:00.000Z';

export const SURVEY_VERSION_ID = 'sv_01JQZK8N0000000000000001';

const MULTI_SELECT_CONFIG: JsonObject = {
  display: 'vertical',
  columns: 1,
  minSelected: 0,
  maxSelected: 0,
  other: { enabled: false, maxLen: 200, required: true },
};

export interface FixtureSpec {
  /** Extra language codes beyond `en`. Their bundles are deliberately partial. */
  readonly languages?: readonly string[];
  /** Replaces the `q1.label` string in the base bundle, for the "one label moves" hash test. */
  readonly q1Label?: string;
  readonly themeCss?: string | null;
  readonly scriptSource?: string;
  /**
   * Register the first-party cores, so plugins resolve. Off by default: most emit tests do not
   * care, and `CompileInput.plugins` is injectable precisely so a fixture can omit them.
   */
  readonly withPlugins?: boolean;
}

export interface Fixture {
  readonly survey: Survey;
  readonly graph: FlowGraph;
  readonly env: TypeEnv;
  readonly logic: CompiledLogic;
  readonly plugins: PluginResolution;
  readonly manifest: ArtifactManifest;
  readonly artifactGraph: ArtifactGraph;
  readonly artifactLogic: ArtifactLogic;
  readonly pages: PagesResult;
  readonly bundle: ArtifactBundle;
  readonly ids: FixtureIds;
}

/**
 * The ids a test needs to name a specific page, question, option or variable.
 *
 * Plain `string`, not the branded types. Schema's `Id<'qst'>` and logic's `QuestionId` are distinct
 * nominal types on purpose (`registry.ts`' header explains why) and a fixture that picked one side
 * would make every test on the other side cast; the branded boundary belongs to `registry.ts` and
 * `rules.ts`, not here.
 */
export interface FixtureIds {
  readonly page1: string;
  readonly page2: string;
  readonly block: string;
  readonly q1: string;
  readonly q5: string;
  readonly q7: string;
  readonly q1Option1: string;
  readonly q5Option1: string;
  readonly hidden: string;
  readonly q1Variable: string;
}

/* ========================================================================== */
/* The survey                                                                  */
/* ========================================================================== */

function item(ids: IdFactory, ref: string, code: number, labelKey: string): QuestionItem {
  // `position` is written 1-based here on purpose: it is what `packages/schema`'s own fixtures do,
  // and the emitter's job is to densify it 0-based. A fixture that already agreed with the output
  // would not test anything.
  return { id: ids.next('option'), ref, code, label: { key: labelKey }, position: code };
}

export function buildSurvey(spec: FixtureSpec = {}): { readonly survey: Survey; readonly ids: FixtureIds } {
  const ids = deterministicIds();
  const base = makeMiniSurvey(ids);

  const q1: QuestionNode = {
    id: ids.next('question'),
    type: 'question',
    ref: 'Q1',
    question_type: 'single_select',
    label: { key: 'q1.label' },
    instruction: { key: 'q1.instruction' },
    required: true,
    options: [item(ids, 'o1', 1, 'q1.o1'), item(ids, 'o2', 2, 'q1.o2')],
  };

  const maskId = ids.next('mask');
  const q5Options = [item(ids, 'o1', 1, 'q5.o1'), item(ids, 'o2', 2, 'q5.o2'), item(ids, 'o3', 3, 'q5.o3')];
  const q5Mask: Mask = {
    id: maskId,
    applies_to: 'options',
    mode: 'include',
    source: { kind: 'explicit', item_ids: [q5Options[0]?.id ?? ids.next('option')] },
    fallback: { when_empty: 'show_all' },
  };
  const q5: QuestionNode = {
    id: ids.next('question'),
    type: 'question',
    ref: 'Q5',
    question_type: 'multi_select',
    label: { key: 'q5.label' },
    required: false,
    config: MULTI_SELECT_CONFIG,
    options: q5Options,
    masks: [q5Mask],
  };

  const q7: QuestionNode = {
    id: ids.next('question'),
    type: 'question',
    ref: 'Q7',
    question_type: 'numeric',
    label: { key: 'q7.label' },
    required: false,
    config: { min: 0, max: 10 },
  };

  const page1: PageNode = {
    id: ids.next('page'),
    type: 'page',
    ref: 'P1',
    settings: { layout: 'stacked', back_allowed: true },
    children: [q1, q5],
  };
  const page2: PageNode = { id: ids.next('page'), type: 'page', ref: 'P2', children: [q7] };
  const blockId: BlockId = ids.next('block');
  const block: ContentNode = { id: blockId, type: 'block', ref: 'B9', children: [page1, page2] };

  const startId = ids.next('flow_node');
  const sequenceId = ids.next('flow_node');
  const endId = ids.next('flow_node');

  const hidden: Variable = {
    id: ids.next('variable'),
    name: 'FLAG_A',
    kind: 'hidden',
    type: 'boolean',
    export: { include: true, column: 'FLAG_A' },
    pii: false,
    persist: true,
  };

  const registered = applyVariableRegistry(
    {
      ...base,
      variables: [hidden],
      content: [block],
      flow: {
        nodes: [
          { id: startId, type: 'start', next: sequenceId },
          { id: sequenceId, type: 'sequence', target_id: blockId, next: endId },
          { id: endId, type: 'end', disposition: 'COMPLETE' },
        ],
      },
      logic_rules: [],
    },
    { ids },
  );

  const q1Variable = variableOf(registered, q1.id, 'scalar');

  const rules: readonly LogicRule[] = [
    // Trigger and target both on page 1: inlinable.
    displayRule(ids, 'hide', { type: 'question', id: q5.id }, answered(q1Variable)),
    // Trigger on page 1, target on page 2: not inlinable on either page.
    displayRule(ids, 'hide', { type: 'question', id: q7.id }, answered(q1Variable)),
    // Writes a hidden variable, which belongs to no page: inlinable nowhere.
    {
      id: ids.next('rule'),
      kind: 'set_variable',
      target: { type: 'variable', id: hidden.id },
      condition: answered(q1Variable),
      effect: { action: 'set', value: boolLiteral(true) },
    },
  ];

  const survey: Survey = {
    ...registered,
    languages: languagesOf(registered, spec),
    logic_rules: rules,
    ...(spec.scriptSource === undefined
      ? {}
      : {
          assets: {
            scripts: [
              {
                id: ids.next('asset'),
                ref: 'tracker',
                scope: 'survey',
                runs_on: 'client',
                hooks: ['onPageLoad'],
                source: spec.scriptSource,
              },
            ],
          },
        }),
  };

  return {
    survey,
    ids: {
      page1: page1.id,
      page2: page2.id,
      block: blockId,
      q1: q1.id,
      q5: q5.id,
      q7: q7.id,
      q1Option1: q1.options?.[0]?.id ?? '',
      q5Option1: q5Options[0]?.id ?? '',
      hidden: hidden.id,
      q1Variable,
    },
  };
}

function languagesOf(survey: Survey, spec: FixtureSpec): Survey['languages'] {
  const en: StringBundle = {
    ...survey.languages.bundles['en'],
    'q1.label': spec.q1Label ?? 'Pick one',
    'q1.instruction': 'Choose the closest',
    'q1.o1': 'Yes',
    'q1.o2': 'No',
    'q5.label': 'Which of these?',
    'q5.o1': 'Alpha',
    'q5.o2': 'Beta',
    'q5.o3': 'Gamma',
    'q7.label': 'How many?',
  };
  const extra = spec.languages ?? [];
  const bundles: { [code: string]: StringBundle } = { en };
  for (const code of extra) {
    // Deliberately partial: `q1.o2` and `q5.o3` are missing, which is what puts the
    // `on_missing: 'fallback_to_base'` path on a real page rather than only in a unit test.
    bundles[code] = {
      'q1.label': `[${code}] Pick one`,
      'q1.instruction': `[${code}] Choose the closest`,
      'q1.o1': `[${code}] Yes`,
      'q5.label': `[${code}] Which of these?`,
      'q5.o1': `[${code}] Alpha`,
      'q5.o2': `[${code}] Beta`,
      'q7.label': `[${code}] How many?`,
    };
  }
  return {
    base: 'en',
    available: [{ code: 'en' }, ...extra.map((code) => ({ code }))],
    bundles,
    policy: { on_missing: 'fallback_to_base', block_publish_if_incomplete: false },
  };
}

function displayRule(
  ids: IdFactory,
  action: 'show' | 'hide',
  target: LogicRule['target'],
  condition: SchemaExpr,
): LogicRule {
  return { id: ids.next('rule'), kind: 'display', target, condition, effect: { action } };
}

/** `ANSWERED(v)`, which is boolean and not constant — so it draws no `LGC-W030`. */
function answered(variableId: string): SchemaExpr {
  const b = astBuilder();
  return b.probe('answered', { kind: 'variable', id: asVariableId(variableId) }) as unknown as SchemaExpr;
}

function boolLiteral(value: boolean): SchemaExpr {
  return astBuilder().boolLit(value) as unknown as SchemaExpr;
}

function variableOf(survey: Survey, questionId: string, part: string): string {
  const found = survey.variables.find(
    (variable) => variable.source?.question_id === questionId && variable.source.part.kind === part,
  );
  if (found === undefined) throw new Error(`no ${part} variable for ${questionId}`);
  return found.id;
}

/* ========================================================================== */
/* The compile                                                                 */
/* ========================================================================== */

/**
 * The whole pipeline, in the order the compile gate runs it.
 *
 * `declaredVisible` and `optionDefaults` are supplied so the sparse `base_visible` and
 * `base_option` encodings have a non-default entry to carry. In a real compile they come from the
 * document (`OptionBehaviour`'s literal arms); deriving them is not this directory's work, and a
 * fixture that left them empty would make the two sparse records vacuously correct.
 */
export function compileFixture(spec: FixtureSpec = {}): Fixture {
  const { survey, ids } = buildSurvey(spec);
  return fixtureOf(survey, ids, spec);
}

export function fixtureOf(survey: Survey, ids: FixtureIds, spec: FixtureSpec = {}): Fixture {
  const graph = buildFlowGraph(survey);
  const { env } = buildTypeEnvFor(survey);
  const { rules } = buildRules(survey, graph, env);
  const logic = compileLogic(rules, env, {
    declaredVisible: { [ids.q7]: false },
    optionDefaults: { [optionKey(ids.q5Option1, 'preselected')]: true },
  });
  const plugins = resolvePlugins(survey, spec.withPlugins === true ? firstPartyRegistry() : undefined);

  const manifest = buildManifest({ survey, surveyVersionId: SURVEY_VERSION_ID, plugins });
  const artifactGraph = buildArtifactGraph(graph);
  const artifactLogic = buildArtifactLogic({ survey, logic });
  const pages = buildPages({ survey, graph, logic, plugins });
  const i18n = buildI18n(survey);

  const scripts = scriptsOf(survey);
  const designs = designsOf(survey);
  const bundle = buildBundle({
    manifest,
    graph: artifactGraph,
    logic: artifactLogic,
    pages: pages.byLanguage,
    baseLanguage: pages.baseLanguage,
    i18n,
    compiledAt: COMPILED_AT,
    ...(survey.quotas === undefined || survey.quotas === null ? {} : { quotas: survey.quotas }),
    ...(designs === undefined ? {} : { designs }),
    ...(spec.themeCss === undefined || spec.themeCss === null ? {} : { themeCss: spec.themeCss }),
    ...(scripts === undefined ? {} : { scripts }),
  });

  return {
    survey,
    graph,
    env,
    logic,
    plugins,
    manifest,
    artifactGraph,
    artifactLogic,
    pages,
    bundle,
    ids,
  };
}

/** The first-party set, with trust assigned from the source — per `FIRST_PARTY_CORES`' comment. */
function firstPartyRegistry(): PluginRegistry {
  const registry = createRegistry();
  for (const core of FIRST_PARTY_CORES) registry.register(core, { trust: 'first_party' });
  return registry;
}

/* ========================================================================== */
/* Key reordering                                                              */
/* ========================================================================== */

/**
 * A structural clone with every object's keys in reverse order, arrays untouched.
 *
 * This is the input side of the determinism claim. `stableStringify` sorts keys on the way out, so
 * the assertion "two structurally equal surveys hash identically" is only worth making if the two
 * surveys genuinely differ in key order — and the only way to be sure of that is to build one from
 * the other. Arrays are cloned in place because array order is semantic everywhere in this model
 * (option positions, branch precedence, export column order), so reversing one would be a
 * different survey rather than the same one spelled differently.
 *
 * **AST nodes are left alone, and the reason is a defect elsewhere rather than a limitation here.**
 * `compileLogic`'s hash-consing keys a `lit` node on `JSON.stringify(e.v)`
 * (`packages/logic/src/compile.ts`' `discriminant`), which is *key-order sensitive*: a literal
 * written `{"k":"bool","v":true}` and the same literal written `{"v":true,"k":"bool"}` hash to
 * different structural keys, so two documents that differ only in the key order of a stored
 * literal produce a different number of interned nodes — and therefore different node ids,
 * different `derived` indices and a different artifact hash. Nothing in this directory can fix
 * that; every emitter here canonicalizes on output, and the sensitivity is upstream of them, in the
 * interner. Reversing the AST too would make this fixture assert that the interner is canonical,
 * which it is not, instead of asserting what the emitters promise. The gap is reported rather than
 * papered over: in practice `content.logic_rules.condition` is a `jsonb` column and Postgres
 * normalizes key order on the way in, so no document read from the database can trip it.
 */
export function withReversedKeys<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((entry) => withReversedKeys(entry)) as unknown as T;
  }
  if (value === null || typeof value !== 'object') return value;
  const source = value as { readonly [key: string]: unknown };
  if (typeof source['op'] === 'string') return value;
  const out: { [key: string]: unknown } = {};
  for (const key of Object.keys(source).reverse()) out[key] = withReversedKeys(source[key]);
  return out as unknown as T;
}
