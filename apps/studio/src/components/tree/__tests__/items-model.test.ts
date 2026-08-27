/**
 * Options: the reorder plan and the paste parser.
 *
 * The assertions to read first are the two that protect the export contract: a move body carries
 * no `code`, and reordering leaves every code where it was. Schema §5.1 calls conflating code and
 * position "a classic data disaster"; these are the tests that would fail if a later refactor
 * decided a position was a code after all.
 */

import { describe, expect, it } from 'vitest';
import {
  applyItemMoveOptimistically,
  itemMoveBody,
  nextItemCode,
  parsePastedItems,
  planItemMove,
} from '@/components/tree/items-model';
import type { ItemWire } from '@/components/tree/wire';

const ITEMS: readonly ItemWire[] = [
  { id: 'opt_1', code: 10, label: 'Alpha' },
  { id: 'opt_2', code: 20, label: 'Beta' },
  { id: 'opt_3', code: 30, label: 'Gamma' },
];

describe('planItemMove', () => {
  it('is one request with one anchor, and never carries a code', () => {
    const outcome = planItemMove(ITEMS, 'opt_1', 'opt_3');
    if (outcome.ok !== true) throw new Error('expected a plan');
    const body = itemMoveBody(outcome.plan);
    expect(body).toEqual({ after_id: 'opt_3' });
    expect(Object.keys(body)).not.toContain('code');
  });

  it('moves up as before_id', () => {
    const outcome = planItemMove(ITEMS, 'opt_3', 'opt_1');
    if (outcome.ok !== true) throw new Error('expected a plan');
    expect(itemMoveBody(outcome.plan)).toEqual({ before_id: 'opt_1' });
  });

  it('reorders without renumbering: codes travel with their labels', () => {
    const outcome = planItemMove(ITEMS, 'opt_3', 'opt_1');
    if (outcome.ok !== true) throw new Error('expected a plan');
    const next = applyItemMoveOptimistically(ITEMS, outcome.plan);
    expect(next.map((item) => item.id)).toEqual(['opt_3', 'opt_1', 'opt_2']);
    // Display order changed; the exported values did not.
    expect(next.map((item) => item.code)).toEqual([30, 10, 20]);
    expect(next.map((item) => item.label)).toEqual(['Gamma', 'Alpha', 'Beta']);
  });
});

describe('parsePastedItems', () => {
  it('takes a tab-separated code and keeps it', () => {
    const parsed = parsePastedItems('1\tAlpha\n2\tBeta', { itemKind: 'option', startCode: 40 });
    expect(parsed.items.map((item) => [item.code, item.label])).toEqual([
      [1, 'Alpha'],
      [2, 'Beta'],
    ]);
    expect(parsed.assignedCodes).toBe(0);
    expect(parsed.problems).toEqual([]);
  });

  it('assigns codes by position when the paste states none, and says how many', () => {
    const parsed = parsePastedItems('Alpha\nBeta\nGamma', { itemKind: 'option', startCode: 40 });
    expect(parsed.items.map((item) => item.code)).toEqual([40, 41, 42]);
    expect(parsed.assignedCodes).toBe(3);
    expect(parsed.items.map((item) => item.ref)).toEqual(['o40', 'o41', 'o42']);
  });

  it('does not split on commas — a brand name is not a code', () => {
    const parsed = parsePastedItems("Ben & Jerry's, Inc.", { itemKind: 'option', startCode: 1 });
    expect(parsed.items[0]).toMatchObject({ code: 1, label: "Ben & Jerry's, Inc." });
  });

  it('reports a duplicate code and a non-numeric code instead of guessing', () => {
    const parsed = parsePastedItems('5\tAlpha\n5\tBeta\nx\tGamma', {
      itemKind: 'option',
      startCode: 1,
    });
    expect(parsed.items).toHaveLength(1);
    expect(parsed.problems).toHaveLength(2);
    expect(parsed.problems[0]).toContain('twice');
    expect(parsed.problems[1]).toContain('whole-number');
  });

  it('scales to the 60-brand paste in one parse', () => {
    const text = Array.from({ length: 60 }, (_, at) => 'Brand ' + String(at + 1)).join('\n');
    const parsed = parsePastedItems(text, { itemKind: 'option', startCode: 1 });
    expect(parsed.items).toHaveLength(60);
    expect(parsed.items.at(-1)).toMatchObject({ code: 60, label: 'Brand 60' });
  });
});

describe('nextItemCode', () => {
  it('is max + 1, so a deleted option does not hand its code to a new one', () => {
    expect(nextItemCode(ITEMS)).toBe(31);
    expect(nextItemCode([])).toBe(1);
  });
});
