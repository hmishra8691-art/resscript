/**
 * Options, rows and columns as a plugin sees them — Deliverable F §1.1 (`AuthoredItem`) and
 * §1.2 (`ResolvedItem`), over `03-survey-schema.md` §5.1.
 *
 * Two shapes, and the split is the whole point:
 *
 *  - `AuthoredItem` is what `declareVariables` and `staticChecks` see. It is the *authored*
 *    item: codes, refs, label keys, anchors. It has no `visible`/`enabled`, because those are
 *    conditions at authoring time and a compile-time function must not pretend to know how
 *    they will evaluate.
 *  - `ResolvedItem` is what a renderer and a validator see: one language, randomization
 *    applied, option-level `behaviour` already evaluated to booleans.
 *
 * A renderer that could reach the authored model would be able to read a condition it is not
 * allowed to evaluate, and a `declareVariables` that could read a resolved item would depend
 * on the respondent — which is exactly the purity rule F §1.1 makes non-negotiable.
 */

import type { JsonObject } from '@resscript/schema';
import type { I18nKey } from './meta.js';

/**
 * An exported value. Numeric by default (schema §5.1's `code`), string when the author set a
 * `value_override` to match a client's existing tracker layout.
 *
 * NOTE — this is wider than `@resscript/schema`'s `EnumDomainEntry.code`, which is `number`.
 * Deliverable F §1.1 types `enumDomain[].code` as `number | string` and F §2's reference
 * implementation writes `o.valueOverride ?? o.code` into it, so the plugin contract has to
 * carry the wider type. `toPlannedVariables` (see `../interop.ts`) is where the narrowing
 * happens and where the mismatch is reported rather than silently coerced.
 */
export type OptionCode = number | string;

export interface AuthoredItemMedia {
  readonly imageAssetId?: string | null;
  readonly altKey?: I18nKey | null;
}

/** An authored option, row or column. Mirrors schema's `QuestionItem`, minus the ids. */
export interface AuthoredItem {
  /** The human handle within the question (`o1`, `r2`, `c3`). Unique per question per kind. */
  readonly ref: string;
  /**
   * The exported value. **Stable and independent of `position`** — schema §5.1 calls
   * confusing the two "a classic data disaster", and this contract is where that distinction
   * either survives or dies: variable names and enum domains are built from `code`.
   */
  readonly code: number;
  readonly labelKey: I18nKey;
  /** Display position. Present so an editor can show it; never read by `declareVariables`. */
  readonly position: number;
  /** A custom exported value distinct from `code`, for legacy tracker compatibility. */
  readonly valueOverride?: string | null;
  /** Selecting this clears all others — "None of these", "Don't know". */
  readonly exclusive?: boolean;
  /** Marks the item whose selection opens an open-ended "please specify" field. */
  readonly otherSpecify?: boolean;
  readonly anchor?: string;
  readonly media?: AuthoredItemMedia | null;
  /** Author-attached analysis payload (a price point, a brand id). Readable by masks/logic. */
  readonly meta?: JsonObject;
}

export interface ResolvedItemMedia {
  /** Already resolved from an asset id to a URL by the runtime; plugins never resolve assets. */
  readonly imageUrl?: string | null;
  readonly altKey?: I18nKey | null;
}

/**
 * An item with i18n resolved, masks applied and `behaviour` evaluated to concrete booleans.
 */
export interface ResolvedItem {
  readonly ref: string;
  readonly code: number;
  readonly labelKey: I18nKey;
  readonly position: number;
  readonly valueOverride?: string | null;
  readonly exclusive?: boolean;
  readonly otherSpecify?: boolean;
  readonly meta?: JsonObject;
  readonly media?: ResolvedItemMedia | null;
  /** `false` = removed by a mask or a display condition. Not rendered at all. */
  readonly visible: boolean;
  /** `false` = rendered but disabled *in the accessibility tree*, not merely greyed (F §8). */
  readonly enabled: boolean;
  readonly preselected: boolean;
}

/** The value this item stores when selected: the override if present, else the code. */
export function itemCode(item: AuthoredItem | ResolvedItem): OptionCode {
  const override = item.valueOverride;
  return override === undefined || override === null || override === '' ? item.code : override;
}

/**
 * Total order over items for *declaration* purposes: by `code`, then by `ref`.
 *
 * WHY declarations are sorted by code rather than kept in authored order — this is the single
 * most consequential decision in this file, and it is what makes F §9's
 * `assertOrderIndependent` satisfiable at all:
 *
 * `declareVariables` output *is* the export schema (ADR-002/ADR-007). If declarations came out
 * in authored order, then dragging option 7 to the top of the list would reorder the emitted
 * array, renumber `export.order`, and permute an `enumDomain` — a byte-level change to the
 * export contract caused by a purely cosmetic edit. In a tracker that is a wave-over-wave
 * column shift, i.e. the data disaster schema §5.1 is written to prevent, arriving through a
 * different door.
 *
 * Display order is not lost: it lives in `position` and in `RandomizationSpec`, both of which
 * the *renderer* reads through `ctx.order`. Codes order the data; positions order the pixels.
 */
export function compareItemsForDeclaration(a: AuthoredItem, b: AuthoredItem): number {
  if (a.code !== b.code) return a.code - b.code;
  return a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0;
}

/** `[...items].sort(compareItemsForDeclaration)`, without mutating the caller's array. */
export function itemsForDeclaration(
  items: readonly AuthoredItem[],
): readonly AuthoredItem[] {
  return [...items].sort(compareItemsForDeclaration);
}
