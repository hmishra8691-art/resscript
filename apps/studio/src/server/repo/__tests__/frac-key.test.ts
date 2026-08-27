/**
 * The TypeScript port of `content.frac_key_at` against the facts 0001's comments state.
 *
 * This suite exists because the port is a SECOND implementation of the ordering contract, and the
 * only thing that makes a second implementation acceptable is that it is pinned to the first. The
 * two worked examples below are quoted from the migration's own comments; the properties after them
 * are the ones the sibling-set logic depends on.
 */

import { describe, expect, it } from 'vitest';
import {
  fracKeyAtPosition,
  fracKeyBetween,
  FracKeyExhausted,
  rebalanceWidth,
} from '@/server/repo/frac-key';

describe('fracKeyBetween — 0001 §10, worked examples', () => {
  it("frac_key_at('a1','a2') = 'a1V'", () => {
    expect(fracKeyBetween('a1', 'a2')).toBe('a1V');
  });

  it('an unbounded key is the middle of the alphabet', () => {
    expect(fracKeyBetween(null, null)).toBe('V');
  });

  it('never ends in the smallest digit, so something can always be inserted below', () => {
    // '0' would be a wall: '00' sorts ABOVE '0' because a prefix is always smaller.
    expect(fracKeyBetween(null, '1')).toBe('0V');
    expect(fracKeyBetween(null, '0V')).not.toMatch(/0$/);
  });

  it('refuses when no key can exist below the bound, which is the rebalance signal', () => {
    expect(() => fracKeyBetween(null, '0')).toThrow(FracKeyExhausted);
    expect(() => fracKeyBetween(null, '000')).toThrow(FracKeyExhausted);
    expect(() => fracKeyBetween('b', 'a')).toThrow(FracKeyExhausted);
  });

  it('keeps a total order under 200 adjacent inserts, and grows about one char each', () => {
    // The pathological drag sequence B §4.6 names: always insert immediately after the same
    // sibling. 0001 measured 42 characters at 200 inserts; the assertion is the shape of that,
    // not the exact number, plus the property that actually matters — order stays total.
    let previous = fracKeyBetween(null, null);
    const upper = fracKeyBetween(previous, null);
    const keys: string[] = [];
    for (let i = 0; i < 200; i += 1) {
      previous = fracKeyBetween(previous, upper);
      keys.push(previous);
    }
    expect([...keys].sort()).toEqual(keys);
    expect(keys.at(-1)?.length).toBeGreaterThan(16);
    expect(keys.at(-1)?.length).toBeLessThan(64);
  });
});

describe('fracKeyAtPosition — the dense overload', () => {
  it('is fixed width, so lexicographic order equals numeric order', () => {
    expect(fracKeyAtPosition(1, 4)).toBe('0001');
    expect(fracKeyAtPosition(62, 4)).toBe('0010');
    const dense = [1, 2, 10, 61, 62, 63, 3843].map((n) => fracKeyAtPosition(n, 4));
    expect([...dense].sort()).toEqual(dense);
  });

  it('starts at 1, so no key is all zeros', () => {
    expect(() => fracKeyAtPosition(0, 4)).toThrow(FracKeyExhausted);
    expect(fracKeyAtPosition(1, 4)).not.toMatch(/^0+$/);
  });

  it('refuses a position that does not fit the width', () => {
    expect(() => fracKeyAtPosition(62 ** 4, 4)).toThrow(FracKeyExhausted);
  });

  it('rebalanceWidth keeps one character of headroom', () => {
    expect(rebalanceWidth(2)).toBe(4);
    expect(rebalanceWidth(60)).toBe(4);
    expect(rebalanceWidth(4000)).toBeGreaterThanOrEqual(4);
    expect(62 ** rebalanceWidth(4000)).toBeGreaterThan(4000);
  });
});
