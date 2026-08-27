/**
 * What the artifact graph must get right.
 *
 * Two properties, and both need a survey where the wrong answer is visible. **Node order is
 * traversal order, not document order**, so the fixture declares the flow nodes in a shuffled
 * sequence and the test asserts the emitted order is the one a respondent walks. **Unreachable
 * nodes are absent**, so the fixture has a node nothing points at; asserting only "the reachable
 * ones are present" would pass on an emitter that filtered nothing.
 *
 * `page_entry` is asserted as a map rather than by key order, because key order in the stored bytes
 * is `stableStringify`'s and not this module's.
 */

import { describe, expect, it } from 'vitest';
import type {
  ContentNode,
  FlowNode,
  QuestionItem,
  QuestionNode,
  Survey,
} from '@resscript/schema';

import { buildFlowGraph } from '../flow.js';
import { buildSurvey, compileFixture } from './__fixtures__/artifact.js';
import { buildArtifactGraph } from './graph.js';

describe('buildArtifactGraph', () => {
  it('carries the pages a respondent can reach, in flow order', () => {
    const { artifactGraph, graph, ids } = compileFixture();

    expect(artifactGraph.page_order).toEqual(graph.pageOrder);
    expect(artifactGraph.page_order).toEqual([ids.page1, ids.page2]);
  });

  it('maps every page to the flow node that lays it out', () => {
    const { artifactGraph, graph, ids } = compileFixture();

    expect(artifactGraph.page_entry[ids.page1]).toBe(graph.pageEntry.get(ids.page1));
    expect(new Set(Object.keys(artifactGraph.page_entry))).toEqual(new Set([ids.page1, ids.page2]));
  });

  it('emits nodes in traversal order rather than in the order the document declares them', () => {
    const survey = withShuffledFlow();
    const graph = buildFlowGraph(survey);

    const artifact = buildArtifactGraph(graph);

    // The document declares end, sequence, start. The traversal is start, sequence, end.
    expect(survey.flow.nodes.map((node) => node.type)).toEqual(['end', 'sequence', 'start']);
    expect(artifact.nodes.map((node) => node.type)).toEqual(['start', 'sequence', 'end']);
    expect(artifact.nodes.map((node) => node.id)).toEqual([...graph.order]);
  });

  it('omits a flow node nothing can reach, since such an artifact never passes the gate anyway', () => {
    const survey = withOrphanFlowNode();
    const graph = buildFlowGraph(survey);

    const artifact = buildArtifactGraph(graph);

    expect(graph.nodes.size).toBe(4);
    expect(artifact.nodes).toHaveLength(3);
    expect(artifact.nodes.map((node) => node.id)).not.toContain(orphanId(survey));
    // The orphan is reported, so nothing is being silently dropped.
    expect(graph.diagnostics.map((d) => d.code)).toContain('LGC-U001');
  });

  it('is empty rather than throwing when the flow has no start node', () => {
    const { survey } = buildSurvey();
    const graph = buildFlowGraph({ ...survey, flow: { nodes: [] } });

    const artifact = buildArtifactGraph(graph);

    expect(artifact.nodes).toEqual([]);
    expect(artifact.page_order).toEqual([]);
    expect(artifact.page_entry).toEqual({});
  });
});

/* -------------------------------------------------------------------------- */
/* order_groups — E 8.3, roadmap P2-03                                        */
/* -------------------------------------------------------------------------- */

/**
 * The registry that makes shared order across a battery work at all.
 *
 * Before it, `randomize` took a group argument and every production caller passed `undefined`, so
 * a battery sharing a `group_ref` shuffled independently per question. These tests assert the
 * three properties the ordering depends on — the union across members, `code` order, and
 * reachability filtering — because each of them, done wrong, produces a shared order that is
 * internally consistent and still wrong.
 */
describe('buildArtifactGraph order_groups', () => {
  it('emits an entry for a group_ref declared on a reachable question', () => {
    const { artifactGraph, ids } = compileFixture();

    // The fixture's Q5 carries `randomize_options: { group_ref: 'brands' }` over codes 1..3.
    expect(artifactGraph.order_groups?.['brands']).toEqual({
      ref: 'brands',
      codes: [1, 2, 3],
      members: [`${ids.q5}.options`],
    });
  });

  it('omits the field entirely when no question declares a group', () => {
    const survey = withoutGroupRefs();
    const graph = buildFlowGraph(survey);

    const artifact = buildArtifactGraph(graph, survey);

    // Absent, not an empty object: an empty map would claim the survey has groups with no members.
    expect(artifact.order_groups).toBeUndefined();
  });

  it('unions the codes of every member, so one member cannot narrow the domain', () => {
    // Two questions share `brands`; the second carries a code the first does not. Seeding the
    // permutation from either member alone would drop a brand from the shared domain.
    const survey = withSharedGroup([1, 2, 3], [2, 3, 4]);
    const graph = buildFlowGraph(survey);

    const artifact = buildArtifactGraph(graph, survey);

    expect(artifact.order_groups?.['brands']?.codes).toEqual([1, 2, 3, 4]);
    expect(artifact.order_groups?.['brands']?.members).toHaveLength(2);
  });

  it('sorts codes ascending regardless of the order the members declare them', () => {
    const survey = withSharedGroup([9, 3, 7], [1, 3]);
    const graph = buildFlowGraph(survey);

    const artifact = buildArtifactGraph(graph, survey);

    // Sorted, deduped: the permutation domain must not depend on which member the compiler
    // visited first, or the artifact hash moves for a survey nobody edited.
    expect(artifact.order_groups?.['brands']?.codes).toEqual([1, 3, 7, 9]);
  });

  it('is a function of the survey alone — reversing the flow does not change the codes', () => {
    const survey = withSharedGroup([1, 2], [3]);
    const forward = buildArtifactGraph(buildFlowGraph(survey), survey);
    const reversed = { ...survey, flow: { nodes: [...survey.flow.nodes].reverse() } };
    const backward = buildArtifactGraph(buildFlowGraph(reversed), reversed);

    expect(backward.order_groups?.['brands']?.codes).toEqual(
      forward.order_groups?.['brands']?.codes,
    );
  });

  it('a member with mode:none still contributes its codes', () => {
    // Declaring the group without randomizing is how an author pins one question to the
    // battery's order. Dropping it would shrink the domain the others permute.
    const survey = withSharedGroup([1, 2], [5], { secondMode: 'none' });
    const graph = buildFlowGraph(survey);

    const artifact = buildArtifactGraph(graph, survey);

    expect(artifact.order_groups?.['brands']?.codes).toEqual([1, 2, 5]);
  });

  it('ignores a question no flow node lays out', () => {
    // An unreachable question cannot be asked, so letting it widen the domain would make every
    // reachable member permute a longer list and filter it down.
    const survey = withSharedGroup([1, 2], [8], { orphanSecondPage: true });
    const graph = buildFlowGraph(survey);

    const artifact = buildArtifactGraph(graph, survey);

    expect(artifact.order_groups?.['brands']?.codes).toEqual([1, 2]);
    expect(artifact.order_groups?.['brands']?.members).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

function withShuffledFlow(): Survey {
  const { survey } = buildSurvey();
  return { ...survey, flow: { nodes: [...survey.flow.nodes].reverse() } };
}

function withOrphanFlowNode(): Survey {
  const { survey } = buildSurvey();
  const end = survey.flow.nodes.find((node) => node.type === 'end');
  if (end === undefined) throw new Error('fixture has no end node');
  const orphan: FlowNode = {
    ...end,
    id: `${end.id.slice(0, end.id.length - 1)}Z` as typeof end.id,
  };
  return { ...survey, flow: { nodes: [...survey.flow.nodes, orphan] } };
}

function orphanId(survey: Survey): string {
  return survey.flow.nodes[survey.flow.nodes.length - 1]?.id ?? '';
}

/** The fixture survey with every `group_ref` stripped off Q5's option randomization. */
function withoutGroupRefs(): Survey {
  const { survey } = buildSurvey();
  return { ...survey, content: survey.content.map(stripGroupRefs) };
}

function stripGroupRefs(node: ContentNode): ContentNode {
  if (node.type === 'block' || node.type === 'page') {
    return { ...node, children: node.children.map(stripGroupRefs) } as ContentNode;
  }
  if (node.type !== 'question') return node;
  const { randomize_options: _dropped, ...rest } = node;
  return rest as ContentNode;
}

interface SharedGroupOpts {
  /** Randomization mode for the second member. `'none'` exercises the pinned-member case. */
  readonly secondMode?: 'shuffle' | 'none';
  /** Put the second member on a page no flow node lays out. */
  readonly orphanSecondPage?: boolean;
}

/**
 * Two questions declaring one `group_ref` over the given code lists, on two pages.
 *
 * Built by rewriting the shared fixture rather than by hand so the flow, ids and the rest of the
 * document stay exactly what every other test in this file runs against — the only variable is the
 * group membership.
 */
function withSharedGroup(
  firstCodes: readonly number[],
  secondCodes: readonly number[],
  opts: SharedGroupOpts = {},
): Survey {
  const { survey, ids } = buildSurvey();

  const optionsFor = (codes: readonly number[], prefix: string): QuestionItem[] =>
    codes.map((code, i) => ({
      id: `opt_${prefix}${String(code)}`,
      ref: `o${String(code)}`,
      code,
      label: { key: `${prefix}.o${String(code)}` },
      position: i + 1,
    })) as unknown as QuestionItem[];

  const member = (
    id: string,
    ref: string,
    codes: readonly number[],
    mode: 'shuffle' | 'none',
  ): QuestionNode =>
    ({
      id,
      type: 'question',
      ref,
      question_type: 'single_select',
      label: { key: `${ref}.label` },
      required: false,
      options: optionsFor(codes, ref.toLowerCase()),
      randomize_options: { mode, group_ref: 'brands' },
    }) as unknown as QuestionNode;

  // Page 1 keeps the first member, page 2 the second. Both pages already exist in the fixture and
  // are already laid out by its flow (one `sequence` targets the block that contains them), so
  // reachability is inherited rather than re-declared.
  const secondMember = member('qst_gm2', 'GM2', secondCodes, opts.secondMode ?? 'shuffle');

  const rewrite = (node: ContentNode): ContentNode => {
    if (node.type === 'block') {
      return { ...node, children: node.children.map(rewrite) } as ContentNode;
    }
    if (node.type !== 'page') return node;
    if (node.id === ids.page1) {
      return { ...node, children: [member('qst_gm1', 'GM1', firstCodes, 'shuffle')] } as ContentNode;
    }
    if (node.id === ids.page2) {
      // In the orphan case page 2 is emptied and the second member moves to a page outside the
      // block, which nothing in the flow targets.
      return {
        ...node,
        children: opts.orphanSecondPage === true ? [] : [secondMember],
      } as ContentNode;
    }
    return node;
  };

  const content = survey.content.map(rewrite);
  if (opts.orphanSecondPage !== true) return { ...survey, content };

  // A page in `content` that no flow node lays out: the shape an author leaves behind by removing
  // a page from the graph without deleting it from the tree. It is already `LGC-U001`-adjacent
  // (the compile reports the page as unreachable), and its brands must not widen the live
  // battery's permutation domain.
  const orphanPage = {
    id: 'pg_orphan',
    type: 'page',
    ref: 'ORPHAN',
    children: [secondMember],
  } as unknown as ContentNode;

  return { ...survey, content: [...content, orphanPage] };
}
