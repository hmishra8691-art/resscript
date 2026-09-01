/**
 * The AST — D §2.3, and the type language — D §3.1.
 *
 * Four constraints from D §2.1 govern every decision in this file:
 *
 *  1. **Serializable JSON.** No classes, no functions, no symbols. It is stored in Postgres,
 *     embedded in the artifact, diffed, and sent to the browser.
 *  2. **Total.** Every node terminates. The only iteration is `agg` over a statically known
 *     group, which is what makes D §10's time budget a provable property.
 *  3. **References are ids.** `{ var: 'var_01H…' }`, never `{ var: 'Q1' }`, so renaming a ref
 *     touches no AST (schema §3).
 *  4. **Every node carries a stable `n`**, the key for memoization, source maps and the
 *     debug trace.
 *
 * Item 5 of D §2.1 — "types are inferred, then cached on the node as `t`" — is why every node
 * has an optional `t`. The checker produces an annotated copy (it never mutates its input:
 * the engine is pure, ADR-004), and the evaluator trusts `t` without re-deriving it.
 */

import type { AggFn, AstKind, ProbeKind } from './ast-kinds.js';
import { isAstKind } from './ast-kinds.js';
import type { DomainId, LoopId, NodeId, OptionId, PageId, QuestionId, VariableId } from './ids.js';
import { LogicInvariant } from './ids.js';

/* ========================================================================== */
/* Types (D §3.1)                                                             */
/* ========================================================================== */

/**
 * Notably absent: `any`. There is no escape from the checker, because the whole point of a
 * constrained language is that everything is checkable. `never` exists only so that one type
 * error does not produce twelve.
 *
 * Every type is implicitly nullable — nullity is a value-level property (D §2.5), not a
 * separate type, because survey logic is 95% "the null case is fine" and `T | null`
 * everywhere would be ceremony authors would route around.
 */
export type Type =
  | { readonly k: 'bool' }
  | { readonly k: 'num' }
  | { readonly k: 'text' }
  | { readonly k: 'date' }
  | { readonly k: 'enum'; readonly d: DomainId }
  | { readonly k: 'set'; readonly d: DomainId }
  | { readonly k: 'obj'; readonly fields: { readonly [key: string]: Type } }
  | { readonly k: 'null' }
  | { readonly k: 'never' };

export const T_BOOL: Type = { k: 'bool' };
export const T_NUM: Type = { k: 'num' };
export const T_TEXT: Type = { k: 'text' };
export const T_DATE: Type = { k: 'date' };
export const T_NULL: Type = { k: 'null' };
export const T_NEVER: Type = { k: 'never' };

export function typeName(t: Type): string {
  switch (t.k) {
    case 'enum':
      return `enum<${t.d}>`;
    case 'set':
      return `set<${t.d}>`;
    case 'obj':
      return `obj{${Object.keys(t.fields).sort().join(',')}}`;
    default:
      return t.k;
  }
}

export function typeEq(a: Type, b: Type): boolean {
  if (a.k !== b.k) return false;
  switch (a.k) {
    case 'enum':
    case 'set':
      return a.d === (b as { readonly d: DomainId }).d;
    case 'obj': {
      const other = b as { readonly fields: { readonly [key: string]: Type } };
      const aKeys = Object.keys(a.fields).sort();
      const bKeys = Object.keys(other.fields).sort();
      if (aKeys.length !== bKeys.length) return false;
      for (let i = 0; i < aKeys.length; i += 1) {
        const key = aKeys[i];
        if (key === undefined || key !== bKeys[i]) return false;
        const left = a.fields[key];
        const right = other.fields[key];
        if (left === undefined || right === undefined || !typeEq(left, right)) return false;
      }
      return true;
    }
    default:
      return true;
  }
}

/* ========================================================================== */
/* Nodes (D §2.3)                                                             */
/* ========================================================================== */

export interface NodeBase {
  readonly n: NodeId;
  /** Filled by the checker. The evaluator trusts it; a mistyped node is an invariant error. */
  readonly t?: Type;
}

export type LiteralValue =
  | { readonly k: 'null' }
  | { readonly k: 'bool'; readonly v: boolean }
  | { readonly k: 'num'; readonly v: number }
  | { readonly k: 'text'; readonly v: string }
  | { readonly k: 'date'; readonly v: string }
  | { readonly k: 'enum'; readonly v: number; readonly d: DomainId }
  | { readonly k: 'set'; readonly v: readonly number[]; readonly d: DomainId };

export type Lit = NodeBase & { readonly op: 'lit'; readonly v: LiteralValue };

export type VarRef = NodeBase & { readonly op: 'var'; readonly var: VariableId };

export type ProbeTarget =
  | { readonly kind: 'variable'; readonly id: VariableId }
  | { readonly kind: 'question'; readonly id: QuestionId }
  | { readonly kind: 'page'; readonly id: PageId };

/**
 * Metadata about a cell, not its value. This is how an author interrogates nullity without
 * triggering null propagation (D §2.5), and it is why the three-valued semantics are usable
 * at all: `IF ANSWERED(Q9) AND Q9 > 3` is the preferred form over an `ON UNKNOWN` override.
 */
export type Probe = NodeBase & {
  readonly op: 'probe';
  readonly kind: ProbeKind;
  readonly target: ProbeTarget;
};

/** The implicit per-item value inside `agg.where`/`agg.select` or a per-item mask condition. */
export type ItemRef = NodeBase & { readonly op: 'item' };

export type ItemAttr = NodeBase & {
  readonly op: 'item_attr';
  readonly attr: 'code' | 'label' | 'position' | 'selected';
  /** Present when the attribute is a `meta` lookup on the item (schema §5.1). */
  readonly meta_key?: string;
};

export type CmpOp = '==' | '!=' | '<' | '<=' | '>' | '>=';
export type Cmp = NodeBase & { readonly op: CmpOp; readonly args: readonly [Expr, Expr] };

export type SetOp = NodeBase &
  (
    | { readonly op: 'contains'; readonly args: readonly [Expr, Expr] }
    | { readonly op: 'any_of'; readonly args: readonly [Expr, Expr] }
    | { readonly op: 'all_of'; readonly args: readonly [Expr, Expr] }
    | { readonly op: 'none_of'; readonly args: readonly [Expr, Expr] }
    | { readonly op: 'set_eq'; readonly args: readonly [Expr, Expr] }
    | { readonly op: 'subset_of'; readonly args: readonly [Expr, Expr] }
    | {
        readonly op: 'union' | 'intersect' | 'difference';
        readonly args: readonly [Expr, Expr];
      }
  );

export type BoolOp = NodeBase &
  (
    | { readonly op: 'and' | 'or'; readonly args: readonly Expr[] }
    | { readonly op: 'not'; readonly args: readonly [Expr] }
  );

export type Arith = NodeBase &
  (
    | {
        readonly op: '+' | '-' | '*' | '/' | 'mod' | 'pow';
        readonly args: readonly [Expr, Expr];
      }
    | { readonly op: 'neg' | 'abs' | 'floor' | 'ceil'; readonly args: readonly [Expr] }
    | { readonly op: 'round'; readonly args: readonly [Expr, Expr] }
    | { readonly op: 'min' | 'max' | 'clamp'; readonly args: readonly Expr[] }
  );

/**
 * The group an aggregation iterates. Resolved at compile time to a concrete, ordered item
 * list — there is no dynamic group selection, which is what keeps aggregation total and lets
 * the dependency graph (D §4.4) know exactly which cells an `agg` reads.
 */
export type Group =
  | { readonly kind: 'explicit'; readonly variable_ids: readonly VariableId[] }
  | { readonly kind: 'question_emits'; readonly question_id: QuestionId }
  | { readonly kind: 'matrix_rows'; readonly question_id: QuestionId; readonly column_ref?: string }
  | { readonly kind: 'matrix_cols'; readonly question_id: QuestionId; readonly row_ref?: string }
  | {
      readonly kind: 'loop_iterations';
      readonly question_id: QuestionId;
      readonly loop_id: LoopId;
    }
  | { readonly kind: 'options'; readonly question_id: QuestionId };

/**
 * One resolved group member.
 *
 * D §10.1 wants group resolution done at compile time so the hot path holds no registry
 * lookups. D's `TypeEnv.groupMembers` returns `VariableId[]`, which is not quite enough:
 * D's own `Group` union includes `kind: 'options'`, which "iterate[s] options, not vars", and
 * `item_attr` reads `code` / `label` / `position` / `selected` per item. So the resolved form
 * carries the item, not only its variable. Still plain JSON, so the artifact is unaffected.
 */
export interface GroupItem {
  readonly variable_id?: VariableId;
  readonly option_id?: OptionId;
  readonly code?: number;
  /**
   * The domain the `code` belongs to. Present for an `options` group, whose items have no
   * variable, so `item` still evaluates to a properly-domained enum rather than a bare number —
   * without it the nominal-enum check in D §2.2 would have nothing to compare.
   */
  readonly domain?: DomainId;
  readonly label_key?: string;
  /** 0-based position in the *canonical* (unrandomized) list; display order comes from ctx. */
  readonly position?: number;
  /** "Always show": a mask may not remove this item. See `applyMask`. */
  readonly pin?: boolean;
  readonly meta?: { readonly [key: string]: string | number | boolean | null };
}

export type Agg = NodeBase & {
  readonly op: 'agg';
  readonly fn: AggFn;
  readonly over: Group;
  /** Optional predicate; `item` / `item_attr` are bound inside it. */
  readonly where?: Expr;
  /** Optional projection evaluated per item; defaults to the item value. */
  readonly select?: Expr;
  /** How to treat null members. Default `'skip'` (SQL-like). D §2.5. */
  readonly nulls?: 'skip' | 'propagate' | 'as_zero';
  /** Compile-time group resolution (D §10.1). Absent in a hand-authored tree. */
  readonly resolved?: readonly GroupItem[];
};

export type StrOp = NodeBase &
  (
    | { readonly op: 'concat'; readonly args: readonly Expr[] }
    | { readonly op: 'len' | 'lower' | 'upper' | 'trim'; readonly args: readonly [Expr] }
    | {
        readonly op: 'starts_with' | 'ends_with' | 'str_contains';
        readonly args: readonly [Expr, Expr];
      }
    | {
        readonly op: 'matches';
        readonly args: readonly [Expr];
        readonly pattern: string;
        readonly flags?: string;
      }
    | { readonly op: 'substr'; readonly args: readonly Expr[] }
    | { readonly op: 'split_count'; readonly args: readonly [Expr, Expr] }
    | { readonly op: 'word_count'; readonly args: readonly [Expr] }
  );

export type DateUnit = 'day' | 'month' | 'year' | 'hour' | 'minute' | 'second';

export type DateOp = NodeBase &
  (
    | { readonly op: 'date_diff'; readonly unit: DateUnit; readonly args: readonly [Expr, Expr] }
    | {
        readonly op: 'date_add';
        readonly unit: 'day' | 'month' | 'year';
        readonly args: readonly [Expr, Expr];
      }
    | {
        readonly op: 'date_part';
        readonly part: 'year' | 'month' | 'day' | 'dow' | 'hour';
        readonly args: readonly [Expr];
      }
    | {
        readonly op: 'date_trunc';
        readonly unit: 'day' | 'month' | 'year';
        readonly args: readonly [Expr];
      }
  );
// There is no `now`. D §2.6: anything time-dependent reads an injected `system` variable,
// because a clock read makes client and server diverge on a date-cutoff boundary forever.

export type CaseExpr = NodeBase & {
  readonly op: 'case';
  readonly cases: readonly { readonly when: Expr; readonly then: Expr }[];
  /** Required — no implicit null fallthrough. D §2.3 argues this at length. */
  readonly else: Expr;
};

export type Coalesce = NodeBase & { readonly op: 'coalesce'; readonly args: readonly Expr[] };

export type Cast = NodeBase & {
  readonly op: 'cast';
  readonly to: 'num' | 'text' | 'date' | 'bool';
  readonly args: readonly [Expr];
  readonly on_fail: 'null' | 'error';
};

export type LabelOf = NodeBase & {
  readonly op: 'label_of';
  readonly args: readonly [Expr];
  readonly form?: 'short' | 'long';
};

export type Expr =
  | Lit
  | VarRef
  | Probe
  | ItemRef
  | ItemAttr
  | Cmp
  | SetOp
  | BoolOp
  | Arith
  | Agg
  | StrOp
  | DateOp
  | CaseExpr
  | Coalesce
  | Cast
  | LabelOf;

/* ========================================================================== */
/* Walking                                                                    */
/* ========================================================================== */

/**
 * Children in evaluation order.
 *
 * One function, used by the checker, the evaluator's node counter, CSE, the dependency
 * extractor and the analyses. Anywhere else that re-derived "what are this node's children"
 * would be a second definition of the AST that could drift from this one.
 */
export function childrenOf(e: Expr): readonly Expr[] {
  switch (e.op) {
    case 'lit':
    case 'var':
    case 'probe':
    case 'item':
    case 'item_attr':
      return EMPTY_EXPRS;
    case 'agg': {
      const out: Expr[] = [];
      if (e.where !== undefined) out.push(e.where);
      if (e.select !== undefined) out.push(e.select);
      return out;
    }
    case 'case': {
      const out: Expr[] = [];
      for (const c of e.cases) {
        out.push(c.when, c.then);
      }
      out.push(e.else);
      return out;
    }
    default:
      return e.args;
  }
}

const EMPTY_EXPRS: readonly Expr[] = [];

/**
 * Rebuild a node with new children, in the same order `childrenOf` yields them.
 *
 * The inverse of `childrenOf`, and it lives beside it deliberately: every pass that rewrites the
 * tree (renumbering, CSE, type annotation, constant folding) needs exactly this, and a pass that
 * re-derived "how do I put this node back together" would be a second definition of the AST's
 * shape that could drift from the first. The `as Expr` casts re-attach the operator-specific
 * arity that `map` erases to `Expr[]`; the arity itself is preserved because the child count is.
 */
export function mapChildren(e: Expr, f: (child: Expr) => Expr): Expr {
  switch (e.op) {
    case 'lit':
    case 'var':
    case 'probe':
    case 'item':
    case 'item_attr':
      return e;
    case 'agg':
      return {
        ...e,
        ...(e.where === undefined ? {} : { where: f(e.where) }),
        ...(e.select === undefined ? {} : { select: f(e.select) }),
      };
    case 'case':
      return {
        ...e,
        cases: e.cases.map((arm) => ({ when: f(arm.when), then: f(arm.then) })),
        else: f(e.else),
      };
    default: {
      // Every remaining variant of `Expr` carries `args`, so this is an invariant assertion and
      // not input validation: reaching it means an untyped object got past `checkExpr`, which is
      // supposed to normalise exactly that (see its `argsOf` and its LGC-T002 branch).
      //
      // It exists because the bare `e.args.map(f)` that used to be here failed as "TypeError:
      // Cannot read properties of undefined (reading 'map')" ten frames deep in a worker job,
      // which says nothing about which node was wrong or where it came from. Naming the op and
      // dumping the node turned that into a one-line diagnosis. The cost is one Array.isArray
      // per interior node per pass; the alternative cost was an afternoon.
      const args = (e as { readonly args?: unknown }).args;
      if (!Array.isArray(args)) {
        throw new TypeError(
          `mapChildren: node with op ${JSON.stringify(String(e.op))} has no args array — ` +
            `an unchecked expression reached a rewrite pass: ${JSON.stringify(e)}`,
        );
      }
      return { ...e, args: (args as readonly Expr[]).map(f) } as Expr;
    }
  }
}

/** Pre-order walk. Total and non-recursive-in-user-data (the AST has no cycles by §2.1). */
export function walkExpr(root: Expr, visit: (e: Expr) => void): void {
  const stack: Expr[] = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === undefined) break;
    visit(node);
    const children = childrenOf(node);
    for (let i = children.length - 1; i >= 0; i -= 1) {
      const child = children[i];
      if (child !== undefined) stack.push(child);
    }
  }
}

/** Every variable this expression reads, deduped, in first-seen order. */
export function readsOf(root: Expr): readonly VariableId[] {
  const seen = new Set<VariableId>();
  const out: VariableId[] = [];
  walkExpr(root, (e) => {
    if (e.op === 'var' && !seen.has(e.var)) {
      seen.add(e.var);
      out.push(e.var);
    }
    if (e.op === 'agg' && e.resolved !== undefined) {
      for (const item of e.resolved) {
        if (item.variable_id !== undefined && !seen.has(item.variable_id)) {
          seen.add(item.variable_id);
          out.push(item.variable_id);
        }
      }
    }
  });
  return out;
}

/** Every probe in the expression. The dependency graph turns these into cell reads. */
export function probesOf(root: Expr): readonly Probe[] {
  const out: Probe[] = [];
  walkExpr(root, (e) => {
    if (e.op === 'probe') out.push(e);
  });
  return out;
}

export function countNodes(root: Expr): number {
  let n = 0;
  walkExpr(root, () => {
    n += 1;
  });
  return n;
}

/**
 * Structural equality ignoring node ids and cached types — D §6.4's `≡`.
 *
 * P1-07's round-trip property P1 is stated in terms of this relation, so it lives here with
 * the AST rather than in the DSL package: the definition of "the same rule" belongs to the
 * owner of the tree.
 */
export function exprEq(a: Expr, b: Expr): boolean {
  if (a.op !== b.op) return false;
  if (!discriminantsEq(a, b)) return false;
  const ac = childrenOf(a);
  const bc = childrenOf(b);
  if (ac.length !== bc.length) return false;
  for (let i = 0; i < ac.length; i += 1) {
    const left = ac[i];
    const right = bc[i];
    if (left === undefined || right === undefined) return false;
    if (!exprEq(left, right)) return false;
  }
  return true;
}

function discriminantsEq(a: Expr, b: Expr): boolean {
  switch (a.op) {
    case 'lit':
      return b.op === 'lit' && literalEq(a.v, b.v);
    case 'var':
      return b.op === 'var' && a.var === b.var;
    case 'probe':
      return (
        b.op === 'probe' &&
        a.kind === b.kind &&
        a.target.kind === b.target.kind &&
        a.target.id === b.target.id
      );
    case 'item':
      return b.op === 'item';
    case 'item_attr':
      return b.op === 'item_attr' && a.attr === b.attr && a.meta_key === b.meta_key;
    case 'agg':
      return (
        b.op === 'agg' &&
        a.fn === b.fn &&
        (a.nulls ?? 'skip') === (b.nulls ?? 'skip') &&
        groupEq(a.over, b.over)
      );
    case 'matches':
      return b.op === 'matches' && a.pattern === b.pattern && a.flags === b.flags;
    case 'date_diff':
      return b.op === 'date_diff' && a.unit === b.unit;
    case 'date_add':
      return b.op === 'date_add' && a.unit === b.unit;
    case 'date_part':
      return b.op === 'date_part' && a.part === b.part;
    case 'date_trunc':
      return b.op === 'date_trunc' && a.unit === b.unit;
    case 'cast':
      return b.op === 'cast' && a.to === b.to && a.on_fail === b.on_fail;
    case 'label_of':
      return b.op === 'label_of' && (a.form ?? 'short') === (b.form ?? 'short');
    case 'case':
      return b.op === 'case' && a.cases.length === b.cases.length;
    default:
      return true;
  }
}

export function literalEq(a: LiteralValue, b: LiteralValue): boolean {
  if (a.k !== b.k) return false;
  switch (a.k) {
    case 'null':
      return true;
    case 'set': {
      const other = b as { readonly v: readonly number[]; readonly d: DomainId };
      if (a.d !== other.d || a.v.length !== other.v.length) return false;
      return a.v.every((code, i) => code === other.v[i]);
    }
    case 'enum': {
      const other = b as { readonly v: number; readonly d: DomainId };
      return a.v === other.v && a.d === other.d;
    }
    default:
      return a.v === (b as { readonly v: boolean | number | string }).v;
  }
}

export function groupEq(a: Group, b: Group): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case 'explicit': {
      const other = b as { readonly variable_ids: readonly VariableId[] };
      return (
        a.variable_ids.length === other.variable_ids.length &&
        a.variable_ids.every((id, i) => id === other.variable_ids[i])
      );
    }
    case 'matrix_rows':
      return b.kind === 'matrix_rows' && a.question_id === b.question_id && a.column_ref === b.column_ref;
    case 'matrix_cols':
      return b.kind === 'matrix_cols' && a.question_id === b.question_id && a.row_ref === b.row_ref;
    case 'loop_iterations':
      return b.kind === 'loop_iterations' && a.question_id === b.question_id && a.loop_id === b.loop_id;
    default: {
      const other = b as { readonly question_id: QuestionId };
      return a.question_id === other.question_id;
    }
  }
}

/**
 * Structural validation of an untrusted tree.
 *
 * The AST arrives as JSON from Postgres, from an artifact, or from a hand edit. Schema
 * carries it opaquely (`{ op: string, …JSON }`, schema `types/common.ts`), so this package is
 * where a wrong `op` first becomes an error — as that file's comment says it should be. The
 * checker calls this before inference, so a malformed node produces `LGC-T002`/`LGC-T006`
 * rather than a crash inside inference.
 */
export function isExprShape(value: unknown): value is Expr {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as { readonly [key: string]: unknown };
  const op = record['op'];
  return typeof op === 'string' && isAstKind(op);
}

export function assertExprShape(value: unknown): Expr {
  if (!isExprShape(value)) {
    throw new LogicInvariant(`not an AST node: ${JSON.stringify(value)}`);
  }
  return value;
}

/** The node's kind, narrowed to the closed registry. */
export function kindOf(e: Expr): AstKind {
  return e.op;
}

/**
 * True iff this subtree reads no state: no `var`, `probe`, `item`, `item_attr` or `agg` appears
 * anywhere beneath it. A state-free expression evaluates to the same `Value` on every call —
 * `evalStateFree` (`evaluator.ts`) computes that value, and both `check.ts`'s `constantVerdict`
 * (D §3.5's `LGC-W030`) and `optimize.ts`'s constant folding (D §10.1) key off this same
 * definition. One function rather than two, so the checker's warning and the optimizer's fold
 * can never disagree about what counts as constant.
 *
 * `agg` is excluded even when its `over`/`where`/`select` are themselves state-free, because an
 * aggregation still reads the *group's* runtime values (D §2.4) — its own subtree containing no
 * `var` proves nothing about the members it iterates.
 */
export function isStateFree(expr: Expr): boolean {
  let free = true;
  const stack: Expr[] = [expr];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === undefined) break;
    if (
      node.op === 'var' ||
      node.op === 'probe' ||
      node.op === 'item' ||
      node.op === 'item_attr' ||
      node.op === 'agg'
    ) {
      free = false;
      break;
    }
    for (const child of childrenOf(node)) stack.push(child);
  }
  return free;
}
