/**
 * Masking — Deliverable C §15.
 *
 * A mask restricts which options / rows / columns a respondent sees, based on earlier
 * answers ("ask only about the brands selected in Q3").
 */

import type { MaskId, OptionId, VariableId } from '../ids.js';
import type { Expr } from './common.js';

export const MASK_TARGETS = ['options', 'rows', 'columns'] as const;
export type MaskTarget = (typeof MASK_TARGETS)[number];

export const MASK_MODES = ['include', 'exclude'] as const;
export type MaskMode = (typeof MASK_MODES)[number];

export type MaskSource =
  /** Keep (or drop) the items whose code appears in a set variable's value. */
  | { readonly kind: 'selected_in'; readonly variable_id: VariableId }
  /** Keep (or drop) the items whose code does *not* appear — "brands you did not pick". */
  | { readonly kind: 'not_selected_in'; readonly variable_id: VariableId }
  /** An explicit static list, for the cases that are genuinely hand-picked. */
  | { readonly kind: 'explicit'; readonly item_ids: readonly OptionId[] }
  /** An AST evaluated once per item, with `item` / `item_attr` bound to that item. */
  | { readonly kind: 'expression_per_item'; readonly condition: Expr };

export const MASK_FALLBACKS = ['skip_question', 'show_all', 'terminate'] as const;
export type MaskFallback = (typeof MASK_FALLBACKS)[number];

/**
 * `when_empty` is required and has no default.
 *
 * This is the field most often forgotten in masking implementations, and forgetting it
 * produces the classic dead end: the mask resolves to zero items, the respondent is shown an
 * empty required question, and cannot proceed. There is no safe default — `show_all` is
 * wrong for a brand battery, `skip_question` is wrong for a screener, `terminate` is wrong
 * for both — so the programmer has to decide, and the compiler blocks publish if they did not
 * (C §17).
 */
export interface MaskFallbackSpec {
  readonly when_empty: MaskFallback;
}

export interface Mask {
  readonly id: MaskId;
  readonly applies_to: MaskTarget;
  readonly mode: MaskMode;
  readonly source: MaskSource;
  readonly fallback: MaskFallbackSpec;
}
