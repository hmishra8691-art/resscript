/**
 * Test suite for masking (task 56), against the real schema shapes (C §15).
 *
 * Masks arrive in artifact order with no `order_key`, items are addressed by numeric `code`
 * (and by `id` for an explicit list), and `fallback.when_empty` has no default.
 */

import { describe, it, expect } from 'vitest';
import {
  applyMasking,
  type Mask,
  type MaskContext,
  type MaskItem,
} from './masking.js';

/* ---------------------------------------------------------------- *
 * Fixtures
 * ---------------------------------------------------------------- */

/** Four brands with codes 1–4, as the compiler emits them. */
const BRANDS: MaskItem[] = [
  { id: 'opt_a', code: 1, ref: 'o1', position: 1 },
  { id: 'opt_b', code: 2, ref: 'o2', position: 2 },
  { id: 'opt_c', code: 3, ref: 'o3', position: 3 },
  { id: 'opt_d', code: 4, ref: 'o4', position: 4 },
];

function mask(over: Partial<Mask> = {}): Mask {
  return {
    id: 'msk_1',
    applies_to: 'options',
    mode: 'include',
    source: { kind: 'selected_in', variable_id: 'var_q1' },
    fallback: { when_empty: 'show_all' },
    ...over,
  };
}

function ctx(vars: Record<string, unknown> = {}, over: Partial<MaskContext> = {}): MaskContext {
  return { vars, ...over };
}

const codes = (r: { items: readonly MaskItem[] }) => r.items.map(i => i.code);

/* ---------------------------------------------------------------- *
 * selected_in
 * ---------------------------------------------------------------- */

describe('selected_in', () => {
  it('include keeps the items whose code was selected', () => {
    const r = applyMasking(BRANDS, [mask()], 'options', ctx({ var_q1: [1, 3] }));
    expect(codes(r)).toEqual([1, 3]);
  });

  it('exclude drops the items whose code was selected', () => {
    const r = applyMasking(
      BRANDS,
      [mask({ mode: 'exclude' })],
      'options',
      ctx({ var_q1: [1, 3] }),
    );
    expect(codes(r)).toEqual([2, 4]);
  });

  it('accepts a single-select scalar value', () => {
    const r = applyMasking(BRANDS, [mask()], 'options', ctx({ var_q1: 2 }));
    expect(codes(r)).toEqual([2]);
  });

  it('coerces string codes from the transport', () => {
    const r = applyMasking(BRANDS, [mask()], 'options', ctx({ var_q1: ['1', '4'] }));
    expect(codes(r)).toEqual([1, 4]);
  });

  it('preserves the base item order (masking filters, it does not reorder)', () => {
    // Order is randomization's job (E §8.3), applied after masking. A mask that reordered
    // would make the shared-group order unreproducible.
    const r = applyMasking(BRANDS, [mask()], 'options', ctx({ var_q1: [4, 2, 1] }));
    expect(codes(r)).toEqual([1, 2, 4]);
  });

  it('a null source variable empties the include set', () => {
    const r = applyMasking(
      BRANDS,
      [mask({ fallback: { when_empty: 'skip_question' } })],
      'options',
      ctx({ var_q1: null }),
    );
    expect(r.skip_question).toBe(true);
  });
});

/* ---------------------------------------------------------------- *
 * not_selected_in
 * ---------------------------------------------------------------- */

describe('not_selected_in', () => {
  it('include keeps the items that were NOT selected', () => {
    // "Which of the brands you did not pick have you heard of?"
    const r = applyMasking(
      BRANDS,
      [mask({ source: { kind: 'not_selected_in', variable_id: 'var_q1' } })],
      'options',
      ctx({ var_q1: [1, 3] }),
    );
    expect(codes(r)).toEqual([2, 4]);
  });

  it('the complement is within the question item set, not the variable enum', () => {
    // A code selected in Q1 that this question does not offer must not affect the result.
    const r = applyMasking(
      BRANDS.slice(0, 2),
      [mask({ source: { kind: 'not_selected_in', variable_id: 'var_q1' } })],
      'options',
      ctx({ var_q1: [1, 99] }),
    );
    expect(codes(r)).toEqual([2]);
  });

  it('exclude over not_selected_in keeps the selected items', () => {
    const r = applyMasking(
      BRANDS,
      [mask({ mode: 'exclude', source: { kind: 'not_selected_in', variable_id: 'var_q1' } })],
      'options',
      ctx({ var_q1: [2] }),
    );
    expect(codes(r)).toEqual([2]);
  });
});

/* ---------------------------------------------------------------- *
 * explicit
 * ---------------------------------------------------------------- */

describe('explicit', () => {
  it('matches on item id, not code', () => {
    // C §15 addresses an explicit list by `item_ids`, so a hand-picked list survives a code
    // renumber. Matching on code here would silently retarget the mask.
    const r = applyMasking(
      BRANDS,
      [mask({ source: { kind: 'explicit', item_ids: ['opt_b', 'opt_d'] } })],
      'options',
      ctx(),
    );
    expect(codes(r)).toEqual([2, 4]);
  });

  it('an id that matches nothing empties the set', () => {
    const r = applyMasking(
      BRANDS,
      [
        mask({
          source: { kind: 'explicit', item_ids: ['opt_zzz'] },
          fallback: { when_empty: 'skip_question' },
        }),
      ],
      'options',
      ctx(),
    );
    expect(r.skip_question).toBe(true);
  });
});

/* ---------------------------------------------------------------- *
 * expression_per_item
 * ---------------------------------------------------------------- */

describe('expression_per_item', () => {
  it('evaluates the condition once per item with the item bound', () => {
    const seen: number[] = [];
    const r = applyMasking(
      BRANDS,
      [mask({ source: { kind: 'expression_per_item', condition: { k: 'even' } } })],
      'options',
      ctx({}, {
        evalPerItem: (_c, item) => {
          seen.push(item.code);
          return item.code % 2 === 0;
        },
      }),
    );

    expect(seen).toEqual([1, 2, 3, 4]);
    expect(codes(r)).toEqual([2, 4]);
  });

  it('treats UNKNOWN as not matching', () => {
    // Guessing would either hide or reveal an item on unknown data. Neither is defensible.
    const r = applyMasking(
      BRANDS,
      [
        mask({
          source: { kind: 'expression_per_item', condition: {} },
          fallback: { when_empty: 'skip_question' },
        }),
      ],
      'options',
      ctx({}, { evalPerItem: () => null }),
    );
    expect(r.skip_question).toBe(true);
  });

  it('does not match when no evaluator is injected', () => {
    const r = applyMasking(
      BRANDS,
      [
        mask({
          source: { kind: 'expression_per_item', condition: {} },
          fallback: { when_empty: 'show_all' },
        }),
      ],
      'options',
      ctx(),
    );
    expect(r.fallback_applied).toBe('show_all');
  });
});

/* ---------------------------------------------------------------- *
 * Axis targeting
 * ---------------------------------------------------------------- */

describe('axis targeting', () => {
  it('only applies masks whose applies_to matches the axis', () => {
    const rowMask = mask({ id: 'msk_rows', applies_to: 'rows', mode: 'exclude' });
    const r = applyMasking(BRANDS, [rowMask], 'options', ctx({ var_q1: [1, 2, 3, 4] }));

    expect(codes(r)).toEqual([1, 2, 3, 4]);
  });

  it('applies a rows mask when asked for rows', () => {
    const rowMask = mask({ id: 'msk_rows', applies_to: 'rows' });
    const r = applyMasking(BRANDS, [rowMask], 'rows', ctx({ var_q1: [2] }));

    expect(codes(r)).toEqual([2]);
  });

  it('no masks at all is a passthrough', () => {
    const r = applyMasking(BRANDS, [], 'options', ctx());
    expect(codes(r)).toEqual([1, 2, 3, 4]);
    expect(r.fallback_applied).toBeUndefined();
  });
});

/* ---------------------------------------------------------------- *
 * Successive masks
 * ---------------------------------------------------------------- */

describe('successive masks', () => {
  it('applies masks in artifact order, intersecting', () => {
    const m1 = mask({ id: 'm1', mode: 'exclude', source: { kind: 'explicit', item_ids: ['opt_d'] } });
    const m2 = mask({ id: 'm2', mode: 'exclude', source: { kind: 'explicit', item_ids: ['opt_b'] } });

    const r = applyMasking(BRANDS, [m1, m2], 'options', ctx());
    expect(codes(r)).toEqual([1, 3]);
  });

  it('does not sort — array order is the artifact order', () => {
    // Reversing the array must give the same intersection here, but the mask credited with an
    // empty result must be the first one to empty it, which is order-dependent.
    const emptying = mask({ id: 'first', source: { kind: 'explicit', item_ids: [] } });
    const later = mask({ id: 'second', mode: 'exclude', source: { kind: 'explicit', item_ids: ['opt_a'] } });

    const r = applyMasking(BRANDS, [emptying, later], 'options', ctx());
    expect(r.fallback_mask_id).toBe('first');

    const flipped = applyMasking(BRANDS, [later, emptying], 'options', ctx());
    expect(flipped.fallback_mask_id).toBe('first'); // still the emptying one, reached second
  });

  it('stops at the first mask that empties the set', () => {
    const emptying = mask({
      id: 'msk_empty',
      source: { kind: 'explicit', item_ids: [] },
      fallback: { when_empty: 'show_all' },
    });
    const later = mask({
      id: 'msk_later',
      mode: 'exclude',
      source: { kind: 'explicit', item_ids: ['opt_a'] },
    });

    const r = applyMasking(BRANDS, [emptying, later], 'options', ctx());

    // show_all reverts to the base items and the later mask is NOT re-applied: re-applying
    // would risk re-emptying, and show_all means the respondent must see something.
    expect(codes(r)).toEqual([1, 2, 3, 4]);
    expect(r.fallback_mask_id).toBe('msk_empty');
  });
});

/* ---------------------------------------------------------------- *
 * Fallbacks
 * ---------------------------------------------------------------- */

describe('fallback.when_empty', () => {
  const empties = (fb: 'skip_question' | 'show_all' | 'terminate') =>
    applyMasking(
      BRANDS,
      [mask({ source: { kind: 'selected_in', variable_id: 'var_q1' }, fallback: { when_empty: fb } })],
      'options',
      ctx({ var_q1: [] }),
    );

  it('skip_question yields no items and flags the skip', () => {
    const r = empties('skip_question');

    expect(r.items).toEqual([]);
    expect(r.skip_question).toBe(true);
    expect(r.terminate).toBeUndefined();
  });

  it('show_all reverts to the base items and emits an event', () => {
    const r = empties('show_all');

    expect(codes(r)).toEqual([1, 2, 3, 4]);
    expect(r.event).toBe('mask.fallback_show_all');
  });

  it('terminate yields no items and flags the termination', () => {
    const r = empties('terminate');

    expect(r.items).toEqual([]);
    expect(r.terminate).toBe(true);
    expect(r.skip_question).toBeUndefined();
  });

  it('names the mask that emptied the set, for the trace', () => {
    expect(empties('skip_question').fallback_mask_id).toBe('msk_1');
  });

  it('the three fallbacks are genuinely different — no safe default exists', () => {
    // show_all is wrong for a brand battery, skip_question for a screener, terminate for
    // both. This asserts the outcomes stay distinguishable.
    const a = empties('skip_question');
    const b = empties('show_all');
    const c = empties('terminate');

    expect([a.items.length, b.items.length, c.items.length]).toEqual([0, 4, 0]);
    expect([a.skip_question, b.skip_question, c.skip_question]).toEqual([
      true,
      undefined,
      undefined,
    ]);
    expect([a.terminate, b.terminate, c.terminate]).toEqual([undefined, undefined, true]);
  });
});

/* ---------------------------------------------------------------- *
 * Purity
 * ---------------------------------------------------------------- */

describe('purity', () => {
  it('does not mutate the base items', () => {
    const before = JSON.stringify(BRANDS);
    applyMasking(BRANDS, [mask()], 'options', ctx({ var_q1: [1] }));
    expect(JSON.stringify(BRANDS)).toBe(before);
  });

  it('is deterministic', () => {
    const c = ctx({ var_q1: [1, 3] });
    expect(applyMasking(BRANDS, [mask()], 'options', c)).toEqual(
      applyMasking(BRANDS, [mask()], 'options', c),
    );
  });

  it('preserves the caller item type', () => {
    // The generic parameter matters: the caller gets CompiledItem back, with its label.
    const labelled = [{ id: 'opt_a', code: 1, label: 'Alpha' }];
    const r = applyMasking(labelled, [], 'options', ctx());
    expect(r.items[0]?.label).toBe('Alpha');
  });
});
