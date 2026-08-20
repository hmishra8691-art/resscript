/**
 * Validation and the resolved question — Deliverable F §1.2.
 *
 * `ResolvedQuestion` is the boundary between authoring and running. A renderer and a validator
 * see *only* this: one language, randomization applied, masks applied, option `behaviour`
 * evaluated to booleans, and the declared variable names already computed. Neither ever
 * touches the authoring model, which is what keeps "the renderer cannot depend on a condition
 * it is not allowed to evaluate" true by construction rather than by review.
 */

import type { JsonValue } from '@resscript/schema';
import type { ResolvedItem } from './items.js';
import type { I18nKey } from './meta.js';
import type { CellControl, ComposeScope } from './variables.js';

export interface ResolvedQuestionVariables {
  readonly self?: string;
  /** The question-level other-specify (`Q6_other`), when there is exactly one. */
  readonly other?: string;
  /** `rowRef | optionRef -> variable name`, so a validator never string-builds a name. */
  readonly byRow: Readonly<Record<string, string>>;
  /**
   * `optionRef -> the name of that option's own other-specify variable` (`Q2r5_other`).
   *
   * Not in F §1.2, which offers a single `other?: string`. That shape cannot describe a fan-out:
   * a `multi_select` may mark several options `other_specify` and therefore declares several
   * verbatim variables, and a validator that has to attach "please specify" to the *right* one
   * would have to string-build the name — the exact thing this record exists to prevent.
   */
  readonly otherByItem: Readonly<Record<string, string>>;
}

export interface ResolvedQuestion<Config> {
  readonly ref: string;
  readonly config: Config;
  readonly required: boolean;
  readonly label: I18nKey;
  readonly instruction: I18nKey | null;
  readonly options: readonly ResolvedItem[];
  readonly rows: readonly ResolvedItem[];
  readonly columns: readonly ResolvedItem[];
  readonly variables: ResolvedQuestionVariables;
  /** The variable name for one row/option. Throws for an unknown ref: that is a plugin bug. */
  variableFor(rowRef: string): string;
  /** Reverse lookup from a stored code to the item ref that produced it. */
  optionRefOf(code: JsonValue): string | undefined;
}

export interface ValidationIssue {
  /** Which variable the error attaches to; drives error placement in the UI. */
  readonly variableName: string | null;
  readonly messageKey: I18nKey;
  readonly params?: Readonly<Record<string, string | number>>;
  readonly severity: 'error' | 'warning';
  /** For grids: which cell to focus on error. */
  readonly focus?: {
    readonly rowRef?: string;
    readonly columnRef?: string;
    readonly optionRef?: string;
  };
}

export type ValidationPhase = 'on_change' | 'on_submit';

/**
 * `side` exists for exactly one reason (F §1.2): a plugin may skip an expensive check on the
 * client (a 200-row grid cross-check) but may never *disagree* with the server. Fewer issues
 * on the client is allowed; different issues trip ADR-004's divergence metric.
 */
export type ValidationSide = 'client' | 'server';

export interface ValidateContext<Config, Answer> {
  readonly question: ResolvedQuestion<Config>;
  readonly value: Answer | undefined;
  readonly required: boolean;
  readonly phase: ValidationPhase;
  readonly side: ValidationSide;
  /** Sibling values on this page, for page-scoped rules (schema §14 `scope: "page"`). */
  read(variableName: string): JsonValue | undefined;
  /** Composition: delegate a sub-region to the child plugin's validator (F §3). */
  delegateValidate(
    scope: ComposeScope,
    control: CellControl,
    args: { readonly value: unknown; readonly required: boolean },
  ): readonly ValidationIssue[];
}

/* -------------------------------------------------------------------------- */
/* Message keys the kit itself guarantees                                     */
/* -------------------------------------------------------------------------- */

/**
 * The shared validation message keys. Collected here rather than inlined per plugin because
 * the i18n bundle has to contain them and "which keys must a translation provide" needs an
 * answer that is a value, not a grep.
 */
export const KIT_MESSAGE_KEYS = {
  required: 'err.required',
  invalidOption: 'err.invalid_option',
  otherRequired: 'err.other_required',
  tooLong: 'err.too_long',
  tooFewSelected: 'err.too_few_selected',
  tooManySelected: 'err.too_many_selected',
  exclusiveViolated: 'err.exclusive_violated',
  notNumeric: 'err.not_numeric',
  outOfRange: 'err.out_of_range',
} as const;

export type KitMessageKey = (typeof KIT_MESSAGE_KEYS)[keyof typeof KIT_MESSAGE_KEYS];
