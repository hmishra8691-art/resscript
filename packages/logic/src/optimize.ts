/**
 * The optimizer pass — D §10.1's "constant folding" and "and/or flattening ... reordering" rows,
 * the roadmap P2-01 backend line ("flatten and reorder associative and/or, constant-fold, hoist
 * common subexpressions"). CSE ("hoist common subexpressions") already lives in `compile.ts`
 * (D §5.4); this file is the other three.
 *
 * WHY THIS IS SEPARATE FROM CSE, AND RUNS BEFORE IT. CSE shares identical subtrees; it cannot
 * discover that `S1 = 1 AND TRUE` and `S1 = 1` are the *same rule* because they are not
 * structurally equal until the `TRUE` is gone. Folding and flattening normalize a tree into the
 * shape CSE's structural key is looking for, so running the optimizer first makes CSE strictly
 * more effective, never less — the two passes compose in one direction only.
 *
 * WHY THIS IS SAFE UNDER KLEENE THREE-VALUED LOGIC (D §2.5), NOT JUST TWO-VALUED. Every
 * transformation below is licensed by a property the truth tables in `kleene.ts` actually have,
 * not by classical boolean algebra:
 *
 *  - **Constant folding** evaluates a state-free subtree once, at compile time, via
 *    `evalStateFree` — the exact function `check.ts` already trusts for `LGC-W030`. A state-free
 *    node is deterministic (D §2.1 item 2: the AST is total), so replacing it with its own value
 *    changes nothing about what a respondent sees, ever.
 *  - **`and`/`or` flattening** relies on associativity, which D §2.5 states explicitly: "`and` and
 *    `or` are n-ary; the tables are the binary generators and both operators are associative and
 *    commutative under them". Inlining a nested `and` into its parent `and`'s argument list is
 *    therefore not a rewrite of *meaning* at all — it is two spellings of the identical n-ary fold.
 *  - **Literal absorption inside `and`/`or`** is `kleene.ts`'s own tables read as rewrite rules:
 *    `F AND x = F` for every `x` (the F row is constant), so a literal `false` argument makes the
 *    whole `and` fold to `false` regardless of what its siblings evaluate to at runtime — including
 *    siblings this pass cannot itself decide. The mirror holds for `or` and `true`. A literal `true`
 *    inside `and` (or `false` inside `or`) is the identity element and can be dropped outright.
 *    A literal `null` cannot be dropped by the same argument — `U AND T = U` but `U AND F = F` — so
 *    at most one is *kept*, deduplicated, never discarded for free.
 *  - **Operand reordering** is licensed by the same commutativity that licenses flattening. D §10.1
 *    asks for "cheapest and most-selective operand first" using cost estimates from the abstract
 *    domain solver in `packages/compiler` (D §8.3); this package cannot depend on that one (ADR-010:
 *    `packages/logic` has zero dependencies and runs inside QuickJS), so the heuristic here is
 *    syntactic — fewest nodes first, `countNodes` from `ast.ts` — cheaper to *evaluate*, which is
 *    the dimension this pass actually controls. Reordering by node count is always safe, whatever
 *    its effect on short-circuit frequency, because commutativity makes the *verdict* invariant
 *    under any operand order; only the amount of work done to reach it changes.
 *  - **`case` branch pruning** uses D §2.5's own stated deviation: "a `when` evaluating `U` is
 *    treated as not matched". A branch whose `when` folds to a literal `false` or `null` therefore
 *    can never be chosen and is dropped; a branch whose `when` folds to literal `true` is chosen
 *    unconditionally by every path that reaches it, so it — and every branch declared after it —
 *    collapses into the `else` of a `case` built from only the branches that precede it.
 *  - **`not`** of a literal folds by `not3` directly; `not` of anything else is left alone, because
 *    pushing negation through `and`/`or` (De Morgan) would change which subexpressions are shared
 *    with sibling rules and is not asked for by the roadmap or needed for `LGC-W031`'s equivalence
 *    guarantee.
 *
 * WHAT THIS BUYS, CONCRETELY. `agg` is never folded — even a state-free `where`/`select` — because
 * `isStateFree` (`ast.ts`) excludes `agg` on purpose: an aggregation still reads its group's
 * members at runtime (D §2.4), so nothing beneath it is truly constant regardless of what its own
 * subtree contains. `var`, `probe`, `item` and `item_attr` are opaque for the same reason: they are
 * exactly the four leaf kinds `isStateFree` treats as "reads state".
 *
 * NODE IDS. A folded or reordered node's `n` is not required to be a fresh, dense integer here —
 * `compile.ts`'s CSE interner assigns final dense ids from a structural hash *after* this pass
 * runs (see the file header there), so it neither reads nor depends on the ids this pass leaves
 * behind. Reusing the parent's `n` on a synthesized literal is deliberate: it keeps this file from
 * needing a node-id allocator of its own.
 */

import type { BoolOp, CaseExpr, Expr, LiteralValue } from './ast.js';
import { T_BOOL, T_NULL, childrenOf, countNodes, isStateFree, mapChildren } from './ast.js';
import { evalStateFree } from './evaluator.js';
import { LogicInvariant } from './ids.js';
import { not3 } from './kleene.js';
import type { Value } from './value.js';

/**
 * `BoolOp`'s `not` arm has `args: readonly [Expr]`, distinct from the n-ary `and`/`or` arm — this
 * alias exists only so `foldNot` can be typed precisely instead of re-widening to `BoolOp`.
 */
type NotOp = Extract<BoolOp, { readonly op: 'not' }>;
type AndOrOp = Extract<BoolOp, { readonly op: 'and' | 'or' }>;

/**
 * Optimize one expression tree — the whole pass, applied bottom-up.
 *
 * `compileLogic` (`compile.ts`) calls this on every rule's condition and effect expressions and
 * on every `derived` variable's expression, before CSE. It is also exposed here directly because
 * `CompileOptions.optimize = false` needs a code path that skips it entirely (the roadmap's
 * accept line: "turning the optimizer off and on produces identical verdicts"), which means the
 * pass has to be a clean, separately callable step rather than folded into CSE's own traversal.
 */
export function optimizeExpr(root: Expr): Expr {
  return foldNode(root);
}

function foldNode(e: Expr): Expr {
  // Bottom-up: children are fully folded, flattened and reordered before this node is examined,
  // so every special case below only ever has to reason about already-optimal children.
  const withOptimizedChildren = mapChildren(e, foldNode);

  switch (withOptimizedChildren.op) {
    case 'and':
    case 'or':
      return foldBoolOp(withOptimizedChildren);
    case 'not':
      return foldNot(withOptimizedChildren);
    case 'case':
      return foldCase(withOptimizedChildren);
    default:
      return foldGeneric(withOptimizedChildren);
  }
}

/* ========================================================================== */
/* Generic constant folding                                                   */
/* ========================================================================== */

/**
 * Everything that is not `and`/`or`/`not`/`case`: comparisons, set ops, arithmetic, string and
 * date ops, `coalesce`, `cast`, `label_of`. Folds to a literal when the whole subtree is
 * state-free; otherwise returns the node unchanged (its children are already folded).
 */
function foldGeneric(e: Expr): Expr {
  if (e.op === 'lit') return e;
  if (!isStateFree(e)) return e;
  return literalNode(e.n, e.t, evalStateFree(e));
}

function literalOfValue(v: Value): LiteralValue {
  switch (v.k) {
    case 'null':
      return { k: 'null' };
    case 'bool':
      return { k: 'bool', v: v.v };
    case 'num':
      return { k: 'num', v: v.v };
    case 'text':
      return { k: 'text', v: v.v };
    case 'date':
      return { k: 'date', v: v.v };
    case 'enum':
      return { k: 'enum', v: v.v, d: v.d };
    case 'set':
      return { k: 'set', v: v.v, d: v.d };
    case 'obj':
      // No `Expr` production yields `obj` without also reading state (D §2.2's `obj` values come
      // from `item_attr` meta lookups, which `isStateFree` already excludes), so `foldGeneric`
      // never reaches here. An invariant, not a diagnosable authoring error.
      throw new LogicInvariant('constant folding produced an obj value, which has no literal form');
  }
}

// `exactOptionalPropertyTypes` treats `t: undefined` as distinct from omitting `t` altogether, so
// every literal built here spreads it in conditionally rather than assigning it directly — the
// same pattern `ast.ts`'s own `mapChildren` uses for `agg.where`/`agg.select`.
function literalNode(n: Expr['n'], t: Expr['t'], value: Value): Expr {
  return { n, ...(t === undefined ? {} : { t }), op: 'lit', v: literalOfValue(value) };
}

function boolLit(n: Expr['n'], t: Expr['t'], v: boolean): Expr {
  return { n, t: t ?? T_BOOL, op: 'lit', v: { k: 'bool', v } };
}

function nullLit(n: Expr['n'], t: Expr['t']): Expr {
  return { n, t: t ?? T_NULL, op: 'lit', v: { k: 'null' } };
}

function literalTri(e: Expr): 'T' | 'F' | 'U' | undefined {
  if (e.op !== 'lit') return undefined;
  if (e.v.k === 'bool') return e.v.v ? 'T' : 'F';
  if (e.v.k === 'null') return 'U';
  return undefined;
}

/* ========================================================================== */
/* `not`                                                                      */
/* ========================================================================== */

function foldNot(e: NotOp): Expr {
  const child = e.args[0];
  const tri = literalTri(child);
  if (tri === undefined) return e;
  if (tri === 'U') return nullLit(e.n, e.t);
  return boolLit(e.n, e.t, not3(tri) === 'T');
}

/* ========================================================================== */
/* `and` / `or`: flatten, absorb literals, reorder                            */
/* ========================================================================== */

/**
 * Flatten, fold and reorder one `and`/`or` node. Every argument has already been through
 * `foldNode`, so a same-op child is already itself flattened/folded — one level of splicing here
 * is enough to merge it into this node rather than needing to recurse into it again.
 */
function foldBoolOp(e: AndOrOp): Expr {
  const isAnd = e.op === 'and';
  // The value that makes the whole node collapse the instant it appears (`false` for `and`,
  // `true` for `or` — the row in kleene.ts's table that is constant regardless of the other
  // operand). The value that is the identity element and can simply be dropped is the other one.
  const absorbing: 'T' | 'F' = isAnd ? 'F' : 'T';

  const flat: Expr[] = [];
  for (const arg of e.args) {
    if ((arg.op === 'and' || arg.op === 'or') && arg.op === e.op) {
      flat.push(...arg.args);
    } else {
      flat.push(arg);
    }
  }

  let sawUnknown = false;
  const rest: Expr[] = [];
  for (const arg of flat) {
    const tri = literalTri(arg);
    if (tri === undefined) {
      rest.push(arg);
      continue;
    }
    if (tri === absorbing) return boolLit(e.n, e.t, isAnd ? false : true);
    if (tri === 'U') {
      sawUnknown = true;
      continue;
    }
    // The remaining case is the identity element (`T` for `and`, `F` for `or`) — drop it.
  }

  // Cheapest operand first (D §10.1): commutativity makes the verdict invariant under reordering
  // (see the file header), so this changes only how much work reaches that verdict, never the
  // verdict itself. Stable sort keeps otherwise-equal-cost operands in their authored order, which
  // is what makes a diff of the compiled artifact legible when an unrelated rule is edited.
  rest.sort((a, b) => countNodes(a) - countNodes(b));

  if (rest.length === 0) return sawUnknown ? nullLit(e.n, e.t) : boolLit(e.n, e.t, isAnd);
  if (rest.length === 1 && !sawUnknown) return rest[0] as Expr;

  const args = sawUnknown ? [...rest, nullLit(e.n, undefined)] : rest;
  return { ...e, args } as Expr;
}

/* ========================================================================== */
/* `case`                                                                     */
/* ========================================================================== */

/**
 * Drop a branch whose `when` is provably `false` or `U` — D §2.5's own rule that an unknown
 * `when` is "not matched", stated here as a rewrite rather than only as a runtime behaviour. A
 * branch whose `when` is provably `true` is chosen by every path that reaches it, so it and every
 * later branch collapse into the `else` of the `case` built from the branches before it.
 */
function foldCase(e: CaseExpr): Expr {
  const cases: { readonly when: Expr; readonly then: Expr }[] = [];
  let resolvedElse: Expr | undefined;

  for (const c of e.cases) {
    const tri = literalTri(c.when);
    if (tri === 'F' || tri === 'U') continue; // never matched — drop the branch entirely
    if (tri === 'T') {
      resolvedElse = c.then; // always matched by every path that reaches this point
      break;
    }
    cases.push(c);
  }

  const finalElse = resolvedElse ?? e.else;
  if (cases.length === 0) return finalElse;
  if (cases.length === e.cases.length && finalElse === e.else) return e; // nothing changed
  return { ...e, cases, else: finalElse };
}
