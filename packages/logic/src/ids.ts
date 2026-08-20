/**
 * Branded ids, re-declared locally.
 *
 * WHY these are not imported from `@resscript/schema`, which already owns them:
 * `.dependency-cruiser.cjs`'s `logic-is-dependency-free` rule forbids **every** import out of
 * `packages/logic`, including a workspace sibling and including `import type` (verified
 * empirically: both spellings are reported as violations, because dependency-cruiser runs with
 * `tsPreCompilationDeps: true`). ADR-004/ADR-010 want this package to be a leaf that can be
 * dropped into QuickJS, a browser or a worker with no resolution step at all, so the rule is
 * correct and the duplication is the cost. The duplication is kept as small as possible:
 * only the id *shape*, never the ULID contract.
 *
 * Consequence for callers (`packages/compiler`, P1-08): schema's `Id<'var'>` and this file's
 * `VariableId` are two distinct nominal types, so ingesting a schema variable registry needs
 * one cast at the boundary. `asVariableId` / `asQuestionId` / … are that boundary: they
 * validate the prefix and re-attach the local brand. This mirrors `parseId`/`asId` in schema,
 * deliberately, so the ceremony is recognizable.
 *
 * WHY the ULID body is not re-validated here: the wire format (`app.ulid`, 26 Crockford
 * base32 characters) is schema's contract. Duplicating that regex would create exactly the
 * drift ADR-010 exists to prevent — two packages disagreeing about what an id is, and the
 * disagreement only visible when a valid id is rejected in field. The prefix is enough for
 * the property this package actually needs: "this is an id of the right kind."
 */

declare const LOGIC_ID_BRAND: unique symbol;

/** A nominal id. The brand exists only in the type system; at runtime this is a string. */
export type LogicId<P extends string> = string & { readonly [LOGIC_ID_BRAND]: P };

export type VariableId = LogicId<'var'>;
export type QuestionId = LogicId<'qst'>;
export type PageId = LogicId<'pg'>;
export type BlockId = LogicId<'blk'>;
export type OptionId = LogicId<'opt'>;
export type RuleId = LogicId<'rul'>;
export type FlowNodeId = LogicId<'fn'>;
export type QuotaPlanId = LogicId<'qp'>;
export type QuotaDimensionId = LogicId<'qd'>;

/**
 * Loop ids.
 *
 * D §11 note 3 records that `LoopId` has no prefix in `03-survey-schema.md`. Re-checked
 * against the current doc: still true — `ID_PREFIXES` in schema has no loop member and
 * `LoopSpec` (schema `types/content.ts`) identifies a loop by the owning node, not by its own
 * prefixed id. So `LoopId` here is the loop-owning question's id: the only stable handle that
 * actually exists today. Reported rather than invented, per the milestone brief.
 */
export type LoopId = QuestionId;

/**
 * An enum domain id (D §2.2). Not in schema's `ID_PREFIXES` either: D derives it from the
 * option-bearing question's id (`dom_q5` in the worked example) or from a shared option-list
 * template. It is therefore a free-form interned key, branded so it cannot be swapped with a
 * variable id — which is the actual bug class (`{k:'enum', d: someVariableId}` type-checks
 * without the brand).
 */
export type DomainId = LogicId<'dom'>;

/**
 * A node id, per D §2.1 item 4: "every node carries a stable `n`". Numeric, matching the
 * worked example in D §9.3 (`"n": 1`) and the trace format in E §14.2 (`n: number`), and
 * because it doubles as the memo table index (D §5.4) which is an `Int32Array`.
 *
 * Not branded: it is used as an array index on the hot path, and branding a number costs a
 * cast at every arithmetic site for no protection that `NodeId`-vs-`CellIdx` confusion would
 * actually survive (both are opaque integers into different arrays).
 */
export type NodeId = number;

/** Index into `CompiledLogic.cells`. */
export type CellIdx = number;

/** Index into `CompiledLogic.nodes`, i.e. the memo slot for a node. */
export type NodeIdx = number;

const PREFIXES = {
  var: 'var_',
  qst: 'qst_',
  pg: 'pg_',
  blk: 'blk_',
  opt: 'opt_',
  rul: 'rul_',
  fn: 'fn_',
  qp: 'qp_',
  qd: 'qd_',
  dom: 'dom_',
} as const;

export type LogicIdPrefix = keyof typeof PREFIXES;

function brand<P extends LogicIdPrefix>(prefix: P, value: string): LogicId<P> {
  const expected = PREFIXES[prefix];
  if (!value.startsWith(expected) || value.length <= expected.length) {
    throw new Error(`Not a valid ${expected}* id: ${JSON.stringify(value)}`);
  }
  // The one unavoidable cast: a brand is a type-level fiction and has to be attached where
  // the value is admitted.
  return value as LogicId<P>;
}

export const asVariableId = (v: string): VariableId => brand('var', v);
export const asQuestionId = (v: string): QuestionId => brand('qst', v);
export const asPageId = (v: string): PageId => brand('pg', v);
export const asBlockId = (v: string): BlockId => brand('blk', v);
export const asOptionId = (v: string): OptionId => brand('opt', v);
export const asRuleId = (v: string): RuleId => brand('rul', v);
export const asFlowNodeId = (v: string): FlowNodeId => brand('fn', v);
export const asQuotaPlanId = (v: string): QuotaPlanId => brand('qp', v);
export const asQuotaDimensionId = (v: string): QuotaDimensionId => brand('qd', v);
export const asDomainId = (v: string): DomainId => brand('dom', v);

/** True when `value` carries the given prefix. Used by the checker before it brands. */
export function hasPrefix(prefix: LogicIdPrefix, value: string): boolean {
  const expected = PREFIXES[prefix];
  return value.startsWith(expected) && value.length > expected.length;
}

/**
 * A logic invariant failure: the evaluator found a state only a compiler bug can produce
 * (D §1: "`evaluate` … cannot fail with anything other than a thrown `LogicInvariant`").
 * It is deliberately not a diagnostic — diagnostics are for user input, this is for us.
 */
export class LogicInvariant extends Error {
  override readonly name = 'LogicInvariant';
  constructor(message: string) {
    super(`logic invariant violated: ${message}`);
  }
}

export function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new LogicInvariant(message);
}

/**
 * Indexed read that cannot silently produce `undefined`.
 *
 * `noUncheckedIndexedAccess` is on, which is right, but it turns every hot-path array read
 * into a branch. This helper puts that branch in one place and turns a compiler bug into a
 * `LogicInvariant` instead of an `undefined` that propagates into a respondent's verdict.
 */
export function at<T>(array: readonly T[], index: number): T {
  const value = array[index];
  if (value === undefined) {
    throw new LogicInvariant(`index ${String(index)} out of range (length ${String(array.length)})`);
  }
  return value;
}
