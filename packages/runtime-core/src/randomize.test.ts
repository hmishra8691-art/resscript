/**
 * Test suite for randomization modes (task 55).
 *
 * Verifies E §8 requirements: determinism, shared group order, anchors.
 */

import { describe, it, expect } from 'vitest';
import {
  randomize,
  testRandomizationDeterminism,
  testSharedGroupOrder,
  testAnchors,
  type Item,
  type Group,
  type RandomizationConfig,
} from './randomize.js';

describe('randomization determinism', () => {
  it('same seed produces identical permutation', () => {
    const items: Item[] = [{ code: 'a' }, { code: 'b' }, { code: 'c' }];
    const config: RandomizationConfig = { mode: 'shuffle' };
    const seed = 'seed-abc123';

    const result1 = randomize(items, config, seed);
    const result2 = randomize(items, config, seed);

    expect(result1.items.map(i => i.code)).toEqual(result2.items.map(i => i.code));
  });

  it('different seeds produce different permutations', () => {
    const items: Item[] = Array.from({ length: 10 }, (_, i) => ({ code: `${i}` }));
    const config: RandomizationConfig = { mode: 'shuffle' };

    const result1 = randomize(items, config, 'seed1');
    const result2 = randomize(items, config, 'seed2');

    expect(result1.items.map(i => i.code)).not.toEqual(
      result2.items.map(i => i.code),
    );
  });

  it('built-in determinism test passes', () => {
    expect(testRandomizationDeterminism()).toBe(true);
  });
});

describe('shared group order', () => {
  it('identical order for different item subsets', () => {
    const group: Group = {
      ref: 'brands',
      canonical: [
        { code: 'coca' },
        { code: 'pepsi' },
        { code: 'sprite' },
        { code: 'fanta' },
      ],
    };

    const q1Items = [{ code: 'coca' }, { code: 'pepsi' }, { code: 'sprite' }];
    const q2Items = [{ code: 'coca' }, { code: 'sprite' }, { code: 'fanta' }];

    const config: RandomizationConfig = { mode: 'shuffle', group_ref: 'brands' };
    const seed = 'battery-seed';

    const result1 = randomize(q1Items, config, seed, group);
    const result2 = randomize(q2Items, config, seed, group);

    // coca and sprite should have the same relative order in both
    const coca1 = result1.items.findIndex(i => i.code === 'coca');
    const coca2 = result2.items.findIndex(i => i.code === 'coca');
    const sprite1 = result1.items.findIndex(i => i.code === 'sprite');
    const sprite2 = result2.items.findIndex(i => i.code === 'sprite');

    expect(coca1 < sprite1).toBe(coca2 < sprite2);
  });

  it('same canonical order across questions', () => {
    const group: Group = {
      ref: 'options',
      canonical: [
        { code: '1' },
        { code: '2' },
        { code: '3' },
        { code: '4' },
        { code: '5' },
      ],
    };

    const config: RandomizationConfig = { mode: 'shuffle', group_ref: 'options' };
    const seed = 'shared-seed';

    // Permute the same group in three different questions
    const perm1 = randomize(
      [{ code: '1' }, { code: '2' }, { code: '3' }],
      config,
      seed,
      group,
    );
    const perm2 = randomize(
      [{ code: '2' }, { code: '3' }, { code: '4' }],
      config,
      seed,
      group,
    );
    const perm3 = randomize(
      [{ code: '1' }, { code: '4' }, { code: '5' }],
      config,
      seed,
      group,
    );

    // Check that shared items maintain relative order
    const idx12 = perm1.items.findIndex(i => i.code === '2');
    const idx13 = perm1.items.findIndex(i => i.code === '3');
    const idx23 = perm2.items.findIndex(i => i.code === '2');
    const idx33 = perm2.items.findIndex(i => i.code === '3');

    expect(idx12 < idx13).toBe(idx23 < idx33);
  });

  it('built-in shared group order test passes', () => {
    expect(testSharedGroupOrder()).toBe(true);
  });
});

describe('randomization modes', () => {
  it('shuffle randomizes items', () => {
    const items: Item[] = Array.from({ length: 5 }, (_, i) => ({ code: `${i}` }));
    const config: RandomizationConfig = { mode: 'shuffle' };

    const result = randomize(items, config, 'seed');
    const codes = result.items.map(i => i.code);

    // Should be a valid permutation
    expect(new Set(codes)).toEqual(new Set(['0', '1', '2', '3', '4']));
  });

  it('subset selects n items and records count', () => {
    const items: Item[] = Array.from({ length: 10 }, (_, i) => ({ code: `${i}` }));
    const config: RandomizationConfig = { mode: 'subset', n: 3 };

    const result = randomize(items, config, 'seed');

    expect(result.items.length).toBe(3);
    expect(result.subset).toBe(3);
  });

  it('subset n > items.length returns all items', () => {
    const items: Item[] = [{ code: 'a' }, { code: 'b' }, { code: 'c' }];
    const config: RandomizationConfig = { mode: 'subset', n: 100 };

    const result = randomize(items, config, 'seed');

    expect(result.items.length).toBe(3);
    expect(result.subset).toBe(3);
  });

  it('reverse_half uses one bit from PRNG', () => {
    const items: Item[] = [
      { code: 'a' },
      { code: 'b' },
      { code: 'c' },
      { code: 'd' },
    ];
    const config: RandomizationConfig = { mode: 'reverse_half' };

    const result = randomize(items, config, 'seed-reverse');

    const codes = result.items.map(i => i.code);
    const isReversed = codes[0] === 'd';
    const isForward = codes[0] === 'a';

    expect(isReversed || isForward).toBe(true);
  });

  it('fixed_order preserves item order', () => {
    const items: Item[] = [
      { code: 'a' },
      { code: 'b' },
      { code: 'c' },
    ];
    const config: RandomizationConfig = { mode: 'fixed_order' };

    const result = randomize(items, config, 'seed');

    expect(result.items.map(i => i.code)).toEqual(['a', 'b', 'c']);
  });
});

describe('anchors', () => {
  it('first anchor preserves first position', () => {
    const items: Item[] = [
      { code: 'a', anchor: 'first' },
      { code: 'b' },
      { code: 'c' },
      { code: 'd' },
    ];
    const config: RandomizationConfig = { mode: 'shuffle', respect_anchors: true };

    const result = randomize(items, config, 'seed');

    expect(result.items[0]?.code).toBe('a');
  });

  it('last anchor preserves last position', () => {
    const items: Item[] = [
      { code: 'a' },
      { code: 'b' },
      { code: 'c' },
      { code: 'd', anchor: 'last' },
    ];
    const config: RandomizationConfig = { mode: 'shuffle', respect_anchors: true };

    const result = randomize(items, config, 'seed');

    expect(result.items[result.items.length - 1]?.code).toBe('d');
  });

  it('first and last anchors both respected', () => {
    const items: Item[] = [
      { code: 'a', anchor: 'first' },
      { code: 'b' },
      { code: 'c' },
      { code: 'd', anchor: 'last' },
    ];
    const config: RandomizationConfig = { mode: 'shuffle', respect_anchors: true };

    const result = randomize(items, config, 'seed');
    const codes = result.items.map(i => i.code);

    expect(codes[0]).toBe('a');
    expect(codes[codes.length - 1]).toBe('d');
  });

  it('fixed anchor inserts at absolute position', () => {
    const items: Item[] = [
      { code: 'a', anchor: 'fixed:2' as any },
      { code: 'b' },
      { code: 'c' },
      { code: 'd' },
    ];
    const config: RandomizationConfig = { mode: 'shuffle', respect_anchors: true };

    const result = randomize(items, config, 'seed');
    const codes = result.items.map(i => i.code);

    // Position is 1-indexed, so fixed:2 means index 1
    expect(codes[1]).toBe('a');
  });

  it('built-in anchor test passes', () => {
    expect(testAnchors()).toBe(true);
  });
});
