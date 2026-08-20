/**
 * The type checker — D §3.
 *
 * Three properties of this file are requirements, not polish (D §3.4):
 *
 *  1. It runs **in the editor as you type**, because Monaco loads this same package (01 §3.1).
 *  2. It runs **at publish and blocks**, because the compiler loads this same package.
 *  3. The two therefore cannot disagree. That is the whole reason the checker lives in
 *     `packages/logic` and not in the compiler.
 *
 * The checker is parameterized by the variable registry and nothing else (D §3.2). It never
 * mutates its input: `annotate` returns a *copy* carrying `t` on every node, because the AST is
 * shared with the DSL printer and the builder, and an in-place annotation would make "the same
 * rule" depend on whether it had been checked yet.
 *
 * There is no `any` in the type language, so there is no escape from this file. `never` exists
 * only so that one type error does not produce twelve — every rule below that reports a
 * diagnostic returns `T_NEVER`, and every rule that consumes `never` stays quiet.
 */

import type {
  Agg,
  CaseExpr,
  Expr,
  Group,
  GroupItem,
  ItemAttr,
  LiteralValue,
  Type,
} from './ast.js';
import { T_BOOL, T_DATE, T_NEVER, T_NULL, T_NUM, T_TEXT, childrenOf, typeEq, typeName } from './ast.js';
import type { AggFn } from './ast-kinds.js';
import { isAstKind } from './ast-kinds.js';
import type { LgcDiagnostic, LgcJsonValue } from './diagnostics.js';
import { diagnostic } from './diagnostics.js';
import type { DomainId, NodeId, PageId, QuestionId, VariableId } from './ids.js';
import { LogicInvariant } from './ids.js';
import type { EnumDomain, TypeEnv } from './registry.js';
import { isWritableKind } from './registry.js';
import type { Effect, Rule, RuleKind } from './rules.js';

/* ========================================================================== */
/* Public surface                                                             */
/* ========================================================================== */

export interface CheckResult {
  /** The inferred type. `never` when a diagnostic was reported for the root. */
  readonly type: Type;
  /** A copy of the input with `t` filled on every node (D §2.1 item 5). */
  readonly expr: Expr;
  readonly diagnostics: readonly LgcDiagnostic[];
}

export interface CheckExprOptions {
  /**
   * RFC 6901 pointer to the expression inside the authoring document. Diagnostics carry it
   * unchanged and put the offending node's id in `detail.node`; the *position* inside the
   * source comes from the node-id source map (D §2.1 item 4), which is the DSL package's
   * business. Synthesising `/args/0/args/1` pointers here would invent a second addressing
   * scheme that nothing consumes.
   */
  readonly path?: string;
  /** Binds `item` / `item_attr`, for a per-item mask condition checked outside an `agg`. */
  readonly item?: ItemBinding;
}

/** What `item` and `item_attr` resolve to inside an aggregation or a per-item mask. */
export interface ItemBinding {
  readonly elem: Type;
  readonly meta: { readonly [key: string]: Type };
}

export function checkExpr(expr: Expr, env: TypeEnv, options: CheckExprOptions = {}): CheckResult {
  const cx: Cx = {
    env,
    diagnostics: [],
    path: options.path ?? '',
    item: options.item,
  };
  const ann = infer(expr, cx);
  return { type: ann.t, expr: ann.node, diagnostics: cx.diagnostics };
}

/** Convenience for callers that only want the annotated tree (the compiler's hot path). */
export function annotate(expr: Expr, env: TypeEnv, options: CheckExprOptions = {}): Expr {
  return checkExpr(expr, env, options).expr;
}

/* ========================================================================== */
/* Inference                                                                  */
/* ========================================================================== */

interface Cx {
  readonly env: TypeEnv;
  readonly diagnostics: LgcDiagnostic[];
  readonly path: string;
  readonly item: ItemBinding | undefined;
}

interface Ann {
  readonly node: Expr;
  readonly t: Type;
}

function report(
  cx: Cx,
  code: Parameters<typeof diagnostic>[0],
  node: Expr,
  message: string,
  detail?: { readonly [key: string]: LgcJsonValue },
): void {
  cx.diagnostics.push(
    diagnostic(code, message, cx.path, { node: node.n, op: node.op, ...(detail ?? {}) }),
  );
}

/** Erases the tuple-literal `length` so an arity guard against untrusted JSON compiles. */
function argsOf(e: Expr): readonly Expr[] {
  const anyArgs = (e as { readonly args?: readonly Expr[] }).args;
  return anyArgs ?? [];
}

function withType(node: Expr, t: Type): Expr {
  return { ...node, t } as Expr;
}

/** Re-attaches the operator-specific arity that `map` erases to `Expr[]`. */
function withArgs(node: Expr, args: readonly Expr[], t: Type): Expr {
  return { ...node, args, t } as Expr;
}

function infer(e: Expr, cx: Cx): Ann {
  if (!isAstKind(e.op)) {
    report(cx, 'LGC-T002', e, `Unknown AST node kind ${JSON.stringify(String(e.op))}.`);
    return { node: withType(e, T_NEVER), t: T_NEVER };
  }
  switch (e.op) {
    case 'lit': {
      const t = literalType(e.v);
      return { node: withType(e, t), t };
    }

    case 'var': {
      const decl = cx.env.byId(e.var);
      if (decl === undefined) {
        report(cx, 'LGC-T001', e, `Unknown variable id ${JSON.stringify(e.var)}.`, {
          variable_id: e.var,
        });
        return { node: withType(e, T_NEVER), t: T_NEVER };
      }
      const t = cx.env.typeOf(decl);
      if (t.k === 'never') {
        // A declaration this package cannot type — an `enum` with no domain, most often.
        // Reported as T001 rather than crashed on, and `never` suppresses the cascade.
        report(
          cx,
          'LGC-T001',
          e,
          `Variable ${decl.name} is declared ${decl.type} but carries no enum domain, so it has no type.`,
          { variable_id: e.var, declared: decl.type },
        );
      }
      return { node: withType(e, t), t };
    }

    case 'probe': {
      // Probes are `bool` and are **never** null (D §2.5). That is the entire point of them:
      // they let an author interrogate nullity without triggering propagation.
      const exists = probeTargetExists(e.target, cx.env);
      if (!exists) {
        report(cx, 'LGC-T016', e, `Probe target ${e.target.kind} ${JSON.stringify(e.target.id)} does not exist.`, {
          target_kind: e.target.kind,
          target_id: e.target.id,
        });
      }
      return { node: withType(e, T_BOOL), t: T_BOOL };
    }

    case 'item': {
      if (cx.item === undefined) {
        report(cx, 'LGC-T012', e, '`item` used outside an aggregation or a per-item mask condition.');
        return { node: withType(e, T_NEVER), t: T_NEVER };
      }
      return { node: withType(e, cx.item.elem), t: cx.item.elem };
    }

    case 'item_attr': {
      if (cx.item === undefined) {
        report(
          cx,
          'LGC-T012',
          e,
          '`item_attr` used outside an aggregation or a per-item mask condition.',
        );
        return { node: withType(e, T_NEVER), t: T_NEVER };
      }
      const t = itemAttrType(e, cx);
      return { node: withType(e, t), t };
    }

    case '==':
    case '!=': {
      const [a, b] = binary(e, cx);
      const t = checkEquality(e, a, b, cx);
      return { node: withArgs(e, [a.node, b.node], t), t };
    }

    case '<':
    case '<=':
    case '>':
    case '>=': {
      const [a, b] = binary(e, cx);
      const t = checkOrdered(e, a, b, cx);
      return { node: withArgs(e, [a.node, b.node], t), t };
    }

    case 'contains': {
      const [a, b] = binary(e, cx);
      const setDomain = requireSet(e, a, cx, 'left');
      if (setDomain !== undefined && b.t.k !== 'null' && b.t.k !== 'never') {
        if (b.t.k !== 'enum') {
          report(
            cx,
            'LGC-T021',
            e,
            `CONTAINS expects an enum<${setDomain}> element, got ${typeName(b.t)}. ` +
              'Option-bearing questions store integer codes, not labels; labels are translated, ' +
              'so matching on them breaks in every non-base language.',
            { expected_domain: setDomain, got: typeName(b.t) },
          );
        } else if (b.t.d !== setDomain) {
          report(
            cx,
            'LGC-T021',
            e,
            `CONTAINS expects an enum<${setDomain}> element, got enum<${b.t.d}>.`,
            { expected_domain: setDomain, got_domain: b.t.d },
          );
        }
      }
      return { node: withArgs(e, [a.node, b.node], T_BOOL), t: T_BOOL };
    }

    case 'any_of':
    case 'none_of': {
      const [a, b] = binary(e, cx);
      // The left operand may be a set or a single enum; the right must be a set of the same
      // domain. D §2.5's asymmetry (`none_of` on a null left operand is U, not T) is an
      // *evaluation* rule, not a typing rule — both type identically.
      const left = a.t.k === 'set' || a.t.k === 'enum' ? a.t.d : undefined;
      if (left === undefined && a.t.k !== 'null' && a.t.k !== 'never') {
        report(cx, 'LGC-T011', e, `${e.op.toUpperCase()} expects a set or enum on the left, got ${typeName(a.t)}.`);
      }
      const right = requireSet(e, b, cx, 'right');
      if (left !== undefined && right !== undefined && left !== right) {
        report(cx, 'LGC-T021', e, `Set operand domain ${right} differs from the element domain ${left}.`, {
          left_domain: left,
          right_domain: right,
        });
      }
      return { node: withArgs(e, [a.node, b.node], T_BOOL), t: T_BOOL };
    }

    case 'all_of':
    case 'subset_of':
    case 'set_eq': {
      const [a, b] = binary(e, cx);
      const left = requireSet(e, a, cx, 'left');
      const right = requireSet(e, b, cx, 'right');
      if (left !== undefined && right !== undefined && left !== right) {
        report(cx, 'LGC-T021', e, `Set operand domain ${right} differs from ${left}.`, {
          left_domain: left,
          right_domain: right,
        });
      }
      return { node: withArgs(e, [a.node, b.node], T_BOOL), t: T_BOOL };
    }

    case 'union':
    case 'intersect':
    case 'difference': {
      const [a, b] = binary(e, cx);
      const left = requireSet(e, a, cx, 'left');
      const right = requireSet(e, b, cx, 'right');
      if (left !== undefined && right !== undefined && left !== right) {
        report(cx, 'LGC-T021', e, `Cannot combine set<${left}> with set<${right}>.`, {
          left_domain: left,
          right_domain: right,
        });
        return { node: withArgs(e, [a.node, b.node], T_NEVER), t: T_NEVER };
      }
      const domain = left ?? right;
      const t: Type = domain === undefined ? T_NEVER : { k: 'set', d: domain };
      return { node: withArgs(e, [a.node, b.node], t), t };
    }

    case 'and':
    case 'or': {
      const args = argsOf(e).map((a) => infer(a, cx));
      if (args.length < 2) {
        report(cx, 'LGC-T006', e, `${e.op.toUpperCase()} needs at least two operands, got ${args.length}.`, {
          arity: args.length,
        });
      }
      for (const a of args) requireBool(e, a, cx);
      return { node: withArgs(e, args.map((a) => a.node), T_BOOL), t: T_BOOL };
    }

    case 'not': {
      const args = argsOf(e).map((a) => infer(a, cx));
      if (args.length !== 1) {
        report(cx, 'LGC-T006', e, `NOT takes exactly one operand, got ${args.length}.`, { arity: args.length });
      }
      for (const a of args) requireBool(e, a, cx);
      return { node: withArgs(e, args.map((a) => a.node), T_BOOL), t: T_BOOL };
    }

    case '+':
    case '-':
    case '*':
    case '/':
    case 'mod':
    case 'pow':
    case 'round':
      return arith(e, cx, 2, 2);

    case 'neg':
    case 'abs':
    case 'floor':
    case 'ceil':
      return arith(e, cx, 1, 1);

    case 'min':
    case 'max':
      return arith(e, cx, 1, Number.MAX_SAFE_INTEGER);

    case 'clamp':
      return arith(e, cx, 3, 3);

    case 'agg':
      return inferAgg(e, cx);

    case 'concat': {
      const args = argsOf(e).map((a) => infer(a, cx));
      for (const a of args) requireText(e, a, cx);
      return { node: withArgs(e, args.map((a) => a.node), T_TEXT), t: T_TEXT };
    }

    case 'lower':
    case 'upper':
    case 'trim': {
      const args = strArgs(e, cx, 1, 1);
      return { node: withArgs(e, args, T_TEXT), t: T_TEXT };
    }

    case 'len':
    case 'word_count': {
      // `len(null)` is `null`, not `0` (D §2.5). That is an evaluation rule; the *type* is num.
      const args = strArgs(e, cx, 1, 1);
      return { node: withArgs(e, args, T_NUM), t: T_NUM };
    }

    case 'starts_with':
    case 'ends_with':
    case 'str_contains': {
      const args = strArgs(e, cx, 2, 2);
      return { node: withArgs(e, args, T_BOOL), t: T_BOOL };
    }

    case 'split_count': {
      const args = strArgs(e, cx, 2, 2);
      return { node: withArgs(e, args, T_NUM), t: T_NUM };
    }

    case 'substr': {
      const raw = argsOf(e).map((a) => infer(a, cx));
      if (raw.length < 2 || raw.length > 3) {
        report(cx, 'LGC-T006', e, `SUBSTR takes two or three operands, got ${raw.length}.`, {
          arity: raw.length,
        });
      }
      const first = raw[0];
      if (first !== undefined) requireText(e, first, cx);
      for (const a of raw.slice(1)) requireNum(e, a, cx);
      return { node: withArgs(e, raw.map((a) => a.node), T_TEXT), t: T_TEXT };
    }

    case 'matches': {
      const args = strArgs(e, cx, 1, 1);
      checkRegex(e, e.pattern, e.flags, cx);
      return { node: withArgs(e, args, T_BOOL), t: T_BOOL };
    }

    case 'date_diff': {
      const args = dateArgs(e, cx, 2);
      return { node: withArgs(e, args, T_NUM), t: T_NUM };
    }

    case 'date_add': {
      const raw = argsOf(e).map((a) => infer(a, cx));
      if (raw.length !== 2) {
        report(cx, 'LGC-T006', e, `DATE_ADD takes two operands, got ${raw.length}.`, { arity: raw.length });
      }
      const base = raw[0];
      if (base !== undefined) requireDate(e, base, cx);
      const amount = raw[1];
      if (amount !== undefined) requireNum(e, amount, cx);
      return { node: withArgs(e, raw.map((a) => a.node), T_DATE), t: T_DATE };
    }

    case 'date_part': {
      const args = dateArgs(e, cx, 1);
      return { node: withArgs(e, args, T_NUM), t: T_NUM };
    }

    case 'date_trunc': {
      const args = dateArgs(e, cx, 1);
      return { node: withArgs(e, args, T_DATE), t: T_DATE };
    }

    case 'case':
      return inferCase(e, cx);

    case 'coalesce': {
      const args = argsOf(e).map((a) => infer(a, cx));
      if (args.length < 1) {
        report(cx, 'LGC-T006', e, 'COALESCE needs at least one operand.', { arity: 0 });
      }
      let t: Type = T_NULL;
      for (const a of args) {
        const unified = unify(t, a.t);
        if (unified === undefined) {
          report(
            cx,
            'LGC-T015',
            e,
            `COALESCE arguments have non-unifiable types: ${typeName(t)} and ${typeName(a.t)}.`,
            { left: typeName(t), right: typeName(a.t) },
          );
          t = T_NEVER;
          break;
        }
        t = unified;
      }
      return { node: withArgs(e, args.map((a) => a.node), t), t };
    }

    case 'cast': {
      const args = argsOf(e).map((a) => infer(a, cx));
      if (args.length !== 1) {
        report(cx, 'LGC-T006', e, `CAST takes one operand, got ${args.length}.`, { arity: args.length });
      }
      const t = castTarget(e.to);
      return { node: withArgs(e, args.map((a) => a.node), t), t };
    }

    case 'label_of': {
      // `label_of` accepts anything with a label — an enum, a set, or a null. The result is
      // text, and `label_of(null)` is null (D §2.5), which piping renders as the empty token.
      const args = argsOf(e).map((a) => infer(a, cx));
      if (args.length !== 1) {
        report(cx, 'LGC-T006', e, `LABEL_OF takes one operand, got ${args.length}.`, { arity: args.length });
      }
      return { node: withArgs(e, args.map((a) => a.node), T_TEXT), t: T_TEXT };
    }

    default: {
      // The `never` guard. Adding a member to `Expr` without a case here is a compile error,
      // which is the mechanism D §7.2 asks for: a new node kind must be a four-file change,
      // and the build must fail until all four exist.
      const never: never = e;
      throw new LogicInvariant(`unhandled AST node ${JSON.stringify(never)}`);
    }
  }
}

/* ========================================================================== */
/* Inference helpers                                                          */
/* ========================================================================== */

function binary(e: Expr, cx: Cx): [Ann, Ann] {
  const args = argsOf(e);
  if (args.length !== 2) {
    report(cx, 'LGC-T006', e, `${e.op} takes exactly two operands, got ${args.length}.`, {
      arity: args.length,
    });
  }
  const a = args[0];
  const b = args[1];
  const left = a === undefined ? nullAnn(e.n) : infer(a, cx);
  const right = b === undefined ? nullAnn(e.n) : infer(b, cx);
  return [left, right];
}

/** A stand-in for a missing operand, so one arity error does not produce a crash. */
function nullAnn(n: NodeId): Ann {
  return { node: { n, op: 'lit', v: { k: 'null' }, t: T_NEVER }, t: T_NEVER };
}

function literalType(v: LiteralValue): Type {
  switch (v.k) {
    case 'null':
      return T_NULL;
    case 'bool':
      return T_BOOL;
    case 'num':
      return T_NUM;
    case 'text':
      return T_TEXT;
    case 'date':
      return T_DATE;
    case 'enum':
      return { k: 'enum', d: v.d };
    case 'set':
      return { k: 'set', d: v.d };
    default: {
      const never: never = v;
      throw new LogicInvariant(`unhandled literal ${JSON.stringify(never)}`);
    }
  }
}

function castTarget(to: 'num' | 'text' | 'date' | 'bool'): Type {
  switch (to) {
    case 'num':
      return T_NUM;
    case 'text':
      return T_TEXT;
    case 'date':
      return T_DATE;
    case 'bool':
      return T_BOOL;
    default: {
      const never: never = to;
      throw new LogicInvariant(`unhandled cast target ${JSON.stringify(never)}`);
    }
  }
}

/**
 * `compatEq` from D §3.3: num~num, text~text, bool~bool, date~date, enum<d>~enum<d>,
 * set<d>~set<d>, obj~obj (deep), and τ~null for any τ.
 *
 * Deliberately absent: enum~num and enum~text. Comparing an enum to a text literal is never
 * coerced in either direction, because labels are translated and `Q1 == "yes"` would break in
 * every non-English language (D §3.4). `CODE()` — a `cast` to num — is the explicit escape.
 */
function checkEquality(e: Expr, a: Ann, b: Ann, cx: Cx): Type {
  if (a.t.k === 'never' || b.t.k === 'never') return T_BOOL;
  if (a.t.k === 'null' || b.t.k === 'null') return T_BOOL;
  if (a.t.k === 'enum' && b.t.k === 'enum' && a.t.d !== b.t.d) {
    report(
      cx,
      'LGC-T007',
      e,
      `Cannot compare enum<${a.t.d}> with enum<${b.t.d}>. Codes that happen to overlap are not ` +
        'the same domain — enum values are nominal. Did you mean CODE(a) == CODE(b)?',
      { left_domain: a.t.d, right_domain: b.t.d, ...domainHint(cx, a.t.d, b.t.d) },
    );
    return T_BOOL;
  }
  if (!typeEq(a.t, b.t)) {
    report(
      cx,
      'LGC-T003',
      e,
      `Type mismatch in comparison: left ${typeName(a.t)}, right ${typeName(b.t)}.` +
        (a.t.k === 'enum' && b.t.k === 'text'
          ? ' An option-bearing question stores integer codes, not labels.'
          : ''),
      { left: typeName(a.t), right: typeName(b.t) },
    );
  }
  return T_BOOL;
}

/**
 * `ordered(τ) ∧ τ = τ'` from D §3.3. `ordered` is num, date, and enum<d> **only when the
 * domain is declared ordinal**.
 *
 * The ordinal requirement is the fix for the "top-2-box on a brand list" bug: scales are
 * ordinal, brand lists are not, and `<` on a brand list silently counts the first two brands
 * in list order as favourable. `text` is deliberately not ordered — lexicographic comparison
 * of translated strings is never what an author means.
 */
function checkOrdered(e: Expr, a: Ann, b: Ann, cx: Cx): Type {
  if (a.t.k === 'never' || b.t.k === 'never') return T_BOOL;
  if (a.t.k === 'null' || b.t.k === 'null') return T_BOOL;
  if (!typeEq(a.t, b.t)) {
    report(
      cx,
      'LGC-T003',
      e,
      `Ordered comparison needs both operands to be the same type: left ${typeName(a.t)}, right ${typeName(b.t)}.`,
      { left: typeName(a.t), right: typeName(b.t) },
    );
    return T_BOOL;
  }
  if (a.t.k === 'num' || a.t.k === 'date') return T_BOOL;
  if (a.t.k === 'enum') {
    const domain = cx.env.domain(a.t.d);
    if (domain === undefined || !domain.ordinal) {
      report(
        cx,
        'LGC-T009',
        e,
        `${e.op} is not defined on the non-ordinal enum domain ${a.t.d}. Ordering a nominal ` +
          'list (a brand list) by code is meaningless — it produces the "top 2 box on a brand ' +
          'list" bug. Declare the domain ordinal, or compare CODE() explicitly.',
        { domain: a.t.d },
      );
    }
    return T_BOOL;
  }
  report(cx, 'LGC-T003', e, `${e.op} is not defined on ${typeName(a.t)}.`, { operand: typeName(a.t) });
  return T_BOOL;
}

function domainHint(cx: Cx, left: DomainId, right: DomainId): { readonly [key: string]: LgcJsonValue } {
  const describe = (d: DomainId): LgcJsonValue => {
    const domain = cx.env.domain(d);
    if (domain === undefined) return null;
    return domain.entries.map((entry) => entry.code);
  };
  return { left_codes: describe(left), right_codes: describe(right) };
}

function requireSet(e: Expr, a: Ann, cx: Cx, side: 'left' | 'right'): DomainId | undefined {
  if (a.t.k === 'set') return a.t.d;
  if (a.t.k === 'null' || a.t.k === 'never') return undefined;
  report(cx, 'LGC-T011', e, `${e.op} expects a set on the ${side}, got ${typeName(a.t)}.`, {
    side,
    got: typeName(a.t),
  });
  return undefined;
}

function requireBool(e: Expr, a: Ann, cx: Cx): void {
  if (a.t.k === 'bool' || a.t.k === 'null' || a.t.k === 'never') return;
  report(cx, 'LGC-T004', e, `${e.op} expects a boolean operand, got ${typeName(a.t)}.`, {
    got: typeName(a.t),
  });
}

function requireNum(e: Expr, a: Ann, cx: Cx): void {
  if (a.t.k === 'num' || a.t.k === 'null' || a.t.k === 'never') return;
  report(cx, 'LGC-T005', e, `${e.op} expects a numeric operand, got ${typeName(a.t)}.`, {
    got: typeName(a.t),
  });
}

function requireText(e: Expr, a: Ann, cx: Cx): void {
  if (a.t.k === 'text' || a.t.k === 'null' || a.t.k === 'never') return;
  report(cx, 'LGC-T008', e, `${e.op} expects a text operand, got ${typeName(a.t)}.`, {
    got: typeName(a.t),
  });
}

function requireDate(e: Expr, a: Ann, cx: Cx): void {
  if (a.t.k === 'date' || a.t.k === 'null' || a.t.k === 'never') return;
  report(cx, 'LGC-T010', e, `${e.op} expects a date operand, got ${typeName(a.t)}.`, {
    got: typeName(a.t),
  });
}

function arith(e: Expr, cx: Cx, min: number, max: number): Ann {
  const args = argsOf(e).map((a) => infer(a, cx));
  if (args.length < min || args.length > max) {
    report(cx, 'LGC-T006', e, `${e.op} takes ${arityText(min, max)}, got ${args.length}.`, {
      arity: args.length,
    });
  }
  for (const a of args) requireNum(e, a, cx);
  return { node: withArgs(e, args.map((a) => a.node), T_NUM), t: T_NUM };
}

function arityText(min: number, max: number): string {
  if (min === max) return `${min} operand(s)`;
  if (max === Number.MAX_SAFE_INTEGER) return `at least ${min} operand(s)`;
  return `between ${min} and ${max} operands`;
}

function strArgs(e: Expr, cx: Cx, min: number, max: number): readonly Expr[] {
  const args = argsOf(e).map((a) => infer(a, cx));
  if (args.length < min || args.length > max) {
    report(cx, 'LGC-T006', e, `${e.op} takes ${arityText(min, max)}, got ${args.length}.`, {
      arity: args.length,
    });
  }
  for (const a of args) requireText(e, a, cx);
  return args.map((a) => a.node);
}

function dateArgs(e: Expr, cx: Cx, count: number): readonly Expr[] {
  const args = argsOf(e).map((a) => infer(a, cx));
  if (args.length !== count) {
    report(cx, 'LGC-T006', e, `${e.op} takes ${count} operand(s), got ${args.length}.`, {
      arity: args.length,
    });
  }
  for (const a of args) requireDate(e, a, cx);
  return args.map((a) => a.node);
}

/**
 * `null` unifies with anything (nullity is a value-level property, D §3.1) and `never` is
 * absorbing-quiet so one error does not cascade. Everything else must match exactly:
 * **`case` branches unify strictly, with no widening to text** (D §3.3), which is what catches
 * a `case` returning `1` in one branch and `"18_24"` in another — the `AGE_BAND` defect in
 * schema §19 that D §11 note 1 records.
 */
export function unify(a: Type, b: Type): Type | undefined {
  if (a.k === 'never') return b;
  if (b.k === 'never') return a;
  if (a.k === 'null') return b;
  if (b.k === 'null') return a;
  if (typeEq(a, b)) return a;
  return undefined;
}

function inferCase(e: CaseExpr, cx: Cx): Ann {
  const cases = e.cases.map((c) => {
    const when = infer(c.when, cx);
    requireBool(e, when, cx);
    const then = infer(c.then, cx);
    return { when, then };
  });
  const otherwise = infer(e.else, cx);

  let t: Type = T_NULL;
  for (const c of cases) {
    const unified = unify(t, c.then.t);
    if (unified === undefined) {
      report(
        cx,
        'LGC-T014',
        e,
        `CASE branches have non-unifiable types: ${typeName(t)} and ${typeName(c.then.t)}. ` +
          'Branches unify strictly; there is no widening to text.',
        { left: typeName(t), right: typeName(c.then.t) },
      );
      t = T_NEVER;
      break;
    }
    t = unified;
  }
  if (t.k !== 'never') {
    const unified = unify(t, otherwise.t);
    if (unified === undefined) {
      report(
        cx,
        'LGC-T014',
        e,
        `CASE else branch is ${typeName(otherwise.t)} but the when-branches are ${typeName(t)}.`,
        { left: typeName(t), right: typeName(otherwise.t) },
      );
      t = T_NEVER;
    } else {
      t = unified;
    }
  }

  const node: Expr = {
    ...e,
    cases: cases.map((c) => ({ when: c.when.node, then: c.then.node })),
    else: otherwise.node,
    t,
  };
  return { node, t };
}

/* ========================================================================== */
/* Aggregation                                                                */
/* ========================================================================== */

/**
 * The element type of a group: the unified type of its member variables, or `enum<domain>` for
 * an `options` group (which "iterate[s] options, not vars", D §2.3).
 */
export function groupElementType(
  group: Group,
  items: readonly GroupItem[],
  env: TypeEnv,
): Type {
  if (group.kind === 'options') {
    const question = env.question(group.question_id);
    const domain = question?.domain;
    return domain === undefined ? T_NEVER : { k: 'enum', d: domain };
  }
  let t: Type = T_NULL;
  for (const item of items) {
    if (item.variable_id === undefined) continue;
    const decl = env.byId(item.variable_id);
    if (decl === undefined) continue;
    const unified = unify(t, env.typeOf(decl));
    if (unified === undefined) return T_NEVER;
    t = unified;
  }
  return t.k === 'null' ? T_NEVER : t;
}

function itemMetaTypes(items: readonly GroupItem[]): { readonly [key: string]: Type } {
  const out: { [key: string]: Type } = {};
  for (const item of items) {
    if (item.meta === undefined) continue;
    for (const key of Object.keys(item.meta)) {
      const raw = item.meta[key];
      const observed: Type =
        typeof raw === 'number' ? T_NUM : typeof raw === 'boolean' ? T_BOOL : typeof raw === 'string' ? T_TEXT : T_NULL;
      const previous = out[key];
      const unified = previous === undefined ? observed : unify(previous, observed);
      out[key] = unified ?? T_NEVER;
    }
  }
  return out;
}

/**
 * `item_attr` typing, D §3.3: `code : num`, `label : text`, `selected : bool`, and `position`
 * (absent from D's abridged table) `: num`, since it is an index into the randomizer's order.
 *
 * A `meta` lookup is the awkward corner: D §2.3 gives `item_attr` a `meta_key` field but no
 * `'meta'` member in `attr`, so the two spellings disagree. Resolved here by treating a present
 * `meta_key` as the discriminator — a meta lookup is a meta lookup whatever `attr` says — and
 * typing it from the *observed* metas of the group's items, because schema declares item meta
 * as free-form JSON with no type. Inconsistent metas across a group are `LGC-T013` rather than
 * a silent `text`, since `item.meta.discontinued = TRUE` (D §6.3) must not compare a bool to a
 * string somewhere in the middle of a list.
 */
function itemAttrType(e: ItemAttr, cx: Cx): Type {
  const binding = cx.item;
  if (binding === undefined) return T_NEVER;
  if (e.meta_key !== undefined) {
    const t = binding.meta[e.meta_key];
    if (t === undefined) {
      report(cx, 'LGC-T013', e, `No item in this group declares the meta key ${JSON.stringify(e.meta_key)}.`, {
        meta_key: e.meta_key,
      });
      return T_NEVER;
    }
    if (t.k === 'never') {
      report(
        cx,
        'LGC-T013',
        e,
        `Item meta key ${JSON.stringify(e.meta_key)} has different types on different items in this group.`,
        { meta_key: e.meta_key },
      );
      return T_NEVER;
    }
    return t;
  }
  switch (e.attr) {
    case 'code':
      return T_NUM;
    case 'label':
      return T_TEXT;
    case 'position':
      return T_NUM;
    case 'selected':
      return T_BOOL;
    default: {
      const never: never = e.attr;
      throw new LogicInvariant(`unhandled item attribute ${JSON.stringify(never)}`);
    }
  }
}

function inferAgg(e: Agg, cx: Cx): Ann {
  const items = e.resolved ?? cx.env.groupItems(e.over);
  if (items.length === 0) {
    report(
      cx,
      'LGC-T018',
      e,
      `Aggregation group ${e.over.kind} resolves to zero items. An aggregation over nothing has ` +
        'no defined value, and it is almost always a stale question reference.',
      { group: e.over.kind },
    );
  }
  const elem = groupElementType(e.over, items, cx.env);
  const inner: Cx = { ...cx, item: { elem, meta: itemMetaTypes(items) } };

  const where = e.where === undefined ? undefined : infer(e.where, inner);
  if (where !== undefined) requireBool(e, where, cx);
  const select = e.select === undefined ? undefined : infer(e.select, inner);

  // The projected type: `select` when present, otherwise the item itself.
  const projected = select?.t ?? elem;
  const t = aggResultType(e, e.fn, projected, cx);

  const node: Expr = {
    ...e,
    ...(where === undefined ? {} : { where: where.node }),
    ...(select === undefined ? {} : { select: select.node }),
    ...(e.resolved === undefined ? { resolved: items } : {}),
    t,
  };
  return { node, t };
}

function aggResultType(e: Agg, fn: AggFn, projected: Type, cx: Cx): Type {
  switch (fn) {
    case 'count':
    case 'distinct_count':
      return T_NUM;
    case 'sum':
    case 'mean':
    case 'stdev':
      if (projected.k !== 'num' && projected.k !== 'never') {
        report(cx, 'LGC-T019', e, `${fn.toUpperCase()} needs numeric members, got ${typeName(projected)}.`, {
          fn,
          got: typeName(projected),
        });
        return T_NEVER;
      }
      return T_NUM;
    case 'min':
    case 'max': {
      if (projected.k === 'never') return T_NEVER;
      if (projected.k === 'num' || projected.k === 'date') return projected;
      if (projected.k === 'enum') {
        const domain = cx.env.domain(projected.d);
        if (domain !== undefined && domain.ordinal) return projected;
        report(cx, 'LGC-T009', e, `${fn.toUpperCase()} orders its members, and ${typeName(projected)} is not ordinal.`, {
          fn,
          domain: projected.d,
        });
        return T_NEVER;
      }
      report(cx, 'LGC-T019', e, `${fn.toUpperCase()} needs ordered members, got ${typeName(projected)}.`, {
        fn,
        got: typeName(projected),
      });
      return T_NEVER;
    }
    case 'any':
    case 'all':
      if (projected.k !== 'bool' && projected.k !== 'never') {
        report(cx, 'LGC-T019', e, `${fn.toUpperCase()} needs boolean members, got ${typeName(projected)}.`, {
          fn,
          got: typeName(projected),
        });
        return T_NEVER;
      }
      return T_BOOL;
    case 'first_answered':
    case 'last_answered':
      // Not in D §3.3's abridged table. These pick a member, so they return the member type —
      // the same rule as min/max without the ordering requirement.
      return projected;
    default: {
      const never: never = fn;
      throw new LogicInvariant(`unhandled aggregation ${JSON.stringify(never)}`);
    }
  }
}

/* ========================================================================== */
/* Regex safety (LGC-T025)                                                    */
/* ========================================================================== */

/**
 * Two failure modes, one code.
 *
 * 1. **The pattern does not compile.** Caught by constructing it once, here, at compile time.
 * 2. **The pattern is not provably linear-time.** A full linearity proof needs an automaton
 *    analysis; this is a narrow *shape* check for a quantifier applied to a group that already
 *    contains a quantifier (`(a+)+`), which is the shape behind essentially every reported
 *    catastrophic-backtracking incident. It is deliberately narrow rather than aggressive: a
 *    false positive here **blocks a publish**, and a diagnostic that blocks a valid survey gets
 *    the whole check deleted within a week. Missing some exponential patterns costs a slow
 *    validation on one open-end; blocking a valid publish costs trust.
 *
 * The `g` and `y` flags are rejected outright, and that is not a style rule: both make a
 * `RegExp` object *stateful* through `lastIndex`, so a cached regex would return different
 * answers for identical inputs on successive calls. That is precisely the impurity ADR-004's
 * divergence detector exists to catch, and it would present as an unreproducible verdict.
 */
export function regexDiagnosis(pattern: string, flags?: string): string | undefined {
  if (flags !== undefined) {
    for (const flag of flags) {
      if (flag === 'g' || flag === 'y') {
        return `the ${flag} flag makes the pattern stateful (lastIndex), so the same input can ` +
          'produce different verdicts on successive evaluations';
      }
      if (!'imsu'.includes(flag)) return `unsupported regex flag ${JSON.stringify(flag)}`;
    }
  }
  try {
    new RegExp(pattern, flags);
  } catch (err: unknown) {
    return `does not compile: ${err instanceof Error ? err.message : String(err)}`;
  }
  if (hasNestedQuantifier(pattern)) {
    return 'contains a quantifier applied to a group that is itself quantified, which can ' +
      'backtrack exponentially';
  }
  return undefined;
}

function checkRegex(e: Expr, pattern: string, flags: string | undefined, cx: Cx): void {
  const problem = regexDiagnosis(pattern, flags);
  if (problem !== undefined) {
    report(cx, 'LGC-T025', e, `Regex ${JSON.stringify(pattern)} ${problem}.`, {
      pattern,
      ...(flags === undefined ? {} : { flags }),
    });
  }
}

function hasNestedQuantifier(pattern: string): boolean {
  // Walk the pattern tracking group nesting, note whether each open group body contains a
  // quantifier, and flag when a group that did is itself immediately quantified.
  const stack: boolean[] = [];
  let escaped = false;
  let inClass = false;
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === undefined) break;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (inClass) {
      if (ch === ']') inClass = false;
      continue;
    }
    if (ch === '[') {
      inClass = true;
      continue;
    }
    if (ch === '(') {
      stack.push(false);
      continue;
    }
    if (ch === ')') {
      const innerHadQuantifier = stack.pop() ?? false;
      const next = pattern[i + 1];
      const quantified = next === '*' || next === '+' || (next === '{' && !pattern.startsWith('{0,1}', i + 1));
      if (innerHadQuantifier && quantified) return true;
      continue;
    }
    if (ch === '*' || ch === '+' || ch === '{') {
      if (stack.length > 0) stack[stack.length - 1] = true;
    }
  }
  return false;
}

/* ========================================================================== */
/* Rules                                                                      */
/* ========================================================================== */

export interface CheckRuleOptions {
  readonly path?: string;
}

export interface RuleCheckResult {
  /** The rule with `t` filled on every node of every expression it carries. */
  readonly rule: Rule;
  readonly diagnostics: readonly LgcDiagnostic[];
}

/**
 * Rule-level checks: everything that needs the effect as well as the condition.
 *
 * The condition must be boolean-typed (`LGC-T033`) — the rule boundary is where the single
 * coercion happens (D §2.5), and coercing a *number* there would be a second, undocumented
 * coercion point. That is the failure the whole three-valued design exists to prevent.
 *
 * Returns the annotated rule as well as the diagnostics because the compiler needs both and
 * checking twice to get them separately would double the most expensive compile pass (D §10.2
 * measures typechecking 640 rules at 38 ms, an order of magnitude above everything else).
 */
export function checkRule(rule: Rule, env: TypeEnv, options: CheckRuleOptions = {}): RuleCheckResult {
  const path = options.path ?? '';
  const diagnostics: LgcDiagnostic[] = [];

  const condition = checkExpr(rule.condition, env, { path: `${path}/condition` });
  diagnostics.push(...condition.diagnostics);
  if (condition.type.k !== 'bool' && condition.type.k !== 'null' && condition.type.k !== 'never') {
    diagnostics.push(
      diagnostic(
        'LGC-T033',
        `Rule condition must be boolean, got ${typeName(condition.type)}. There is no implicit ` +
          'truthiness: the rule boundary is the single coercion point and it collapses UNKNOWN, ' +
          'not numbers or strings.',
        `${path}/condition`,
        { rule_id: rule.id, got: typeName(condition.type) },
      ),
    );
  }

  const effect = checkEffect(rule, env, path);
  diagnostics.push(...effect.diagnostics);
  diagnostics.push(...checkTargetKind(rule, path));

  if (rule.on_unknown === 'fire') {
    diagnostics.push(
      diagnostic(
        'LGC-I002',
        `Rule ${rule.id} overrides the UNKNOWN collapse with ON UNKNOWN, so it fires when its ` +
          'condition is neither true nor false. Deliberate overrides are legitimate; this note ' +
          'exists so a reviewer sees every one of them.',
        path,
        { rule_id: rule.id },
      ),
    );
  }

  if (rule.kind === 'terminate' && mayBeUnknown(rule.condition, env)) {
    diagnostics.push(
      diagnostic(
        'LGC-W021',
        `Terminate rule ${rule.id} can evaluate to UNKNOWN, which collapses to "do not ` +
          'terminate". That is the safe direction, but if the author expected it to fire for ' +
          'respondents who never saw the question, it will not. Guard it with ANSWERED(...).',
        `${path}/condition`,
        { rule_id: rule.id },
      ),
    );
  }

  const constant = constantVerdict(rule.condition);
  if (constant !== undefined) {
    diagnostics.push(
      diagnostic(
        'LGC-W030',
        `Rule ${rule.id}'s condition is constant (${constant}); it reads no variable and no probe.`,
        `${path}/condition`,
        { rule_id: rule.id, verdict: constant },
      ),
    );
  }

  return { rule: { ...rule, condition: condition.expr, effect: effect.effect }, diagnostics };
}

interface EffectCheckResult {
  readonly effect: Effect;
  readonly diagnostics: readonly LgcDiagnostic[];
}

function checkEffect(rule: Rule, env: TypeEnv, path: string): EffectCheckResult {
  const effect = rule.effect;
  const diagnostics: LgcDiagnostic[] = [];
  switch (effect.action) {
    case 'set': {
      const target = env.byId(effect.variable_id);
      const value = checkExpr(effect.value, env, { path: `${path}/effect/value` });
      diagnostics.push(...value.diagnostics);
      if (target === undefined) {
        diagnostics.push(
          diagnostic('LGC-T001', `SET target ${effect.variable_id} is not a known variable.`, `${path}/effect`, {
            rule_id: rule.id,
            variable_id: effect.variable_id,
          }),
        );
        return { effect: { ...effect, value: value.expr }, diagnostics };
      }
      if (!isWritableKind(target.kind)) {
        diagnostics.push(
          diagnostic(
            'LGC-T030',
            `SET target ${target.name} is a ${target.kind} variable and is not writable. ` +
              'Response variables belong to the respondent and system variables to the runtime; ' +
              'a rule that overwrote either would make the export disagree with what was asked.',
            `${path}/effect`,
            { rule_id: rule.id, variable_id: effect.variable_id, kind: target.kind },
          ),
        );
      }
      const declared = env.typeOf(target);
      if (unify(declared, value.type) === undefined) {
        diagnostics.push(
          diagnostic(
            'LGC-T031',
            `SET ${target.name} expects ${typeName(declared)} but the value is ${typeName(value.type)}.`,
            `${path}/effect/value`,
            { rule_id: rule.id, expected: typeName(declared), got: typeName(value.type) },
          ),
        );
      }
      return { effect: { ...effect, value: value.expr }, diagnostics };
    }
    case 'mask': {
      if (
        effect.fallback === undefined ||
        (effect.fallback as { when_empty?: unknown }).when_empty === undefined
      ) {
        // Typed as required, so this is only reachable from untrusted JSON — which is exactly
        // where it matters. An unset fallback is how a masked question dead-ends in field.
        diagnostics.push(
          diagnostic('LGC-T032', `Mask rule ${rule.id} has no fallback.when_empty.`, `${path}/effect`, {
            rule_id: rule.id,
          }),
        );
      }
      const question = rule.target.type === 'question' ? env.question(rule.target.id) : undefined;
      const items = question === undefined ? [] : itemsForAxis(question, effect.applies_to);
      const perItem = checkExpr(effect.per_item, env, {
        path: `${path}/effect/per_item`,
        item: {
          elem: question?.domain === undefined ? T_NEVER : { k: 'enum', d: question.domain },
          meta: itemMetaTypes(items),
        },
      });
      diagnostics.push(...perItem.diagnostics);
      if (perItem.type.k !== 'bool' && perItem.type.k !== 'null' && perItem.type.k !== 'never') {
        diagnostics.push(
          diagnostic(
            'LGC-T004',
            `A mask's per-item condition must be boolean, got ${typeName(perItem.type)}.`,
            `${path}/effect/per_item`,
            { rule_id: rule.id, got: typeName(perItem.type) },
          ),
        );
      }
      return { effect: { ...effect, per_item: perItem.expr }, diagnostics };
    }
    case 'option_state': {
      const value = checkExpr(effect.value, env, { path: `${path}/effect/value` });
      diagnostics.push(...value.diagnostics);
      if (value.type.k !== 'bool' && value.type.k !== 'null' && value.type.k !== 'never') {
        diagnostics.push(
          diagnostic(
            'LGC-T004',
            `Option ${effect.prop} must be boolean, got ${typeName(value.type)}.`,
            `${path}/effect/value`,
            { rule_id: rule.id, prop: effect.prop, got: typeName(value.type) },
          ),
        );
      }
      return { effect: { ...effect, value: value.expr }, diagnostics };
    }
    case 'show':
    case 'hide':
    case 'skip_to':
    case 'skip_this':
    case 'require_valid':
    case 'terminate':
      return { effect, diagnostics };
    default: {
      const never: never = effect;
      throw new LogicInvariant(`unhandled effect ${JSON.stringify(never)}`);
    }
  }
}

function itemsForAxis(
  question: NonNullable<ReturnType<TypeEnv['question']>>,
  axis: 'options' | 'rows' | 'columns',
): readonly GroupItem[] {
  const list = axis === 'options' ? question.options : axis === 'rows' ? question.rows : question.columns;
  return list.map((item) => ({
    option_id: item.option_id,
    code: item.code,
    label_key: item.label_key,
    position: item.position,
    ...(item.variable_id === undefined ? {} : { variable_id: item.variable_id }),
    ...(item.meta === undefined ? {} : { meta: item.meta }),
  }));
}

/** A rule kind writes exactly one family of cell, so its target kind is not free. */
function checkTargetKind(rule: Rule, path: string): readonly LgcDiagnostic[] {
  const allowed: { readonly [K in RuleKind]: readonly string[] } = {
    display: ['question', 'page', 'block'],
    skip: ['question', 'page', 'block', 'survey'],
    mask: ['question'],
    set_variable: ['variable', 'survey'],
    validate: ['question', 'page', 'variable'],
    option_state: ['option', 'question'],
    terminate: ['survey', 'question', 'page'],
  };
  const permitted = allowed[rule.kind];
  if (permitted.includes(rule.target.type)) return [];
  return [
    diagnostic(
      'LGC-T034',
      `A ${rule.kind} rule cannot target a ${rule.target.type}; it must target one of ${permitted.join(', ')}.`,
      `${path}/target`,
      { rule_id: rule.id, kind: rule.kind, target: rule.target.type },
    ),
  ];
}

function probeTargetExists(
  target: { readonly kind: 'variable' | 'question' | 'page'; readonly id: string },
  env: TypeEnv,
): boolean {
  switch (target.kind) {
    case 'variable':
      return env.byId(target.id as VariableId) !== undefined;
    case 'question':
      // The question registry is optional: the studio's editor path checks conditions against
      // variables alone, before a full compile has resolved the tree. Absent registry means
      // "cannot disprove", not "does not exist" — reporting T016 there would light up the
      // editor with errors that publish does not have.
      return env.questions().length === 0 || env.question(target.id as QuestionId) !== undefined;
    case 'page':
      return env.pages().length === 0 || env.page(target.id as PageId) !== undefined;
    default: {
      const never: never = target.kind;
      throw new LogicInvariant(`unhandled probe target ${JSON.stringify(never)}`);
    }
  }
}

/* ========================================================================== */
/* Three-valued reachability of UNKNOWN (LGC-W021)                            */
/* ========================================================================== */

/**
 * Can this condition be UNKNOWN?
 *
 * A syntactic over-approximation, sound in the direction that matters: it says "yes" whenever
 * it cannot prove "no". The one pattern it *does* prove is the one D §2.5 names as preferred —
 * `ANSWERED(Q9) AND Q9 > 3` — because an author who has written the guard should not then be
 * warned about the thing they guarded. Without that case the warning fires on the correct code
 * and gets ignored, which is worse than not having it.
 *
 * D §8.1's full answer needs the flow graph and a dominance query, and that analysis belongs to
 * the compiler (P1-08), which owns `graph.json`. This is the part that can be decided from the
 * expression alone.
 */
export function mayBeUnknown(expr: Expr, env: TypeEnv, guarded: ReadonlySet<string> = new Set()): boolean {
  switch (expr.op) {
    case 'probe':
      return false;
    case 'lit':
      return expr.v.k === 'null';
    case 'var':
      return !guarded.has(expr.var);
    case 'and': {
      const asserted = new Set(guarded);
      for (const arg of expr.args) {
        if (arg.op === 'probe' && arg.kind === 'answered' && arg.target.kind === 'variable') {
          asserted.add(arg.target.id);
        }
      }
      return expr.args.some((arg) => mayBeUnknown(arg, env, asserted));
    }
    default:
      return childrenOf(expr).some((child) => mayBeUnknown(child, env, guarded));
  }
}

/**
 * `true`/`false` when the condition is decidable without reading any state.
 *
 * This is the sound, solver-free subset of `LGC-W030`. D §8.3's abstract-domain solver — which
 * also proves *unsatisfiability* (`LGC-W031`), dead options and unfillable quota cells — needs
 * the flow graph and belongs to the compiler's static-analysis suite (roadmap P1-08). What can
 * be decided here is the degenerate case that is nonetheless common in practice: a condition
 * left as `TRUE` after a debugging session.
 */
export function constantVerdict(expr: Expr): 'true' | 'false' | undefined {
  if (!isStateFree(expr)) return undefined;
  if (expr.op === 'lit' && expr.v.k === 'bool') return expr.v.v ? 'true' : 'false';
  return undefined;
}

function isStateFree(expr: Expr): boolean {
  let free = true;
  const stack: Expr[] = [expr];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === undefined) break;
    if (node.op === 'var' || node.op === 'probe' || node.op === 'item' || node.op === 'item_attr' || node.op === 'agg') {
      free = false;
      break;
    }
    for (const child of childrenOf(node)) stack.push(child);
  }
  return free;
}
