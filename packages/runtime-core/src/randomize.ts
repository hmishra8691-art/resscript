/**
 * Task 55: randomization, per Deliverable E §8 and schema C §12.
 *
 * Runs after masking (E §9.2) and orders the surviving items.
 *
 * Two families of mode, and conflating them is the mistake this module is shaped to prevent:
 *
 *   SEED-DERIVED — `shuffle`, `subset`, `reverse_half`. Order is a pure function of
 *   `(seed, salt)`, so nothing is stored and every session replays (ADR-006).
 *
 *   COUNTER-BACKED — `rotate`, `fixed_order_list`, and a randomizer's `even_distribution`.
 *   These distribute *across* respondents, which needs shared state, so they run on the quota
 *   counter infrastructure (ADR-008) and persist their choice as a `design` variable. They are
 *   not implementable here and this module says so rather than silently falling back to the
 *   PRNG — "randomize" and "randomize evenly" are different features that users conflate, and
 *   a silent substitution would produce an unbalanced cell nobody notices until fieldwork ends.
 */

import { deriveKey, permute, sfc32Counter } from './prng.js';

/* ------------------------------------------------------------------ *
 * Structural types — mirrors of `RandomizationSpec` and `CompiledItem`
 * ------------------------------------------------------------------ */

export type RandomizationMode =
  | 'none'
  | 'shuffle'
  | 'subset'
  | 'rotate'
  | 'reverse_half'
  | 'fixed_order_list';

/** `none | first | last | fixed:<n>`, where `n` is a 1-based display position. */
export type AnchorSpec = 'none' | 'first' | 'last' | string;

export interface RandomizationSubBlock {
  /** Item refs that shuffle only among themselves, e.g. keeping competitor brands grouped. */
  readonly refs: readonly string[];
}

export interface RandomizationSpec {
  readonly mode: RandomizationMode;
  /** For `subset`: how many items to keep. Ignored by other modes. */
  readonly n?: number | null;
  /** Two specs sharing a `group_ref` produce the same order (E §8.3). */
  readonly group_ref?: string | null;
  readonly respect_anchors?: boolean;
  readonly sub_blocks?: readonly RandomizationSubBlock[];
  /** Stable salt, so an order is reproducible from the session seed alone (ADR-006). */
  readonly seed_salt?: string | null;
  readonly even_distribution?: boolean;
  readonly fixed_orders?: readonly (readonly string[])[];
}

export interface RandomizeItem {
  readonly id: string;
  readonly code: number;
  readonly ref?: string;
  readonly anchor?: AnchorSpec;
  readonly position?: number;
}

/**
 * A shared-order group: the group's canonical full item list, declared once in the artifact
 * in code order.
 */
export interface OrderGroup<T extends RandomizeItem = RandomizeItem> {
  readonly ref: string;
  readonly canonical: readonly T[];
}

export interface RandomizeResult<T extends RandomizeItem = RandomizeItem> {
  readonly items: readonly T[];
  /**
   * For `subset`: the codes actually presented. Recorded as a `design` variable because
   * "which subset did they see" is required for analysis (E §8.4) and is not otherwise
   * recoverable once the item list changes.
   */
  readonly subset_codes?: readonly number[];
  /** Set when a counter-backed mode was requested but no counter was supplied. */
  readonly needs_counter?: boolean;
  readonly event?: string;
}

/* ------------------------------------------------------------------ *
 * Salt derivation (E §8.2)
 * ------------------------------------------------------------------ */

/**
 * The salt that scopes a draw.
 *
 * A `group_ref` wins over an explicit `seed_salt`, because sharing the group is the whole
 * point: two questions in a battery must derive the same key. `axis_key` (e.g. `qst_5.options`)
 * is the fallback, so two axes of one question do not share an order by accident.
 */
export function saltFor(spec: RandomizationSpec, axis_key: string): string {
  if (spec.group_ref) return `grp:${spec.group_ref}`;
  if (spec.seed_salt) return spec.seed_salt;
  return axis_key;
}

/* ------------------------------------------------------------------ *
 * Anchors (E §8.4)
 * ------------------------------------------------------------------ */

function fixedIndex(anchor: AnchorSpec | undefined): number | null {
  if (typeof anchor !== 'string' || !anchor.startsWith('fixed:')) return null;
  const n = Number.parseInt(anchor.slice('fixed:'.length), 10);
  return Number.isFinite(n) && n >= 1 ? n : null;
}

/**
 * Apply anchors *after* permutation.
 *
 * `first` and `last` items keep their declared relative order among themselves — shuffling
 * them would defeat the anchor. `fixed:n` items are then spliced in at their 1-based absolute
 * position in ascending `n`, so two fixed items cannot fight over a slot.
 *
 * `RANDOMIZE Q9 OPTIONS KEEP OPTION 1 FIRST` (D §6.3) is sugar for `anchor: 'first'`, which is
 * why the DSL and the schema agree with no translation layer.
 */
export function applyAnchors<T extends RandomizeItem>(
  shuffled: readonly T[],
  declared: readonly T[],
): T[] {
  const declaredOrder = (xs: readonly T[]) =>
    [...xs].sort((a, b) => declared.indexOf(a) - declared.indexOf(b));

  const first = declaredOrder(shuffled.filter(i => i.anchor === 'first'));
  const last = declaredOrder(shuffled.filter(i => i.anchor === 'last'));
  const fixed = shuffled
    .filter(i => fixedIndex(i.anchor) !== null)
    .sort((a, b) => fixedIndex(a.anchor)! - fixedIndex(b.anchor)!);
  const free = shuffled.filter(
    i => i.anchor !== 'first' && i.anchor !== 'last' && fixedIndex(i.anchor) === null,
  );

  const out: T[] = [...first, ...free, ...last];
  for (const f of fixed) {
    const idx = Math.min(Math.max(fixedIndex(f.anchor)! - 1, 0), out.length);
    out.splice(idx, 0, f);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Sub-blocks
 * ------------------------------------------------------------------ */

/**
 * Shuffle within each contiguous sub-block, preserving the block boundaries.
 *
 * Each block draws from its own salt so that adding a brand to one block does not reorder
 * another — the alternative makes a tracker's wave-on-wave orders incomparable.
 */
function permuteSubBlocks<T extends RandomizeItem>(
  items: readonly T[],
  blocks: readonly RandomizationSubBlock[],
  seed: string,
  salt: string,
): T[] {
  const out = [...items];
  for (const [b, block] of blocks.entries()) {
    const refs = new Set(block.refs);
    const positions: number[] = [];
    const members: T[] = [];
    out.forEach((item, i) => {
      if (item.ref !== undefined && refs.has(item.ref)) {
        positions.push(i);
        members.push(item);
      }
    });
    if (members.length < 2) continue;
    const shuffled = permute(members, deriveKey(seed, `${salt}#sub${b}`));
    positions.forEach((pos, k) => {
      out[pos] = shuffled[k]!;
    });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * The entry point
 * ------------------------------------------------------------------ */

/**
 * Order `items` for one axis of one question.
 *
 * `group` is the shared-order group when `spec.group_ref` is set. Supplying it is what makes
 * E §8.3 work, and omitting it when a `group_ref` is set silently degrades a battery to
 * independent orders — so that case emits an event rather than passing quietly.
 */
export function randomize<T extends RandomizeItem>(
  items: readonly T[],
  spec: RandomizationSpec,
  seed: string,
  opts: { axis_key: string; group?: OrderGroup<T> },
): RandomizeResult<T> {
  if (spec.mode === 'none' || items.length < 2) {
    return { items };
  }

  // Counter-backed modes need cross-respondent state (ADR-008). Say so; do not substitute.
  if (spec.mode === 'rotate' || spec.mode === 'fixed_order_list' || spec.even_distribution) {
    return {
      items,
      needs_counter: true,
      event: 'randomize.needs_counter',
    };
  }

  const salt = saltFor(spec, opts.axis_key);
  const key = deriveKey(seed, salt);

  let ordered: readonly T[];
  let event: string | undefined;

  if (spec.group_ref) {
    if (!opts.group) {
      // Falling back to an independent shuffle here is exactly the bug `group_ref` exists to
      // prevent, so it is recorded rather than silent.
      ordered = permute(items, key);
      event = 'randomize.group_missing';
    } else {
      // Permute the group's CANONICAL list, then filter to the items present.
      //
      // This is the detail simpler tools get wrong. Q5 and Q6 may share a group but be masked
      // differently; permuting each question's already-filtered list independently gives them
      // different orders whenever the masks differ, which is precisely what a shared group is
      // for. Permute first, filter second.
      const present = new Set(items.map(i => i.code));
      const canonicalOrder = permute(opts.group.canonical, key).filter(i => present.has(i.code));
      // Any item not in the canonical list (an artifact/group mismatch) is appended in
      // declared order rather than dropped: dropping it would remove an answerable option.
      const seen = new Set(canonicalOrder.map(i => i.code));
      ordered = [...canonicalOrder, ...items.filter(i => !seen.has(i.code))];
    }
  } else if (spec.sub_blocks && spec.sub_blocks.length > 0) {
    ordered = permuteSubBlocks(items, spec.sub_blocks, seed, salt);
  } else if (spec.mode === 'reverse_half') {
    // One bit from the PRNG. Half of respondents see the declared order, half the reverse —
    // enough to cancel primacy effects on a scale without a full shuffle.
    ordered = sfc32Counter(key, 0) < 0.5 ? items : [...items].reverse();
  } else {
    ordered = permute(items, key);
  }

  const anchored = spec.respect_anchors ? applyAnchors(ordered, items) : [...ordered];

  if (spec.mode === 'subset') {
    const n = spec.n ?? anchored.length;
    const kept = anchored.slice(0, Math.max(0, Math.min(n, anchored.length)));
    return {
      items: kept,
      subset_codes: kept.map(i => i.code),
      ...(event ? { event } : {}),
    };
  }

  return { items: anchored, ...(event ? { event } : {}) };
}
