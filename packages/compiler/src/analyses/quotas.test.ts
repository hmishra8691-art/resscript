/**
 * What the quota analysis must get right, one test per claim `quotas.ts` makes.
 *
 * The three claims that carry the design are asserted directly rather than through a big fixture:
 * a cell whose two buckets contradict each other is unfillable *and* names both dimensions; a cell
 * the screener empties is unfillable *and* names the terminating rule (the roadmap's own example);
 * and a dimension whose variable is collected after the gate is `LGC-Q003` while the same dimension
 * with the question moved before the gate is silent. The mirror pair is the important one — if the
 * post-gate test ever passes with the question moved earlier, the check has stopped consulting the
 * flow graph and is reading document order.
 *
 * Severity is asserted on `LGC-Q001` because the roadmap and `packages/logic`'s catalogue disagree
 * about it and this file records which one won.
 *
 * Diagnostics are asserted by code and `detail`, never by message prose.
 */

import { describe, expect, it } from 'vitest';
import type {
  ContentNode,
  Expr as SchemaExpr,
  FlowNode,
  IdFactory,
  LogicRule,
  PageNode,
  QuestionNode,
  QuotaConfig,
  QuotaDimension,
  QuotaPlan,
  Survey,
  Variable,
} from '@resscript/schema';
import { asDomainId, asVariableId, astBuilder, type DomainId, type Expr } from '@resscript/logic';

import { deterministicIds } from '../../../schema/src/__fixtures__/mini.js';
import type { CompileDiagnostic } from '../diagnostics.js';
import { buildFlowGraph } from '../flow.js';
import { buildRules } from '../rules.js';
import { buildTypeEnvFor } from '../registry.js';
import { buildVariableSites } from './forward-ref.js';
import { analyzeQuotas } from './quotas.js';

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

interface SceneSpec {
  readonly content: readonly ContentNode[];
  readonly nodes: readonly FlowNode[];
  readonly variables: readonly Variable[];
  readonly quotas?: QuotaConfig;
  readonly rules?: readonly LogicRule[];
}

/**
 * The whole pipeline this analysis sits in. Not a mock: `Rule.flow_node_id` (which decides whether
 * a terminate rule precedes the gate) and `VariableSites.writes` (which decides `LGC-Q003`) are
 * both produced by other passes from the flow graph, and a fixture that set them by hand would be
 * testing this file against claims those passes do not make.
 */
function run(spec: SceneSpec): readonly CompileDiagnostic[] {
  const survey = surveyOf(spec);
  const env = buildTypeEnvFor(survey).env;
  const graph = buildFlowGraph(survey);
  const rules = buildRules(survey, graph, env).rules;
  const sites = buildVariableSites(survey, graph, rules, env);
  return analyzeQuotas({ survey, graph, rules, env, sites });
}

function surveyOf(spec: SceneSpec): Survey {
  const ids = deterministicIds(999);
  return {
    meta: { id: ids.next('survey'), ref: 'QUOTA', name: 'Quota fixture' },
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
    variables: spec.variables,
    content: spec.content,
    flow: { nodes: spec.nodes },
    logic_rules: spec.rules ?? [],
    ...(spec.quotas === undefined ? {} : { quotas: spec.quotas }),
  };
}

/** A single-select question, the enum variable it emits, and the domain id that variable lives in. */
interface Asked {
  readonly node: QuestionNode;
  readonly variable: Variable;
  readonly domain: DomainId;
}

function askEnum(ids: IdFactory, ref: string, codes: readonly number[]): Asked {
  const node: QuestionNode = {
    id: ids.next('question'),
    type: 'question',
    ref,
    question_type: 'single_select',
    label: { key: `${ref}.label` },
    required: false,
    options: codes.map((code, index) => ({
      id: ids.next('option'),
      ref: `o${String(code)}`,
      code,
      position: index + 1,
    })),
  };
  const variable: Variable = {
    id: ids.next('variable'),
    name: ref,
    kind: 'response',
    type: 'enum',
    source: { question_id: node.id, part: { kind: 'scalar' } },
    enum_domain: codes.map((code) => ({ code, label_key: `${ref}.o${String(code)}` })),
    export: { include: true, column: ref },
    pii: false,
    persist: true,
  };
  // `registry.ts` synthesizes `dom_<question id>` for a question-sourced enum. Restated here
  // rather than imported so that a change to the synthesis rule breaks this fixture loudly.
  return { node, variable, domain: asDomainId(`dom_${node.id}`) };
}

function page(ids: IdFactory, ref: string, children: readonly QuestionNode[]): PageNode {
  return { id: ids.next('page'), type: 'page', ref, children };
}

function toSchema(expression: Expr): SchemaExpr {
  return expression as unknown as SchemaExpr;
}

/** `<var> == <code>`, in the variable's own enum domain. */
function equals(asked: Asked, code: number): SchemaExpr {
  const b = astBuilder();
  return toSchema(
    b.cmp('==', b.variable(asVariableId(asked.variable.id)), b.enumLit(code, asked.domain)),
  );
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

function dimension(
  ids: IdFactory,
  ref: string,
  asked: Asked,
  buckets: readonly { readonly ref: string; readonly match: SchemaExpr }[],
): QuotaDimension {
  return {
    id: ids.next('quota_dimension'),
    ref,
    variable_id: asked.variable.id,
    buckets: buckets.map((bucket) => ({ ref: bucket.ref, match: bucket.match })),
  };
}

const POLICY = {
  count_at: 'completion',
  reservation_ttl_s: 600,
  on_store_unavailable: 'fail_closed',
  counter_scope: 'survey',
} as const;

/* -------------------------------------------------------------------------- */
/* LGC-Q001                                                                    */
/* -------------------------------------------------------------------------- */

describe('a cell nobody can land in is LGC-Q001', () => {
  it('reports an interlocked cell whose two buckets contradict each other', () => {
    const ids = deterministicIds();
    const gender = askEnum(ids, 'GENDER', [1, 2]);
    const age = askEnum(ids, 'AGE', [1, 2]);
    const p = page(ids, 'P1', [gender.node, age.node]);
    const blockId = ids.next('block');
    const startId = ids.next('flow_node');
    const seqId = ids.next('flow_node');
    const endId = ids.next('flow_node');

    const genderDim = dimension(ids, 'GENDER', gender, [
      { ref: 'M', match: equals(gender, 1) },
      { ref: 'F', match: equals(gender, 2) },
    ]);
    // The authoring mistake this exists for: a bucket on the AGE dimension whose predicate was
    // copy-pasted from GENDER, so `[M, MISCOPIED]` requires GENDER to be 1 and 2 at once.
    const ageDim = dimension(ids, 'AGE', age, [
      { ref: '18_24', match: equals(age, 1) },
      { ref: 'MISCOPIED', match: equals(gender, 2) },
    ]);
    const planId = ids.next('quota_plan');

    const diagnostics = run({
      content: [{ id: blockId, type: 'block', ref: 'B1', children: [p] }],
      nodes: [
        { id: startId, type: 'start', next: seqId },
        { id: seqId, type: 'sequence', target_id: p.id, next: endId },
        { id: endId, type: 'end', disposition: 'COMPLETE' },
      ],
      variables: [gender.variable, age.variable],
      quotas: {
        policy: POLICY,
        dimensions: [genderDim, ageDim],
        plans: [
          {
            id: planId,
            ref: 'MAIN',
            type: 'interlocked',
            dimension_ids: [genderDim.id, ageDim.id],
            target_mode: 'count',
            cells: [
              { key: ['M', '18_24'], target: 50, mode: 'hard' },
              { key: ['M', 'MISCOPIED'], target: 50, mode: 'hard' },
            ],
          },
        ],
      },
    });

    expect(codes(diagnostics)).toEqual(['LGC-Q001']);
    const detail = detailOf(diagnostics, 'LGC-Q001');
    expect(detail['reason']).toBe('contradictory_key');
    expect(detail['cell_key']).toEqual(['M', 'MISCOPIED']);
    expect(detail['plan_ref']).toBe('MAIN');
    expect(detail['dimension_refs']).toEqual(['GENDER', 'AGE']);
  });

  it('emits the catalogue severity (error), not the roadmap wording (warning)', () => {
    const ids = deterministicIds();
    const gender = askEnum(ids, 'GENDER', [1, 2]);
    const p = page(ids, 'P1', [gender.node]);
    const blockId = ids.next('block');
    const startId = ids.next('flow_node');
    const seqId = ids.next('flow_node');
    const endId = ids.next('flow_node');
    // A bucket that cannot hold: GENDER is both 1 and 2.
    const b = astBuilder();
    const impossible = toSchema(
      b.and(
        b.cmp('==', b.variable(asVariableId(gender.variable.id)), b.enumLit(1, gender.domain)),
        b.cmp('==', b.variable(asVariableId(gender.variable.id)), b.enumLit(2, gender.domain)),
      ),
    );
    const genderDim = dimension(ids, 'GENDER', gender, [{ ref: 'BOTH', match: impossible }]);

    const diagnostics = run({
      content: [{ id: blockId, type: 'block', ref: 'B1', children: [p] }],
      nodes: [
        { id: startId, type: 'start', next: seqId },
        { id: seqId, type: 'sequence', target_id: p.id, next: endId },
        { id: endId, type: 'end', disposition: 'COMPLETE' },
      ],
      variables: [gender.variable],
      quotas: {
        policy: POLICY,
        dimensions: [genderDim],
        plans: [
          {
            id: ids.next('quota_plan'),
            ref: 'MAIN',
            type: 'marginal',
            dimension_ids: [genderDim.id],
            target_mode: 'count',
            cells: [{ key: ['BOTH'], target: 10, mode: 'hard' }],
          },
        ],
      },
    });

    expect(codes(diagnostics)).toEqual(['LGC-Q001']);
    expect(diagnostics[0]?.severity).toBe('error');
    expect(detailOf(diagnostics, 'LGC-Q001')['reason']).toBe('unsatisfiable_bucket');
    expect(detailOf(diagnostics, 'LGC-Q001')['bucket_ref']).toBe('BOTH');
  });

  it('reports the cell the screener empties, naming the terminating rule', () => {
    const ids = deterministicIds();
    const gender = askEnum(ids, 'GENDER', [1, 2]);
    const age = askEnum(ids, 'AGE', [1, 2]);
    const p = page(ids, 'P1', [gender.node, age.node]);
    const blockId = ids.next('block');
    const startId = ids.next('flow_node');
    const seqId = ids.next('flow_node');
    const gateId = ids.next('flow_node');
    const endId = ids.next('flow_node');

    const genderDim = dimension(ids, 'GENDER', gender, [
      { ref: 'M', match: equals(gender, 1) },
      { ref: 'F', match: equals(gender, 2) },
    ]);
    const ageDim = dimension(ids, 'AGE', age, [
      { ref: '18_24', match: equals(age, 1) },
      { ref: '25_34', match: equals(age, 2) },
    ]);

    const diagnostics = run({
      content: [{ id: blockId, type: 'block', ref: 'B1', children: [p] }],
      nodes: [
        { id: startId, type: 'start', next: seqId },
        { id: seqId, type: 'sequence', target_id: p.id, next: gateId },
        { id: gateId, type: 'quota_gate', quota_ref: 'MAIN', on_pass: endId, on_full: endId },
        { id: endId, type: 'end', disposition: 'COMPLETE' },
      ],
      variables: [gender.variable, age.variable],
      rules: [
        {
          id: 'rul_screenout_men',
          kind: 'terminate',
          target: { type: 'survey' },
          condition: equals(gender, 1),
          effect: { action: 'terminate', disposition: 'SCREENOUT' },
        } as LogicRule,
      ],
      quotas: {
        policy: POLICY,
        dimensions: [genderDim, ageDim],
        plans: [
          {
            id: ids.next('quota_plan'),
            ref: 'MAIN',
            type: 'interlocked',
            dimension_ids: [genderDim.id, ageDim.id],
            target_mode: 'count',
            cells: [
              { key: ['M', '18_24'], target: 50, mode: 'hard' },
              { key: ['F', '18_24'], target: 50, mode: 'hard' },
            ],
          },
        ],
      },
    });

    // Only the male cell. The female cell is fillable and must stay silent.
    expect(codes(diagnostics)).toEqual(['LGC-Q001']);
    const detail = detailOf(diagnostics, 'LGC-Q001');
    expect(detail['reason']).toBe('terminated_before_gate');
    expect(detail['cell_key']).toEqual(['M', '18_24']);
    expect(detail['rule_id']).toBe('rul_screenout_men');
    expect(detail['disposition']).toBe('SCREENOUT');
    expect(detail['flow_node_id']).toBe(gateId);
  });

  it('says nothing about a plan whose cells are all reachable', () => {
    const ids = deterministicIds();
    const gender = askEnum(ids, 'GENDER', [1, 2]);
    const p = page(ids, 'P1', [gender.node]);
    const blockId = ids.next('block');
    const startId = ids.next('flow_node');
    const seqId = ids.next('flow_node');
    const gateId = ids.next('flow_node');
    const endId = ids.next('flow_node');
    const genderDim = dimension(ids, 'GENDER', gender, [
      { ref: 'M', match: equals(gender, 1) },
      { ref: 'F', match: equals(gender, 2) },
    ]);

    const diagnostics = run({
      content: [{ id: blockId, type: 'block', ref: 'B1', children: [p] }],
      nodes: [
        { id: startId, type: 'start', next: seqId },
        { id: seqId, type: 'sequence', target_id: p.id, next: gateId },
        { id: gateId, type: 'quota_gate', quota_ref: 'MAIN', on_pass: endId, on_full: endId },
        { id: endId, type: 'end', disposition: 'COMPLETE' },
      ],
      variables: [gender.variable],
      quotas: {
        policy: POLICY,
        dimensions: [genderDim],
        plans: [
          {
            id: ids.next('quota_plan'),
            ref: 'MAIN',
            type: 'marginal',
            dimension_ids: [genderDim.id],
            target_mode: 'count',
            cells: [
              { key: ['M'], target: 50, mode: 'hard' },
              { key: ['F'], target: 50, mode: 'hard' },
            ],
          },
        ],
      },
    });

    expect(diagnostics).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* LGC-Q002                                                                    */
/* -------------------------------------------------------------------------- */

describe('targets that do not add up are LGC-Q002', () => {
  interface TwoPlans {
    readonly interlockedCells: readonly QuotaPlan['cells'][number][];
    readonly marginalCells: readonly QuotaPlan['cells'][number][];
    readonly mode: 'count' | 'percentage';
  }

  function twoPlans(spec: TwoPlans): readonly CompileDiagnostic[] {
    const ids = deterministicIds();
    const gender = askEnum(ids, 'GENDER', [1, 2]);
    const age = askEnum(ids, 'AGE', [1, 2]);
    const p = page(ids, 'P1', [gender.node, age.node]);
    const blockId = ids.next('block');
    const startId = ids.next('flow_node');
    const seqId = ids.next('flow_node');
    const endId = ids.next('flow_node');
    const genderDim = dimension(ids, 'GENDER', gender, [
      { ref: 'M', match: equals(gender, 1) },
      { ref: 'F', match: equals(gender, 2) },
    ]);
    const ageDim = dimension(ids, 'AGE', age, [
      { ref: '18_24', match: equals(age, 1) },
      { ref: '25_34', match: equals(age, 2) },
    ]);

    return run({
      content: [{ id: blockId, type: 'block', ref: 'B1', children: [p] }],
      nodes: [
        { id: startId, type: 'start', next: seqId },
        { id: seqId, type: 'sequence', target_id: p.id, next: endId },
        { id: endId, type: 'end', disposition: 'COMPLETE' },
      ],
      variables: [gender.variable, age.variable],
      quotas: {
        policy: POLICY,
        dimensions: [genderDim, ageDim],
        plans: [
          {
            id: ids.next('quota_plan'),
            ref: 'CELLS',
            type: 'interlocked',
            dimension_ids: [genderDim.id, ageDim.id],
            target_mode: spec.mode,
            cells: spec.interlockedCells,
          },
          {
            id: ids.next('quota_plan'),
            ref: 'MARGINS',
            type: 'marginal',
            dimension_ids: [genderDim.id],
            target_mode: spec.mode,
            cells: spec.marginalCells,
          },
        ],
      },
    });
  }

  it('reports an interlocked bucket sum that exceeds the marginal target for the same bucket', () => {
    const diagnostics = twoPlans({
      mode: 'count',
      interlockedCells: [
        { key: ['M', '18_24'], target: 60, mode: 'hard' },
        { key: ['M', '25_34'], target: 60, mode: 'hard' },
        { key: ['F', '18_24'], target: 50, mode: 'hard' },
      ],
      marginalCells: [
        { key: ['M'], target: 100, mode: 'hard' },
        { key: ['F'], target: 100, mode: 'hard' },
      ],
    });

    expect(codes(diagnostics)).toEqual(['LGC-Q002']);
    const detail = detailOf(diagnostics, 'LGC-Q002');
    expect(detail['reason']).toBe('interlocked_exceeds_marginal');
    expect(detail['bucket_ref']).toBe('M');
    expect(detail['dimension_ref']).toBe('GENDER');
    expect(detail['interlocked_sum']).toBe(120);
    expect(detail['marginal_target']).toBe(100);
    expect(detail['plan_ref']).toBe('CELLS');
    expect(detail['marginal_plan_ref']).toBe('MARGINS');
    expect(diagnostics[0]?.severity).toBe('warning');
  });

  it('is silent when every interlocked bucket sum fits inside its marginal', () => {
    const diagnostics = twoPlans({
      mode: 'count',
      interlockedCells: [
        { key: ['M', '18_24'], target: 40, mode: 'hard' },
        { key: ['M', '25_34'], target: 60, mode: 'hard' },
      ],
      marginalCells: [{ key: ['M'], target: 100, mode: 'hard' }],
    });

    expect(diagnostics).toEqual([]);
  });

  it('reports percentage targets that do not close on 100', () => {
    const diagnostics = twoPlans({
      mode: 'percentage',
      interlockedCells: [
        { key: ['M', '18_24'], target_pct: 25, mode: 'hard' },
        { key: ['M', '25_34'], target_pct: 25, mode: 'hard' },
        { key: ['F', '18_24'], target_pct: 25, mode: 'hard' },
      ],
      marginalCells: [
        { key: ['M'], target_pct: 50, mode: 'hard' },
        { key: ['F'], target_pct: 50, mode: 'hard' },
      ],
    });

    expect(codes(diagnostics)).toEqual(['LGC-Q002']);
    const detail = detailOf(diagnostics, 'LGC-Q002');
    expect(detail['reason']).toBe('percentages_do_not_sum');
    expect(detail['sum']).toBe(75);
    expect(detail['expected']).toBe(100);
    expect(detail['plan_ref']).toBe('CELLS');
  });

  it('tolerates a rounded even split', () => {
    // Three cells of 33.3 sum to 99.9, which is inside PERCENTAGE_SUM_TOLERANCE. An author who
    // wrote the obvious thing must not be told their plan is broken.
    const diagnostics = twoPlans({
      mode: 'percentage',
      interlockedCells: [
        { key: ['M', '18_24'], target_pct: 33.3, mode: 'hard' },
        { key: ['M', '25_34'], target_pct: 33.3, mode: 'hard' },
        { key: ['F', '18_24'], target_pct: 33.4, mode: 'hard' },
      ],
      marginalCells: [
        { key: ['M'], target_pct: 50, mode: 'hard' },
        { key: ['F'], target_pct: 50, mode: 'hard' },
      ],
    });

    expect(diagnostics).toEqual([]);
  });

  it('reports one cell key stated twice', () => {
    const diagnostics = twoPlans({
      mode: 'count',
      interlockedCells: [
        { key: ['M', '18_24'], target: 10, mode: 'hard' },
        { key: ['M', '18_24'], target: 40, mode: 'hard' },
      ],
      marginalCells: [{ key: ['M'], target: 100, mode: 'hard' }],
    });

    expect(codes(diagnostics)).toEqual(['LGC-Q002']);
    const detail = detailOf(diagnostics, 'LGC-Q002');
    expect(detail['reason']).toBe('duplicate_cell_key');
    expect(detail['cell_key']).toEqual(['M', '18_24']);
    expect(detail['cell_index']).toBe(1);
    expect(detail['first_cell_index']).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/* LGC-Q003                                                                    */
/* -------------------------------------------------------------------------- */

describe('a dimension over a post-gate variable is LGC-Q003', () => {
  /** The same survey twice, with the gate before or after the page that collects GENDER. */
  function gated(order: 'gate_first' | 'page_first'): {
    readonly diagnostics: readonly CompileDiagnostic[];
    readonly gateId: string;
    readonly variableId: string;
  } {
    const ids = deterministicIds();
    const gender = askEnum(ids, 'GENDER', [1, 2]);
    const p = page(ids, 'P1', [gender.node]);
    const blockId = ids.next('block');
    const startId = ids.next('flow_node');
    const seqId = ids.next('flow_node');
    const gateId = ids.next('flow_node');
    const endId = ids.next('flow_node');
    const genderDim = dimension(ids, 'GENDER', gender, [
      { ref: 'M', match: equals(gender, 1) },
      { ref: 'F', match: equals(gender, 2) },
    ]);

    const nodes: readonly FlowNode[] =
      order === 'gate_first'
        ? [
            { id: startId, type: 'start', next: gateId },
            { id: gateId, type: 'quota_gate', quota_ref: 'MAIN', on_pass: seqId, on_full: endId },
            { id: seqId, type: 'sequence', target_id: p.id, next: endId },
            { id: endId, type: 'end', disposition: 'COMPLETE' },
          ]
        : [
            { id: startId, type: 'start', next: seqId },
            { id: seqId, type: 'sequence', target_id: p.id, next: gateId },
            { id: gateId, type: 'quota_gate', quota_ref: 'MAIN', on_pass: endId, on_full: endId },
            { id: endId, type: 'end', disposition: 'COMPLETE' },
          ];

    return {
      diagnostics: run({
        content: [{ id: blockId, type: 'block', ref: 'B1', children: [p] }],
        nodes,
        variables: [gender.variable],
        quotas: {
          policy: POLICY,
          dimensions: [genderDim],
          plans: [
            {
              id: ids.next('quota_plan'),
              ref: 'MAIN',
              type: 'marginal',
              dimension_ids: [genderDim.id],
              target_mode: 'count',
              cells: [
                { key: ['M'], target: 50, mode: 'hard' },
                { key: ['F'], target: 50, mode: 'hard' },
              ],
            },
          ],
        },
      }),
      gateId,
      variableId: gender.variable.id,
    };
  }

  it('reports a dimension whose variable is collected after the gate', () => {
    const scene = gated('gate_first');
    expect(codes(scene.diagnostics)).toEqual(['LGC-Q003']);
    const detail = detailOf(scene.diagnostics, 'LGC-Q003');
    expect(detail['dimension_ref']).toBe('GENDER');
    expect(detail['variable_id']).toBe(scene.variableId);
    expect(detail['variable_name']).toBe('GENDER');
    expect(detail['flow_node_id']).toBe(scene.gateId);
    expect(detail['source']).toBe('variable_id');
    expect(scene.diagnostics[0]?.severity).toBe('error');
  });

  it('is silent when the same question is asked before the gate', () => {
    expect(gated('page_first').diagnostics).toEqual([]);
  });

  it('reports a bucket predicate that reads a post-gate variable the dimension does not', () => {
    const ids = deterministicIds();
    const gender = askEnum(ids, 'GENDER', [1, 2]);
    const later = askEnum(ids, 'LATER', [1, 2]);
    const first = page(ids, 'P1', [gender.node]);
    const second = page(ids, 'P2', [later.node]);
    const blockId = ids.next('block');
    const startId = ids.next('flow_node');
    const firstSeq = ids.next('flow_node');
    const gateId = ids.next('flow_node');
    const secondSeq = ids.next('flow_node');
    const endId = ids.next('flow_node');
    // The dimension is over GENDER (collected before the gate), but one bucket's predicate reads
    // LATER, which is collected after it.
    const genderDim = dimension(ids, 'GENDER', gender, [
      { ref: 'M', match: equals(gender, 1) },
      { ref: 'F_LATE', match: equals(later, 1) },
    ]);

    const diagnostics = run({
      content: [{ id: blockId, type: 'block', ref: 'B1', children: [first, second] }],
      nodes: [
        { id: startId, type: 'start', next: firstSeq },
        { id: firstSeq, type: 'sequence', target_id: first.id, next: gateId },
        { id: gateId, type: 'quota_gate', quota_ref: 'MAIN', on_pass: secondSeq, on_full: endId },
        { id: secondSeq, type: 'sequence', target_id: second.id, next: endId },
        { id: endId, type: 'end', disposition: 'COMPLETE' },
      ],
      variables: [gender.variable, later.variable],
      quotas: {
        policy: POLICY,
        dimensions: [genderDim],
        plans: [
          {
            id: ids.next('quota_plan'),
            ref: 'MAIN',
            type: 'marginal',
            dimension_ids: [genderDim.id],
            target_mode: 'count',
            cells: [{ key: ['M'], target: 50, mode: 'hard' }],
          },
        ],
      },
    });

    expect(codes(diagnostics)).toEqual(['LGC-Q003']);
    const detail = detailOf(diagnostics, 'LGC-Q003');
    expect(detail['variable_name']).toBe('LATER');
    expect(detail['source']).toBe('bucket:F_LATE');
  });
});

/* -------------------------------------------------------------------------- */
/* The silent case                                                             */
/* -------------------------------------------------------------------------- */

describe('a survey with no quotas', () => {
  it('produces nothing at all', () => {
    const ids = deterministicIds();
    const gender = askEnum(ids, 'GENDER', [1, 2]);
    const p = page(ids, 'P1', [gender.node]);
    const blockId = ids.next('block');
    const startId = ids.next('flow_node');
    const seqId = ids.next('flow_node');
    const endId = ids.next('flow_node');

    expect(
      run({
        content: [{ id: blockId, type: 'block', ref: 'B1', children: [p] }],
        nodes: [
          { id: startId, type: 'start', next: seqId },
          { id: seqId, type: 'sequence', target_id: p.id, next: endId },
          { id: endId, type: 'end', disposition: 'COMPLETE' },
        ],
        variables: [gender.variable],
      }),
    ).toEqual([]);
  });
});
