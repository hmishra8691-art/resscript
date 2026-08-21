/**
 * What `buildFlowGraph` must get right, one test per property another pass depends on.
 *
 * The shape of this file follows from what the flow graph is *for*. Three of its outputs are
 * quoted verbatim by later diagnostics — `position` ("page 18 vs page 24"), `idom` (the forward
 * reference check) and `pageOrder` (the artifact's page list) — so those are asserted by value,
 * not by shape. Dominance in particular is checked against a brute-force oracle rather than
 * against hand-written expectations: "every path from start to b passes through a" is a claim
 * about paths, and a test that restates the algorithm's own answer proves nothing. Diagnostics
 * are asserted by code and `detail`, never by message prose, because prose is not the contract.
 */

import { describe, expect, it } from 'vitest';
import type {
  BlockId,
  BlockNode,
  ContentNode,
  Expr,
  FlowNode,
  FlowNodeId,
  PageId,
  PageNode,
  QuestionId,
  QuestionNode,
  Survey,
  SurveyId,
} from '@resscript/schema';

import { blockPathOf, buildFlowGraph, flowNodeOfNode, pageOfQuestion } from './flow.js';
import { dominates, type FlowGraph } from './types.js';
import type { CompileDiagnostic } from './diagnostics.js';

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Readable ids. `flow.ts` treats every id as an opaque string — it resolves content through
 * `findContentNode` and flow through its own index, and validates neither format — so a fixture
 * id says what it is (`fn_branch`, `pg_p2`) instead of being a ULID nobody can read in a failed
 * assertion. The brands are asserted at the one place they are constructed, as at the parse
 * boundary.
 */
const fn = (name: string): FlowNodeId => `fn_${name}` as FlowNodeId;
const pgId = (ref: string): PageId => `pg_${ref}` as PageId;
const blkId = (ref: string): BlockId => `blk_${ref}` as BlockId;
const qstId = (ref: string): QuestionId => `qst_${ref}` as QuestionId;

const TRUE: Expr = { op: 'lit', value: true };

function question(ref: string): QuestionNode {
  return {
    id: qstId(ref),
    type: 'question',
    ref,
    question_type: 'numeric',
    required: false,
  };
}

function page(ref: string, children: readonly QuestionNode[] = [question(`${ref}q`)]): PageNode {
  return { id: pgId(ref), type: 'page', ref, children };
}

function block(ref: string, children: readonly ContentNode[]): BlockNode {
  return { id: blkId(ref), type: 'block', ref, children };
}

function makeSurvey(content: readonly ContentNode[], nodes: readonly FlowNode[]): Survey {
  return {
    meta: { id: 'svy_test' as SurveyId, ref: 'FLOW', name: 'Flow fixture' },
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
    variables: [],
    content,
    flow: { nodes },
    logic_rules: [],
  };
}

function codes(diagnostics: readonly CompileDiagnostic[]): readonly string[] {
  return diagnostics.map((d) => d.code);
}

function only(diagnostics: readonly CompileDiagnostic[], code: string): readonly CompileDiagnostic[] {
  return diagnostics.filter((d) => d.code === code);
}

/**
 * The oracle: `a` dominates `b` iff `b` is reachable and becomes unreachable once `a` is deleted.
 * Deliberately a different algorithm from the one under test.
 */
function dominatesByDeletion(graph: FlowGraph, a: string, b: string): boolean {
  if (!graph.reachable.has(b)) return false;
  if (a === b) return true;
  const seen = new Set<string>();
  if (graph.start !== a) {
    seen.add(graph.start);
    const stack = [graph.start];
    while (stack.length > 0) {
      const cursor = stack.pop();
      if (cursor === undefined) break;
      for (const next of graph.successors.get(cursor) ?? []) {
        if (next === a || seen.has(next)) continue;
        seen.add(next);
        stack.push(next);
      }
    }
  }
  return !seen.has(b);
}

/** Every reachable pair, both ways, against the oracle. */
function expectDominanceAgreesWithPaths(graph: FlowGraph): void {
  const mismatches: string[] = [];
  for (const a of graph.reachable) {
    for (const b of graph.reachable) {
      const claimed = dominates(graph, a, b);
      const actual = dominatesByDeletion(graph, a, b);
      if (claimed !== actual) mismatches.push(`${a} dom ${b}: helper=${claimed} paths=${actual}`);
    }
  }
  expect(mismatches).toEqual([]);
}

/* -------------------------------------------------------------------------- */
/* Linear flows                                                               */
/* -------------------------------------------------------------------------- */

function linearSurvey(): Survey {
  return makeSurvey(
    [block('b1', [page('p1'), page('p2'), page('p3')])],
    [
      { id: fn('start'), type: 'start', next: fn('seq') },
      { id: fn('seq'), type: 'sequence', target_id: blkId('b1'), next: fn('end') },
      { id: fn('end'), type: 'end', disposition: 'COMPLETE' },
    ],
  );
}

describe('a linear flow', () => {
  it('orders nodes by traversal and gives every node a position', () => {
    const graph = buildFlowGraph(linearSurvey());
    expect(graph.diagnostics).toEqual([]);
    expect(graph.start).toBe('fn_start');
    expect(graph.order).toEqual(['fn_start', 'fn_seq', 'fn_end']);
    expect([...graph.position]).toEqual([
      ['fn_start', 0],
      ['fn_seq', 1],
      ['fn_end', 2],
    ]);
    expect([...graph.reachable]).toEqual(['fn_start', 'fn_seq', 'fn_end']);
  });

  it('records successors and predecessors, treating a null edge as a terminal', () => {
    const graph = buildFlowGraph(linearSurvey());
    expect(graph.successors.get('fn_start')).toEqual(['fn_seq']);
    expect(graph.successors.get('fn_seq')).toEqual(['fn_end']);
    expect(graph.successors.get('fn_end')).toEqual([]);
    expect(graph.predecessors.get('fn_seq')).toEqual(['fn_start']);
    expect(graph.predecessors.get('fn_start')).toEqual([]);
  });

  it('makes dominance total: each node dominates everything after it', () => {
    const graph = buildFlowGraph(linearSurvey());
    expect([...graph.idom]).toEqual([
      ['fn_start', 'fn_start'],
      ['fn_seq', 'fn_start'],
      ['fn_end', 'fn_seq'],
    ]);
    expectDominanceAgreesWithPaths(graph);
  });

  it('lays out a block as its pages in document order, from one entry node', () => {
    const graph = buildFlowGraph(linearSurvey());
    expect(graph.pageOrder).toEqual(['pg_p1', 'pg_p2', 'pg_p3']);
    expect([...graph.pageEntry]).toEqual([
      ['pg_p1', 'fn_seq'],
      ['pg_p2', 'fn_seq'],
      ['pg_p3', 'fn_seq'],
    ]);
    expect(graph.contentSites.get('blk_b1')).toEqual(['fn_seq']);
    expect(graph.contentSites.get('qst_p2q')).toEqual(['fn_seq']);
    expect(flowNodeOfNode(graph, 'qst_p2q')).toBe('fn_seq');
    expect(flowNodeOfNode(graph, 'pg_nope')).toBeUndefined();
  });

  it('lays out nested blocks depth-first, so document order survives nesting', () => {
    const survey = makeSurvey(
      [
        block('outer', [
          page('p1'),
          block('inner', [page('p2'), page('p3')]),
          page('p4'),
        ]),
      ],
      [
        { id: fn('start'), type: 'start', next: fn('seq') },
        { id: fn('seq'), type: 'sequence', target_id: blkId('outer'), next: null },
      ],
    );
    const graph = buildFlowGraph(survey);
    expect(graph.diagnostics).toEqual([]);
    expect(graph.pageOrder).toEqual(['pg_p1', 'pg_p2', 'pg_p3', 'pg_p4']);
    expect(graph.contentSites.get('blk_inner')).toEqual(['fn_seq']);
  });

  it('resolves a sequence that names a question to the page holding it', () => {
    const survey = makeSurvey(
      [block('b1', [page('p1'), page('p2')])],
      [
        { id: fn('start'), type: 'start', next: fn('seq') },
        { id: fn('seq'), type: 'sequence', target_id: qstId('p2q'), next: null },
      ],
    );
    const graph = buildFlowGraph(survey);
    expect(graph.diagnostics).toEqual([]);
    expect(graph.pageOrder).toEqual(['pg_p2']);
    expect(graph.contentSites.get('qst_p2q')).toEqual(['fn_seq']);
  });
});

/* -------------------------------------------------------------------------- */
/* Branching                                                                  */
/* -------------------------------------------------------------------------- */

function diamondSurvey(): Survey {
  return makeSurvey(
    [block('b1', [page('p1'), page('pa'), page('pb'), page('join')])],
    [
      { id: fn('start'), type: 'start', next: fn('branch') },
      {
        id: fn('branch'),
        type: 'branch',
        branches: [
          { condition: TRUE, next: fn('armA') },
          { condition: null, next: fn('armB') },
        ],
      },
      { id: fn('armA'), type: 'sequence', target_id: pgId('pa'), next: fn('join') },
      { id: fn('armB'), type: 'sequence', target_id: pgId('pb'), next: fn('join') },
      { id: fn('join'), type: 'sequence', target_id: pgId('join'), next: fn('end') },
      { id: fn('end'), type: 'end', disposition: 'COMPLETE' },
    ],
  );
}

describe('a diamond', () => {
  it('does not let a node on one arm dominate the join; the branch does', () => {
    const graph = buildFlowGraph(diamondSurvey());
    expect(graph.diagnostics).toEqual([]);
    expect(graph.idom.get('fn_join')).toBe('fn_branch');
    expect(graph.idom.get('fn_armA')).toBe('fn_branch');
    expect(graph.idom.get('fn_armB')).toBe('fn_branch');
    expect(dominates(graph, 'fn_armA', 'fn_join')).toBe(false);
    expect(dominates(graph, 'fn_armB', 'fn_join')).toBe(false);
    expect(dominates(graph, 'fn_branch', 'fn_join')).toBe(true);
    expect(dominates(graph, 'fn_branch', 'fn_end')).toBe(true);
    expectDominanceAgreesWithPaths(graph);
  });

  it('visits branch arms in array order, so position is a function of the document', () => {
    const graph = buildFlowGraph(diamondSurvey());
    expect(graph.order).toEqual([
      'fn_start',
      'fn_branch',
      'fn_armA',
      'fn_armB',
      'fn_join',
      'fn_end',
    ]);
    expect(graph.pageOrder).toEqual(['pg_pa', 'pg_pb', 'pg_join']);
  });

  it('collects both predecessors of the join', () => {
    const graph = buildFlowGraph(diamondSurvey());
    expect(graph.predecessors.get('fn_join')).toEqual(['fn_armA', 'fn_armB']);
  });

  it('orders quota_gate and api_call successors by their declared fields', () => {
    const survey = makeSurvey(
      [block('b1', [page('p1'), page('p2')])],
      [
        { id: fn('start'), type: 'start', next: fn('api') },
        {
          id: fn('api'),
          type: 'api_call',
          url_template: 'https://example.test',
          on_success: fn('gate'),
          on_error: fn('bail'),
        },
        { id: fn('gate'), type: 'quota_gate', quota_ref: 'q', on_pass: fn('ok'), on_full: fn('full') },
        { id: fn('ok'), type: 'sequence', target_id: pgId('p1'), next: null },
        { id: fn('full'), type: 'termination', disposition: 'QUOTA_FULL' },
        { id: fn('bail'), type: 'termination', disposition: 'SCREENOUT' },
      ],
    );
    const graph = buildFlowGraph(survey);
    expect(graph.successors.get('fn_api')).toEqual(['fn_gate', 'fn_bail']);
    expect(graph.successors.get('fn_gate')).toEqual(['fn_ok', 'fn_full']);
    // Depth-first from the first declared edge: on_success before on_error, on_pass before
    // on_full. Only `pg_p2` is never laid out, which is a content-level concern, not flow's.
    expect(graph.order).toEqual([
      'fn_start',
      'fn_api',
      'fn_gate',
      'fn_ok',
      'fn_full',
      'fn_bail',
    ]);
    expect(codes(graph.diagnostics)).toEqual([]);
  });
});

describe('a loop back-edge', () => {
  it('converges and keeps the loop header dominated by its entry, not by its body', () => {
    const survey = makeSurvey(
      [block('b1', [page('p1'), page('p2')])],
      [
        { id: fn('start'), type: 'start', next: fn('head') },
        { id: fn('head'), type: 'sequence', target_id: pgId('p1'), next: fn('body') },
        { id: fn('body'), type: 'sequence', target_id: pgId('p2'), next: fn('again') },
        {
          id: fn('again'),
          type: 'branch',
          branches: [
            { condition: TRUE, next: fn('head') },
            { condition: null, next: fn('end') },
          ],
        },
        { id: fn('end'), type: 'end', disposition: 'COMPLETE' },
      ],
    );
    const graph = buildFlowGraph(survey);
    expect(graph.diagnostics).toEqual([]);
    expect(graph.order).toEqual(['fn_start', 'fn_head', 'fn_body', 'fn_again', 'fn_end']);
    expect([...graph.idom]).toEqual([
      ['fn_start', 'fn_start'],
      ['fn_head', 'fn_start'],
      ['fn_body', 'fn_head'],
      ['fn_again', 'fn_body'],
      ['fn_end', 'fn_again'],
    ]);
    expectDominanceAgreesWithPaths(graph);
  });

  it('handles a self-loop without spinning', () => {
    const survey = makeSurvey(
      [block('b1', [page('p1')])],
      [
        { id: fn('start'), type: 'start', next: fn('self') },
        {
          id: fn('self'),
          type: 'branch',
          branches: [
            { condition: TRUE, next: fn('self') },
            { condition: null, next: fn('end') },
          ],
        },
        { id: fn('end'), type: 'end', disposition: 'COMPLETE' },
      ],
    );
    const graph = buildFlowGraph(survey);
    expect(graph.idom.get('fn_self')).toBe('fn_start');
    expect(graph.idom.get('fn_end')).toBe('fn_self');
    expectDominanceAgreesWithPaths(graph);
  });

  it('keeps an irreducible graph (two entries into a cycle) dominated by the branch', () => {
    const survey = makeSurvey(
      [block('b1', [page('p1'), page('p2')])],
      [
        { id: fn('start'), type: 'start', next: fn('branch') },
        {
          id: fn('branch'),
          type: 'branch',
          branches: [
            { condition: TRUE, next: fn('a') },
            { condition: null, next: fn('b') },
          ],
        },
        { id: fn('a'), type: 'sequence', target_id: pgId('p1'), next: fn('b') },
        { id: fn('b'), type: 'sequence', target_id: pgId('p2'), next: fn('a') },
      ],
    );
    const graph = buildFlowGraph(survey);
    expect(graph.idom.get('fn_a')).toBe('fn_branch');
    expect(graph.idom.get('fn_b')).toBe('fn_branch');
    expectDominanceAgreesWithPaths(graph);
  });
});

/* -------------------------------------------------------------------------- */
/* Wellformedness                                                             */
/* -------------------------------------------------------------------------- */

describe('start node wellformedness', () => {
  it('reports CMP-0001 and returns an empty reachable set rather than throwing', () => {
    const survey = makeSurvey(
      [block('b1', [page('p1')])],
      [
        { id: fn('seq'), type: 'sequence', target_id: blkId('b1'), next: fn('end') },
        { id: fn('end'), type: 'end', disposition: 'COMPLETE' },
      ],
    );
    const graph = buildFlowGraph(survey);
    expect(codes(graph.diagnostics)).toEqual(['CMP-0001']);
    expect(graph.diagnostics[0]?.detail).toEqual({ node_count: 2 });
    expect(graph.diagnostics[0]?.path).toBe('/flow/nodes');
    expect(graph.start).toBe('');
    expect([...graph.reachable]).toEqual([]);
    expect(graph.order).toEqual([]);
    expect([...graph.position]).toEqual([]);
    expect([...graph.idom]).toEqual([]);
    expect(graph.pageOrder).toEqual([]);
    // The edges are still indexed: the author gets the graph they wrote, minus an entry point.
    expect(graph.nodes.size).toBe(2);
    expect(graph.successors.get('fn_seq')).toEqual(['fn_end']);
  });

  it('does not add an unreachability error per node when there is no start', () => {
    const survey = makeSurvey(
      [block('b1', [page('p1')])],
      [{ id: fn('end'), type: 'end', disposition: 'COMPLETE' }],
    );
    expect(codes(buildFlowGraph(survey).diagnostics)).toEqual(['CMP-0001']);
  });

  it('reports CMP-0002 naming every start node, and proceeds from the first', () => {
    const survey = makeSurvey(
      [block('b1', [page('p1')])],
      [
        { id: fn('s1'), type: 'start', next: fn('seq') },
        { id: fn('s2'), type: 'start', next: fn('seq') },
        { id: fn('seq'), type: 'sequence', target_id: blkId('b1'), next: null },
      ],
    );
    const graph = buildFlowGraph(survey);
    expect(codes(graph.diagnostics)).toEqual(['CMP-0002', 'LGC-U001']);
    expect(only(graph.diagnostics, 'CMP-0002')[0]?.detail).toEqual({
      flow_node_ids: ['fn_s1', 'fn_s2'],
    });
    expect(graph.start).toBe('fn_s1');
    // The second start is itself unreachable from the first, and says so.
    expect(only(graph.diagnostics, 'LGC-U001')[0]?.detail).toEqual({
      flow_node_id: 'fn_s2',
      node_type: 'start',
    });
    expect(graph.order).toEqual(['fn_s1', 'fn_seq']);
  });
});

describe('edges', () => {
  it('reports CMP-0005 naming the node and the offending edge', () => {
    const survey = makeSurvey(
      [block('b1', [page('p1')])],
      [
        { id: fn('start'), type: 'start', next: fn('branch') },
        {
          id: fn('branch'),
          type: 'branch',
          branches: [
            { condition: TRUE, next: fn('ghost') },
            { condition: null, next: fn('seq') },
          ],
        },
        { id: fn('seq'), type: 'sequence', target_id: blkId('b1'), next: null },
      ],
    );
    const graph = buildFlowGraph(survey);
    expect(codes(graph.diagnostics)).toEqual(['CMP-0005']);
    expect(graph.diagnostics[0]?.detail).toEqual({
      flow_node_id: 'fn_branch',
      node_type: 'branch',
      edge: 'branches.0.next',
      target_id: 'fn_ghost',
    });
    expect(graph.diagnostics[0]?.path).toBe('/flow/nodes/1/branches/0/next');
    // The dangling edge is dropped, not guessed at: the rest of the graph still resolves.
    expect(graph.successors.get('fn_branch')).toEqual(['fn_seq']);
    expect(graph.order).toEqual(['fn_start', 'fn_branch', 'fn_seq']);
  });

  it('names on_error and on_full when those are the dangling edges', () => {
    const survey = makeSurvey(
      [block('b1', [page('p1')])],
      [
        { id: fn('start'), type: 'start', next: fn('gate') },
        { id: fn('gate'), type: 'quota_gate', quota_ref: 'q', on_pass: null, on_full: fn('x') },
        { id: fn('api'), type: 'api_call', on_success: null, on_error: fn('y') },
      ],
    );
    const graph = buildFlowGraph(survey);
    // Sorted by path, so the earlier node's edge comes first regardless of which field it was.
    expect(only(graph.diagnostics, 'CMP-0005').map((d) => d.detail?.['edge'])).toEqual([
      'on_full',
      'on_error',
    ]);
  });

  it('treats a null edge as a legal terminal', () => {
    const survey = makeSurvey(
      [block('b1', [page('p1')])],
      [
        { id: fn('start'), type: 'start', next: fn('seq') },
        { id: fn('seq'), type: 'sequence', target_id: blkId('b1'), next: null },
      ],
    );
    expect(buildFlowGraph(survey).diagnostics).toEqual([]);
  });
});

interface BranchArm {
  readonly condition: Expr | null;
  readonly next: FlowNodeId | null;
}

describe('branch wellformedness', () => {
  const withBranches = (branches: readonly BranchArm[]): Survey =>
    makeSurvey(
      [block('b1', [page('p1')])],
      [
        { id: fn('start'), type: 'start', next: fn('branch') },
        { id: fn('branch'), type: 'branch', branches },
        { id: fn('seq'), type: 'sequence', target_id: blkId('b1'), next: null },
      ],
    );

  it('reports CMP-0003 when the else arm is not last', () => {
    const graph = buildFlowGraph(
      withBranches([
        { condition: null, next: fn('seq') },
        { condition: TRUE, next: fn('seq') },
      ]),
    );
    expect(only(graph.diagnostics, 'CMP-0003')[0]?.detail).toEqual({
      flow_node_id: 'fn_branch',
      reason: 'else_arm_not_last',
      arm_count: 2,
      else_index: 0,
    });
    expect(only(graph.diagnostics, 'CMP-0003')[0]?.path).toBe('/flow/nodes/1/branches');
  });

  it('reports CMP-0003 when there is no else arm', () => {
    const graph = buildFlowGraph(withBranches([{ condition: TRUE, next: fn('seq') }]));
    expect(only(graph.diagnostics, 'CMP-0003')[0]?.detail).toEqual({
      flow_node_id: 'fn_branch',
      reason: 'no_else_arm',
      arm_count: 1,
      else_indexes: [],
    });
  });

  it('reports CMP-0003 when there are two else arms', () => {
    const graph = buildFlowGraph(
      withBranches([
        { condition: null, next: fn('seq') },
        { condition: null, next: fn('seq') },
      ]),
    );
    expect(only(graph.diagnostics, 'CMP-0003')[0]?.detail).toEqual({
      flow_node_id: 'fn_branch',
      reason: 'multiple_else_arms',
      arm_count: 2,
      else_indexes: [0, 1],
    });
  });

  it('reports CMP-0003 for a branch with no arms, and does not also claim a missing else', () => {
    const graph = buildFlowGraph(withBranches([]));
    expect(only(graph.diagnostics, 'CMP-0003').map((d) => d.detail?.['reason'])).toEqual([
      'no_arms',
    ]);
  });

  it('accepts a well-formed branch', () => {
    const graph = buildFlowGraph(
      withBranches([
        { condition: TRUE, next: fn('seq') },
        { condition: null, next: fn('seq') },
      ]),
    );
    expect(only(graph.diagnostics, 'CMP-0003')).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* Reachability                                                               */
/* -------------------------------------------------------------------------- */

describe('unreachable nodes', () => {
  it('reports LGC-U001 once per node, with its id and type', () => {
    const survey = makeSurvey(
      [block('b1', [page('p1'), page('orphan')])],
      [
        { id: fn('start'), type: 'start', next: fn('seq') },
        { id: fn('seq'), type: 'sequence', target_id: pgId('p1'), next: fn('end') },
        { id: fn('end'), type: 'end', disposition: 'COMPLETE' },
        // An island: reachable from each other, from nothing else.
        { id: fn('lost1'), type: 'sequence', target_id: pgId('orphan'), next: fn('lost2') },
        { id: fn('lost2'), type: 'termination', disposition: 'SCREENOUT' },
      ],
    );
    const graph = buildFlowGraph(survey);
    const unreachable = only(graph.diagnostics, 'LGC-U001');
    expect(unreachable.map((d) => d.detail)).toEqual([
      { flow_node_id: 'fn_lost1', node_type: 'sequence' },
      { flow_node_id: 'fn_lost2', node_type: 'termination' },
    ]);
    expect(unreachable.map((d) => d.severity)).toEqual(['error', 'error']);
    expect(unreachable.map((d) => d.path)).toEqual(['/flow/nodes/3', '/flow/nodes/4']);
    expect(graph.reachable.has('fn_lost1')).toBe(false);
    expect(graph.position.has('fn_lost1')).toBe(false);
    expect(graph.idom.has('fn_lost1')).toBe(false);
    // An unreachable sequence lays nothing out: no page entry, and no CMP-0004 piled on top.
    expect(graph.pageOrder).toEqual(['pg_p1']);
    expect(codes(graph.diagnostics)).toEqual(['LGC-U001', 'LGC-U001']);
  });

  it('does not let an unreachable predecessor weaken a dominator', () => {
    const survey = makeSurvey(
      [block('b1', [page('p1')])],
      [
        { id: fn('start'), type: 'start', next: fn('a') },
        { id: fn('a'), type: 'sequence', target_id: pgId('p1'), next: fn('b') },
        { id: fn('b'), type: 'end', disposition: 'COMPLETE' },
        { id: fn('ghost'), type: 'sequence', target_id: pgId('p1'), next: fn('b') },
      ],
    );
    const graph = buildFlowGraph(survey);
    expect(graph.predecessors.get('fn_b')).toEqual(['fn_a', 'fn_ghost']);
    expect(graph.idom.get('fn_b')).toBe('fn_a');
    expect(dominates(graph, 'fn_a', 'fn_b')).toBe(true);
    expectDominanceAgreesWithPaths(graph);
  });
});

/* -------------------------------------------------------------------------- */
/* Layout ambiguity                                                           */
/* -------------------------------------------------------------------------- */

describe('page layout', () => {
  it('keeps the first entry in flow order and reports the second as CMP-0004', () => {
    const survey = makeSurvey(
      [block('b1', [page('shared')])],
      [
        { id: fn('start'), type: 'start', next: fn('first') },
        { id: fn('first'), type: 'sequence', target_id: pgId('shared'), next: fn('second') },
        { id: fn('second'), type: 'sequence', target_id: pgId('shared'), next: null },
      ],
    );
    const graph = buildFlowGraph(survey);
    expect(graph.pageEntry.get('pg_shared')).toBe('fn_first');
    expect(graph.pageOrder).toEqual(['pg_shared']);
    // Both sites are recorded; only the entry is single-valued.
    expect(graph.contentSites.get('pg_shared')).toEqual(['fn_first', 'fn_second']);
    expect(flowNodeOfNode(graph, 'pg_shared')).toBe('fn_first');
    expect(codes(graph.diagnostics)).toEqual(['CMP-0004']);
    expect(graph.diagnostics[0]?.detail).toEqual({
      flow_node_id: 'fn_second',
      node_type: 'sequence',
      target_id: 'pg_shared',
      page_id: 'pg_shared',
      entry_flow_node_id: 'fn_first',
      reason: 'duplicate_page_entry',
    });
  });

  it('does not report a loop or a randomizer for laying the same page out twice itself', () => {
    const survey = makeSurvey(
      [block('b1', [page('p1')])],
      [
        { id: fn('start'), type: 'start', next: fn('rand') },
        {
          id: fn('rand'),
          type: 'randomizer',
          targets: [pgId('p1'), pgId('p1')],
          mode: 'shuffle',
          next: null,
        },
      ],
    );
    const graph = buildFlowGraph(survey);
    expect(graph.diagnostics).toEqual([]);
    expect(graph.pageEntry.get('pg_p1')).toBe('fn_rand');
    expect(graph.contentSites.get('pg_p1')).toEqual(['fn_rand']);
  });

  it('reports CMP-0004 for a target that resolves to no pages', () => {
    const survey = makeSurvey(
      [block('empty', []), block('b1', [page('p1')])],
      [
        { id: fn('start'), type: 'start', next: fn('seq') },
        { id: fn('seq'), type: 'sequence', target_id: blkId('empty'), next: null },
      ],
    );
    const graph = buildFlowGraph(survey);
    expect(codes(graph.diagnostics)).toEqual(['CMP-0004']);
    expect(graph.diagnostics[0]?.detail).toEqual({
      flow_node_id: 'fn_seq',
      node_type: 'sequence',
      target_id: 'blk_empty',
      reason: 'no_pages',
    });
  });

  it('reports CMP-0004 for a target that does not resolve at all', () => {
    const survey = makeSurvey(
      [block('b1', [page('p1')])],
      [
        { id: fn('start'), type: 'start', next: fn('loop') },
        { id: fn('loop'), type: 'loop', target_id: blkId('gone'), next: null },
      ],
    );
    const graph = buildFlowGraph(survey);
    expect(graph.diagnostics[0]?.detail).toEqual({
      flow_node_id: 'fn_loop',
      node_type: 'loop',
      target_id: 'blk_gone',
      reason: 'unresolved_target',
    });
    expect(graph.diagnostics[0]?.path).toBe('/flow/nodes/1/target_id');
  });

  it('reports a randomizer with no targets at the targets field', () => {
    const survey = makeSurvey(
      [block('b1', [page('p1')])],
      [
        { id: fn('start'), type: 'start', next: fn('rand') },
        { id: fn('rand'), type: 'randomizer', targets: [], mode: 'shuffle', next: null },
      ],
    );
    const graph = buildFlowGraph(survey);
    expect(codes(graph.diagnostics)).toEqual(['CMP-0004']);
    expect(graph.diagnostics[0]?.detail).toEqual({
      flow_node_id: 'fn_rand',
      node_type: 'randomizer',
      reason: 'no_targets',
    });
    expect(graph.diagnostics[0]?.path).toBe('/flow/nodes/1/targets');
  });

  it('lays out a randomizer and a loop in the order their fields declare', () => {
    const survey = makeSurvey(
      [block('b1', [page('p1'), page('p2'), page('p3')])],
      [
        { id: fn('start'), type: 'start', next: fn('rand') },
        {
          id: fn('rand'),
          type: 'randomizer',
          targets: [pgId('p2'), pgId('p1')],
          mode: 'shuffle',
          next: fn('loop'),
        },
        { id: fn('loop'), type: 'loop', target_id: pgId('p3'), next: null },
      ],
    );
    const graph = buildFlowGraph(survey);
    expect(graph.diagnostics).toEqual([]);
    expect(graph.pageOrder).toEqual(['pg_p2', 'pg_p1', 'pg_p3']);
    expect(graph.pageEntry.get('pg_p3')).toBe('fn_loop');
  });
});

/* -------------------------------------------------------------------------- */
/* Shared content indexes                                                     */
/* -------------------------------------------------------------------------- */

describe('the content indexes other passes share', () => {
  const survey = makeSurvey(
    [
      block('outer', [
        page('p1', [question('q1'), question('q2')]),
        block('inner', [page('p2', [question('q3')])]),
      ]),
    ],
    [{ id: fn('start'), type: 'start', next: null }],
  );

  it('maps every page child to its page', () => {
    expect([...pageOfQuestion(survey)]).toEqual([
      ['qst_q1', 'pg_p1'],
      ['qst_q2', 'pg_p1'],
      ['qst_q3', 'pg_p2'],
    ]);
  });

  it('gives each page its ancestor blocks, outermost first', () => {
    expect([...blockPathOf(survey)]).toEqual([
      ['pg_p1', ['blk_outer']],
      ['pg_p2', ['blk_outer', 'blk_inner']],
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/* Depth                                                                      */
/* -------------------------------------------------------------------------- */

it('walks a flow deeper than the call stack, because a tracker is deep', () => {
  const depth = 10_000;
  const nodes: FlowNode[] = [{ id: fn('start'), type: 'start', next: fn('n0') }];
  for (let i = 0; i < depth; i += 1) {
    nodes.push({
      id: fn(`n${i}`),
      type: 'api_call',
      on_success: i + 1 < depth ? fn(`n${i + 1}`) : null,
      on_error: null,
    });
  }
  const graph = buildFlowGraph(makeSurvey([], nodes));
  expect(graph.diagnostics).toEqual([]);
  expect(graph.order.length).toBe(depth + 1);
  expect(graph.position.get(`fn_n${depth - 1}`)).toBe(depth);
  expect(graph.idom.get(`fn_n${depth - 1}`)).toBe(`fn_n${depth - 2}`);
  expect(dominates(graph, 'fn_n0', `fn_n${depth - 1}`)).toBe(true);
  expect(dominates(graph, `fn_n${depth - 1}`, 'fn_n0')).toBe(false);
});

/* -------------------------------------------------------------------------- */
/* Diagnostic ordering                                                        */
/* -------------------------------------------------------------------------- */

it('returns diagnostics in the canonical compile order', () => {
  const survey = makeSurvey(
    [block('b1', [page('p1')])],
    [
      { id: fn('start'), type: 'start', next: fn('branch') },
      {
        id: fn('branch'),
        type: 'branch',
        branches: [
          { condition: null, next: fn('gone') },
          { condition: TRUE, next: fn('seq') },
        ],
      },
      { id: fn('seq'), type: 'sequence', target_id: blkId('b1'), next: null },
      { id: fn('island'), type: 'end', disposition: 'COMPLETE' },
    ],
  );
  const graph = buildFlowGraph(survey);
  expect(codes(graph.diagnostics)).toEqual(['CMP-0003', 'CMP-0005', 'LGC-U001']);
});
