/**
 * What plugin resolution must get right.
 *
 * `resolvePlugins` is asserted directly as well as through `analyzePlugins`, because three later
 * passes read its maps rather than the registry and a resolution that is right in the diagnostics
 * and wrong in the maps would ship an artifact whose `question_type` is not the plugin its config
 * was validated against.
 *
 * The `CMP-0400` / `CMP-0402` split is the pair worth pinning: an unknown id and a known id with an
 * unavailable major are different author actions, and the only thing that distinguishes them is
 * whether the document pinned a major at all.
 *
 * Diagnostics are asserted by code and `detail`, never by message prose.
 */

import { describe, expect, it } from 'vitest';
import type { JsonObject, PageNode, QuestionNode, Survey, Variable } from '@resscript/schema';
import {
  FIRST_PARTY_CORES,
  createRegistry,
  type AnyPluginCore,
  type PluginRegistry,
} from '@resscript/question-kit';

import { deterministicIds } from '../../../schema/src/__fixtures__/mini.js';
import type { CompileDiagnostic } from '../diagnostics.js';
import { CONTENT_ONLY_QUESTION_TYPES, analyzePlugins, resolvePlugins } from './plugins.js';

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

function firstParty(): PluginRegistry<AnyPluginCore> {
  const registry = createRegistry<AnyPluginCore>();
  for (const core of FIRST_PARTY_CORES) registry.register(core, { trust: 'first_party' });
  return registry;
}

/** A single_select config that satisfies `SINGLE_SELECT_CONFIG_SCHEMA`. */
const VALID_CONFIG: JsonObject = { display: 'vertical', other: { enabled: false } };

interface Asked {
  readonly questionType: string;
  readonly config?: JsonObject;
  /** `true` = the question emits one scalar variable. */
  readonly emits?: boolean;
  readonly cells?: QuestionNode['cells'];
}

interface Built {
  readonly survey: Survey;
  readonly questionIds: readonly string[];
}

function survey(asked: readonly Asked[]): Built {
  const ids = deterministicIds();
  const questions: QuestionNode[] = [];
  const variables: Variable[] = [];

  asked.forEach((spec, index) => {
    const ref = `Q${String(index + 1)}`;
    const node: QuestionNode = {
      id: ids.next('question'),
      type: 'question',
      ref,
      question_type: spec.questionType,
      label: { key: `${ref}.label` },
      required: false,
      options: [
        { id: ids.next('option'), ref: 'o1', code: 1, position: 1 },
        { id: ids.next('option'), ref: 'o2', code: 2, position: 2 },
      ],
      ...(spec.config === undefined ? {} : { config: spec.config }),
      ...(spec.cells === undefined ? {} : { cells: spec.cells }),
    };
    questions.push(node);
    if (spec.emits === true) {
      variables.push({
        id: ids.next('variable'),
        name: ref,
        kind: 'response',
        type: 'number',
        source: { question_id: node.id, part: { kind: 'scalar' } },
        export: { include: true, column: ref },
        pii: false,
        persist: true,
      });
    }
  });

  const p: PageNode = { id: ids.next('page'), type: 'page', ref: 'P1', children: questions };
  const blockId = ids.next('block');
  const startId = ids.next('flow_node');
  const seqId = ids.next('flow_node');
  const endId = ids.next('flow_node');

  return {
    questionIds: questions.map((question) => question.id),
    survey: {
      meta: { id: ids.next('survey'), ref: 'PLUG', name: 'Plugin fixture' },
      schema_version: 2,
      settings: {
        navigation: { back_allowed: true },
        resume: { enabled: false, window_s: 3600, position: 'last_page' },
        progress_bar: { mode: 'none' },
        screenout: { show_message: false },
      },
      languages: {
        base: 'en',
        available: [{ code: 'en' }],
        bundles: { en: {} },
        policy: { on_missing: 'fallback_to_base', block_publish_if_incomplete: false },
      },
      variables,
      content: [{ id: blockId, type: 'block', ref: 'B1', children: [p] }],
      flow: {
        nodes: [
          { id: startId, type: 'start', next: seqId },
          { id: seqId, type: 'sequence', target_id: p.id, next: endId },
          { id: endId, type: 'end', disposition: 'COMPLETE' },
        ],
      },
      logic_rules: [],
    },
  };
}

function codes(diagnostics: readonly CompileDiagnostic[]): readonly string[] {
  return diagnostics.map((d) => d.code);
}

function detailOf(
  diagnostics: readonly CompileDiagnostic[],
  code: string,
): { readonly [key: string]: unknown } {
  const found = diagnostics.find((d) => d.code === code);
  if (found?.detail === undefined) throw new Error(`no ${code} with detail`);
  return found.detail;
}

/* -------------------------------------------------------------------------- */
/* Resolution                                                                  */
/* -------------------------------------------------------------------------- */

describe('resolution', () => {
  it('reports an unknown question type as CMP-0400', () => {
    const built = survey([{ questionType: 'acme_dial', emits: true }]);
    const resolution = resolvePlugins(built.survey, firstParty());

    expect(codes(resolution.diagnostics)).toEqual(['CMP-0400']);
    const detail = detailOf(resolution.diagnostics, 'CMP-0400');
    expect(detail['question_type']).toBe('acme_dial');
    expect(detail['plugin_id']).toBe('acme_dial');
    expect(detail['requested_major']).toBe(null);
    expect(detail['question_ref']).toBe('Q1');
    // Nothing recorded for a question that did not resolve: a later pass must not find a key.
    expect(resolution.keys.size).toBe(0);
  });

  it('reports a pinned major the registry no longer has as CMP-0402', () => {
    const built = survey([{ questionType: 'single_select@9', config: VALID_CONFIG, emits: true }]);
    const resolution = resolvePlugins(built.survey, firstParty());

    expect(codes(resolution.diagnostics)).toEqual(['CMP-0402']);
    const detail = detailOf(resolution.diagnostics, 'CMP-0402');
    expect(detail['plugin_id']).toBe('single_select');
    expect(detail['requested_major']).toBe(9);
    expect(detail['available_keys']).toEqual(['single_select@1']);
  });

  it('records the id@major key and the exact version for every resolved question', () => {
    const built = survey([
      { questionType: 'single_select', config: VALID_CONFIG, emits: true },
      {
        questionType: 'nps',
        config: { lowLabelKey: 'nps.low', highLabelKey: 'nps.high' },
        emits: true,
      },
    ]);
    const resolution = resolvePlugins(built.survey, firstParty());

    expect(resolution.diagnostics).toEqual([]);
    expect(resolution.keys.get(built.questionIds[0] ?? '')).toBe('single_select@1');
    expect(resolution.keys.get(built.questionIds[1] ?? '')).toBe('nps@1');
    expect([...resolution.versions.entries()]).toEqual([
      ['nps@1', '1.0.0'],
      ['single_select@1', '1.0.0'],
    ]);
    // No first-party core gates on an entitlement, so nothing is recorded.
    expect(resolution.entitlementKeys.size).toBe(0);
  });

  it('records a plugin-declared entitlement key so entitlements.ts does not re-resolve', () => {
    const built = survey([{ questionType: 'acme_conjoint', emits: true }]);
    const stub = {
      resolveForCompile: () => ({
        plugin: {} as unknown as AnyPluginCore,
        meta: {
          id: 'acme_conjoint',
          version: '2.1.0',
          displayName: 'x',
          description: 'x',
          category: 'advanced' as const,
          icon: 'x',
          entitlementKey: 'conjoint',
          trust: 'marketplace' as const,
          composable: false,
          emitsData: true,
        },
        version: '2.1.0',
        key: 'acme_conjoint@2',
      }),
      // `resolveEntry` misses, which is the "no schema to check against" path: a registry bug,
      // and deliberately not reported as a config failure.
      resolveEntry: () => undefined,
      entries: () => [],
    } as unknown as PluginRegistry<AnyPluginCore>;

    const resolution = resolvePlugins(built.survey, stub);
    expect(resolution.diagnostics).toEqual([]);
    expect(resolution.entitlementKeys.get(built.questionIds[0] ?? '')).toBe('conjoint');
    expect([...resolution.versions.entries()]).toEqual([['acme_conjoint@2', '2.1.0']]);
  });

  it('resolves nothing and says nothing when no registry is supplied', () => {
    const built = survey([{ questionType: 'acme_dial', emits: true }]);
    const resolution = resolvePlugins(built.survey, undefined);
    expect(resolution.diagnostics).toEqual([]);
    expect(resolution.keys.size).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/* CMP-0401                                                                    */
/* -------------------------------------------------------------------------- */

describe('a config that does not satisfy its plugin schema', () => {
  it('reports CMP-0401 with the schema own errors in detail', () => {
    const built = survey([
      { questionType: 'single_select', config: { display: 'carousel', other: { enabled: false } }, emits: true },
    ]);
    const diagnostics = resolvePlugins(built.survey, firstParty()).diagnostics;

    expect(codes(diagnostics)).toEqual(['CMP-0401']);
    expect(diagnostics[0]?.severity).toBe('error');
    const detail = detailOf(diagnostics, 'CMP-0401');
    expect(detail['plugin_key']).toBe('single_select@1');
    expect(detail['plugin_version']).toBe('1.0.0');
    expect(detail['issue_count']).toBe(1);
    expect(detail['truncated']).toBe(false);
    const issues = detail['issues'] as readonly { readonly path: string; readonly keyword: string }[];
    expect(issues.length).toBe(1);
    expect(issues[0]?.path).toBe('/display');
    expect(issues[0]?.keyword).toBe('enum');
  });

  it('reports the missing required field a defaulted config cannot fill', () => {
    // `display` has no schema default, so `applySchemaDefaults` cannot supply it: an empty config
    // is genuinely incomplete rather than merely terse.
    const built = survey([{ questionType: 'single_select', config: {}, emits: true }]);
    const diagnostics = resolvePlugins(built.survey, firstParty()).diagnostics;

    expect(codes(diagnostics)).toEqual(['CMP-0401']);
    const issues = detailOf(diagnostics, 'CMP-0401')['issues'] as readonly {
      readonly keyword: string;
    }[];
    expect(issues.some((issue) => issue.keyword === 'required')).toBe(true);
  });

  it('is silent for a config the schema accepts', () => {
    const built = survey([{ questionType: 'single_select', config: VALID_CONFIG, emits: true }]);
    expect(resolvePlugins(built.survey, firstParty()).diagnostics).toEqual([]);
  });

  it('reports an unresolvable cell control, which would otherwise throw at declaration time', () => {
    const built = survey([
      {
        questionType: 'single_select',
        config: VALID_CONFIG,
        emits: true,
        cells: [{ row_ref: 'o1', control: { question_type: 'acme_slider' } }],
      },
    ]);
    const diagnostics = resolvePlugins(built.survey, firstParty()).diagnostics;

    expect(codes(diagnostics)).toEqual(['CMP-0400']);
    const detail = detailOf(diagnostics, 'CMP-0400');
    expect(detail['reason']).toBe('cell_control');
    expect(detail['row_ref']).toBe('o1');
    expect(detail['question_type']).toBe('acme_slider');
  });
});

/* -------------------------------------------------------------------------- */
/* CMP-0102                                                                    */
/* -------------------------------------------------------------------------- */

describe('a question that collects nothing', () => {
  it('reports CMP-0102 for a non-content type that emits no variables', () => {
    const built = survey([{ questionType: 'numeric' }]);
    const diagnostics = analyzePlugins({ survey: built.survey });

    expect(codes(diagnostics)).toEqual(['CMP-0102']);
    expect(diagnostics[0]?.severity).toBe('warning');
    const detail = detailOf(diagnostics, 'CMP-0102');
    expect(detail['question_ref']).toBe('Q1');
    expect(detail['question_type']).toBe('numeric');
    expect(detail['emits_declared']).toBe(0);
    expect(detail['plugin_resolved']).toBe(false);
  });

  it('is silent for a content-only type, by name, when no registry answers', () => {
    for (const questionType of CONTENT_ONLY_QUESTION_TYPES) {
      const built = survey([{ questionType }]);
      expect(analyzePlugins({ survey: built.survey })).toEqual([]);
    }
  });

  it('prefers the plugin PluginMeta.emitsData over the name list', () => {
    const built = survey([{ questionType: 'acme_banner' }]);
    const stub = {
      resolveForCompile: () => ({
        plugin: {} as unknown as AnyPluginCore,
        meta: {
          id: 'acme_banner',
          version: '1.0.0',
          displayName: 'x',
          description: 'x',
          category: 'content' as const,
          icon: 'x',
          entitlementKey: null,
          trust: 'org_custom' as const,
          composable: false,
          emitsData: false,
        },
        version: '1.0.0',
        key: 'acme_banner@1',
      }),
      resolveEntry: () => undefined,
      entries: () => [],
    } as unknown as PluginRegistry<AnyPluginCore>;

    expect(analyzePlugins({ survey: built.survey, plugins: stub })).toEqual([]);
  });

  it('is silent for a question whose variables exist', () => {
    const built = survey([{ questionType: 'numeric', emits: true }]);
    expect(analyzePlugins({ survey: built.survey })).toEqual([]);
  });
});
