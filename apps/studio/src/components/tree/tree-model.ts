/**
 * The tree's pure core: the index, the flatten, and — the reason this file exists — the DROP
 * PLANNER.
 *
 * ═══ ONE DRAG, ONE WRITE ═══
 *
 * P1-03's acceptance line is "the database shows one `UPDATE` on `content.nodes` per drag", and
 * DB §4.6 earns that with a fractional `sort_key`: inserting between `a1` and `a2` yields `a1V`,
 * so a move is one column on one row. The client half of that promise is this planner. A drop
 * produces exactly ONE `MovePlan` — `{parent_id, after_id | before_id}` — and the caller issues
 * exactly one `POST /nodes/{id}/move`. There is deliberately no function here that returns a
 * *list* of moves: a re-sequence loop is the failure mode the fractional key was chosen to
 * prevent, and the way that regression arrives is a helper that makes it easy to write.
 *
 * ═══ WHY THE DROP RULE IS KIND-DRIVEN, NOT COORDINATE-DRIVEN ═══
 *
 * The usual outline-editor drop rule reads pointer geometry: top third = before, bottom third =
 * after, middle = nest. It needs `getBoundingClientRect` and it has no keyboard equivalent, so
 * the keyboard path ends up a *second* implementation of placement — two rules that disagree in
 * exactly one case, and the case is always nesting.
 *
 * Here the rule is the containment table: dropping a question on a PAGE nests it (a page can
 * contain a question), dropping a question on a QUESTION places it as that question's sibling.
 * The kinds already carry the intent, so `planDrop` and `planKeyboardMove` produce the same
 * `MovePlan` shape from the same table, and the a11y floor F §8 holds everything else to — a
 * pointer gesture must have a keyboard equivalent — is met by construction rather than by a
 * parallel code path. Direction (before vs after) comes from the two nodes' current sibling
 * order, which is data we already have, not from where in the row the pointer happened to be.
 */

import type { NodeKind, TreeRowWire } from './wire';

export interface TreeIndex {
  readonly rows: readonly TreeRowWire[];
  readonly byId: ReadonlyMap<string, TreeRowWire>;
  /** Children per parent, ordered by `sort_key`. `null` is the version root. */
  readonly childrenByParent: ReadonlyMap<string | null, readonly TreeRowWire[]>;
}

export interface FlatRow {
  readonly row: TreeRowWire;
  readonly depth: number;
  readonly hasChildren: boolean;
  readonly deleted: boolean;
}

/**
 * Who may contain whom (schema §5, DB §4.1).
 *
 * **Blocks nest** — schema §5 is explicit that "nesting is what makes looping and block-level
 * randomization composable, and it is how a 2,000-question tracker stays navigable" — and a block
 * is the only legal ROOT, which the database states as a constraint (`nodes_root_is_block`: "a
 * root page has no block to attach block-level randomization or a loop to"). A `text` node is
 * page-level instruction copy, so it sits where a question sits.
 */
export const CONTAINS: Readonly<Record<'root' | NodeKind, readonly NodeKind[]>> = {
  root: ['block'],
  block: ['block', 'page'],
  page: ['question', 'text'],
  question: [],
  text: [],
};

export function canContain(parent: NodeKind | null, child: NodeKind): boolean {
  return CONTAINS[parent ?? 'root'].includes(child);
}

export function buildIndex(rows: readonly TreeRowWire[]): TreeIndex {
  const byId = new Map<string, TreeRowWire>();
  const groups = new Map<string | null, TreeRowWire[]>();
  for (const row of rows) {
    byId.set(row.id, row);
    const key = row.parent_id;
    const bucket = groups.get(key);
    if (bucket === undefined) groups.set(key, [row]);
    else bucket.push(row);
  }
  // Order is `sort_key`, always — including right after an optimistic move, which is why
  // `applyMoveOptimistically` writes a provisional key rather than shuffling an array. One
  // source of order means the optimistic view and the refetched view cannot disagree.
  for (const bucket of groups.values()) {
    bucket.sort((a, b) => (a.sort_key < b.sort_key ? -1 : a.sort_key > b.sort_key ? 1 : 0));
  }
  return { rows, byId, childrenByParent: groups };
}

export function childrenOf(index: TreeIndex, parentId: string | null): readonly TreeRowWire[] {
  return index.childrenByParent.get(parentId) ?? [];
}

export function isDeleted(row: TreeRowWire): boolean {
  return (row.deleted_at ?? null) !== null;
}

/**
 * The visible rows, in render order.
 *
 * A deleted node's subtree is not walked even with `showDeleted`: the undo affordance restores
 * the node, and rendering its children as independently-restorable rows would offer an action
 * (`undelete` a child of a deleted parent) whose result is invisible.
 */
export function flattenVisible(
  index: TreeIndex,
  expanded: ReadonlySet<string>,
  options: { readonly showDeleted: boolean },
): readonly FlatRow[] {
  const out: FlatRow[] = [];
  const walk = (parentId: string | null, depth: number): void => {
    for (const row of childrenOf(index, parentId)) {
      const deleted = isDeleted(row);
      if (deleted && !options.showDeleted) continue;
      const children = childrenOf(index, row.id);
      out.push({ row, depth, hasChildren: children.length > 0, deleted });
      if (!deleted && expanded.has(row.id)) walk(row.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

/** Is `nodeId` inside `ancestorId`'s subtree (or the node itself)? The cycle guard. */
export function isDescendant(index: TreeIndex, ancestorId: string, nodeId: string): boolean {
  let cursor: string | null | undefined = nodeId;
  // Bounded by the row count: a cycle in the data must not become a hang in the UI.
  for (let hops = 0; cursor != null && hops <= index.byId.size; hops += 1) {
    if (cursor === ancestorId) return true;
    cursor = index.byId.get(cursor)?.parent_id ?? null;
  }
  return false;
}

/* -------------------------------------------------------------------------- */
/* The plan                                                                   */
/* -------------------------------------------------------------------------- */

export interface MovePlan {
  readonly node_id: string;
  readonly parent_id: string | null;
  readonly after_id?: string;
  readonly before_id?: string;
  /** For the undo log and the live-region announcement — never sent to the server. */
  readonly description: string;
}

export type PlanOutcome =
  | { readonly ok: true; readonly plan: MovePlan }
  | { readonly ok: false; readonly reason: string }
  /** A legal gesture that would change nothing. Not an error, and not a request either. */
  | { readonly ok: 'noop' };

/** The request body for `POST /nodes/{id}/move`. Exactly one anchor, never both (API §2.5). */
export function moveBody(plan: MovePlan): Record<string, unknown> {
  return {
    parent_id: plan.parent_id,
    ...(plan.after_id === undefined ? {} : { after_id: plan.after_id }),
    ...(plan.before_id === undefined ? {} : { before_id: plan.before_id }),
  };
}

function name(row: TreeRowWire): string {
  return row.ref ?? row.label_preview ?? row.id;
}

/** Place `drag` as the last child of `parent`, skipping `drag` itself if it is already there. */
function nestPlan(index: TreeIndex, drag: TreeRowWire, parent: TreeRowWire): PlanOutcome {
  const siblings = childrenOf(index, parent.id).filter((row) => row.id !== drag.id && !isDeleted(row));
  const last = siblings[siblings.length - 1];
  if (drag.parent_id === parent.id && childrenOf(index, parent.id).at(-1)?.id === drag.id) {
    return { ok: 'noop' };
  }
  return {
    ok: true,
    plan: {
      node_id: drag.id,
      parent_id: parent.id,
      ...(last === undefined ? {} : { after_id: last.id }),
      description:
        last === undefined
          ? `${name(drag)} moved into ${name(parent)}`
          : `${name(drag)} moved into ${name(parent)} after ${name(last)}`,
    },
  };
}

/**
 * Where a drop lands.
 *
 * Refusals are CLIENT-SIDE for the two cases the user can reach by accident — dropping a node
 * into its own subtree, and dropping a kind where it cannot live. The server refuses both too
 * (API §2.5: "rejected if it would move a node into its own subtree"), and that refusal is still
 * surfaced by the caller; checking here as well means the common mistake costs no round trip and
 * no optimistic flash of an illegal tree.
 */
export function planDrop(index: TreeIndex, dragId: string, targetId: string): PlanOutcome {
  const drag = index.byId.get(dragId);
  const target = index.byId.get(targetId);
  if (drag === undefined || target === undefined) return { ok: false, reason: 'unknown row' };
  if (dragId === targetId) return { ok: 'noop' };
  if (isDescendant(index, dragId, targetId)) {
    return { ok: false, reason: `${name(drag)} cannot be moved inside itself` };
  }
  // SAME KIND means reorder, not nest — even though a block can contain a block. Dropping a
  // block on a block is a programmer reordering their outline, essentially always; if it nested,
  // top-level blocks could not be reordered by pointer at all. Nesting a block inside another is
  // `⌥→`, or a drop onto a row already inside it (which resolves as a sibling of that row).
  if (drag.kind !== target.kind && canContain(target.kind, drag.kind)) {
    return nestPlan(index, drag, target);
  }

  const targetParentKind: NodeKind | null =
    target.parent_id === null ? null : (index.byId.get(target.parent_id)?.kind ?? null);
  if (!canContain(targetParentKind, drag.kind)) {
    return { ok: false, reason: `a ${drag.kind} cannot go there` };
  }

  const siblings = childrenOf(index, target.parent_id);
  const from = siblings.findIndex((row) => row.id === dragId);
  const to = siblings.findIndex((row) => row.id === targetId);
  // Dragging DOWN onto a row means "take the slot after it"; dragging UP, "the slot before it".
  // A drop from another parent has no direction, so it lands before the target — the row the
  // user pointed at stays where the eye left it.
  const after = from >= 0 && from < to;
  return {
    ok: true,
    plan: {
      node_id: dragId,
      parent_id: target.parent_id,
      ...(after ? { after_id: targetId } : { before_id: targetId }),
      description: `${name(drag)} moved ${after ? 'after' : 'before'} ${name(target)}`,
    },
  };
}

export type KeyboardMove = 'up' | 'down' | 'indent' | 'outdent';

/**
 * The keyboard equivalent (UI §1.3: `⌥↑`/`⌥↓` reorder within siblings, `⌥←`/`⌥→` outdent and
 * indent). Same `MovePlan`, same single request — see this file's header.
 */
export function planKeyboardMove(index: TreeIndex, nodeId: string, move: KeyboardMove): PlanOutcome {
  const drag = index.byId.get(nodeId);
  if (drag === undefined) return { ok: false, reason: 'unknown row' };
  const siblings = childrenOf(index, drag.parent_id).filter((row) => !isDeleted(row));
  const at = siblings.findIndex((row) => row.id === nodeId);

  switch (move) {
    case 'up': {
      const previous = at > 0 ? siblings[at - 1] : undefined;
      if (previous === undefined) return { ok: false, reason: `${name(drag)} is already first` };
      return {
        ok: true,
        plan: {
          node_id: nodeId,
          parent_id: drag.parent_id,
          before_id: previous.id,
          description: `${name(drag)} moved before ${name(previous)}`,
        },
      };
    }
    case 'down': {
      const next = at >= 0 ? siblings[at + 1] : undefined;
      if (next === undefined) return { ok: false, reason: `${name(drag)} is already last` };
      return {
        ok: true,
        plan: {
          node_id: nodeId,
          parent_id: drag.parent_id,
          after_id: next.id,
          description: `${name(drag)} moved after ${name(next)}`,
        },
      };
    }
    case 'indent': {
      const previous = at > 0 ? siblings[at - 1] : undefined;
      if (previous === undefined) return { ok: false, reason: 'nothing above to nest into' };
      if (!canContain(previous.kind, drag.kind)) {
        return { ok: false, reason: `a ${previous.kind} cannot contain a ${drag.kind}` };
      }
      return nestPlan(index, drag, previous);
    }
    case 'outdent': {
      const parentId = drag.parent_id;
      const parent = parentId === null ? undefined : index.byId.get(parentId);
      if (parent === undefined) return { ok: false, reason: `${name(drag)} is already at the top level` };
      const grandparent =
        parent.parent_id === null ? undefined : index.byId.get(parent.parent_id);
      const grandparentKind: NodeKind | null = grandparent === undefined ? null : grandparent.kind;
      if (!canContain(grandparentKind, drag.kind)) {
        return { ok: false, reason: `a ${drag.kind} cannot live outside a ${parent.kind}` };
      }
      return {
        ok: true,
        plan: {
          node_id: drag.id,
          parent_id: grandparent === undefined ? null : grandparent.id,
          after_id: parent.id,
          description: `${name(drag)} moved out of ${name(parent)}`,
        },
      };
    }
    default: {
      const never: never = move;
      throw new Error(`unhandled move ${String(never)}`);
    }
  }
}

export interface InsertPlan {
  readonly parent_id: string | null;
  readonly after_id?: string;
}

export type InsertOutcome =
  | { readonly ok: true; readonly plan: InsertPlan }
  | { readonly ok: false; readonly reason: string };

/**
 * Where a new node of `kind` goes, given what is selected.
 *
 * The rule is "next to what I am looking at": walk up from the selection until a node that can
 * contain `kind`, and insert after the child that was on the path — so adding a question with Q7
 * selected puts it after Q7, and adding a page with Q7 selected puts it after Q7's page. With
 * nothing selected it appends to the last legal container, and when there is none it refuses with
 * the missing step rather than silently creating an orphan.
 */
export function planInsert(
  index: TreeIndex,
  selectedId: string | null,
  kind: NodeKind,
): InsertOutcome {
  let cursor = selectedId === null ? undefined : index.byId.get(selectedId);
  let child: TreeRowWire | undefined;
  for (let hops = 0; cursor !== undefined && hops <= index.byId.size; hops += 1) {
    // Same kind means SIBLING, for `planDrop`'s reason: a block can contain a block, so without
    // this "add a block" with a block selected would build a nest instead of an outline. Nesting
    // is the explicit gesture (a drag, or `⌥→`), never the default of an insert.
    if (cursor.kind !== kind && canContain(cursor.kind, kind)) {
      const siblings = childrenOf(index, cursor.id).filter((row) => !isDeleted(row));
      const anchor = child ?? siblings[siblings.length - 1];
      return {
        ok: true,
        plan: { parent_id: cursor.id, ...(anchor === undefined ? {} : { after_id: anchor.id }) },
      };
    }
    child = cursor;
    cursor = cursor.parent_id === null ? undefined : index.byId.get(cursor.parent_id);
  }

  if (canContain(null, kind)) {
    const roots = childrenOf(index, null).filter((row) => !isDeleted(row));
    const anchor = child?.parent_id === null ? child : roots[roots.length - 1];
    return {
      ok: true,
      plan: { parent_id: null, ...(anchor === undefined ? {} : { after_id: anchor.id }) },
    };
  }

  // Nothing selected and nothing to append to: name the missing step.
  const containerKind = (Object.keys(CONTAINS) as readonly ('root' | NodeKind)[]).find(
    (parent) => parent !== 'root' && CONTAINS[parent].includes(kind),
  );
  const fallbackParents = containerKind === undefined ? [] : index.rows.filter((row) => row.kind === containerKind && !isDeleted(row));
  const last = fallbackParents[fallbackParents.length - 1];
  if (last === undefined) {
    return { ok: false, reason: `add a ${containerKind ?? 'container'} before adding a ${kind}` };
  }
  const siblings = childrenOf(index, last.id).filter((row) => !isDeleted(row));
  const anchor = siblings[siblings.length - 1];
  return {
    ok: true,
    plan: { parent_id: last.id, ...(anchor === undefined ? {} : { after_id: anchor.id }) },
  };
}

/* -------------------------------------------------------------------------- */
/* The optimistic view                                                        */
/* -------------------------------------------------------------------------- */

const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/**
 * A base-62 fractional key strictly between `a` and `b` — DB §4.6's arithmetic, client-side.
 *
 * **Provisional, and never sent to the server.** `sort_key` is the server's to compute (it holds
 * the sibling uniqueness index and the rebalancer). This exists only so the optimistic row can
 * be *ordered* between its new neighbours for the frame between the drop and the response; the
 * response's real key overwrites it. Doing it any other way means keeping a second notion of
 * order beside `sort_key`, and then the optimistic view and the refetched view can disagree.
 */
export function midpointKey(a: string, b: string | null): string {
  if (b !== null && !(a < b)) return a + 'V';
  let shared = 0;
  if (b !== null) {
    while (shared < b.length && (a[shared] ?? '0') === b[shared]) shared += 1;
    if (shared > 0) {
      const tail = b.slice(shared);
      return b.slice(0, shared) + midpointKey(a.slice(shared), tail === '' ? null : tail);
    }
  }
  const lo = a === '' ? 0 : DIGITS.indexOf(a.charAt(0));
  const hi = b === null ? DIGITS.length : DIGITS.indexOf(b.charAt(0));
  if (hi - lo > 1) return DIGITS.charAt(Math.floor((lo + hi) / 2));
  if (b !== null && b.length > 1) return b.charAt(0);
  return (a === '' ? DIGITS.charAt(0) : a.charAt(0)) + midpointKey(a.slice(1), null);
}

/**
 * The optimistic row set for a plan: new `parent_id`, provisional `sort_key`.
 *
 * The caller keeps the previous array for rollback — one snapshot per mutation, restored whole,
 * because a partial rollback of a tree is how a UI ends up showing a node in two places.
 */
export function applyMoveOptimistically(
  rows: readonly TreeRowWire[],
  plan: MovePlan,
): readonly TreeRowWire[] {
  const index = buildIndex(rows);
  const moving = index.byId.get(plan.node_id);
  if (moving === undefined) return rows;
  const siblings = childrenOf(index, plan.parent_id).filter((row) => row.id !== plan.node_id);
  let previousKey = '';
  let nextKey: string | null = null;
  if (plan.after_id !== undefined) {
    const at = siblings.findIndex((row) => row.id === plan.after_id);
    previousKey = siblings[at]?.sort_key ?? '';
    nextKey = siblings[at + 1]?.sort_key ?? null;
  } else if (plan.before_id !== undefined) {
    const at = siblings.findIndex((row) => row.id === plan.before_id);
    previousKey = at > 0 ? (siblings[at - 1]?.sort_key ?? '') : '';
    nextKey = siblings[at]?.sort_key ?? null;
  } else {
    const last = siblings[siblings.length - 1];
    previousKey = last?.sort_key ?? '';
  }
  const sortKey = midpointKey(previousKey, nextKey);
  return rows.map((row) =>
    row.id === plan.node_id ? { ...row, parent_id: plan.parent_id, sort_key: sortKey } : row,
  );
}

/** Replace one row wholesale — what a `move`/`patch` response is applied with. */
export function replaceRow(
  rows: readonly TreeRowWire[],
  id: string,
  patch: Partial<TreeRowWire>,
): readonly TreeRowWire[] {
  return rows.map((row) => (row.id === id ? { ...row, ...patch } : row));
}

/** Counters for the rail's footer — the tree's own scale, as UI §3.3 shows it. */
export function treeCounts(rows: readonly TreeRowWire[]): {
  readonly blocks: number;
  readonly pages: number;
  readonly questions: number;
  readonly rules: number;
  readonly errors: number;
  readonly warnings: number;
} {
  let blocks = 0;
  let pages = 0;
  let questions = 0;
  let rules = 0;
  let errors = 0;
  let warnings = 0;
  for (const row of rows) {
    if (isDeleted(row)) continue;
    if (row.kind === 'block') blocks += 1;
    if (row.kind === 'page') pages += 1;
    if (row.kind === 'question') questions += 1;
    rules += row.rule_summaries?.length ?? 0;
    errors += row.diagnostic_counts?.errors ?? 0;
    warnings += row.diagnostic_counts?.warnings ?? 0;
  }
  return { blocks, pages, questions, rules, errors, warnings };
}
