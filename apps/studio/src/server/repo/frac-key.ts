/**
 * `content.frac_key_at()`, ported to TypeScript.
 *
 * WHY a port at all, when the whole point of B §4.6 living in the database is that the key
 * depends on the CURRENT neighbours and computing it in the application means read-then-write —
 * the line this file draws, and both halves of it matter:
 *
 *  - **`fracKeyBetween` is the in-memory store's only.** `SupabaseRepo` never calls it. It calls
 *    `content.next_sort_key` / `content.move_node` / `content.move_question_item`, so the real
 *    system has exactly one implementation of interpolation and one place where the race is
 *    closed. `InMemoryRepo` has no database to call, and a store that ordered siblings `'a'`,
 *    `'b'`, `'c'` would let a route test pass while the real system produced a different key —
 *    including for the two behaviours P1-03's acceptance criteria are about: that a drag is ONE
 *    row write, and that the key growth of adjacent inserts eventually triggers a rebalance.
 *  - **`fracKeyAtPosition` is shared by both stores**, because it takes no neighbours: it is
 *    arithmetic on a 1-based position, which is exactly why 0001 declared that overload
 *    `IMMUTABLE`. There is no read to be raced. Both stores use it for the paste-60-brands path,
 *    where the pasted block defines its own order and the only interaction with existing rows is
 *    handled by prefixing the set's current maximum key (see `bulkItems`).
 *
 * So this is a transliteration, not a reimplementation: the same alphabet, the same
 * common-prefix recursion, the same `(da + db + 1) / 2` rounding (integer division, hence
 * `Math.trunc`), the same "a key must never end in the smallest digit" escape, and the same two
 * refusals — which surface as `FracKeyExhausted` where plpgsql raises
 * `invalid_parameter_value`, because the caller's recovery is identical: rebalance the sibling
 * set and retry once.
 *
 * `frac-key.test.ts` pins the two worked examples 0001's comments state (`frac_key_at('a1','a2')
 * = 'a1V'`, `frac_key_at(NULL, NULL) = 'V'`) so a divergence is a failing test rather than a
 * store that orders differently from Postgres.
 */

/** Base-62, in `content.sort_key`'s COLLATE "C" order: digits, uppercase, lowercase. */
const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const RADIX = 62;

/**
 * `frac_key_at`'s `invalid_parameter_value`: no key can exist below the given upper bound.
 *
 * Not a `StoreConstraintError`: it is not a constraint, it is the documented signal that the
 * sibling set needs rebalancing (0001's own HINT says so), and every caller here handles it by
 * doing exactly that — see `content.next_sort_key`, which this store's callers mirror.
 */
export class FracKeyExhausted extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FracKeyExhausted';
  }
}

function orNull(value: string): string | null {
  return value === '' ? null : value;
}

/**
 * A base-62 key strictly between two siblings. A `null` bound means "no bound".
 *
 * `content.frac_key_at(content.sort_key, content.sort_key)`, line for line.
 */
export function fracKeyBetween(before: string | null, after: string | null): string {
  const a = before ?? '';
  const b = after ?? '';
  if (b !== '' && a >= b) {
    throw new FracKeyExhausted(`frac_key_at: before (${a}) must sort strictly before after (${b})`);
  }
  if (b !== '' && /^0+$/.test(b)) {
    // No key can exist between '' and a string of only zeros, because '00' > '0'.
    throw new FracKeyExhausted(`frac_key_at: no key exists below ${b}; rebalance the sibling set`);
  }

  // Strip the common prefix and recurse on the remainder — what keeps keys short, and
  // therefore what keeps a drag one UPDATE of one short string.
  let common = 0;
  while (common < a.length && common < b.length && a[common] === b[common]) common += 1;
  if (common > 0) {
    return a.slice(0, common) + fracKeyBetween(orNull(a.slice(common)), orNull(b.slice(common)));
  }

  // -1 encodes "below every digit"; 62 encodes "above every digit".
  const da = a === '' ? -1 : ALPHABET.indexOf(a.slice(0, 1));
  const db = b === '' ? RADIX : ALPHABET.indexOf(b.slice(0, 1));

  if (db - da >= 2) {
    // Round up, so frac_key_at('a1','a2') = 'a1V' — B §4.6's worked example.
    const mid = Math.trunc((da + db + 1) / 2);
    if (mid === 0) {
      // A key must never END in the smallest digit: '…00' sorts ABOVE '…0' (a prefix is always
      // smaller), so nothing could ever be inserted below it. '0V' keeps a digit of headroom.
      return `0${fracKeyBetween(null, null)}`;
    }
    return ALPHABET.slice(mid, mid + 1);
  }

  // Adjacent digits: keep this digit and go one character deeper.
  if (da >= 0) {
    return ALPHABET.slice(da, da + 1) + fracKeyBetween(orNull(a.slice(1)), null);
  }
  return ALPHABET.slice(db, db + 1) + fracKeyBetween(null, orNull(b.slice(1)));
}

/**
 * Dense, FIXED-WIDTH base-62 key for 1-based position `n`.
 *
 * `content.frac_key_at(integer, integer)`. Used only by the rebalance emulation, for the reason
 * 0001 gives: fixed width is what makes lexicographic order equal numeric order, and starting
 * at 1 guarantees no key is all zeros (which would leave no room to insert before it).
 */
export function fracKeyAtPosition(n: number, width = 4): string {
  if (n < 1) throw new FracKeyExhausted(`frac_key_at: dense position must be >= 1 (got ${n})`);
  if (n >= RADIX ** width) {
    throw new FracKeyExhausted(`frac_key_at: position ${n} does not fit in ${width} base-62 characters`);
  }
  let out = '';
  let value = n;
  for (let i = 0; i < width; i += 1) {
    const digit = value % RADIX;
    out = ALPHABET.slice(digit, digit + 1) + out;
    value = Math.trunc(value / RADIX);
  }
  return out;
}

/**
 * `content.rebalance_siblings`' width choice: `greatest(4, ceil(ln(n)/ln(62)) + 1)`.
 *
 * One extra character of headroom so the set can grow without an immediate re-rebalance.
 */
export function rebalanceWidth(count: number): number {
  return Math.max(4, Math.ceil(Math.log(Math.max(count, 2)) / Math.log(RADIX)) + 1);
}

/**
 * The threshold `content.move_node` and `content.move_question_item` rebalance at: the sibling
 * set is rewritten only once its longest key passes 16 characters, and only AFTER the move is
 * already durable, so the common drag stays a single-row write.
 */
export const REBALANCE_KEY_LENGTH = 16;
