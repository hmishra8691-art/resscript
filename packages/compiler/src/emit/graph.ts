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

import {
  flattenContent,
  type ArtifactGraph,
  type FlowNode,
  type OrderGroupEntry,
  type QuestionItem,
  type QuestionNode,
  type RandomizationSpec,
  type Survey,
} from '@resscript/schema';

import type { FlowGraph } from '../types.js';

export function buildArtifactGraph(graph: FlowGraph, survey?: Survey): ArtifactGraph {
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

  // `survey` is optional so the emitter stays independently callable (the QA suite and this
  // package's own fixtures drive it with a hand-built FlowGraph and no document). Absent it, the
  // artifact simply carries no groups — the same shape a version-1 artifact had.
  const orderGroups = survey === undefined ? undefined : buildOrderGroups(survey, graph);

  return {
    page_order: graph.pageOrder,
    nodes,
    page_entry: pageEntry,
    ...(orderGroups === undefined || Object.keys(orderGroups).length === 0
      ? {}
      : { order_groups: orderGroups }),
  };
}

/* ========================================================================== */
/* Order groups (E §8.3, roadmap P2-03)                                        */
/* ========================================================================== */

const AXES = ['options', 'rows', 'columns'] as const;
type Axis = (typeof AXES)[number];

function axisItems(question: QuestionNode, axis: Axis): readonly QuestionItem[] | undefined {
  if (axis === 'options') return question.options ?? undefined;
  if (axis === 'rows') return question.rows ?? undefined;
  return question.columns ?? undefined;
}

function axisSpec(question: QuestionNode, axis: Axis): RandomizationSpec | undefined {
  if (axis === 'options') return question.randomize_options ?? undefined;
  if (axis === 'rows') return question.randomize_rows ?? undefined;
  return question.randomize_columns ?? undefined;
}

/**
 * Collect the canonical membership of every `group_ref` declared anywhere in the survey.
 *
 * **Only reachable questions contribute.** A question no flow node lays out cannot be asked, so
 * including its brands would let a retired question widen the permutation domain of a live
 * battery — every member would then shuffle a longer list and filter it down, producing a shared
 * order that is *consistent* but derived from items no respondent can see. Reachability is the
 * same predicate `nodes` above is filtered by, read off the same `FlowGraph`.
 *
 * Iteration is in flow order (`graph.pageOrder`), not content order, so `members` reads in the
 * order a respondent meets the battery. The `codes` list is sorted, so it does not depend on
 * iteration order at all — see `OrderGroupEntry`.
 */
function buildOrderGroups(
  survey: Survey,
  graph: FlowGraph,
): { readonly [groupRef: string]: OrderGroupEntry } {
  const questionsByPage = new Map<string, QuestionNode[]>();
  for (const node of flattenContent(survey.content)) {
    if (node.type !== 'page') continue;
    const questions = node.children.filter((child): child is QuestionNode => child.type === 'question');
    if (questions.length > 0) questionsByPage.set(node.id, questions);
  }

  const codes = new Map<string, Set<number>>();
  const members = new Map<string, string[]>();

  for (const pageId of graph.pageOrder) {
    for (const question of questionsByPage.get(pageId) ?? []) {
      for (const axis of AXES) {
        const spec = axisSpec(question, axis);
        const ref = spec?.group_ref;
        // `mode: 'none'` still contributes: a member that declares the group but is not itself
        // randomized is how an author pins one question to the battery's order without shuffling
        // it, and dropping it from the union would shrink the domain the others permute.
        if (ref === undefined || ref === null || ref === '') continue;
        const items = axisItems(question, axis);
        if (items === undefined) continue;

        let set = codes.get(ref);
        if (set === undefined) {
          set = new Set<number>();
          codes.set(ref, set);
          members.set(ref, []);
        }
        for (const item of items) set.add(item.code);
        members.get(ref)?.push(`${question.id}.${axis}`);
      }
    }
  }

  const out: { [groupRef: string]: OrderGroupEntry } = {};
  for (const [ref, set] of codes) {
    out[ref] = {
      ref,
      codes: [...set].sort((a, b) => a - b),
      members: members.get(ref) ?? [],
    };
  }
  return out;
}
