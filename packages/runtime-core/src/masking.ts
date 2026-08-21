/**
 * Task 56: masking and item resolution, per Deliverable E §9.2 and schema C §15.
 *
 * Masking resolves *which items exist* for a question, before logic evaluates option states
 * and before randomization filters to the group order (E §8.3). The order is fixed:
 *
 *   1. base items = the question's options / rows / columns from the artifact
 *   2. apply masks in artifact order
 *   3. if the result is empty -> apply `fallback.when_empty`
 *   4. option_state rules evaluate over the surviving items only
 *   5. randomization orders the surviving items
 *
 * Steps 4 and 5 are the caller's; this module owns 1–3.
 *
 * `fallback.when_empty` being required with no default (C §15) is the whole point. It is the
 * field most often forgotten, and forgetting it produces the classic dead end: the mask
 * resolves to zero items, the respondent gets an empty required question, and cannot proceed.
 * No default is safe — `show_all` is wrong for a brand battery, `skip_question` is wrong for a
 * screener, `terminate` is wrong for both.
 *
 * ---
 *
 * NOTE ON ORDERING. E §9.2 says "apply masks in artifact order (compiler-ordered by rule
 * order_key)". `Mask` carries no `order_key` field — the compiler bakes the order into the
 * array, so the runtime applies them positionally and must not sort. An earlier draft of this
 * module required a `mask.order_key`, which no artifact would have supplied.
 */

/* ------------------------------------------------------------------ *
 * Structural types
 *
 * Mirrors of `@resscript/schema`'s `Mask` and `CompiledItem`. `code` is a **number**: C §5.1
 * keeps `code` (the exported value) and `position` (the display slot) as separate fields
 * precisely so that randomizing display order cannot silently rewrite exported values.
 * ------------------------------------------------------------------ */

export type MaskTarget = 'options' | 'rows' | 'columns';
export type MaskMode = 'include' | 'exclude';
export type MaskFallback = 'skip_question' | 'show_all' | 'terminate';

export type MaskSource =
  /** Keep (or drop) the items whose `code` appears in a set variable's value. */
  | { readonly kind: 'selected_in'; readonly variable_id: string }
  /** Keep (or drop) the items whose `code` does *not* appear — "brands you did not pick". */
  | { readonly kind: 'not_selected_in'; readonly variable_id: string }
  /** An explicit static list, addressed by item **id** rather than code. */
  | { readonly kind: 'explicit'; readonly item_ids: readonly string[] }
  /** An AST evaluated once per item, with `item` bound. Evaluation is injected. */
  | { readonly kind: 'expression_per_item'; readonly condition: unknown };

export interface Mask {
  readonly id: string;
  readonly applies_to: MaskTarget;
  readonly mode: MaskMode;
  readonly source: MaskSource;
  readonly fallback: { readonly when_empty: MaskFallback };
}

export interface MaskItem {
  readonly id: string;
  readonly code: number;
  readonly ref?: string;
  readonly position?: number;
}

export interface MaskContext {
  /** Session variable state. A set variable's value is an array of codes. */
  readonly vars: { readonly [variableId: string]: unknown };
  /**
   * Evaluate an `expression_per_item` condition with `item` bound. Injected because rule
   * evaluation lives in `packages/logic` and `runtime-core` must stay loadable in QuickJS.
   * `null` (UNKNOWN) is treated as "does not match", the conservative direction.
   */
  readonly evalPerItem?: (condition: unknown, item: MaskItem) => boolean | null;
}

export interface MaskResult<T extends MaskItem = MaskItem> {
  readonly items: readonly T[];
  /** Set when a mask emptied the set and its fallback fired. */
  readonly fallback_applied?: MaskFallback;
  /** The mask that emptied the set, for the trace. */
  readonly fallback_mask_id?: string;
  /** Emitted for `show_all` (E §9.2) so a silently widened question is visible in the log. */
  readonly event?: string;
  /**
   * True when the question must not be shown and its variables stay null. Recorded in the
   * trace as `masked_empty` — NOT as a respondent skip, which would be a different fact.
   */
  readonly skip_question?: boolean;
  /** True when the fallback demands a disposition. The caller owns the termination. */
  readonly terminate?: boolean;
}

/* ------------------------------------------------------------------ *
 * Source resolution
 * ------------------------------------------------------------------ */

/**
 * The set of codes a `selected_in` / `not_selected_in` source names.
 *
 * A set variable's value is an array of codes; a single-select's is one code. Both are
 * normalized to a numeric set. Codes are compared numerically after coercion because a
 * multi-select's stored value may carry codes as strings depending on the transport.
 */
function selectedCodes(vars: MaskContext['vars'], variable_id: string): Set<number> {
  const value = vars[variable_id];
  if (value == null) return new Set();
  const raw = Array.isArray(value) ? value : [value];
  const out = new Set<number>();
  for (const v of raw) {
    const n = typeof v === 'number' ? v : Number(v);
    if (Number.isFinite(n)) out.add(n);
  }
  return out;
}

/** Does `item` match the mask's source, independent of include/exclude? */
function matchesSource<T extends MaskItem>(
  source: MaskSource,
  item: T,
  ctx: MaskContext,
): boolean {
  switch (source.kind) {
    case 'selected_in':
      return selectedCodes(ctx.vars, source.variable_id).has(item.code);

    case 'not_selected_in':
      // The complement within the question's own item set, which is what makes this
      // different from `include`/`exclude` inversion: the domain is the items, not the
      // variable's enum.
      return !selectedCodes(ctx.vars, source.variable_id).has(item.code);

    case 'explicit':
      // Addressed by item id, not code. C §15 says `item_ids`, and an authored hand-picked
      // list survives a code renumber this way.
      return source.item_ids.includes(item.id);

    case 'expression_per_item': {
      if (!ctx.evalPerItem) return false;
      // UNKNOWN does not match. Guessing would hide or reveal an item on unknown data.
      return ctx.evalPerItem(source.condition, item) === true;
    }
  }
}

/* ------------------------------------------------------------------ *
 * Application
 * ------------------------------------------------------------------ */

/**
 * Apply the masks that target one axis, in artifact order.
 *
 * Emptiness is absorbing — `include ∩ ∅` and `exclude` over `∅` are both `∅` — so the first
 * mask to empty the set is the one that determines the outcome, and its `fallback.when_empty`
 * is the one that fires. Later masks are not applied, including after `show_all` reverts to
 * the base items: re-applying them would just re-empty the set, and `show_all` means "the
 * respondent must see something".
 */
export function applyMasking<T extends MaskItem>(
  baseItems: readonly T[],
  masks: readonly Mask[],
  axis: MaskTarget,
  ctx: MaskContext,
): MaskResult<T> {
  // Positional order is the artifact's order. Do not sort.
  const applicable = masks.filter(m => m.applies_to === axis);

  let items: readonly T[] = baseItems;

  for (const mask of applicable) {
    items = items.filter(item => {
      const matched = matchesSource(mask.source, item, ctx);
      return mask.mode === 'include' ? matched : !matched;
    });

    if (items.length === 0) {
      switch (mask.fallback.when_empty) {
        case 'skip_question':
          return {
            items: [],
            fallback_applied: 'skip_question',
            fallback_mask_id: mask.id,
            skip_question: true,
          };
        case 'show_all':
          return {
            items: baseItems,
            fallback_applied: 'show_all',
            fallback_mask_id: mask.id,
            event: 'mask.fallback_show_all',
          };
        case 'terminate':
          return {
            items: [],
            fallback_applied: 'terminate',
            fallback_mask_id: mask.id,
            terminate: true,
          };
      }
    }
  }

  return { items };
}
