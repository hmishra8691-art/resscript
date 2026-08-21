/**
 * Test suite for randomization (task 55), against the real schema shapes (C §12).
 *
 * The tests that carry the weight are the shared-group ones: E §8.3 exists to make a brand
 * list appear in the same order across a battery even when the questions are masked
 * differently, and the natural-looking implementation (permute each question's filtered list)
 * passes every other test here while failing exactly that.
 */

import { describe, it, expect } from 'vitest';
import {
  applyAnchors,
  randomize,
  saltFor,
  type OrderGroup,
  type RandomizationSpec,
  type RandomizeItem,
} from './randomize.js';

/* ---------------------------------------------------------------- *
 * Fixtures
 * ---------------------------------------------------------------- */

function items(n: number): RandomizeItem[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `opt_${i + 1}`,
    code: i + 1,
    ref: `o${i + 1}`,
    position: i + 1,
  }));
}

const BRANDS: RandomizeItem[] = [
  { id: 'opt_coca', code: 1, ref: 'o1' },
  { id: 'opt_pepsi', code: 2, ref: 'o2' },
  { id: 'opt_sprite', code: 3, ref: 'o3' },
  { id: 'opt_fanta', code: 4, ref: 'o4' },
  { id: 'opt_tango', code: 5, ref: 'o5' },
];

const GROUP: OrderGroup = { ref: 'brands', canonical: BRANDS };

const codes = (r: { items: readonly RandomizeItem[] }) => r.items.map(i => i.code);
const SEED = 'a3f9c1d2e4b6a8f0c2d4e6b8a0f2c4d6';

function spec(over: Partial<RandomizationSpec> = {}): RandomizationSpec {
  return { mode: 'shuffle', ...over };
}

/* ---------------------------------------------------------------- *
 * Salt derivation (E §8.2)
 * ---------------------------------------------------------------- */

describe('saltFor', () => {
  it('group_ref wins, so a battery shares a key', () => {
    expect(saltFor(spec({ group_ref: 'brands', seed_salt: 'other' }), 'qst_5.options')).toBe(
      'grp:brands',
    );
  });

  it('falls back to seed_salt', () => {
    expect(saltFor(spec({ seed_salt: 'custom' }), 'qst_5.options')).toBe('custom');
  });

  it('falls back to the axis key', () => {
    expect(saltFor(spec(), 'qst_5.options')).toBe('qst_5.options');
  });

  it('two axes of one question do not share an order by accident', () => {
    expect(saltFor(spec(), 'qst_5.rows')).not.toBe(saltFor(spec(), 'qst_5.columns'));
  });
});

/* ---------------------------------------------------------------- *
 * Determinism (ADR-006)
 * ---------------------------------------------------------------- */

describe('determinism', () => {
  it('the same seed and salt give the same order', () => {
    const a = randomize(items(12), spec(), SEED, { axis_key: 'qst_1.options' });
    const b = randomize(items(12), spec(), SEED, { axis_key: 'qst_1.options' });
    expect(codes(a)).toEqual(codes(b));
  });

  it('a different seed gives a different order', () => {
    const a = randomize(items(12), spec(), SEED, { axis_key: 'qst_1.options' });
    const b = randomize(items(12), spec(), 'f'.repeat(32), { axis_key: 'qst_1.options' });
    expect(codes(a)).not.toEqual(codes(b));
  });

  it('a different axis gives a different order under one seed', () => {
    const a = randomize(items(12), spec(), SEED, { axis_key: 'qst_1.options' });
    const b = randomize(items(12), spec(), SEED, { axis_key: 'qst_2.options' });
    expect(codes(a)).not.toEqual(codes(b));
  });

  it('the result is a permutation — nothing added, dropped or duplicated', () => {
    const r = randomize(items(12), spec(), SEED, { axis_key: 'q.options' });
    expect([...codes(r)].sort((x, y) => x - y)).toEqual(items(12).map(i => i.code));
  });

  it('does not mutate the input', () => {
    const input = items(8);
    const before = JSON.stringify(input);
    randomize(input, spec(), SEED, { axis_key: 'q.options' });
    expect(JSON.stringify(input)).toBe(before);
  });
});

/* ---------------------------------------------------------------- *
 * Shared group order (E §8.3)
 * ---------------------------------------------------------------- */

describe('shared group order', () => {
  const groupSpec = spec({ group_ref: 'brands' });

  it('two identically-masked questions get the identical order', () => {
    const q5 = randomize(BRANDS, groupSpec, SEED, { axis_key: 'qst_5.options', group: GROUP });
    const q6 = randomize(BRANDS, groupSpec, SEED, { axis_key: 'qst_6.options', group: GROUP });

    expect(codes(q5)).toEqual(codes(q6));
  });

  it('a masked question is a SUBSEQUENCE of the full group order', () => {
    // The property that matters. Q6 masked to the brands picked in Q5 must appear in the same
    // relative order as in Q5 — not merely "some deterministic order".
    const full = randomize(BRANDS, groupSpec, SEED, { axis_key: 'qst_5.options', group: GROUP });
    const masked = BRANDS.filter(b => [1, 3, 5].includes(b.code));
    const q6 = randomize(masked, groupSpec, SEED, { axis_key: 'qst_6.options', group: GROUP });

    const fullOrder = codes(full);
    const expected = fullOrder.filter(c => [1, 3, 5].includes(c));
    expect(codes(q6)).toEqual(expected);
  });

  it('every pairwise order is preserved across six differently-masked questions', () => {
    // The battery case from E §8.3, stated as the invariant rather than by example.
    const masks = [
      [1, 2, 3],
      [1, 3, 5],
      [2, 4, 5],
      [1, 2, 4, 5],
      [3, 4],
      [1, 2, 3, 4, 5],
    ];
    const orders = masks.map(m =>
      codes(
        randomize(
          BRANDS.filter(b => m.includes(b.code)),
          groupSpec,
          SEED,
          { axis_key: 'qst.options', group: GROUP },
        ),
      ),
    );

    for (const order of orders) {
      for (let i = 0; i < order.length; i++) {
        for (let j = i + 1; j < order.length; j++) {
          const [a, b] = [order[i]!, order[j]!];
          // a precedes b here, so a must precede b in every other order containing both.
          for (const other of orders) {
            const ia = other.indexOf(a);
            const ib = other.indexOf(b);
            if (ia !== -1 && ib !== -1) expect(ia).toBeLessThan(ib);
          }
        }
      }
    }
  });

  it('permuting the filtered list instead of the canonical one would fail the above', () => {
    // Guards the implementation choice directly. Shuffling each question's already-filtered
    // list gives orders that disagree on the shared items — the bug group_ref exists to
    // prevent. A single seed may agree by luck, so this searches for a disagreement: the
    // claim is "does not hold in general", not "never holds".
    let disagreements = 0;
    for (let i = 0; i < 50; i++) {
      const seed = `s${i}`.padEnd(32, '0');
      const a = codes(
        randomize(BRANDS.filter(b => b.code !== 2), spec(), seed, { axis_key: 'same.axis' }),
      );
      const b = codes(
        randomize(BRANDS.filter(b => b.code !== 4), spec(), seed, { axis_key: 'same.axis' }),
      );
      if (a.filter(c => b.includes(c)).join() !== b.filter(c => a.includes(c)).join()) {
        disagreements++;
      }
    }
    expect(disagreements).toBeGreaterThan(0);
  });

  it('the canonical-list approach never disagrees, over the same seeds', () => {
    // The mirror of the test above: the shipped implementation holds where the naive one does
    // not. Together they show the group_ref machinery is load-bearing, not decorative.
    const groupSpecLocal = spec({ group_ref: 'brands' });
    for (let i = 0; i < 50; i++) {
      const seed = `s${i}`.padEnd(32, '0');
      const a = codes(
        randomize(BRANDS.filter(b => b.code !== 2), groupSpecLocal, seed, {
          axis_key: 'q5.options',
          group: GROUP,
        }),
      );
      const b = codes(
        randomize(BRANDS.filter(b => b.code !== 4), groupSpecLocal, seed, {
          axis_key: 'q6.options',
          group: GROUP,
        }),
      );
      expect(a.filter(c => b.includes(c))).toEqual(b.filter(c => a.includes(c)));
    }
  });

  it('a different session gives the battery a different but internally consistent order', () => {
    const s1 = codes(randomize(BRANDS, groupSpec, SEED, { axis_key: 'q.options', group: GROUP }));
    const s2 = codes(
      randomize(BRANDS, groupSpec, '9'.repeat(32), { axis_key: 'q.options', group: GROUP }),
    );
    expect(s1).not.toEqual(s2);
  });

  it('records an event when group_ref is set but no group was supplied', () => {
    // Silently degrading a battery to independent orders is the failure mode this catches.
    const r = randomize(BRANDS, groupSpec, SEED, { axis_key: 'q.options' });
    expect(r.event).toBe('randomize.group_missing');
  });

  it('appends an item missing from the canonical list rather than dropping it', () => {
    const extra: RandomizeItem = { id: 'opt_new', code: 99, ref: 'o99' };
    const r = randomize([...BRANDS, extra], groupSpec, SEED, {
      axis_key: 'q.options',
      group: GROUP,
    });

    expect(codes(r)).toContain(99);
    expect(r.items).toHaveLength(6);
  });
});

/* ---------------------------------------------------------------- *
 * Modes
 * ---------------------------------------------------------------- */

describe('modes', () => {
  it('none is a passthrough', () => {
    const r = randomize(items(5), spec({ mode: 'none' }), SEED, { axis_key: 'q.options' });
    expect(codes(r)).toEqual([1, 2, 3, 4, 5]);
  });

  it('subset keeps n items', () => {
    const r = randomize(items(10), spec({ mode: 'subset', n: 3 }), SEED, {
      axis_key: 'q.options',
    });
    expect(r.items).toHaveLength(3);
  });

  it('subset records which codes were shown, for analysis', () => {
    // "Which subset did they see" is not recoverable later, so it becomes a design variable.
    const r = randomize(items(10), spec({ mode: 'subset', n: 3 }), SEED, {
      axis_key: 'q.options',
    });
    expect(r.subset_codes).toEqual(codes(r));
  });

  it('subset with n above the item count keeps everything', () => {
    const r = randomize(items(3), spec({ mode: 'subset', n: 99 }), SEED, {
      axis_key: 'q.options',
    });
    expect(r.items).toHaveLength(3);
  });

  it('subset is deterministic in both membership and order', () => {
    const a = randomize(items(10), spec({ mode: 'subset', n: 4 }), SEED, { axis_key: 'q.o' });
    const b = randomize(items(10), spec({ mode: 'subset', n: 4 }), SEED, { axis_key: 'q.o' });
    expect(codes(a)).toEqual(codes(b));
  });

  it('reverse_half yields either the declared order or its exact reverse', () => {
    const src = items(6);
    const r = randomize(src, spec({ mode: 'reverse_half' }), SEED, { axis_key: 'q.options' });
    const forward = [1, 2, 3, 4, 5, 6];

    expect([forward, [...forward].reverse()]).toContainEqual(codes(r));
  });

  it('reverse_half splits roughly evenly across seeds', () => {
    let reversed = 0;
    for (let i = 0; i < 200; i++) {
      const r = randomize(items(4), spec({ mode: 'reverse_half' }), `seed${i}`.padEnd(32, '0'), {
        axis_key: 'q.options',
      });
      if (codes(r)[0] === 4) reversed++;
    }
    expect(reversed).toBeGreaterThan(40);
    expect(reversed).toBeLessThan(160);
  });

  it('fewer than two items is a passthrough regardless of mode', () => {
    expect(codes(randomize(items(1), spec(), SEED, { axis_key: 'q.o' }))).toEqual([1]);
    expect(randomize([], spec(), SEED, { axis_key: 'q.o' }).items).toEqual([]);
  });
});

/* ---------------------------------------------------------------- *
 * Counter-backed modes (ADR-008)
 * ---------------------------------------------------------------- */

describe('counter-backed modes', () => {
  it('rotate reports that it needs a counter instead of using the PRNG', () => {
    // "randomize" and "randomize evenly" are different features. A silent PRNG substitution
    // produces an unbalanced cell nobody notices until fieldwork ends.
    const r = randomize(items(5), spec({ mode: 'rotate' }), SEED, { axis_key: 'q.options' });

    expect(r.needs_counter).toBe(true);
    expect(r.event).toBe('randomize.needs_counter');
    expect(codes(r)).toEqual([1, 2, 3, 4, 5]);
  });

  it('fixed_order_list needs a counter', () => {
    const r = randomize(items(5), spec({ mode: 'fixed_order_list' }), SEED, {
      axis_key: 'q.options',
    });
    expect(r.needs_counter).toBe(true);
  });

  it('even_distribution needs a counter even with a seeded mode', () => {
    const r = randomize(items(5), spec({ mode: 'shuffle', even_distribution: true }), SEED, {
      axis_key: 'q.options',
    });
    expect(r.needs_counter).toBe(true);
  });
});

/* ---------------------------------------------------------------- *
 * Anchors (E §8.4)
 * ---------------------------------------------------------------- */

describe('anchors', () => {
  const anchored: RandomizeItem[] = [
    { id: 'opt_1', code: 1, ref: 'o1', anchor: 'first' },
    { id: 'opt_2', code: 2, ref: 'o2' },
    { id: 'opt_3', code: 3, ref: 'o3' },
    { id: 'opt_4', code: 4, ref: 'o4' },
    { id: 'opt_5', code: 5, ref: 'o5', anchor: 'last' },
  ];

  it('respect_anchors pins first and last', () => {
    const r = randomize(anchored, spec({ respect_anchors: true }), SEED, {
      axis_key: 'q.options',
    });
    const c = codes(r);

    expect(c[0]).toBe(1);
    expect(c[c.length - 1]).toBe(5);
  });

  it('pins across every seed, not just a lucky one', () => {
    for (let i = 0; i < 60; i++) {
      const c = codes(
        randomize(anchored, spec({ respect_anchors: true }), `s${i}`.padEnd(32, '0'), {
          axis_key: 'q.options',
        }),
      );
      expect(c[0]).toBe(1);
      expect(c[c.length - 1]).toBe(5);
    }
  });

  it('without respect_anchors the anchors are ignored', () => {
    // The spec field is what enables the behaviour; an anchor alone must not.
    let anyMoved = false;
    for (let i = 0; i < 40; i++) {
      const c = codes(
        randomize(anchored, spec(), `s${i}`.padEnd(32, '0'), { axis_key: 'q.options' }),
      );
      if (c[0] !== 1) anyMoved = true;
    }
    expect(anyMoved).toBe(true);
  });

  it('shuffles the free items between the anchors', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 40; i++) {
      const c = codes(
        randomize(anchored, spec({ respect_anchors: true }), `s${i}`.padEnd(32, '0'), {
          axis_key: 'q.options',
        }),
      );
      seen.add(c.slice(1, -1).join(','));
    }
    expect(seen.size).toBeGreaterThan(1);
  });

  it('fixed:n lands at its 1-based absolute position', () => {
    const withFixed: RandomizeItem[] = [
      { id: 'opt_1', code: 1, ref: 'o1' },
      { id: 'opt_2', code: 2, ref: 'o2' },
      { id: 'opt_3', code: 3, ref: 'o3', anchor: 'fixed:2' },
      { id: 'opt_4', code: 4, ref: 'o4' },
    ];
    const c = codes(
      randomize(withFixed, spec({ respect_anchors: true }), SEED, { axis_key: 'q.options' }),
    );
    expect(c[1]).toBe(3);
  });

  it('two fixed items take ascending slots without fighting', () => {
    const twoFixed: RandomizeItem[] = [
      { id: 'opt_1', code: 1, ref: 'o1' },
      { id: 'opt_2', code: 2, ref: 'o2', anchor: 'fixed:1' },
      { id: 'opt_3', code: 3, ref: 'o3', anchor: 'fixed:3' },
      { id: 'opt_4', code: 4, ref: 'o4' },
    ];
    const c = codes(
      randomize(twoFixed, spec({ respect_anchors: true }), SEED, { axis_key: 'q.options' }),
    );

    expect(c[0]).toBe(2);
    expect(c[2]).toBe(3);
    expect(c).toHaveLength(4);
  });

  it('multiple first anchors keep their declared relative order', () => {
    // Shuffling anchored items among themselves would defeat the anchor.
    const twoFirst: RandomizeItem[] = [
      { id: 'opt_1', code: 1, ref: 'o1', anchor: 'first' },
      { id: 'opt_2', code: 2, ref: 'o2', anchor: 'first' },
      { id: 'opt_3', code: 3, ref: 'o3' },
      { id: 'opt_4', code: 4, ref: 'o4' },
    ];
    for (let i = 0; i < 30; i++) {
      const c = codes(
        randomize(twoFirst, spec({ respect_anchors: true }), `s${i}`.padEnd(32, '0'), {
          axis_key: 'q.options',
        }),
      );
      expect(c.slice(0, 2)).toEqual([1, 2]);
    }
  });

  it('an out-of-range fixed:n is clamped rather than dropping the item', () => {
    const r = applyAnchors(
      [
        { id: 'opt_1', code: 1 },
        { id: 'opt_2', code: 2, anchor: 'fixed:99' },
      ],
      [],
    );
    expect(r.map(i => i.code).sort((a, b) => a - b)).toEqual([1, 2]);
  });

  it('anchors compose with subset', () => {
    const r = randomize(anchored, spec({ mode: 'subset', n: 3, respect_anchors: true }), SEED, {
      axis_key: 'q.options',
    });
    expect(r.items).toHaveLength(3);
    expect(codes(r)[0]).toBe(1);
  });
});

/* ---------------------------------------------------------------- *
 * Sub-blocks
 * ---------------------------------------------------------------- */

describe('sub_blocks', () => {
  const subSpec = spec({
    sub_blocks: [{ refs: ['o1', 'o2'] }, { refs: ['o4', 'o5'] }],
  });

  it('keeps items inside their own block', () => {
    // Competitor brands stay grouped: positions 1–2 hold o1/o2 in some order, 4–5 hold o4/o5.
    for (let i = 0; i < 40; i++) {
      const c = codes(
        randomize(items(5), subSpec, `s${i}`.padEnd(32, '0'), { axis_key: 'q.options' }),
      );
      expect(c.slice(0, 2).sort((a, b) => a - b)).toEqual([1, 2]);
      expect(c.slice(3, 5).sort((a, b) => a - b)).toEqual([4, 5]);
      expect(c[2]).toBe(3);
    }
  });

  it('shuffles within a block', () => {
    const seen = new Set<number>();
    for (let i = 0; i < 40; i++) {
      const c = codes(
        randomize(items(5), subSpec, `s${i}`.padEnd(32, '0'), { axis_key: 'q.options' }),
      );
      seen.add(c[0]!);
    }
    expect(seen).toEqual(new Set([1, 2]));
  });

  it('each block draws from its own salt', () => {
    // Adding a brand to one block must not reorder another, or a tracker's waves stop being
    // comparable. Asserted by the two blocks not moving in lockstep across seeds.
    const pairs = new Set<string>();
    for (let i = 0; i < 60; i++) {
      const c = codes(
        randomize(items(5), subSpec, `s${i}`.padEnd(32, '0'), { axis_key: 'q.options' }),
      );
      pairs.add(`${c[0]}|${c[3]}`);
    }
    expect(pairs.size).toBeGreaterThan(2);
  });

  it('a one-member block is left alone', () => {
    const r = randomize(items(3), spec({ sub_blocks: [{ refs: ['o2'] }] }), SEED, {
      axis_key: 'q.options',
    });
    expect(codes(r)).toEqual([1, 2, 3]);
  });
});
