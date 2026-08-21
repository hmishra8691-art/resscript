/**
 * Deterministic seeded PRNG — Deliverable E §8, ADR-006.
 *
 * Counter-based and stateless: `randomAt(key, i)` is a pure function of the key and the index,
 * so a permutation depends only on `(seed, salt, length)` and never on call order. That is what
 * makes a session replayable — the seed is captured once at entry and never changes, and every
 * randomization decision is re-derivable from it rather than stored.
 *
 * This is the ONLY source of randomness in the runtime. `Math.random()` is banned under
 * `apps/runtime` by an ESLint rule, because a single unseeded draw makes a session
 * unreproducible and the loss is silent.
 *
 * Not cryptographic, and it does not need to be: the seed never reaches the browser and an
 * option order is not a secret. It needs to be *uniform* and *identical across platforms*.
 *
 * PLATFORM IDENTITY. Every 32-bit multiply goes through `Math.imul`. Plain `*` on two 32-bit
 * integers overflows into IEEE-754 doubles and silently loses the low bits, and the exact point
 * at which that happens is an engine detail — so `a * b | 0` can differ between V8, a browser,
 * and QuickJS. `Math.imul` is specified to wrap, so it is the only portable 32-bit multiply.
 * ADR-006 requires the three to agree; this is the mechanism that makes them.
 */

/* ------------------------------------------------------------------ *
 * Mixing primitives
 * ------------------------------------------------------------------ */

/** Murmur3's 32-bit finalizer. Full avalanche: one input bit flips ~16 output bits. */
function fmix32(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

const FNV_PRIME = 0x01000193;

/* ------------------------------------------------------------------ *
 * Key derivation
 * ------------------------------------------------------------------ */

/**
 * Hash a string to four 32-bit words.
 *
 * Four independent FNV-1a lanes with different offset bases, then a cross-lane mix and an
 * avalanche pass. The lanes are seeded differently so the words are not correlated; a single
 * lane copied four ways would give a 32-bit key wearing a 128-bit costume.
 */
function hash128(input: string): [number, number, number, number] {
  let h0 = 0x811c9dc5;
  let h1 = 0x01000193;
  let h2 = 0x9e3779b9;
  let h3 = 0x85ebca6b;

  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h0 = Math.imul(h0 ^ c, FNV_PRIME) >>> 0;
    h1 = Math.imul(h1 ^ (c + i), FNV_PRIME) >>> 0;
    h2 = Math.imul(h2 ^ (c ^ (i << 8)), FNV_PRIME) >>> 0;
    h3 = Math.imul(h3 ^ (c + (i << 16)), FNV_PRIME) >>> 0;
  }

  // Cross-lane diffusion, so a change late in the string reaches every word.
  h0 = (h0 + h3) >>> 0;
  h1 = (h1 ^ h0) >>> 0;
  h2 = (h2 + h1) >>> 0;
  h3 = (h3 ^ h2) >>> 0;

  // Length is mixed in so that "ab" and "ab\0" cannot collide via the lanes alone.
  const n = input.length;
  return [fmix32(h0 ^ n), fmix32(h1 ^ n), fmix32(h2 ^ n), fmix32(h3 ^ n)];
}

/**
 * Derive a 128-bit key from `(seed, salt)`.
 *
 * The `\x00` separator is load-bearing: without it `("ab", "c")` and `("a", "bc")` hash
 * identically, so two different salts would share an order. A null byte cannot appear in a
 * seed (hex) or a salt (`grp:<ref>`, `<question id>.<axis>`), so it is a safe separator.
 */
export function deriveKey(seed: string, salt: string): [number, number, number, number] {
  return hash128(`${seed}\x00${salt}`);
}

/**
 * A stable 128-bit hex digest of a string.
 *
 * Exists so the runtime can answer "is this render the same as the one I recorded" (E §7.2) in
 * an environment with no `node:crypto` — the browser and QuickJS both run this code. Not
 * cryptographic: a collision costs one unnecessary re-ask, not a security boundary.
 */
export function hashString(input: string): string {
  return hash128(input)
    .map(w => (w >>> 0).toString(16).padStart(8, '0'))
    .join('');
}

/* ------------------------------------------------------------------ *
 * Counter-mode draw
 * ------------------------------------------------------------------ */

/**
 * The `i`-th draw from `key`, in `[0, 1)`.
 *
 * Counter mode rather than a stateful generator: the caller can ask for draw 7 without having
 * taken draws 0–6, so a permutation is a function of its inputs alone and adding a question to
 * a page cannot shift another question's order.
 *
 * The counter is mixed into EVERY key word before the avalanche. An earlier implementation
 * added it to one word whose value never reached the output, so every `i` returned the same
 * number — Fisher–Yates then reused a single draw at every step and reached 10 of the 120
 * permutations of five items. The `counter_changes_output` test below is the direct guard.
 */
export function randomAt(key: readonly [number, number, number, number], i: number): number {
  const c = (i | 0) >>> 0;

  // Two odd multipliers, so distinct counters cannot map to the same word pair.
  let x = (key[0] ^ Math.imul(c + 1, 0x9e3779b9)) >>> 0;
  let y = (key[1] + Math.imul(c + 1, 0x85ebca6b)) >>> 0;

  x = fmix32(x ^ y);
  y = fmix32((y + key[2]) >>> 0);
  const z = fmix32((x ^ Math.imul(y, 0x27d4eb2f) ^ key[3]) >>> 0);

  // 2**32 exactly; the result is in [0, 1) because z is a uint32.
  return z / 4294967296;
}

/**
 * Deprecated alias for {@link randomAt}.
 *
 * E §8.4 calls this `randomAt`. Kept as a re-export so a rename does not ripple, and named
 * without "sfc32" because the construction is a counter-mode hash, not SFC32 — the original
 * name described an implementation that never worked.
 *
 * @deprecated Use `randomAt`.
 */
export const sfc32Counter = randomAt;

/* ------------------------------------------------------------------ *
 * Permutation
 * ------------------------------------------------------------------ */

/**
 * Fisher–Yates over `randomAt`.
 *
 * Unbiased: at step `i` the swap index is drawn uniformly from `[0, i]`, which is the property
 * that makes every one of the `n!` orders equally likely. Drawing from `[0, n)` at every step
 * instead — the common mistake — biases the result towards a few orders.
 */
export function permute<T>(
  items: readonly T[],
  key: readonly [number, number, number, number],
): T[] {
  const a = items.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(randomAt(key, i) * (i + 1));
    const tmp = a[i]!;
    a[i] = a[j]!;
    a[j] = tmp;
  }
  return a;
}

/* ------------------------------------------------------------------ *
 * Self-checks
 *
 * Exported so the same assertions can run inside QuickJS and in a browser, where the test
 * runner is not available. That is what turns "identical across platforms" from a claim into
 * something CI can check on all three (E §8, ADR-006).
 * ------------------------------------------------------------------ */

/** The same `(seed, salt)` always yields the same permutation. */
export function testPermuteDeterminism(): boolean {
  const items = Array.from({ length: 10 }, (_, i) => i);
  const key = deriveKey('seed123', 'test');
  const a = permute(items, key);
  const b = permute(items, key);
  return a.every((v, i) => v === b[i]);
}

/** The counter must change the draw. This is the regression guard for the bug above. */
export function testCounterVariesOutput(): boolean {
  const key = deriveKey('seed123', 'test');
  const draws = new Set(Array.from({ length: 32 }, (_, i) => randomAt(key, i)));
  return draws.size === 32;
}

/**
 * χ² goodness-of-fit over 10,000 seeds: where does item 0 land in a 10-item shuffle?
 *
 * A uniform generator puts it in each of the 10 positions about 1,000 times. The broken
 * implementation this replaced scored ~20,012 against a critical value of 21.7.
 */
export function testDistributionUniformity(): { uniform: boolean; chisq: number } {
  const positions = Array.from({ length: 10 }, () => 0);
  const iterations = 10_000;
  const expected = iterations / 10;

  for (let s = 0; s < iterations; s++) {
    const perm = permute(
      Array.from({ length: 10 }, (_, i) => i),
      deriveKey(`seed${s}`, 'test'),
    );
    const pos = perm.indexOf(0);
    positions[pos] = (positions[pos] ?? 0) + 1;
  }

  let chisq = 0;
  for (const count of positions) {
    const diff = count - expected;
    chisq += (diff * diff) / expected;
  }

  // 9 degrees of freedom: p=0.05 -> 16.92, p=0.01 -> 21.67. The seed set is fixed, so this is
  // deterministic rather than flaky, and 21.67 leaves no room for a degenerate generator.
  return { uniform: chisq < 21.67, chisq };
}

/**
 * Coverage of the permutation space: how many of the 120 orders of 5 items appear over 500
 * seeds? A correct generator finds essentially all of them; the broken one found 10.
 */
export function testPermutationCoverage(): { distinct: number; total: number } {
  const seen = new Set<string>();
  for (let s = 0; s < 500; s++) {
    seen.add(permute([1, 2, 3, 4, 5], deriveKey(`s${s}`, 'x')).join(','));
  }
  return { distinct: seen.size, total: 120 };
}
