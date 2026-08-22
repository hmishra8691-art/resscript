/**
 * The 500-question fixture, extracted from `pipeline.test.ts` so two consumers stay in
 * agreement: the compile-budget test ("500 questions × 5 languages under 5 s") and the Phase-1
 * exit perf rig (`tools/perf/p1-exit.mjs`, "page render p95 < 300 ms and submit p95 < 250 ms
 * against a 500-question fixture"). Two hand-maintained copies of "what a 500-question survey
 * is" would eventually measure two different surveys and report one number for both.
 *
 * Shape: `questionCount` numeric questions, ten per page, one block, a linear flow, a COMPLETE
 * redirect (so the fixture is publishable under CMP-0300), and per-language bundles derived
 * from the base by prefixing — enough translation mass to exercise the i18n emit without
 * pretending to be real German.
 */

import type {
  FlowNode,
  IdFactory,
  Languages,
  PageNode,
  QuestionNode,
  StringBundle,
  Survey,
} from '@resscript/schema';
import { applyVariableRegistry } from '@resscript/schema';
import { deterministicIds } from '../../../schema/src/__fixtures__/mini.js';

export function largeSurvey(questionCount: number, languages: readonly string[]): Survey {
  const ids = deterministicIds();
  const perPage = 10;
  const pages: PageNode[] = [];
  const en: { [key: string]: string } = {};

  for (let i = 0; i < questionCount; i += 1) {
    if (i % perPage === 0) {
      pages.push({ id: ids.next('page'), type: 'page', ref: `P${String(pages.length + 1)}`, children: [] });
    }
    const ref = `Q${String(i + 1)}`;
    en[`${ref}.label`] = `Question ${String(i + 1)}`;
    const question: QuestionNode = {
      id: ids.next('question'),
      type: 'question',
      ref,
      question_type: 'numeric',
      label: { key: `${ref}.label` },
      required: false,
    };
    const current = pages[pages.length - 1];
    if (current === undefined) continue;
    pages[pages.length - 1] = { ...current, children: [...current.children, question] };
  }

  const blockId = ids.next('block');
  const startId = ids.next('flow_node');
  const endId = ids.next('flow_node');
  const sequenceIds = pages.map(() => ids.next('flow_node'));
  const nodes: FlowNode[] = [
    { id: startId, type: 'start', next: sequenceIds[0] ?? endId },
    ...pages.map((p, i): FlowNode => ({
      id: sequenceIds[i] ?? endId,
      type: 'sequence',
      target_id: p.id,
      next: sequenceIds[i + 1] ?? endId,
    })),
    { id: endId, type: 'end', disposition: 'COMPLETE' },
  ];

  const bundles: { [code: string]: StringBundle } = { en };
  for (const code of languages) {
    if (code === 'en') continue;
    const bundle: { [key: string]: string } = {};
    for (const key of Object.keys(en)) bundle[key] = `[${code}] ${en[key] ?? ''}`;
    bundles[code] = bundle;
  }

  const languagesSpec: Languages = {
    base: 'en',
    available: languages.map((code) => ({ code })),
    bundles,
    policy: { on_missing: 'fallback_to_base', block_publish_if_incomplete: true },
  };

  const bare: Survey = {
    meta: { id: ids.next('survey'), ref: 'GATE', name: 'Compile gate fixture' },
    schema_version: 2,
    settings: {
      navigation: { back_allowed: true },
      resume: { enabled: false, window_s: 3600, position: 'last_page' },
      progress_bar: { mode: 'none' },
      screenout: { show_message: false },
    },
    languages: languagesSpec,
    variables: [],
    content: [{ id: blockId, type: 'block', ref: 'B1', children: pages }],
    flow: { nodes },
    logic_rules: [],
    redirects: { default: { COMPLETE: 'https://example.test/done' } },
  };

  return applyVariableRegistry(bare, { ids });
}

/** Ten of `largeSurvey`'s ids the perf rig needs without re-deriving the id sequence. */
export function largeSurveyIds(survey: Survey): {
  readonly pageIds: readonly string[];
  readonly questionRefs: readonly string[];
} {
  const block = survey.content[0];
  const pages = block !== undefined && 'children' in block ? (block.children as PageNode[]) : [];
  return {
    pageIds: pages.map((p) => p.id),
    questionRefs: pages.flatMap((p) => p.children.map((q) => (q as QuestionNode).ref)),
  };
}
