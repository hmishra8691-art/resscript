/**
 * Primitives shared by every part of the model.
 */

export type JsonPrimitive = string | number | boolean | null;

export type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export interface JsonObject {
  readonly [key: string]: JsonValue;
}

/**
 * A logic expression, Deliverable D's typed AST.
 *
 * WHY this is structural-but-opaque here: `packages/logic` owns the AST — its node union,
 * its type checker and its evaluator (ADR-004, milestone P1-06). Restating that union in
 * `packages/schema` would create exactly the drift ADR-010 exists to prevent, and schema
 * cannot depend on logic without making the two un-versionable separately. What schema needs
 * is narrower: carry the AST losslessly through parse/serialize/migrate, and assert the one
 * envelope invariant that makes it recognizable as an AST node at all — a string `op`.
 * The checker in P1-06 is where a wrong `op` becomes an error.
 */
export interface Expr {
  readonly op: string;
  readonly [key: string]: JsonValue | undefined;
}

/**
 * A reference to a translatable string (Deliverable C §16). Never inline text: translation is
 * an export/import of a flat key-value file, completeness is computable and can gate publish,
 * and the compiled artifact ships only the respondent's language.
 */
export interface I18nRef {
  readonly key: string;
}

/**
 * A value that may be static or computed at runtime. Deliverable C §5.1 requires every
 * behavioural field on an option to accept either, so this is one shape rather than a
 * nullable-literal-plus-nullable-condition pair (which would make "both set" expressible).
 */
export type ConditionalValue<T extends JsonValue> =
  | { readonly literal: T }
  | { readonly condition: Expr };

/**
 * Randomization spec — Deliverable C §12. Used identically on options, rows, columns, page
 * children and block children, which is why it is one type and not five.
 */
export interface RandomizationSpec {
  readonly mode: RandomizationMode;
  /** For `subset`: how many items to keep. Meaningless (and ignored) for other modes. */
  readonly n?: number | null;
  /**
   * Shared group: two randomizations with the same `group_ref` produce the same order.
   * This is the "brand list in the same random order across every question in a battery"
   * requirement, and it is nearly free because order derives from (seed, salt).
   */
  readonly group_ref?: string | null;
  /** Honour `option.anchor` (first / last / fixed:n) when shuffling. */
  readonly respect_anchors?: boolean;
  /** Shuffle only within contiguous sub-blocks, e.g. keep competitor brands grouped. */
  readonly sub_blocks?: readonly RandomizationSubBlock[];
  /**
   * Stable salt so an order is reproducible from the session seed alone (ADR-006). Without
   * this, replaying a session cannot reproduce what the respondent actually saw.
   */
  readonly seed_salt?: string | null;
  /**
   * `rotate`, `fixed_order_list` and `even_distribution` distribute *across* respondents,
   * so they are counter-backed (ADR-008) rather than seed-derived. Recorded here because
   * "randomize" and "randomize evenly" are different features that users conflate.
   */
  readonly even_distribution?: boolean;
  /** For `fixed_order_list`: the explicit orders to rotate respondents through. */
  readonly fixed_orders?: readonly (readonly string[])[];
}

export const RANDOMIZATION_MODES = [
  'none',
  'shuffle',
  'subset',
  'rotate',
  'reverse_half',
  'fixed_order_list',
] as const;
export type RandomizationMode = (typeof RANDOMIZATION_MODES)[number];

export interface RandomizationSubBlock {
  /** Item refs (options/rows/columns) or child node refs that shuffle only among themselves. */
  readonly refs: readonly string[];
}

/** `none | first | last | fixed:<n>` — where an item sits when its siblings are shuffled. */
export type AnchorSpec = 'none' | 'first' | 'last' | `fixed:${number}`;

export const ANCHOR_PATTERN = '^(none|first|last|fixed:[0-9]{1,4})$';

/** An ISO-8601 UTC instant. There are no local timestamps in this model by design. */
export type Iso8601 = string;
