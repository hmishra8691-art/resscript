/**
 * The planner — the file the "one UPDATE per drag" acceptance line actually rests on.
 *
 * Every test here is about a REQUEST SHAPE rather than about a rendered tree: a drop produces one
 * plan with one anchor, the keyboard produces the same plan the equivalent drag does, and the two
 * illegal gestures are refused before a request exists. Rendering is `SurveyTreePane.test.tsx`'s
 * problem; if these are right, that one only has to prove the wiring.
 */

import { describe, expect, it } from 'vitest';
import {
  applyMoveOptimistically,
  buildIndex,
  canContain,
  flattenVisible,
  isDescendant,
  midpointKey,
  moveBody,
  planDrop,
  planInsert,
  planKeyboardMove,
  treeCounts,
} from '@/components/tree/tree-model';
import type { NodeKind, TreeRowWire } from '@/components/tree/wire';

function row(
  id: string,
  kind: NodeKind,
  parentId: string | null,
  sortKey: string,
  extra: Partial<TreeRowWire> = {},
): TreeRowWire {
  return { id, kind, parent_id: parentId, sort_key: sortKey, ref: id.toUpperCase(), ...extra };
}

/** B1 → P1 → (Q1, Q2, Q3); B2 → P2 → (Q4). */
const ROWS: readonly TreeRowWire[] = [
  row('b1', 'block', null, 'a0'),
  row('p1', 'page', 'b1', 'a0'),
  row('q1', 'question', 'p1', 'a0'),
  row('q2', 'question', 'p1', 'a1'),
  row('q3', 'question', 'p1', 'a2'),
  row('b2', 'block', null, 'a1'),
  row('p2', 'page', 'b2', 'a0'),
  row('q4', 'question', 'p2', 'a0'),
];

const index = buildIndex(ROWS);

describe('containment', () => {
  it('is the only rule placement consults', () => {
    expect(canContain(null, 'block')).toBe(true);
    expect(canContain('block', 'page')).toBe(true);
    // Blocks nest (schema §5); a page never roots (DB's `nodes_root_is_block`).
    expect(canContain('block', 'block')).toBe(true);
    expect(canContain(null, 'page')).toBe(false);
    expect(canContain('page', 'question')).toBe(true);
    expect(canContain('page', 'text')).toBe(true);
    expect(canContain('question', 'question')).toBe(false);
    expect(canContain(null, 'question')).toBe(false);
  });
});

describe('planDrop', () => {
  it('drops onto a sibling as one plan with exactly one anchor', () => {
    const outcome = planDrop(index, 'q1', 'q3');
    expect(outcome.ok).toBe(true);
    if (outcome.ok !== true) return;
    expect(outcome.plan).toMatchObject({ node_id: 'q1', parent_id: 'p1', after_id: 'q3' });
    expect(outcome.plan.before_id).toBeUndefined();
    expect(moveBody(outcome.plan)).toEqual({ parent_id: 'p1', after_id: 'q3' });
  });

  it('drags UPWARD as before_id, so the row lands where the eye left it', () => {
    const outcome = planDrop(index, 'q3', 'q1');
    if (outcome.ok !== true) throw new Error('expected a plan');
    expect(moveBody(outcome.plan)).toEqual({ parent_id: 'p1', before_id: 'q1' });
  });

  it('nests when the target kind can contain the dragged kind', () => {
    const outcome = planDrop(index, 'q4', 'p1');
    if (outcome.ok !== true) throw new Error('expected a plan');
    // Into P1, after its last child: one anchor, one request.
    expect(moveBody(outcome.plan)).toEqual({ parent_id: 'p1', after_id: 'q3' });
  });

  it('refuses a drop into the dragged node’s own subtree, client-side', () => {
    expect(isDescendant(index, 'b1', 'q2')).toBe(true);
    const outcome = planDrop(index, 'b1', 'q2');
    expect(outcome.ok).toBe(false);
    if (outcome.ok !== false) return;
    expect(outcome.reason).toContain('inside itself');
  });

  it('refuses a kind that cannot live there', () => {
    // A block onto a question: the question cannot contain it and its parent (a page) cannot
    // either.
    expect(planDrop(index, 'b1', 'q4').ok).toBe(false);
  });

  it('reorders same-kind rows rather than nesting them, even where nesting is legal', () => {
    // A block CAN contain a block, so this is the case that would silently swallow B2.
    const outcome = planDrop(index, 'b2', 'b1');
    if (outcome.ok !== true) throw new Error('expected a plan');
    expect(moveBody(outcome.plan)).toEqual({ parent_id: null, before_id: 'b1' });
  });

  it('nests a block by dropping it onto a row already inside another block', () => {
    const outcome = planDrop(index, 'b2', 'p1');
    if (outcome.ok !== true) throw new Error('expected a plan');
    expect(moveBody(outcome.plan)).toEqual({ parent_id: 'b1', before_id: 'p1' });
  });

  it('treats a drop on itself as a no-op rather than a request', () => {
    expect(planDrop(index, 'q1', 'q1')).toEqual({ ok: 'noop' });
  });
});

describe('planKeyboardMove', () => {
  it('produces the SAME plan as the equivalent drag', () => {
    const dragged = planDrop(index, 'q1', 'q2');
    const typed = planKeyboardMove(index, 'q1', 'down');
    if (dragged.ok !== true || typed.ok !== true) throw new Error('expected two plans');
    expect(moveBody(typed.plan)).toEqual(moveBody(dragged.plan));
  });

  it('moves up as before_id and refuses at the ends', () => {
    const up = planKeyboardMove(index, 'q2', 'up');
    if (up.ok !== true) throw new Error('expected a plan');
    expect(moveBody(up.plan)).toEqual({ parent_id: 'p1', before_id: 'q1' });
    expect(planKeyboardMove(index, 'q1', 'up').ok).toBe(false);
    expect(planKeyboardMove(index, 'q3', 'down').ok).toBe(false);
  });

  it('indents a block into the block above it — one plan, one anchor', () => {
    const indent = planKeyboardMove(index, 'b2', 'indent');
    if (indent.ok !== true) throw new Error('expected a plan');
    // Into B1, after its last child: `parent_id` plus one anchor, never a re-sequence.
    expect(moveBody(indent.plan)).toEqual({ parent_id: 'b1', after_id: 'p1' });
  });

  it('outdents to the grandparent, and refuses the moves the schema forbids', () => {
    const nested = buildIndex([...ROWS, row('b3', 'block', 'b1', 'a1')]);
    const outdent = planKeyboardMove(nested, 'b3', 'outdent');
    if (outdent.ok !== true) throw new Error('expected a plan');
    expect(moveBody(outdent.plan)).toEqual({ parent_id: null, after_id: 'b1' });

    // A question cannot live in a block, and a page cannot root (DB's `nodes_root_is_block`),
    // so both are refused rather than silently reparented into an illegal position.
    expect(planKeyboardMove(index, 'q4', 'outdent').ok).toBe(false);
    expect(planKeyboardMove(index, 'p2', 'outdent').ok).toBe(false);
    // A page's previous sibling is a page, which cannot contain it.
    expect(planKeyboardMove(index, 'p2', 'indent').ok).toBe(false);
  });
});

describe('planInsert', () => {
  it('inserts next to what is selected', () => {
    expect(planInsert(index, 'q1', 'question')).toEqual({
      ok: true,
      plan: { parent_id: 'p1', after_id: 'q1' },
    });
    expect(planInsert(index, 'q1', 'page')).toEqual({
      ok: true,
      plan: { parent_id: 'b1', after_id: 'p1' },
    });
    expect(planInsert(index, 'q1', 'block')).toEqual({
      ok: true,
      plan: { parent_id: null, after_id: 'b1' },
    });
  });

  it('adds a same-kind node as a SIBLING, so an outline does not become a nest', () => {
    // The acceptance flow: add a block, then another. The second must not land inside the first,
    // even though a block can contain a block.
    expect(planInsert(index, 'b1', 'block')).toEqual({
      ok: true,
      plan: { parent_id: null, after_id: 'b1' },
    });
    expect(planInsert(index, 'p1', 'page')).toEqual({
      ok: true,
      plan: { parent_id: 'b1', after_id: 'p1' },
    });
  });

  it('appends to the last legal container with nothing selected', () => {
    expect(planInsert(index, null, 'question')).toEqual({
      ok: true,
      plan: { parent_id: 'p2', after_id: 'q4' },
    });
  });

  it('names the missing step instead of creating an orphan', () => {
    const empty = buildIndex([]);
    const outcome = planInsert(empty, null, 'question');
    expect(outcome.ok).toBe(false);
    if (outcome.ok !== false) return;
    expect(outcome.reason).toContain('page');
  });
});

describe('the optimistic view', () => {
  it('orders the moved row between its new neighbours', () => {
    const outcome = planKeyboardMove(index, 'q3', 'up');
    if (outcome.ok !== true) throw new Error('expected a plan');
    const next = applyMoveOptimistically(ROWS, outcome.plan);
    const order = buildIndex(next)
      .childrenByParent.get('p1')
      ?.map((entry) => entry.id);
    expect(order).toEqual(['q1', 'q3', 'q2']);
  });

  it('reparents optimistically, so a nest is visible before the response', () => {
    const outcome = planDrop(index, 'q4', 'p1');
    if (outcome.ok !== true) throw new Error('expected a plan');
    const next = applyMoveOptimistically(ROWS, outcome.plan);
    const order = buildIndex(next)
      .childrenByParent.get('p1')
      ?.map((entry) => entry.id);
    expect(order).toEqual(['q1', 'q2', 'q3', 'q4']);
  });

  it('midpointKey lands strictly between, including in the adjacent-digit case', () => {
    expect(midpointKey('a1', 'a2') > 'a1').toBe(true);
    expect(midpointKey('a1', 'a2') < 'a2').toBe(true);
    expect(midpointKey('', 'a0') < 'a0').toBe(true);
    expect(midpointKey('zz', null) > 'zz').toBe(true);
    let low = 'a0';
    // Repeated insert-at-the-same-point is the pathological case DB §4.6 names; it must stay
    // ordered rather than collide.
    for (let i = 0; i < 20; i += 1) {
      const mid = midpointKey(low, 'a1');
      expect(mid > low && mid < 'a1').toBe(true);
      low = mid;
    }
  });
});

describe('flattenVisible', () => {
  it('walks only expanded containers and hides deleted rows by default', () => {
    const withDeleted = buildIndex([
      ...ROWS,
      row('q5', 'question', 'p1', 'a3', { deleted_at: '2026-08-01T00:00:00Z' }),
    ]);
    const collapsed = flattenVisible(withDeleted, new Set(), { showDeleted: false });
    expect(collapsed.map((entry) => entry.row.id)).toEqual(['b1', 'b2']);

    const expanded = flattenVisible(withDeleted, new Set(['b1', 'p1']), { showDeleted: false });
    expect(expanded.map((entry) => entry.row.id)).toEqual(['b1', 'p1', 'q1', 'q2', 'q3', 'b2']);

    const shown = flattenVisible(withDeleted, new Set(['b1', 'p1']), { showDeleted: true });
    expect(shown.map((entry) => entry.row.id)).toContain('q5');
    expect(shown.find((entry) => entry.row.id === 'q5')?.deleted).toBe(true);
  });
});

describe('treeCounts', () => {
  it('counts live rows only, and sums badges', () => {
    const counts = treeCounts([
      ...ROWS,
      row('q9', 'question', 'p1', 'a9', { deleted_at: '2026-08-01T00:00:00Z' }),
      row('q8', 'question', 'p2', 'a8', {
        rule_summaries: [{ id: 'r1' }, { id: 'r2' }],
        diagnostic_counts: { errors: 1, warnings: 2 },
      }),
    ]);
    expect(counts).toEqual({ blocks: 2, pages: 2, questions: 5, rules: 2, errors: 1, warnings: 2 });
  });
});
