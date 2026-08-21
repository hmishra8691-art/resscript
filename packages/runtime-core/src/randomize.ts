/**
 * Task 55: Randomization modes per Deliverable E §8.
 *
 * Apply PRNG-driven randomization to question items:
 * - `shuffle`: Fisher-Yates permutation of free items
 * - `subset`: permute, take first n, record which n as design variable
 * - `reverse_half`: flip direction based on one bit from PRNG
 *
 * Shared group order (schema §12, E §8.3): identical order across linked questions.
 * Anchors (first, last, fixed:n) applied *after* randomization (E §8.4).
 *
 * Counter-backed modes (rotate, fixed_order_list) are P1-10; this handles PRNG only.
 */

import { deriveKey, permute, sfc32Counter } from './prng.js';

export interface Item {
  code: string;
  anchor?: 'none' | 'first' | 'last' | string; // string for 'fixed:n'
  label?: string;
}

export interface Group {
  ref: string;
  /** Canonical items in declared order. */
  canonical: Item[];
}

export type RandomizationMode = 'shuffle' | 'subset' | 'reverse_half' | 'fixed_order';

export interface RandomizationConfig {
  mode: RandomizationMode;
  /** For subset mode, how many items to include. */
  n?: number;
  /** For shared group order, the group ref. */
  group_ref?: string;
  /** If true, apply anchors (first, last, fixed:n). */
  respect_anchors?: boolean;
}

/**
 * Apply anchors to an ordered item list.
 * Order: first, free, last, fixed:n (ascending by position).
 */
function applyAnchors(shuffled: Item[]): Item[] {
  const first = shuffled.filter(i => i.anchor === 'first');
  const last = shuffled.filter(i => i.anchor === 'last');
  const fixed = shuffled.filter(i => i.anchor?.toString().startsWith('fixed:'));
  const free = shuffled.filter(i => !i.anchor || i.anchor === 'none');

  let out: Item[] = [...first, ...free, ...last];

  // Fixed:n inserts at absolute position n, applied in ascending order
  for (const f of fixed.sort((a, b) => {
    const aIdx = parseInt(a.anchor?.toString().split(':')[1] ?? '0', 10);
    const bIdx = parseInt(b.anchor?.toString().split(':')[1] ?? '0', 10);
    return aIdx - bIdx;
  })) {
    const idx = parseInt(f.anchor!.toString().split(':')[1]!, 10);
    out.splice(idx - 1, 0, f);
  }

  return out;
}

/**
 * Randomize items according to the given mode and seed.
 *
 * For shared group order (group_ref set), permute the canonical group list
 * and filter to the present items, to ensure all questions in the battery
 * see the same order (filtered for their specific masks).
 */
export function randomize(
  items: Item[],
  config: RandomizationConfig,
  seed: string,
  group?: Group,
): { items: Item[]; subset?: number } {
  // Derive salt for the randomization
  const salt = config.group_ref ? `grp:${config.group_ref}` : 'items';
  const key = deriveKey(seed, salt);

  let ordered: Item[];

  if (config.mode === 'shuffle') {
    if (group) {
      // Shared group order: permute canonical, filter to present items, preserve order
      const permuted = permute(group.canonical, key);
      const codes = new Set(items.map(i => i.code));
      ordered = permuted.filter(i => codes.has(i.code));
    } else {
      // Independent shuffle: permute this question's items
      ordered = permute(items, key);
    }
  } else if (config.mode === 'subset') {
    if (group) {
      const permuted = permute(group.canonical, key);
      const codes = new Set(items.map(i => i.code));
      const allOrdered = permuted.filter(i => codes.has(i.code));
      const n = config.n ?? items.length;
      ordered = allOrdered.slice(0, Math.min(n, allOrdered.length));
    } else {
      const permuted = permute(items, key);
      const n = config.n ?? items.length;
      ordered = permuted.slice(0, Math.min(n, permuted.length));
    }
  } else if (config.mode === 'reverse_half') {
    // One bit from PRNG: < 0.5 means reverse
    const bit = sfc32Counter(key, 0) < 0.5;
    ordered = bit ? items.slice().reverse() : items;
  } else {
    // fixed_order: no randomization
    ordered = items;
  }

  // Apply anchors if requested
  const result = config.respect_anchors ? applyAnchors(ordered) : ordered;

  // For subset mode, record how many items were included
  if (config.mode === 'subset') {
    const n = config.n ?? items.length;
    return { items: result, subset: Math.min(n, items.length) };
  }

  return { items: result };
}

/**
 * Unit test: deterministic randomization.
 */
export function testRandomizationDeterminism(): boolean {
  const items = [
    { code: 'a' },
    { code: 'b' },
    { code: 'c' },
    { code: 'd' },
  ];

  const config: RandomizationConfig = { mode: 'shuffle' };
  const seed = 'seed-test';

  const result1 = randomize(items, config, seed);
  const result2 = randomize(items, config, seed);

  return result1.items.every((v, i) => v.code === result2.items[i]?.code);
}

/**
 * Unit test: shared group order produces identical order for different item sets.
 *
 * The key requirement: coca and sprite maintain the same relative order
 * across different masked questions (E §8.3).
 */
export function testSharedGroupOrder(): boolean {
  const group: Group = {
    ref: 'brands',
    canonical: [
      { code: 'coca' },
      { code: 'pepsi' },
      { code: 'sprite' },
      { code: 'fanta' },
    ],
  };

  // Q1: sees coca, pepsi, sprite
  const q1Items = [{ code: 'coca' }, { code: 'pepsi' }, { code: 'sprite' }];
  // Q2: sees coca, sprite, fanta (different subset)
  const q2Items = [{ code: 'coca' }, { code: 'sprite' }, { code: 'fanta' }];

  const config: RandomizationConfig = { mode: 'shuffle', group_ref: 'brands' };
  const seed = 'seed-battery';

  const result1 = randomize(q1Items, config, seed, group);
  const result2 = randomize(q2Items, config, seed, group);

  // Both should have coca and sprite in the same relative order
  const covidx1 = result1.items.findIndex(i => i.code === 'coca');
  const spriteidx1 = result1.items.findIndex(i => i.code === 'sprite');

  const covidx2 = result2.items.findIndex(i => i.code === 'coca');
  const spriteidx2 = result2.items.findIndex(i => i.code === 'sprite');

  // The relative order must be consistent: if coca < sprite in Q1, then coca < sprite in Q2
  const order1 = covidx1 < spriteidx1;
  const order2 = covidx2 < spriteidx2;

  return order1 === order2;
}

/**
 * Unit test: anchors are respected.
 */
export function testAnchors(): boolean {
  const items = [
    { code: 'a', anchor: 'first' as const },
    { code: 'b' },
    { code: 'c', anchor: 'last' as const },
    { code: 'd' },
  ];

  const config: RandomizationConfig = { mode: 'shuffle', respect_anchors: true };
  const result = randomize(items, config, 'seed-test');

  // 'a' should be first, 'c' should be last
  const codes = result.items.map(i => i.code);
  return codes[0] === 'a' && codes[codes.length - 1] === 'c';
}
