/**
 * Validation rules — Deliverable C §14.
 */

import type { ValidationId } from '../ids.js';
import type { Expr, JsonObject } from './common.js';

export const VALIDATION_TYPES = [
  'required',
  'min_selections',
  'max_selections',
  'min_value',
  'max_value',
  'sum_equals',
  'regex',
  'expression',
  'cross_question',
] as const;
export type ValidationType = (typeof VALIDATION_TYPES)[number];

/**
 * `scope` distinguishes validations that can only run once every answer on the page exists
 * (sum-to-100 across a numeric list) from per-field ones. It matters beyond timing: the two
 * need different UI placement for the error message, and a page-scoped error attached to a
 * single field is how respondents get stuck without knowing why.
 */
export const VALIDATION_SCOPES = ['field', 'page'] as const;
export type ValidationScope = (typeof VALIDATION_SCOPES)[number];

export interface ValidationRule {
  readonly id: ValidationId;
  readonly type: ValidationType;
  /**
   * Type-specific parameters. Deliberately open JSON rather than a per-type union: the set
   * of validation types is extended by question plugins (Deliverable F), and a closed union
   * here would make `packages/schema` a blocker for every new plugin.
   *
   * `type: "expression"` carries `{ condition: Expr }`, which is what makes arbitrary
   * validation expressible with no custom JavaScript for the overwhelming majority of cases.
   */
  readonly params?: JsonObject;
  /** An AST hoisted out of `params` for `expression` / `cross_question`, for convenience. */
  readonly condition?: Expr | null;
  readonly message_key?: string | null;
  readonly scope?: ValidationScope;
}
