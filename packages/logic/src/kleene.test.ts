/**
 * The truth tables of D §2.5, asserted cell by cell.
 *
 * A test that only checked "and(T,T) === T" would pass on a two-valued implementation, which is
 * the implementation this whole design exists to replace. So every one of the nine cells of `AND`
 * and `OR` and every one of the three of `NOT` is named individually, and the two absorption
 * properties that make real surveys work (`F AND U = F`, `T OR U = T`) get their own assertions.
 */

import { describe, expect, it } from 'vitest';
import { TRI_VALUES, and3, andAll, not3, or3, orAll, triOf, triToValue, type Tri } from './kleene.js';
import { FALSE, NULL, TRUE, num } from './value.js';
import { LogicInvariant } from './ids.js';

describe('Kleene AND (D §2.5)', () => {
  const table: readonly (readonly [Tri, Tri, Tri])[] = [
    ['F', 'F', 'F'],
    ['F', 'U', 'F'],
    ['F', 'T', 'F'],
    ['U', 'F', 'F'],
    ['U', 'U', 'U'],
    ['U', 'T', 'U'],
    ['T', 'F', 'F'],
    ['T', 'U', 'U'],
    ['T', 'T', 'T'],
  ];
  for (const [a, b, expected] of table) {
    it(`${a} AND ${b} = ${expected}`, () => {
      expect(and3(a, b)).toBe(expected);
    });
  }
});

describe('Kleene OR (D §2.5)', () => {
  const table: readonly (readonly [Tri, Tri, Tri])[] = [
    ['F', 'F', 'F'],
    ['F', 'U', 'U'],
    ['F', 'T', 'T'],
    ['U', 'F', 'U'],
    ['U', 'U', 'U'],
    ['U', 'T', 'T'],
    ['T', 'F', 'T'],
    ['T', 'U', 'T'],
    ['T', 'T', 'T'],
  ];
  for (const [a, b, expected] of table) {
    it(`${a} OR ${b} = ${expected}`, () => {
      expect(or3(a, b)).toBe(expected);
    });
  }
});

describe('Kleene NOT (D §2.5)', () => {
  it('NOT F = T', () => {
    expect(not3('F')).toBe('T');
  });
  it('NOT T = F', () => {
    expect(not3('T')).toBe('F');
  });
  it('NOT U = U — the property the whole design turns on', () => {
    // This single cell is the difference between "terminate under-18 does not fire for a
    // respondent who never saw the age question" and "it terminates the entire non-asked sample".
    expect(not3('U')).toBe('U');
  });
});

describe('absorption', () => {
  it('a decisive FALSE absorbs unknown in AND', () => {
    // `S1 = 1 AND Q9 > 3` must be cleanly false for a respondent screened out at S1, without the
    // author having to guard Q9 (D §2.5).
    expect(and3('F', 'U')).toBe('F');
    expect(andAll(['U', 'U', 'F', 'U'])).toBe('F');
  });
  it('a decisive TRUE absorbs unknown in OR', () => {
    expect(or3('T', 'U')).toBe('T');
    expect(orAll(['U', 'U', 'T'])).toBe('T');
  });
  it('unknown survives when nothing is decisive', () => {
    expect(andAll(['T', 'U', 'T'])).toBe('U');
    expect(orAll(['F', 'U', 'F'])).toBe('U');
  });
});

describe('n-ary folds are associative and commutative', () => {
  // D §10.1 reorders and flattens `and`/`or` operands, which is only legal if the fold is
  // order-independent. Asserted exhaustively over all 27 triples rather than assumed.
  const triples: (readonly [Tri, Tri, Tri])[] = [];
  for (const a of TRI_VALUES) for (const b of TRI_VALUES) for (const c of TRI_VALUES) triples.push([a, b, c]);

  it('andAll is invariant under permutation', () => {
    for (const [a, b, c] of triples) {
      const expected = andAll([a, b, c]);
      for (const permutation of permutations([a, b, c])) {
        expect(andAll(permutation)).toBe(expected);
      }
    }
  });

  it('orAll is invariant under permutation', () => {
    for (const [a, b, c] of triples) {
      const expected = orAll([a, b, c]);
      for (const permutation of permutations([a, b, c])) {
        expect(orAll(permutation)).toBe(expected);
      }
    }
  });

  it('andAll is associative: (a AND b) AND c = a AND (b AND c)', () => {
    for (const [a, b, c] of triples) {
      expect(and3(and3(a, b), c)).toBe(and3(a, and3(b, c)));
      expect(or3(or3(a, b), c)).toBe(or3(a, or3(b, c)));
    }
  });

  it('de Morgan holds under three values', () => {
    for (const [a, b] of triples) {
      expect(not3(and3(a, b))).toBe(or3(not3(a), not3(b)));
      expect(not3(or3(a, b))).toBe(and3(not3(a), not3(b)));
    }
  });

  it('the identities of the empty fold match the operators', () => {
    expect(andAll([])).toBe('T');
    expect(orAll([])).toBe('F');
  });
});

describe('Value <-> Tri', () => {
  it('maps null to U in both directions', () => {
    expect(triOf(NULL)).toBe('U');
    expect(triToValue('U')).toBe(NULL);
    expect(triOf(TRUE)).toBe('T');
    expect(triOf(FALSE)).toBe('F');
    expect(triToValue('T')).toBe(TRUE);
    expect(triToValue('F')).toBe(FALSE);
  });

  it('refuses a non-boolean: the checker guarantees bool, so this is a compiler bug', () => {
    expect(() => triOf(num(1))).toThrow(LogicInvariant);
  });
});

function permutations<T>(items: readonly T[]): readonly T[][] {
  if (items.length <= 1) return [[...items]];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += 1) {
    const head = items[i];
    if (head === undefined) continue;
    const rest = [...items.slice(0, i), ...items.slice(i + 1)];
    for (const tail of permutations(rest)) out.push([head, ...tail]);
  }
  return out;
}
