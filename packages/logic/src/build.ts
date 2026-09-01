/**
 * Node constructors.
 *
 * WHY this exists as code rather than "just write the object literal": D §2.1 item 4 requires
 * every node to carry a stable `n`, and a hand-written tree with duplicated or missing node
 * ids breaks memoization (D §5.4) and the trace silently — the evaluator still produces a
 * verdict, just the wrong memo hit. A builder that owns the counter makes that impossible.
 *
 * P1-07's parser and P1-12's builder UI both construct trees; this is the one place that
 * decides what a well-formed node looks like, so they cannot disagree.
 */

import type {
  Agg,
  Arith,
  BoolOp,
  Cast,
  Recode,
  CaseExpr,
  Cmp,
  CmpOp,
  Coalesce,
  DateOp,
  DateUnit,
  Expr,
  Group,
  ItemAttr,
  ItemRef,
  LabelOf,
  Lit,
  LiteralValue,
  Probe,
  ProbeTarget,
  SetOp,
  StrOp,
  VarRef,
} from './ast.js';
import { childrenOf } from './ast.js';
import type { AggFn, ProbeKind } from './ast-kinds.js';
import type { DomainId, NodeId, VariableId } from './ids.js';
import { normalizeCodes } from './value.js';

export interface AstBuilder {
  /** The next node id this builder will hand out. Exposed for fixtures that assert stability. */
  readonly peek: () => NodeId;
  readonly nullLit: () => Lit;
  readonly boolLit: (v: boolean) => Lit;
  readonly numLit: (v: number) => Lit;
  readonly textLit: (v: string) => Lit;
  readonly dateLit: (v: string) => Lit;
  readonly enumLit: (code: number, d: DomainId) => Lit;
  readonly setLit: (codes: readonly number[], d: DomainId) => Lit;
  readonly lit: (v: LiteralValue) => Lit;
  readonly variable: (id: VariableId) => VarRef;
  readonly probe: (kind: ProbeKind, target: ProbeTarget) => Probe;
  readonly item: () => ItemRef;
  readonly itemAttr: (attr: ItemAttr['attr'], metaKey?: string) => ItemAttr;
  readonly cmp: (op: CmpOp, left: Expr, right: Expr) => Cmp;
  readonly setOp: (op: SetOp['op'], left: Expr, right: Expr) => SetOp;
  readonly and: (...args: readonly Expr[]) => BoolOp;
  readonly or: (...args: readonly Expr[]) => BoolOp;
  readonly not: (arg: Expr) => BoolOp;
  readonly binArith: (op: '+' | '-' | '*' | '/' | 'mod' | 'pow', a: Expr, b: Expr) => Arith;
  readonly unArith: (op: 'neg' | 'abs' | 'floor' | 'ceil', a: Expr) => Arith;
  readonly round: (a: Expr, digits: Expr) => Arith;
  readonly nAryArith: (op: 'min' | 'max' | 'clamp', ...args: readonly Expr[]) => Arith;
  readonly agg: (spec: AggSpec) => Agg;
  readonly concat: (...args: readonly Expr[]) => StrOp;
  readonly strUnary: (op: 'len' | 'lower' | 'upper' | 'trim' | 'word_count', a: Expr) => StrOp;
  readonly strBinary: (
    op: 'starts_with' | 'ends_with' | 'str_contains' | 'split_count',
    a: Expr,
    b: Expr,
  ) => StrOp;
  readonly matches: (a: Expr, pattern: string, flags?: string) => StrOp;
  readonly substr: (a: Expr, start: Expr, length?: Expr) => StrOp;
  readonly dateDiff: (unit: DateUnit, a: Expr, b: Expr) => DateOp;
  readonly dateAdd: (unit: 'day' | 'month' | 'year', a: Expr, b: Expr) => DateOp;
  readonly datePart: (part: 'year' | 'month' | 'day' | 'dow' | 'hour', a: Expr) => DateOp;
  readonly dateTrunc: (unit: 'day' | 'month' | 'year', a: Expr) => DateOp;
  readonly caseExpr: (
    cases: readonly { readonly when: Expr; readonly then: Expr }[],
    otherwise: Expr,
  ) => CaseExpr;
  readonly coalesce: (...args: readonly Expr[]) => Coalesce;
  readonly cast: (to: Cast['to'], a: Expr, onFail?: Cast['on_fail']) => Cast;
  /** `RECODE(x, <domain>)` — the explicit cross-domain escape. See `Recode`. */
  readonly recode: (a: Expr, to: DomainId) => Recode;
  readonly labelOf: (a: Expr, form?: LabelOf['form']) => LabelOf;
}

export interface AggSpec {
  readonly fn: AggFn;
  readonly over: Group;
  readonly where?: Expr;
  readonly select?: Expr;
  readonly nulls?: Agg['nulls'];
}

export function astBuilder(start: NodeId = 1): AstBuilder {
  let next = start;
  const n = (): NodeId => {
    const id = next;
    next += 1;
    return id;
  };

  return {
    peek: () => next,
    nullLit: () => ({ n: n(), op: 'lit', v: { k: 'null' } }),
    boolLit: (v) => ({ n: n(), op: 'lit', v: { k: 'bool', v } }),
    numLit: (v) => ({ n: n(), op: 'lit', v: { k: 'num', v } }),
    textLit: (v) => ({ n: n(), op: 'lit', v: { k: 'text', v } }),
    dateLit: (v) => ({ n: n(), op: 'lit', v: { k: 'date', v } }),
    enumLit: (code, d) => ({ n: n(), op: 'lit', v: { k: 'enum', v: code, d } }),
    // Set literals are normalized at construction for the same reason set *values* are
    // (value.ts): `[3,1,1]` and `[1,3]` must be one literal, or `exprEq` and CSE both lie.
    setLit: (codes, d) => ({ n: n(), op: 'lit', v: { k: 'set', v: normalizeCodes(codes), d } }),
    lit: (v) => ({ n: n(), op: 'lit', v }),
    variable: (id) => ({ n: n(), op: 'var', var: id }),
    probe: (kind, target) => ({ n: n(), op: 'probe', kind, target }),
    item: () => ({ n: n(), op: 'item' }),
    itemAttr: (attr, metaKey) =>
      metaKey === undefined
        ? { n: n(), op: 'item_attr', attr }
        : { n: n(), op: 'item_attr', attr, meta_key: metaKey },
    cmp: (op, left, right) => ({ n: n(), op, args: [left, right] }),
    setOp: (op, left, right) => ({ n: n(), op, args: [left, right] }) as SetOp,
    and: (...args) => ({ n: n(), op: 'and', args }),
    or: (...args) => ({ n: n(), op: 'or', args }),
    not: (arg) => ({ n: n(), op: 'not', args: [arg] }),
    binArith: (op, a, b) => ({ n: n(), op, args: [a, b] }),
    unArith: (op, a) => ({ n: n(), op, args: [a] }),
    round: (a, digits) => ({ n: n(), op: 'round', args: [a, digits] }),
    nAryArith: (op, ...args) => ({ n: n(), op, args }),
    agg: (spec) => {
      const base = { n: n(), op: 'agg' as const, fn: spec.fn, over: spec.over };
      return {
        ...base,
        ...(spec.where !== undefined ? { where: spec.where } : {}),
        ...(spec.select !== undefined ? { select: spec.select } : {}),
        ...(spec.nulls !== undefined ? { nulls: spec.nulls } : {}),
      };
    },
    concat: (...args) => ({ n: n(), op: 'concat', args }),
    strUnary: (op, a) => ({ n: n(), op, args: [a] }),
    strBinary: (op, a, b) => ({ n: n(), op, args: [a, b] }),
    matches: (a, pattern, flags) =>
      flags === undefined
        ? { n: n(), op: 'matches', args: [a], pattern }
        : { n: n(), op: 'matches', args: [a], pattern, flags },
    substr: (a, startAt, length) => ({
      n: n(),
      op: 'substr',
      args: length === undefined ? [a, startAt] : [a, startAt, length],
    }),
    dateDiff: (unit, a, b) => ({ n: n(), op: 'date_diff', unit, args: [a, b] }),
    dateAdd: (unit, a, b) => ({ n: n(), op: 'date_add', unit, args: [a, b] }),
    datePart: (part, a) => ({ n: n(), op: 'date_part', part, args: [a] }),
    dateTrunc: (unit, a) => ({ n: n(), op: 'date_trunc', unit, args: [a] }),
    caseExpr: (cases, otherwise) => ({ n: n(), op: 'case', cases, else: otherwise }),
    coalesce: (...args) => ({ n: n(), op: 'coalesce', args }),
    cast: (to, a, onFail = 'null') => ({ n: n(), op: 'cast', to, args: [a], on_fail: onFail }),
    recode: (a, to) => ({ n: n(), op: 'recode', args: [a], to }),
    labelOf: (a, form) =>
      form === undefined
        ? { n: n(), op: 'label_of', args: [a] }
        : { n: n(), op: 'label_of', args: [a], form },
  };
}

/**
 * Renumber a tree's node ids from `start`, pre-order, returning a copy.
 *
 * Needed by two callers with the same underlying problem: D §6.4's `≡` is "structural
 * equality after normalizing node ids", and CSE (D §5.4) rewrites subtrees so ids must be
 * re-assigned densely afterwards to keep them usable as `Int32Array` indices.
 *
 * Pure: the input tree is not touched (ADR-004 — nothing in this package mutates its input).
 */
export function renumber(root: Expr, start: NodeId = 1): Expr {
  let next = start;
  const rewrite = (e: Expr): Expr => {
    const id = next;
    next += 1;
    switch (e.op) {
      case 'lit':
      case 'var':
      case 'probe':
      case 'item':
      case 'item_attr':
        return { ...e, n: id };
      case 'agg':
        return {
          ...e,
          n: id,
          ...(e.where !== undefined ? { where: rewrite(e.where) } : {}),
          ...(e.select !== undefined ? { select: rewrite(e.select) } : {}),
        };
      case 'case':
        return {
          ...e,
          n: id,
          cases: e.cases.map((c) => ({ when: rewrite(c.when), then: rewrite(c.then) })),
          else: rewrite(e.else),
        };
      default: {
        const args = e.args.map(rewrite);
        // The cast re-attaches the operator-specific arity that `map` erases to `Expr[]`.
        // Guarded by the fact that `args.length` is unchanged.
        return { ...e, n: id, args } as Expr;
      }
    }
  };
  return rewrite(root);
}

/** Strip cached types, for tests that compare a hand-written tree to a checked one. */
export function stripTypes(root: Expr): Expr {
  const rewrite = (e: Expr): Expr => {
    const children = childrenOf(e);
    const withoutType = { ...e };
    delete (withoutType as { t?: unknown }).t;
    switch (e.op) {
      case 'lit':
      case 'var':
      case 'probe':
      case 'item':
      case 'item_attr':
        return withoutType;
      case 'agg':
        return {
          ...(withoutType as Agg),
          ...(e.where !== undefined ? { where: rewrite(e.where) } : {}),
          ...(e.select !== undefined ? { select: rewrite(e.select) } : {}),
        };
      case 'case':
        return {
          ...(withoutType as CaseExpr),
          cases: e.cases.map((c) => ({ when: rewrite(c.when), then: rewrite(c.then) })),
          else: rewrite(e.else),
        };
      default:
        return { ...(withoutType as Expr), args: children.map(rewrite) } as Expr;
    }
  };
  return rewrite(root);
}
