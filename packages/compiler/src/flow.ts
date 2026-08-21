/**
 * The flow graph: the one place the authoring `flow` (C §6) is turned into something the static
 * analyses can ask questions of — reachability, an order, dominators, and the map from flow
 * nodes to the pages they lay out (C §17, roadmap P1-08).
 *
 * WHY THIS IS ITS OWN PASS. Four later analyses (forward references, never-visible questions,
 * redirect coverage, quota gating) all need the same three facts: which flow nodes a respondent
 * can reach, in what order the compiler is entitled to say one node precedes another, and which
 * node lays out a given page. Deriving those per analysis is how two analyses come to disagree
 * about whether page 18 precedes page 24 — and the headline diagnostic of this milestone quotes
 * exactly those two numbers, so they have to come from one place. `position` here *is* that
 * number.
 *
 * WHY REVERSE POSTORDER AND NOT DOCUMENT ORDER. `Flow.nodes` is an array, so it has a document
 * order, and that order is meaningless: it is whatever sequence the studio happened to write
 * nodes in, and a graph edit can reorder it without changing the survey. The order a respondent
 * experiences is the traversal order, so `order` is a DFS reverse postorder from `start` — which
 * also happens to be the order the dominator fixpoint wants (D §8.1). Where a node has several
 * successors, `order` lists them in the sequence the node's *own fields* declare (branch arms in
 * array order, `on_pass` before `on_full`, `on_success` before `on_error`), never a hash-map
 * iteration order, because a position that moves when an unrelated id changes is a position no
 * diagnostic can quote. Getting that from a reverse postorder needs one counter-intuitive line;
 * it is commented where it happens.
 *
 * WHY COOPER–HARVEY–KENNEDY. Dominance is what makes the forward-reference check honest
 * (see the comment on `FlowGraph` in `types.ts`), so it has to be here, but it does not have to
 * be fast: a flow graph has tens of nodes even for a 2,000-question tracker, because the *pages*
 * are in `content` and only the branching is in `flow`. The iterative fixpoint over reverse
 * postorder is forty lines with no auxiliary structure and converges in two or three passes at
 * this size. Lengauer–Tarjan is asymptotically better and unreviewable; it was rejected.
 *
 * WHAT THIS MODULE REFUSES TO DO. It does not validate that flow targets resolve, that ids are
 * unique, or that a `quota_ref` names a plan — `validateStructural` in `@resscript/schema` owns
 * all of that and running it twice would double-report. It emits only what needs the *graph*:
 * wellformedness the graph shape depends on (`CMP-0001`…`CMP-0005`) and unreachability
 * (`LGC-U001`, reserved in `packages/logic`'s catalogue rather than given a parallel `CMP-` code).
 * Every walk here is iterative; a tracker's flow can nest deep enough that recursion is a stack
 * overflow in field rather than in CI.
 */

import {
  findContentNode,
  type ContentNode,
  type ContentNodeId,
  type FlowNode,
  type PageId,
  type PageNode,
  type Survey,
} from '@resscript/schema';
import { diagnostic, pointer } from '@resscript/logic';

import {
  cmpDiagnostic,
  fromLogicDiagnostic,
  sortCompileDiagnostics,
  type CompileDiagnostic,
} from './diagnostics.js';
import type { FlowGraph } from './types.js';

/* ========================================================================== */
/* 1. Edges                                                                    */
/* ========================================================================== */

/**
 * One declared out-edge, with the field it came from.
 *
 * The field path is carried rather than reconstructed because `CMP-0005` has to point at the
 * offending *edge* and not merely at the node: a branch with four arms and one dangling target
 * is otherwise a diagnostic the author has to bisect by hand.
 */
interface FlowEdge {
  readonly path: readonly (string | number)[];
  /** `null` is a legal terminal — the respondent stops here — not a missing reference. */
  readonly target: string | null;
}

function edgesOf(node: FlowNode): readonly FlowEdge[] {
  switch (node.type) {
    case 'start':
    case 'sequence':
    case 'randomizer':
    case 'loop':
      return [{ path: ['next'], target: node.next }];
    case 'branch':
      return node.branches.map((arm, i) => ({ path: ['branches', i, 'next'], target: arm.next }));
    case 'quota_gate':
      return [
        { path: ['on_pass'], target: node.on_pass },
        { path: ['on_full'], target: node.on_full },
      ];
    case 'api_call':
      return [
        { path: ['on_success'], target: node.on_success },
        { path: ['on_error'], target: node.on_error },
      ];
    case 'termination':
    case 'end':
      return [];
    default: {
      const never: never = node;
      throw new Error(`Unhandled flow node: ${JSON.stringify(never)}`);
    }
  }
}

function edgeLabel(edge: FlowEdge): string {
  return edge.path.join('.');
}

/* ========================================================================== */
/* 2. The content index                                                        */
/* ========================================================================== */

interface ContentIndex {
  readonly pages: ReadonlyMap<string, PageNode>;
  /** Question / text node id → the page that contains it. */
  readonly pageOfChild: ReadonlyMap<string, PageId>;
  /** Page id → its ancestor block ids, outermost first. */
  readonly blockPath: ReadonlyMap<string, readonly ContentNodeId[]>;
}

/**
 * Index the content tree once: pages by id, children to their page, and each page's block path.
 *
 * One pre-order walk rather than three, because all three facts want the same ancestor stack and
 * a second walk is a second chance to disagree about document order. Iterative for the reason
 * given at the top of the file — blocks nest, and a tracker nests them further than anyone
 * expects.
 */
function indexContent(survey: Survey): ContentIndex {
  const pages = new Map<string, PageNode>();
  const pageOfChild = new Map<string, PageId>();
  const blockPath = new Map<string, readonly ContentNodeId[]>();

  interface Frame {
    readonly node: ContentNode;
    readonly blocks: readonly ContentNodeId[];
  }

  // Reverse-pushed so popping yields document order.
  const stack: Frame[] = [];
  const pushAll = (children: readonly ContentNode[], blocks: readonly ContentNodeId[]): void => {
    for (let i = children.length - 1; i >= 0; i -= 1) {
      const child = children[i];
      if (child !== undefined) stack.push({ node: child, blocks });
    }
  };
  pushAll(survey.content, []);

  while (stack.length > 0) {
    const frame = stack.pop();
    if (frame === undefined) break;
    const node = frame.node;
    switch (node.type) {
      case 'block':
        pushAll(node.children, [...frame.blocks, node.id]);
        break;
      case 'page': {
        pages.set(node.id, node);
        blockPath.set(node.id, frame.blocks);
        for (const child of node.children) pageOfChild.set(child.id, node.id);
        break;
      }
      case 'question':
      case 'text':
        break;
      default: {
        const never: never = node;
        throw new Error(`Unhandled content node: ${JSON.stringify(never)}`);
      }
    }
  }

  return { pages, pageOfChild, blockPath };
}

/**
 * Question / text node id → the page that lays it out.
 *
 * Exported because the variable-site index, the never-visible check and the artifact writer all
 * need it and none of them should re-walk `content` to get it. A node that is a direct child of
 * a block rather than of a page is absent, not defaulted: it has no page, and pretending
 * otherwise would give it a flow position it does not have.
 */
export function pageOfQuestion(survey: Survey): ReadonlyMap<string, PageId> {
  return indexContent(survey).pageOfChild;
}

/** Page id → its ancestor block ids, outermost first. This is `CompiledPage.block_path`. */
export function blockPathOf(survey: Survey): ReadonlyMap<string, readonly ContentNodeId[]> {
  return indexContent(survey).blockPath;
}

/* ========================================================================== */
/* 3. Layout: what a flow node's content target actually renders                */
/* ========================================================================== */

/**
 * What one `target_id` lays out: the pages, and every content node the layout covers.
 *
 * `contents` is wider than `pages` on purpose. A flow node that lays out a page also lays out
 * that page's questions — that is where their variables get written — so the write-site lookup
 * needs question ids in `contentSites`, not just page ids.
 */
interface Layout {
  readonly pages: readonly PageId[];
  readonly contents: readonly string[];
  readonly resolved: boolean;
}

const NOTHING: Layout = { pages: [], contents: [], resolved: false };

function layoutOf(survey: Survey, index: ContentIndex, targetId: string): Layout {
  const target = findContentNode(survey.content, targetId);
  if (target === undefined) return NOTHING;

  const pageLayout = (page: PageNode): Layout => ({
    pages: [page.id],
    contents: [page.id, ...page.children.map((child) => child.id)],
    resolved: true,
  });

  switch (target.type) {
    case 'page':
      return pageLayout(target);
    case 'question':
    case 'text': {
      // A sequence may name a question; what the runtime renders is the page holding it.
      const pageId = index.pageOfChild.get(target.id);
      const page = pageId === undefined ? undefined : index.pages.get(pageId);
      if (page === undefined) return { pages: [], contents: [], resolved: true };
      return pageLayout(page);
    }
    case 'block': {
      // Every page in the subtree, in document order, plus every node the subtree contains.
      const pages: PageId[] = [];
      const contents: string[] = [target.id];
      const stack: ContentNode[] = [];
      const pushAll = (children: readonly ContentNode[]): void => {
        for (let i = children.length - 1; i >= 0; i -= 1) {
          const child = children[i];
          if (child !== undefined) stack.push(child);
        }
      };
      pushAll(target.children);
      while (stack.length > 0) {
        const node = stack.pop();
        if (node === undefined) break;
        contents.push(node.id);
        if (node.type === 'block') pushAll(node.children);
        else if (node.type === 'page') {
          pages.push(node.id);
          pushAll(node.children);
        }
      }
      return { pages, contents, resolved: true };
    }
    default: {
      const never: never = target;
      throw new Error(`Unhandled content node: ${JSON.stringify(never)}`);
    }
  }
}

/** The content targets a flow node lays out, with the field each came from. */
interface LayoutSite {
  readonly target: string;
  readonly path: readonly (string | number)[];
}

function layoutSitesOf(node: FlowNode): readonly LayoutSite[] {
  switch (node.type) {
    case 'sequence':
    case 'loop':
      return [{ target: node.target_id, path: ['target_id'] }];
    case 'randomizer':
      return node.targets.map((target, i) => ({ target, path: ['targets', i] }));
    case 'start':
    case 'branch':
    case 'quota_gate':
    case 'termination':
    case 'api_call':
    case 'end':
      return [];
    default: {
      const never: never = node;
      throw new Error(`Unhandled flow node: ${JSON.stringify(never)}`);
    }
  }
}

/* ========================================================================== */
/* 4. Dominators                                                               */
/* ========================================================================== */

/**
 * "A Simple, Fast Dominance Algorithm", Cooper, Harvey and Kennedy — the iterative fixpoint over
 * reverse postorder, with dominators held as RPO indices so `intersect` is two integer walks.
 *
 * Indices, not ids, because the whole trick is that "higher RPO index" means "deeper in the
 * dominator tree", which makes the two-pointer walk to the nearest common dominator a comparison
 * of numbers. `-1` is "no dominator computed yet"; a reachable node always acquires one, because
 * its DFS-tree parent has a smaller RPO index and is therefore already processed in the same
 * pass. Predecessors outside `position` are unreachable and are skipped: they contribute no path
 * from `start`, so letting them vote would weaken every dominator downstream of a dead edge.
 */
function computeIdom(
  order: readonly string[],
  position: ReadonlyMap<string, number>,
  predecessors: ReadonlyMap<string, readonly string[]>,
): ReadonlyMap<string, string> {
  const idom = new Map<string, string>();
  const start = order[0];
  if (start === undefined) return idom;
  idom.set(start, start);

  const doms = new Array<number>(order.length).fill(-1);
  doms[0] = 0;

  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 1; i < order.length; i += 1) {
      const node = order[i];
      if (node === undefined) continue;
      let candidate = -1;
      for (const pred of predecessors.get(node) ?? []) {
        const pi = position.get(pred);
        if (pi === undefined) continue;
        if (doms[pi] === -1) continue;
        candidate = candidate === -1 ? pi : intersect(pi, candidate, doms);
      }
      if (candidate !== -1 && candidate !== i && doms[i] !== candidate) {
        doms[i] = candidate;
        changed = true;
      }
    }
  }

  for (let i = 1; i < order.length; i += 1) {
    const node = order[i];
    if (node === undefined) continue;
    const d = doms[i];
    const dominator = d === undefined || d === -1 ? undefined : order[d];
    // The fallback is sound rather than convenient: `start` dominates every reachable node.
    idom.set(node, dominator ?? start);
  }
  return idom;
}

/** The nearest common dominator of two RPO indices, walking both up until they meet. */
function intersect(a: number, b: number, doms: readonly number[]): number {
  let x = a;
  let y = b;
  while (x !== y) {
    while (x > y) {
      const up = doms[x];
      // A chain that does not descend to index 0 means a malformed graph, not a deeper
      // dominator; `start` is the only honest answer.
      if (up === undefined || up === -1 || up === x) return 0;
      x = up;
    }
    while (y > x) {
      const up = doms[y];
      if (up === undefined || up === -1 || up === y) return 0;
      y = up;
    }
  }
  return x;
}

/* ========================================================================== */
/* 5. The build                                                                */
/* ========================================================================== */

/**
 * Resolve `survey.flow` into a `FlowGraph`.
 *
 * Total: it always returns a graph. A survey with no start node returns an empty `reachable` and
 * a `start` of `''` rather than throwing, because the caller's contract is to collect
 * diagnostics from every pass and report them together — a pass that throws turns "your flow has
 * no start node" into a 500.
 */
export function buildFlowGraph(survey: Survey): FlowGraph {
  const diagnostics: CompileDiagnostic[] = [];
  const declared = survey.flow.nodes;

  // First declaration of an id wins. Duplicate ids are `validateStructural`'s diagnostic, not
  // ours; what matters here is that the graph is built from one of them deterministically.
  const nodes = new Map<string, FlowNode>();
  const docIndex = new Map<string, number>();
  for (let i = 0; i < declared.length; i += 1) {
    const node = declared[i];
    if (node === undefined) continue;
    if (nodes.has(node.id)) continue;
    nodes.set(node.id, node);
    docIndex.set(node.id, i);
  }

  const successors = new Map<string, readonly string[]>();
  const predecessors = new Map<string, string[]>();
  for (const id of nodes.keys()) predecessors.set(id, []);

  for (const [id, node] of nodes) {
    const at = docIndex.get(id) ?? 0;
    const out: string[] = [];
    for (const edge of edgesOf(node)) {
      if (edge.target === null) continue;
      if (!nodes.has(edge.target)) {
        diagnostics.push(
          cmpDiagnostic(
            'CMP-0005',
            `flow node ${id} points ${edgeLabel(edge)} at ${edge.target}, which is not a flow node`,
            pointer('flow', 'nodes', at, ...edge.path),
            {
              flow_node_id: id,
              node_type: node.type,
              edge: edgeLabel(edge),
              target_id: edge.target,
            },
          ),
        );
        continue;
      }
      // Two arms of one branch naming the same successor is one edge for every purpose here;
      // keeping the duplicate would only make `predecessors` misleading to read.
      if (out.includes(edge.target)) continue;
      out.push(edge.target);
      predecessors.get(edge.target)?.push(id);
    }
    successors.set(id, out);
  }

  for (const [id, node] of nodes) {
    if (node.type !== 'branch') continue;
    const at = docIndex.get(id) ?? 0;
    const path = pointer('flow', 'nodes', at, 'branches');
    const elseArms: number[] = [];
    node.branches.forEach((arm, i) => {
      if (arm.condition === null) elseArms.push(i);
    });

    if (node.branches.length === 0) {
      diagnostics.push(
        cmpDiagnostic('CMP-0003', `branch ${id} has no arms`, path, {
          flow_node_id: id,
          reason: 'no_arms',
          arm_count: 0,
        }),
      );
      continue;
    }
    if (elseArms.length !== 1) {
      diagnostics.push(
        cmpDiagnostic(
          'CMP-0003',
          `branch ${id} has ${elseArms.length} else arms, expected exactly one`,
          path,
          {
            flow_node_id: id,
            reason: elseArms.length === 0 ? 'no_else_arm' : 'multiple_else_arms',
            arm_count: node.branches.length,
            else_indexes: elseArms,
          },
        ),
      );
      continue;
    }
    const elseIndex = elseArms[0] ?? 0;
    if (elseIndex !== node.branches.length - 1) {
      diagnostics.push(
        cmpDiagnostic('CMP-0003', `branch ${id} has its else arm at ${elseIndex}, not last`, path, {
          flow_node_id: id,
          reason: 'else_arm_not_last',
          arm_count: node.branches.length,
          else_index: elseIndex,
        }),
      );
    }
  }

  const startNodes = [...nodes.values()].filter((node) => node.type === 'start');
  const first = startNodes[0];

  if (first === undefined) {
    diagnostics.push(
      cmpDiagnostic('CMP-0001', 'the flow declares no start node', pointer('flow', 'nodes'), {
        node_count: nodes.size,
      }),
    );
    // Deliberately no `LGC-U001` storm here: with no start, *every* node is unreachable, and a
    // hundred unreachability errors would bury the one diagnostic that explains them.
    return {
      nodes,
      start: '',
      order: [],
      position: new Map(),
      successors,
      predecessors,
      reachable: new Set(),
      idom: new Map(),
      pageEntry: new Map(),
      pageOrder: [],
      contentSites: new Map(),
      diagnostics: sortCompileDiagnostics(diagnostics),
    };
  }

  if (startNodes.length > 1) {
    diagnostics.push(
      cmpDiagnostic(
        'CMP-0002',
        `the flow declares ${startNodes.length} start nodes`,
        pointer('flow', 'nodes'),
        { flow_node_ids: startNodes.map((node) => node.id) },
      ),
    );
    // Carry on from the first in document order. The compile fails on the error either way, and
    // an author fixing a duplicated start would rather see the rest of their flow's diagnostics
    // in the same run than one at a time.
  }

  const start = first.id;

  /* --- reachability and reverse postorder, one iterative DFS ------------- */

  // The descent takes the LAST declared successor first, which is what makes the *reverse*
  // postorder come out in declared order: a postorder pushes a subtree before its later
  // siblings, so reversing it puts later siblings first. Descending in declared order would
  // give a reverse postorder in which the else arm precedes the first arm — technically a
  // valid RPO, and a `pageOrder` that lists a branch's arms backwards from the document. This
  // is the one place the tie-break between successors is decided, and it is decided in favour
  // of the document, per §5 of the milestone brief.
  const visited = new Set<string>([start]);
  const postorder: string[] = [];
  const frames: { readonly id: string; cursor: number }[] = [{ id: start, cursor: 0 }];
  while (frames.length > 0) {
    const frame = frames[frames.length - 1];
    if (frame === undefined) break;
    const out = successors.get(frame.id) ?? [];
    if (frame.cursor < out.length) {
      const next = out[out.length - 1 - frame.cursor];
      frame.cursor += 1;
      if (next !== undefined && !visited.has(next)) {
        visited.add(next);
        frames.push({ id: next, cursor: 0 });
      }
      continue;
    }
    postorder.push(frame.id);
    frames.pop();
  }
  const order: readonly string[] = [...postorder].reverse();
  // Same membership as the DFS's visited set, but iterating in flow order rather than in
  // discovery order — a `for (const id of graph.reachable)` in a later pass should not read
  // backwards.
  const reachable = new Set<string>(order);

  const position = new Map<string, number>();
  order.forEach((id, i) => position.set(id, i));

  const idom = computeIdom(order, position, predecessors);

  /* --- page layout ------------------------------------------------------- */

  const index = indexContent(survey);
  const pageEntry = new Map<string, string>();
  const pageOrder: PageId[] = [];
  const contentSites = new Map<string, string[]>();

  const site = (contentId: string, flowNodeId: string): void => {
    const existing = contentSites.get(contentId);
    if (existing === undefined) contentSites.set(contentId, [flowNodeId]);
    else if (!existing.includes(flowNodeId)) existing.push(flowNodeId);
  };

  // Traversal order, not document order: `pageOrder` is what a respondent sees.
  for (const id of order) {
    const node = nodes.get(id);
    if (node === undefined) continue;
    const at = docIndex.get(id) ?? 0;

    if (node.type === 'randomizer' && node.targets.length === 0) {
      diagnostics.push(
        cmpDiagnostic(
          'CMP-0004',
          `randomizer ${id} has no targets, so it lays out no pages`,
          pointer('flow', 'nodes', at, 'targets'),
          { flow_node_id: id, node_type: node.type, reason: 'no_targets' },
        ),
      );
    }

    for (const layoutSite of layoutSitesOf(node)) {
      const layout = layoutOf(survey, index, layoutSite.target);
      if (layout.pages.length === 0) {
        diagnostics.push(
          cmpDiagnostic(
            'CMP-0004',
            `flow node ${id} targets ${layoutSite.target}, which lays out no pages`,
            pointer('flow', 'nodes', at, ...layoutSite.path),
            {
              flow_node_id: id,
              node_type: node.type,
              target_id: layoutSite.target,
              reason: layout.resolved ? 'no_pages' : 'unresolved_target',
            },
          ),
        );
        continue;
      }
      for (const contentId of layout.contents) site(contentId, id);
      for (const pageId of layout.pages) {
        const owner = pageEntry.get(pageId);
        if (owner === undefined) {
          pageEntry.set(pageId, id);
          pageOrder.push(pageId);
          continue;
        }
        // The same flow node laying a page out twice is a loop or an overlapping randomizer,
        // both legitimate. Two *different* flow nodes is an ambiguity: nothing downstream can
        // say where the page's questions are answered, so the second one is an error and the
        // first — first in flow order — keeps the entry.
        if (owner === id) continue;
        diagnostics.push(
          cmpDiagnostic(
            'CMP-0004',
            `page ${pageId} is already laid out by flow node ${owner}`,
            pointer('flow', 'nodes', at, ...layoutSite.path),
            {
              flow_node_id: id,
              node_type: node.type,
              target_id: layoutSite.target,
              page_id: pageId,
              entry_flow_node_id: owner,
              reason: 'duplicate_page_entry',
            },
          ),
        );
      }
    }
  }

  /* --- unreachability ---------------------------------------------------- */

  for (const [id, node] of nodes) {
    if (reachable.has(id)) continue;
    diagnostics.push(
      fromLogicDiagnostic(
        diagnostic(
          'LGC-U001',
          `flow node ${id} (${node.type}) is not reachable from start`,
          pointer('flow', 'nodes', docIndex.get(id) ?? 0),
          { flow_node_id: id, node_type: node.type },
        ),
      ),
    );
  }

  return {
    nodes,
    start,
    order,
    position,
    successors,
    predecessors,
    reachable,
    idom,
    pageEntry,
    pageOrder,
    contentSites,
    diagnostics: sortCompileDiagnostics(diagnostics),
  };
}

/**
 * The flow node that lays out a content node, or `undefined` if none does.
 *
 * The *first* site in flow order, which for a page is by construction its `pageEntry`. A content
 * node with two sites is either legal (a block) or already reported (`CMP-0004`), so a caller
 * that needs one answer gets the earliest rather than an arbitrary one.
 */
export function flowNodeOfNode(graph: FlowGraph, contentNodeId: string): string | undefined {
  return graph.contentSites.get(contentNodeId)?.[0];
}
