/**
 * `ArtifactGraph` — the flattened page graph the runtime navigates by, so that choosing the next
 * page is an array lookup rather than a scan of the survey (C §17, roadmap P1-08).
 *
 * Everything here is a projection of `FlowGraph`, which `flow.ts` already resolved: reachability,
 * traversal order, dominators and the page-entry map. Nothing is recomputed, for the reason
 * `flow.ts`' own header gives — two derivations of "does page 18 precede page 24" is how two
 * passes come to disagree about the number a diagnostic quotes.
 *
 * ## Unreachable nodes are filtered out, and that is a claim worth stating
 *
 * `nodes` carries only the flow nodes reachable from `start`, in traversal order. Three reasons,
 * in increasing order of importance:
 *
 *  - An unreachable node is already `LGC-U001`, which is an **error**, so an artifact containing
 *    one does not reach a publish. Shipping the node would be shipping bytes that only exist in a
 *    build that failed.
 *  - The runtime resolves an edge by looking a target up in `nodes`. A node present in the array
 *    but unreachable from `start` is a node the runtime can never be at, and carrying it makes
 *    "every id in `nodes` is a state a session can occupy" false — which is exactly the invariant
 *    that lets the runtime treat an unresolvable target as a bug rather than as a normal case.
 *  - Document order is meaningless (`flow.ts`: "whatever sequence the studio happened to write
 *    nodes in, and a graph edit can reorder it without changing the survey"), so the array has to
 *    be reordered into traversal order anyway. Once it is, "reachable" and "present in the
 *    traversal" are the same predicate and filtering is free.
 *
 * The consequence to be aware of: a `Survey` round-tripped out of an artifact would lose an
 * unreachable node. That is acceptable because an artifact is not an authoring document — ADR-002
 * makes the *version row* the authoring record and the artifact its compiled projection — and
 * because the node it loses is one no respondent could reach.
 *
 * `page_entry` is emitted as an object keyed by page id, so the runtime's "which flow node lays
 * this page out" is one property access. Its key order is irrelevant: every JSON file in the
 * bundle goes through `stableStringify`, which sorts keys, so two compiles of one survey produce
 * the same bytes whatever order the `Map` iterated in.
 */

import type { ArtifactGraph, FlowNode } from '@resscript/schema';

import type { FlowGraph } from '../types.js';

export function buildArtifactGraph(graph: FlowGraph): ArtifactGraph {
  const nodes: FlowNode[] = [];
  // `graph.order` is the reverse postorder from `start`, so iterating it is both the traversal
  // order and the reachability filter. Iterating `graph.nodes` and testing `reachable` would give
  // the same set in document order, which is the order this deliberately does not use.
  for (const id of graph.order) {
    const node = graph.nodes.get(id);
    if (node !== undefined) nodes.push(node);
  }

  const pageEntry: { [pageId: string]: string } = {};
  for (const [pageId, flowNodeId] of graph.pageEntry) pageEntry[pageId] = flowNodeId;

  return {
    page_order: graph.pageOrder,
    nodes,
    page_entry: pageEntry,
  };
}
