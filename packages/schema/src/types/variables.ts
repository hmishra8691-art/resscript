/**
 * The variable registry — Deliverable C §1 and §4.
 *
 * The idea that makes the whole model coherent: **a question is a UI construct, a variable is
 * a data construct, and a question declares which variables it emits.** Logic, piping,
 * validation, quotas, masking and export all operate on variables and never on questions,
 * which is why none of those engines needs an `if (question_type === 'matrix')` branch.
 */

import type { OptionId, QuestionId, VariableId } from '../ids.js';
import type { Expr, I18nRef, JsonObject } from './common.js';

export const VARIABLE_KINDS = ['response', 'hidden', 'derived', 'system', 'quota', 'design'] as const;
export type VariableKind = (typeof VARIABLE_KINDS)[number];

export const VARIABLE_TYPES = ['enum', 'boolean', 'number', 'text', 'date', 'set', 'object'] as const;
export type VariableType = (typeof VARIABLE_TYPES)[number];

/**
 * Which part of a question produced a variable. This is what `deriveVariableName` reads, and
 * it is what makes renaming a `ref` a metadata edit: the *name* is a function of
 * (ref, part), so changing the ref recomputes every name with no textual substitution.
 *
 * `code` rather than `position` is carried deliberately — see `deriveVariableName`.
 */
export type VariablePart =
  /** The question emits exactly one variable: `Q1`. Single select, numeric, text, NPS score. */
  | { readonly kind: 'scalar' }
  /** One boolean per option in a multi-select fan-out: `Q2r1`. */
  | { readonly kind: 'option'; readonly option_id: OptionId; readonly code: number }
  /** One variable per matrix row / numeric-list row: `Q3r1`. */
  | { readonly kind: 'row'; readonly row_id: OptionId; readonly code: number }
  /** One variable per matrix column, for column-oriented grids: `Q3c1`. */
  | { readonly kind: 'column'; readonly column_id: OptionId; readonly code: number }
  /** A full row x column grid cell: `Q3r1c2`. */
  | {
      readonly kind: 'cell';
      readonly row_id: OptionId;
      readonly row_code: number;
      readonly column_id: OptionId;
      readonly column_code: number;
    }
  /**
   * The open-ended companion to a selectable item: `Q6_other`, or `Q2r5_other` when the
   * "other" is one option of a fan-out.
   */
  | { readonly kind: 'other_specify'; readonly option_id?: OptionId; readonly code?: number }
  /**
   * The derived `set<enum>` view over a boolean fan-out: `Q2`. The compiler materializes it
   * as a derived variable collecting the true booleans, so `Q2 ANY_OF [1,3]` and
   * `Q2r1 == true` are the same machinery.
   */
  | { readonly kind: 'set_view' }
  /**
   * A plugin-declared companion variable, named `{ref}_{suffix}`. NPS's band variable is the
   * first-party example. Kept as an explicit suffix rather than a free-form name so the
   * export contract stays derivable from the ref.
   */
  | { readonly kind: 'suffix'; readonly suffix: string }
  /** A design task slot: `MD_t1_best`. Required for MaxDiff/conjoint estimation. */
  | { readonly kind: 'design_task'; readonly task: number; readonly role: string };

export interface VariableSource {
  readonly question_id?: QuestionId;
  readonly part: VariablePart;
  /** 1-based loop iteration, when this variable lives inside a loop (C §13). */
  readonly iteration?: number;
}

/** One entry of an enum variable's ordered code/label domain. */
export interface EnumDomainEntry {
  readonly code: number;
  readonly label_key: string;
}

export interface VariableStorage {
  /** The exported value for a boolean fan-out member or a scalar enum. */
  readonly code?: number | null;
  readonly label_key?: string | null;
}

export interface VariableExport {
  readonly include: boolean;
  /**
   * The export column header. Defaults to the derived variable name; overridable because
   * clients sometimes require a fixed tracker layout that predates this platform. Unique
   * per version (Deliverable B `variables_export_col_key`), which is what keeps a client's
   * column layout from shifting under them.
   */
  readonly column: string;
  readonly label?: string | null;
  readonly label_key?: string | null;
}

export interface Variable {
  readonly id: VariableId;
  /**
   * Derived from (ref, part) by `deriveVariableName`, but *stored* so that it is diffable
   * and greppable — "where does Q3r2 come from" must be answerable with a text search.
   */
  readonly name: string;
  readonly kind: VariableKind;
  readonly type: VariableType;
  /** Present for `response` and `design` variables; absent for hidden/system variables. */
  readonly source?: VariableSource;
  /** Required when `type` is `enum` or `set` — an enum with no domain has no meaning. */
  readonly enum_domain?: readonly EnumDomainEntry[] | null;
  /** Required exactly when `kind` is `derived` (Deliverable B `vars_derived_expr`). */
  readonly expression?: Expr | null;
  readonly storage?: VariableStorage;
  readonly export: VariableExport;
  /**
   * Drives redaction in debug traces, exclusion from vendor callback URLs, and separately
   * permissioned exports. A first-class flag rather than an afterthought because inferring
   * it later is guesswork over customer data.
   */
  readonly pii: boolean;
  /** `false` = evaluated per page, never stored. Only legal for `derived` and `system`. */
  readonly persist: boolean;
  /** Free-form annotation carried for the editor; never interpreted by an engine. */
  readonly meta?: JsonObject;
  /** Human label for the studio's variable panel, when it differs from the export label. */
  readonly title?: I18nRef | null;
}
