/**
 * Surface expressions — what the parser produces, before resolution.
 *
 * WHY there are two expression representations at all: a `logic` `Expr` cannot be built until the
 * *domains* are known. `[1, 3]` is a `{k:'set', v:[1,3], d: DomainId}` literal and `S1 = 1` needs
 * `{k:'enum', v:1, d:'dom_s1'}` — because D §3.3's `compatEq` explicitly refuses `enum<d> ~ num`,
 * so an enum compared to a bare `num` literal is a type error, not a coercion. The domain comes
 * from the *other* operand, which the parser has not resolved yet.
 *
 * The alternative — build `Expr` with a placeholder domain and patch it later — was rejected: the
 * AST is `readonly` throughout and a half-built node with a lying `d` field is one refactor away
 * from reaching the evaluator, where a wrong domain is exactly the bug the nominal-enum design
 * (D §2.2) exists to catch.
 *
 * So the parser is context-free and total, and one pass (resolve.ts) turns surface into AST with
 * expected-type propagation. Spans live here and only here: the resolved AST carries none, and
 * positions travel to diagnostics through the node-id source map.
 */

import type { CmpOp } from '@resscript/logic';
import type { Span } from './diagnostics.js';

/**
 * The set operators, infix and call spellings together.
 *
 * `contains` / `any_of` / `all_of` / `none_of` have infix spellings in D §6.2's `set_op` production;
 * `set_eq`, `subset_of`, `union`, `intersect` and `difference` are AST kinds D §2.3 defines and
 * D §6.2 gives no syntax for at all, so the DSL spells them as calls. Reported.
 */
export type SetOpName =
  | 'contains'
  | 'any_of'
  | 'all_of'
  | 'none_of'
  | 'set_eq'
  | 'subset_of'
  | 'union'
  | 'intersect'
  | 'difference';

/** The subset D §6.2 gives an infix spelling. */
export type InfixSetOpName = 'contains' | 'any_of' | 'all_of' | 'none_of';
export type BinArithOp = '+' | '-' | '*' | '/' | 'mod' | 'pow';

/** `COUNT(<group>)`'s group spec — the surface form of D §2.3's `Group`. */
export type SGroup =
  | { readonly g: 'ref'; readonly ref: string; readonly span: Span }
  | { readonly g: 'vars'; readonly refs: readonly { readonly ref: string; readonly span: Span }[]; readonly span: Span }
  | {
      readonly g: 'axis';
      readonly axis: 'options' | 'rows' | 'columns' | 'iterations';
      readonly ref: string;
      /** `ROWS OF Q3 COLUMN c2` — D §2.3's `matrix_rows.column_ref`. */
      readonly at?: { readonly axis: 'row' | 'column'; readonly ref: string };
      readonly span: Span;
    };

export interface SPathSegment {
  readonly name: string;
  readonly span: Span;
}

export type SExpr =
  | { readonly k: 'num'; readonly value: number; readonly span: Span }
  | { readonly k: 'str'; readonly value: string; readonly span: Span }
  | { readonly k: 'bool'; readonly value: boolean; readonly span: Span }
  | { readonly k: 'null'; readonly span: Span }
  | { readonly k: 'date'; readonly value: string; readonly span: Span }
  /** `[1, 3, 99]` — a code list. Its domain comes from the operand it is compared against. */
  | { readonly k: 'codes'; readonly items: readonly SExpr[]; readonly span: Span }
  /** `AGE`, `Q1.Yes`, `item.meta.discontinued`, `BRAND.label`. */
  | { readonly k: 'path'; readonly head: string; readonly attrs: readonly SPathSegment[]; readonly span: Span }
  | { readonly k: 'call'; readonly name: string; readonly args: readonly SExpr[]; readonly nameSpan: Span; readonly span: Span }
  /**
   * `ANSWERED(Q9)`, `SHOWN(PAGE P3)`.
   *
   * A probe is not a plain call, because its argument is a *content node reference* and may carry
   * the `PAGE`/`BLOCK` keyword — which is not an expression and would not parse as one. D §2.3's
   * `Probe.target` is `{kind: variable|question|page, id}`, so the surface form has to be able to
   * say which, and a bare ref cannot.
   */
  | {
      readonly k: 'probe';
      readonly probe: 'answered' | 'shown' | 'valid' | 'asked';
      readonly ref: string;
      readonly explicit?: 'question' | 'page' | 'block';
      readonly refSpan: Span;
      readonly span: Span;
    }
  | {
      readonly k: 'agg';
      readonly fn: string;
      readonly group: SGroup;
      readonly where?: SExpr;
      readonly select?: SExpr;
      readonly nulls?: 'skip' | 'propagate' | 'as_zero';
      readonly nameSpan: Span;
      readonly span: Span;
    }
  | {
      readonly k: 'case';
      readonly cases: readonly { readonly when: SExpr; readonly then: SExpr }[];
      readonly otherwise: SExpr;
      readonly span: Span;
    }
  | {
      readonly k: 'cast';
      readonly to: 'num' | 'text' | 'date' | 'bool';
      readonly arg: SExpr;
      readonly on_fail: 'null' | 'error';
      readonly span: Span;
    }
  | { readonly k: 'not'; readonly arg: SExpr; readonly span: Span }
  | { readonly k: 'bool_op'; readonly op: 'and' | 'or'; readonly args: readonly SExpr[]; readonly span: Span }
  | { readonly k: 'cmp'; readonly op: CmpOp; readonly left: SExpr; readonly right: SExpr; readonly span: Span }
  | { readonly k: 'set_op'; readonly op: InfixSetOpName; readonly left: SExpr; readonly right: SExpr; readonly span: Span }
  | { readonly k: 'between'; readonly value: SExpr; readonly lo: SExpr; readonly hi: SExpr; readonly span: Span }
  | { readonly k: 'arith'; readonly op: BinArithOp; readonly left: SExpr; readonly right: SExpr; readonly span: Span }
  | { readonly k: 'neg'; readonly arg: SExpr; readonly span: Span }
  /** The author's parentheses. Recorded, then turned into `Trivia.paren_hints` (D §6.4). */
  | { readonly k: 'paren'; readonly inner: SExpr; readonly span: Span }
  /** Error recovery: a region the parser could not read. Types as `never`, evaluates to nothing. */
  | { readonly k: 'error'; readonly span: Span };

