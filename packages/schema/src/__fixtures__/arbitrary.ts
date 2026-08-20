/**
 * A fast-check arbitrary for the survey model.
 *
 * The round-trip property is only worth as much as the generator behind it, so this builds
 * *structurally valid* surveys rather than random JSON: refs are unique, ids are well-formed
 * and unique, every i18n key referenced exists in the base bundle, the variable registry is the
 * one the content implies, and the flow reaches every block. `survey.test.ts` asserts that
 * property too — if the generator ever starts producing invalid surveys, the round-trip test
 * stops meaning anything and we want to know immediately.
 *
 * Determinism: the id factory is seeded from a generated integer that is part of the arbitrary,
 * so a failing case shrinks and replays to the same bytes.
 */

import fc from 'fast-check';

import { createIdFactory } from '../ids.js';
import type { IdFactory } from '../ids.js';
import type { Survey } from '../types/survey.js';
import type {
  BlockNode,
  ContentNode,
  PageChild,
  PageNode,
  QuestionCell,
  QuestionItem,
  QuestionNode,
} from '../types/content.js';
import type { FlowNode } from '../types/flow.js';
import type { LogicRule } from '../types/logic.js';
import type { Mask } from '../types/masks.js';
import type { StringBundle } from '../types/i18n.js';
import { applyVariableRegistry } from '../variables.js';

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The question shapes the generator knows how to build valid content for. */
const QUESTION_TYPES = [
  'single_select',
  'multi_select',
  'matrix',
  'numeric_list',
  'matrix_mixed',
  'nps',
  'open_text',
  'numeric',
  'date',
  'display_text',
] as const;
type GeneratedQuestionType = (typeof QUESTION_TYPES)[number];

interface QuestionModel {
  readonly questionType: GeneratedQuestionType;
  readonly itemCount: number;
  readonly rowCount: number;
  readonly required: boolean;
  readonly otherSpecify: boolean;
  readonly mask: boolean;
  readonly exclude: boolean;
}

interface PageModel {
  readonly questions: readonly QuestionModel[];
  readonly minTimeS: number | null;
}

interface BlockModel {
  readonly pages: readonly PageModel[];
  readonly loop: boolean;
}

interface SurveyModel {
  readonly seed: number;
  readonly blocks: readonly BlockModel[];
  readonly withQuotas: boolean;
  readonly withRule: boolean;
  readonly rtl: boolean;
}

const questionModel = fc.record<QuestionModel>({
  questionType: fc.constantFrom(...QUESTION_TYPES),
  itemCount: fc.integer({ min: 2, max: 5 }),
  rowCount: fc.integer({ min: 1, max: 4 }),
  required: fc.boolean(),
  otherSpecify: fc.boolean(),
  mask: fc.boolean(),
  exclude: fc.boolean(),
});

const pageModel = fc.record<PageModel>({
  questions: fc.array(questionModel, { minLength: 1, maxLength: 3 }),
  minTimeS: fc.option(fc.integer({ min: 1, max: 120 }), { nil: null }),
});

const blockModel = fc.record<BlockModel>({
  pages: fc.array(pageModel, { minLength: 1, maxLength: 3 }),
  loop: fc.boolean(),
});

const surveyModel = fc.record<SurveyModel>({
  seed: fc.integer({ min: 1, max: 2 ** 30 }),
  blocks: fc.array(blockModel, { minLength: 1, maxLength: 2 }),
  withQuotas: fc.boolean(),
  withRule: fc.boolean(),
  rtl: fc.boolean(),
});

/** An arbitrary, structurally valid survey. */
export const arbitrarySurvey: fc.Arbitrary<Survey> = surveyModel.map(build);

interface BuildCtx {
  readonly ids: IdFactory;
  readonly bundle: Record<string, string>;
  refCounter: number;
}

function build(model: SurveyModel): Survey {
  const ctx: BuildCtx = {
    ids: createIdFactory({ now: () => 1_700_000_000_000, random: mulberry32(model.seed) }),
    bundle: {},
    refCounter: 0,
  };

  // Platform-supplied keys: the NPS band domain references them unconditionally.
  ctx.bundle['sys.nps.detractor'] = 'Detractor';
  ctx.bundle['sys.nps.passive'] = 'Passive';
  ctx.bundle['sys.nps.promoter'] = 'Promoter';

  const content: ContentNode[] = model.blocks.map((block, i) => buildBlock(ctx, block, i));

  const flow: FlowNode[] = [];
  const startId = ctx.ids.next('flow_node');
  const endId = ctx.ids.next('flow_node');
  const sequenceIds = content.map(() => ctx.ids.next('flow_node'));
  flow.push({ id: startId, type: 'start', next: sequenceIds[0] ?? endId });
  content.forEach((node, i) => {
    const id = sequenceIds[i];
    if (id === undefined) return;
    flow.push({ id, type: 'sequence', target_id: node.id, next: sequenceIds[i + 1] ?? endId });
  });
  flow.push({ id: endId, type: 'end', disposition: 'COMPLETE' });

  const bare: Survey = {
    meta: {
      id: ctx.ids.next('survey'),
      ref: 'GEN_SURVEY',
      name: 'Generated survey',
      tags: [],
    },
    schema_version: 2,
    settings: {
      navigation: { back_allowed: true },
      resume: { enabled: false, window_s: 604800, position: 'last_page' },
      progress_bar: { mode: 'pages' },
      screenout: { show_message: false },
    },
    languages: {
      base: 'en',
      available: model.rtl ? [{ code: 'en' }, { code: 'ar', rtl: true }] : [{ code: 'en' }],
      bundles: { en: ctx.bundle as StringBundle },
      policy: { on_missing: 'fallback_to_base', block_publish_if_incomplete: false },
    },
    variables: [],
    content,
    flow: { nodes: flow },
    logic_rules: [],
  };

  const withVariables = applyVariableRegistry(bare, { ids: ctx.ids });

  const firstEnum = withVariables.variables.find((v) => v.type === 'enum');
  const firstBlock = content[0];
  const rules: LogicRule[] =
    model.withRule && firstEnum !== undefined && firstBlock !== undefined
      ? [
          {
            id: ctx.ids.next('rule'),
            kind: 'display',
            target: { type: 'block', id: firstBlock.id },
            condition: { op: '==', n: 'n1', args: [{ var: firstEnum.id }, { lit: 1 }] },
            effect: { action: 'show' },
            evaluation: 'on_change',
          },
        ]
      : [];

  const quotas =
    model.withQuotas && firstEnum !== undefined
      ? {
          policy: {
            count_at: 'reservation' as const,
            reservation_ttl_s: 5400,
            on_store_unavailable: 'fail_closed' as const,
            counter_scope: 'survey' as const,
          },
          dimensions: [
            {
              id: ctx.ids.next('quota_dimension'),
              ref: 'DIM_1',
              variable_id: firstEnum.id,
              buckets: [{ ref: 'a', match: { op: '==', n: 'q1', args: [{ var: firstEnum.id }, { lit: 1 }] } }],
            },
          ],
          plans: [] as const,
        }
      : undefined;

  const plans =
    quotas === undefined
      ? undefined
      : [
          {
            id: ctx.ids.next('quota_plan'),
            ref: 'PLAN_1',
            type: 'interlocked' as const,
            dimension_ids: quotas.dimensions.map((d) => d.id),
            cells: [{ key: ['a'], target: 100, mode: 'hard' as const }],
          },
        ];

  return {
    ...withVariables,
    logic_rules: rules,
    ...(quotas === undefined || plans === undefined ? {} : { quotas: { ...quotas, plans } }),
  };
}

function buildBlock(ctx: BuildCtx, model: BlockModel, index: number): BlockNode {
  const ref = `B${index + 1}`;
  const titleKey = `blk.${ref.toLowerCase()}.title`;
  ctx.bundle[titleKey] = `Block ${ref}`;
  const children = model.pages.map((page) => buildPage(ctx, page));
  return {
    id: ctx.ids.next('block'),
    type: 'block',
    ref,
    title: { key: titleKey },
    // A loop only names variables differently; the generator keeps its source explicit so it
    // needs no variable to point at.
    ...(model.loop
      ? {
          settings: {
            loop: {
              source: {
                kind: 'explicit_list' as const,
                items: [
                  { ref: 'i1', code: 1 },
                  { ref: 'i2', code: 2 },
                ],
              },
              max_iterations: 2,
              iteration_variable_ref: `LOOPVAR${index + 1}`,
              variable_naming: '{ref}_{iteration}',
            },
          },
        }
      : {}),
    children,
  };
}

function buildPage(ctx: BuildCtx, model: PageModel): PageNode {
  ctx.refCounter += 1;
  const ref = `P${ctx.refCounter}`;
  const children: PageChild[] = model.questions.map((q) => buildQuestion(ctx, q));
  return {
    id: ctx.ids.next('page'),
    type: 'page',
    ref,
    settings: {
      layout: 'stacked',
      back_allowed: true,
      min_time_action: 'flag',
      ...(model.minTimeS === null ? {} : { min_time_s: model.minTimeS }),
    },
    children,
  };
}

function buildQuestion(ctx: BuildCtx, model: QuestionModel): QuestionNode {
  ctx.refCounter += 1;
  const ref = `Q${ctx.refCounter}`;
  const labelKey = `${ref.toLowerCase()}.label`;
  ctx.bundle[labelKey] = `Question ${ref}`;

  const items = (kind: string, count: number): QuestionItem[] =>
    Array.from({ length: count }, (_unused, i) => {
      const itemRef = `${kind}${i + 1}`;
      const key = `${ref.toLowerCase()}.${itemRef}`;
      ctx.bundle[key] = `${kind} ${i + 1}`;
      return {
        id: ctx.ids.next('option'),
        ref: itemRef,
        code: i + 1,
        label: { key },
        position: i + 1,
      };
    });

  const base = {
    id: ctx.ids.next('question'),
    type: 'question' as const,
    ref,
    question_type: model.questionType,
    label: { key: labelKey },
    required: model.required,
  };

  const masks: Mask[] = model.mask
    ? [
        {
          id: ctx.ids.next('mask'),
          applies_to: 'options',
          mode: 'include',
          source: { kind: 'expression_per_item', condition: { op: 'item_attr', n: 'm1', attr: 'code' } },
          fallback: { when_empty: 'show_all' },
        },
      ]
    : [];

  const flags = model.exclude ? { flags: { exclude_from_export: true } } : {};
  const withMasks = masks.length > 0 ? { masks } : {};

  switch (model.questionType) {
    case 'single_select': {
      const options = items('o', model.itemCount);
      const last = options[options.length - 1];
      return {
        ...base,
        options:
          model.otherSpecify && last !== undefined
            ? [...options.slice(0, -1), { ...last, other_specify: true }]
            : options,
        ...withMasks,
        ...flags,
      };
    }
    case 'multi_select': {
      const options = items('o', model.itemCount);
      const last = options[options.length - 1];
      return {
        ...base,
        options:
          model.otherSpecify && last !== undefined
            ? [...options.slice(0, -1), { ...last, other_specify: true }]
            : options,
        ...withMasks,
        ...flags,
      };
    }
    case 'matrix':
      return {
        ...base,
        rows: items('r', model.rowCount),
        columns: items('c', model.itemCount),
        ...withMasks,
        ...flags,
      };
    case 'numeric_list':
      return { ...base, rows: items('r', model.rowCount), ...withMasks, ...flags };
    case 'matrix_mixed': {
      const rows = items('r', Math.max(model.rowCount, 3));
      const columns = items('c', model.itemCount);
      const controls: readonly QuestionCell['control'][] = [
        { question_type: 'numeric', config: { min: 0, max: 100 } },
        { question_type: 'text', config: { max_len: 200 } },
        { question_type: 'single_select', use_columns: true },
      ];
      const cells: QuestionCell[] = rows.map((row, i) => ({
        row_ref: row.ref,
        control: controls[i % controls.length] ?? { question_type: 'numeric' },
      }));
      return { ...base, rows, columns, cells, ...withMasks, ...flags };
    }
    case 'nps':
      return { ...base, config: { min: 0, max: 10 }, ...flags };
    case 'open_text':
      return { ...base, config: { max_len: 500 }, ...flags };
    case 'numeric':
      return { ...base, config: { min: 0, max: 999 }, ...flags };
    case 'date':
      return { ...base, ...flags };
    case 'display_text':
      // Emits nothing, which is exactly why it belongs in the generator: an empty `emits`
      // array has to survive the round trip too.
      return { ...base, required: false, ...flags };
    default: {
      const never: never = model.questionType;
      throw new Error(`Unhandled generated question type: ${String(never)}`);
    }
  }
}
