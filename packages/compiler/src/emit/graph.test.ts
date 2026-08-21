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
import type { FlowNode, Survey } from '@resscript/schema';

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
