/**
 * D §8.3's abstract-domain solver, at the smallest size that pays for itself: the three checks
 * that need to decide "can this condition ever be true" rather than "is this condition a
 * literal" — `LGC-W031` (unsatisfiable condition), `LGC-W040` (option that can never be shown)
 * and `LGC-W014` (`case … else null` feeding a comparison).
 *
 * WHY THIS EXISTS AS A SEPARATE THING FROM `constantVerdict`. `check.ts` documents its own
 * `constantVerdict` as "the sound, solver-free subset" and hands the rest here by name: "D §8.3's
 * abstract-domain solver — which also proves *unsatisfiability* (`LGC-W031`), dead options and
 * unfillable quota cells — needs the flow graph and belongs to the compiler's static-analysis
 * suite (roadmap P1-08)." `constantVerdict` answers only for a tree that reads no state at all,
 * so `S1 == 1 AND S1 == 2` — the canonical unsatisfiable condition, and a real defect that
 * survives review because each half reads fine — is invisible to it.
 *
 * ## Soundness is the whole specification
 *
 * The gate may answer "don't know" as often as it likes. It may **never** claim a satisfiable
 * condition is unsatisfiable. A false `LGC-W031` on a correct survey is worse than a hundred
 * missed ones, because it puts an author in front of a warning they cannot make go away, and a
 * gate that cries wolf gets switched off — after which the checks that were right go with it.
 * Everything below is therefore written in one direction: when in doubt, widen to `⊤`.
 *
 * That direction is asserted rather than asserted-to: `solver.test.ts` brute-forces every
 * assignment over a small variable set through `@resscript/logic`'s real `evalCondition` and
 * requires that the abstract answer contains every concrete verdict. The converse is never
 * required — incompleteness is the design.
 *
 * ## The domain
 *
 * Per value, one of:
 *
 *  - `top` — any value, including null. The answer for everything not modelled.
 *  - `null` — definitely null (a `null` literal, a null-propagating operand).
 *  - `bool { t, f, u }` — the set of Kleene verdicts the expression can take. `u` is null: D
 *    §2.5 makes nullity a value-level property, so "may be UNKNOWN" is a flag on the truth set
 *    rather than a fourth kind.
 *  - `num { min, max, u }` — a closed interval. Closed, and therefore *widened* for a strict
 *    comparison: `> 5` becomes `[5, ∞)` in the value domain. The model is the reals, so nothing
 *    integral is assumed and `X > 5 AND X < 6` stays satisfiable; the one place strictness is
 *    tracked is the conjunction rule below, where it is what decides `AGE >= 18 AND AGE < 18`.
 *  - `enum { d, codes, u }` — a finite code set in one nominal domain.
 *  - `set { d, codes, u }` — one exact code set, or null. Deliberately *not* a must/may lattice:
 *    see below.
 *
 * `text`, `date` and `obj` values are `⊤`, and so is every `agg`, every arithmetic result, every
 * string operation, every date operation, `cast` and `label_of`. That is the incompleteness, it
 * is deliberate, and it is where the line falls: proving anything about a regex, a date window or
 * an aggregation needs a different solver, and a survey whose gate depends on one is a survey
 * this check was never aimed at.
 *
 * ## Where the precision actually comes from: a case split, not a lattice
 *
 * A bottom-up abstract evaluation cannot decide `S1 == 1 AND S1 == 2`: each conjunct is
 * independently `{T,F}` and the meet is `{T,F,U}`. The correlation between the two reads of `S1`
 * is the entire content of the claim. Two ways to recover it — assumption propagation
 * (refine the environment as you descend a conjunction) or a disjunctive completion (enumerate
 * the finite variables and evaluate once per combination) — and the second is chosen because it
 * is *exact* over the variables it enumerates and needs no reasoning about which refinements
 * are legal under `not` and `or`. Enumeration covers booleans, enums over a declared domain and
 * sets over a small declared domain, always including `null` as one of the cases; everything
 * else stays `⊤` for every combination.
 *
 * That choice is also why the set predicates (`contains`, `any_of`, `all_of`, `none_of`,
 * `set_eq`, `subset_of`) are evaluated **only when both operands are determinate** and are `⊤`
 * otherwise. A must/may set lattice would give a little more precision on un-enumerated set
 * variables at the cost of six more hand-derived possibility rules, each an independent chance
 * to be unsound in the one direction that is not allowed.
 *
 * One thing enumeration does not reach is a numeric contradiction — `AGE >= 18 AND AGE < 18`
 * has no finite domain to enumerate. So there is exactly one assumption-propagation rule, at
 * the `and` node: intersect the intervals implied by the conjuncts that are literal
 * comparisons on one variable, and drop `T` when the intersection is empty. Sound because `T`
 * for a conjunction requires `T` for every conjunct, and `v op literal` is `T` only inside that
 * interval.
 *
 * ## What this module refuses to do
 *
 * It does not re-report `LGC-W030`. `checkRule` already emits that for every condition
 * `constantVerdict` decides, and `compileLogic` runs `checkRule` on every rule, so a condition
 * that is a bare literal is called first and skipped here — otherwise a `TRUE` left after a
 * debugging session would arrive at the publish dialog twice under two codes.
 */

import {
  pointer,
  type ContentNode,
  type QuestionItem,
  type QuestionNode,
  type Survey,
} from '@resscript/schema';
import {
  constantVerdict,
  diagnostic,
  readsOf,
  walkExpr,
  exprsOf,
  type CmpOp,
  type DomainId,
  type Expr,
  type LiteralValue,
  type MaskAxis,
  type Rule,
  type TypeEnv,
  type VarDecl,
  type VariableId,
} from '@resscript/logic';

import { fromLogicDiagnostic, sortCompileDiagnostics, type CompileDiagnostic } from '../diagnostics.js';
import { synthesizedMaskRuleId } from '../rules.js';
import type { FlowGraph } from '../types.js';

/* ========================================================================== */
/* 1. The abstract domain                                                      */
/* ========================================================================== */

export type Abstract =
  | { readonly k: 'top' }
  | { readonly k: 'null' }
  | { readonly k: 'bool'; readonly t: boolean; readonly f: boolean; readonly u: boolean }
  | { readonly k: 'num'; readonly min: number; readonly max: number; readonly u: boolean }
  | {
      readonly k: 'enum';
      readonly d: DomainId;
      readonly codes: ReadonlySet<number>;
      readonly u: boolean;
    }
  | {
      readonly k: 'set';
      readonly d: DomainId;
      readonly codes: ReadonlySet<number>;
      readonly u: boolean;
    };

export const TOP: Abstract = { k: 'top' };
export const NULL_VALUE: Abstract = { k: 'null' };

/** Every verdict a boolean expression can take. The answer for anything not modelled. */
export const BOOL_ANY: Abstract = { k: 'bool', t: true, f: true, u: true };
/** A boolean that is definitely not null — what a `probe` produces (D §2.5). */
export const BOOL_DECIDED: Abstract = { k: 'bool', t: true, f: true, u: false };
export const TRUE_ONLY: Abstract = { k: 'bool', t: true, f: false, u: false };
export const FALSE_ONLY: Abstract = { k: 'bool', t: false, f: true, u: false };

/** The Kleene verdicts an expression can produce. `triOf`'s image, over-approximated. */
export interface TriSet {
  readonly t: boolean;
  readonly f: boolean;
  readonly u: boolean;
}

const TRI_ANY: TriSet = { t: true, f: true, u: true };

/**
 * The verdicts an abstract value can collapse to.
 *
 * `triOf` throws on a non-boolean, which the checker guarantees cannot reach a rule condition
 * (`LGC-T033`). A numeric or enum value arriving here therefore means the checker was bypassed,
 * and the honest answer for a bypassed checker is "anything" rather than a claim.
 */
export function verdictsOf(a: Abstract): TriSet {
  switch (a.k) {
    case 'bool':
      return { t: a.t, f: a.f, u: a.u };
    case 'null':
      return { t: false, f: false, u: true };
    default:
      return TRI_ANY;
  }
}

function mayBeNull(a: Abstract): boolean {
  switch (a.k) {
    case 'top':
    case 'null':
      return true;
    default:
      return a.u;
  }
}

/** The value with its null case removed, or `undefined` when nothing else remains. */
function nonNull(a: Abstract): Abstract | undefined {
  switch (a.k) {
    case 'null':
      return undefined;
    case 'top':
      return TOP;
    case 'bool':
      return a.t || a.f ? { k: 'bool', t: a.t, f: a.f, u: false } : undefined;
    case 'num':
      return a.min > a.max ? undefined : { k: 'num', min: a.min, max: a.max, u: false };
    case 'enum':
      return a.codes.size === 0 ? undefined : { k: 'enum', d: a.d, codes: a.codes, u: false };
    case 'set':
      return { k: 'set', d: a.d, codes: a.codes, u: false };
    default: {
      const never: never = a;
      throw new Error(`unhandled abstract value ${JSON.stringify(never)}`);
    }
  }
}

function withNull(a: Abstract, nullable: boolean): Abstract {
  if (!nullable) return a;
  switch (a.k) {
    case 'top':
    case 'null':
      return a;
    case 'bool':
      return { k: 'bool', t: a.t, f: a.f, u: true };
    case 'num':
      return { k: 'num', min: a.min, max: a.max, u: true };
    case 'enum':
      return { k: 'enum', d: a.d, codes: a.codes, u: true };
    case 'set':
      return { k: 'set', d: a.d, codes: a.codes, u: true };
    default: {
      const never: never = a;
      throw new Error(`unhandled abstract value ${JSON.stringify(never)}`);
    }
  }
}

/**
 * Least upper bound. Two values of different kinds join to `⊤` rather than to a union type:
 * the domain has no sum, and inventing one would put a second, unverified semantics behind
 * every `case` arm.
 */
export function joinAbstract(a: Abstract, b: Abstract): Abstract {
  if (a.k === 'top' || b.k === 'top') return TOP;
  if (a.k === 'null') return withNull(b, true);
  if (b.k === 'null') return withNull(a, true);
  if (a.k !== b.k) return TOP;
  switch (a.k) {
    case 'bool': {
      const other = b as Extract<Abstract, { k: 'bool' }>;
      return { k: 'bool', t: a.t || other.t, f: a.f || other.f, u: a.u || other.u };
    }
    case 'num': {
      const other = b as Extract<Abstract, { k: 'num' }>;
      return {
        k: 'num',
        min: Math.min(a.min, other.min),
        max: Math.max(a.max, other.max),
        u: a.u || other.u,
      };
    }
    case 'enum': {
      const other = b as Extract<Abstract, { k: 'enum' }>;
      if (a.d !== other.d) return TOP;
      return { k: 'enum', d: a.d, codes: union(a.codes, other.codes), u: a.u || other.u };
    }
    case 'set': {
      const other = b as Extract<Abstract, { k: 'set' }>;
      // Two *different* exact sets join to `⊤`, not to their union: the union is a third set,
      // and claiming the value is that set would be a claim no path makes.
      if (a.d !== other.d) return TOP;
      if (!sameCodes(a.codes, other.codes)) return TOP;
      return { k: 'set', d: a.d, codes: a.codes, u: a.u || other.u };
    }
    default: {
      const never: never = a;
      throw new Error(`unhandled abstract value ${JSON.stringify(never)}`);
    }
  }
}

function union(a: ReadonlySet<number>, b: ReadonlySet<number>): ReadonlySet<number> {
  const out = new Set(a);
  for (const code of b) out.add(code);
  return out;
}

function sameCodes(a: ReadonlySet<number>, b: ReadonlySet<number>): boolean {
  if (a.size !== b.size) return false;
  for (const code of a) if (!b.has(code)) return false;
  return true;
}

/* ========================================================================== */
/* 2. The environment                                                          */
/* ========================================================================== */

/** What `item` and `item_attr` evaluate to inside a per-item mask condition. */
export interface ItemFacts {
  readonly code?: number | undefined;
  readonly position?: number | undefined;
  readonly domain?: DomainId | undefined;
  readonly meta?: { readonly [key: string]: string | number | boolean | null } | undefined;
}

export interface AbstractEnv {
  readonly types: TypeEnv;
  readonly variable: (id: VariableId) => Abstract;
  readonly item?: ItemFacts | undefined;
}

/**
 * What a variable can hold, from its declaration alone.
 *
 * Every kind is nullable, including `response`: a variable whose question has not been answered
 * — or was never shown — is null, and that is the case D §2.5 exists for. Assuming otherwise
 * here is the single easiest way to make this module unsound, because it would let
 * `ANSWERED(Q) AND Q == 1` look decidable.
 */
export function declaredAbstract(decl: VarDecl, env: TypeEnv): Abstract {
  switch (decl.type) {
    case 'boolean':
      return BOOL_ANY;
    case 'number':
      return { k: 'num', min: -Infinity, max: Infinity, u: true };
    case 'enum': {
      const codes = domainCodes(decl.domain, env);
      if (codes === undefined || decl.domain === undefined) return TOP;
      return { k: 'enum', d: decl.domain, codes, u: true };
    }
    case 'set':
      // A `set` abstract is one *exact* set, so there is no useful declaration-level value
      // short of enumerating the power set — which `splitsFor` does when the domain is small.
      return TOP;
    case 'text':
    case 'date':
    case 'object':
      return TOP;
    default: {
      const never: never = decl.type;
      void never;
      return TOP;
    }
  }
}

function domainCodes(d: DomainId | undefined, env: TypeEnv): ReadonlySet<number> | undefined {
  if (d === undefined) return undefined;
  const domain = env.domain(d);
  if (domain === undefined || domain.entries.length === 0) return undefined;
  return new Set(domain.entries.map((entry) => entry.code));
}

/* ========================================================================== */
/* 3. Abstract evaluation                                                      */
/* ========================================================================== */

/**
 * Evaluate one expression in the abstract domain.
 *
 * Exported so `unreachable.ts` reuses exactly this interpretation — a second, slightly
 * different notion of "provably false" in the never-visible check is how two analyses come to
 * disagree about the same rule — and so the soundness test can call it directly.
 */
export function evalAbstract(expr: Expr, env: AbstractEnv): Abstract {
  switch (expr.op) {
    case 'lit':
      return literalAbstract(expr.v);

    case 'var':
      return env.variable(expr.var);

    case 'probe':
      // A probe is metadata about a cell, never the cell's value, so it is never null (D §2.5,
      // and `mayBeUnknown` returns `false` for it for the same reason).
      return BOOL_DECIDED;

    case 'item': {
      const item = env.item;
      if (item === undefined || item.code === undefined || item.domain === undefined) return TOP;
      return { k: 'enum', d: item.domain, codes: new Set([item.code]), u: false };
    }

    case 'item_attr': {
      const item = env.item;
      if (item === undefined) return TOP;
      if (expr.attr === 'code' && item.code !== undefined) {
        return { k: 'num', min: item.code, max: item.code, u: false };
      }
      if (expr.attr === 'position' && item.position !== undefined) {
        return { k: 'num', min: item.position, max: item.position, u: false };
      }
      if (expr.attr === 'selected') return BOOL_ANY;
      // `label` is text, and a meta value is free-form: neither is modelled.
      return TOP;
    }

    case '==':
    case '!=':
    case '<':
    case '<=':
    case '>':
    case '>=':
      return compareAbstract(expr.op, evalAbstract(expr.args[0], env), evalAbstract(expr.args[1], env));

    case 'contains':
    case 'any_of':
    case 'all_of':
    case 'none_of':
    case 'set_eq':
    case 'subset_of':
      return setPredicate(expr.op, evalAbstract(expr.args[0], env), evalAbstract(expr.args[1], env));

    case 'union':
    case 'intersect':
    case 'difference':
      return setCombine(expr.op, evalAbstract(expr.args[0], env), evalAbstract(expr.args[1], env));

    case 'and': {
      const verdicts = expr.args.map((arg) => verdictsOf(evalAbstract(arg, env)));
      const naive = foldTri(verdicts, and3set);
      // The one assumption-propagation rule. See the header.
      const refined =
        naive.t && conjunctionInfeasible(expr.args, env) ? { t: false, f: naive.f, u: naive.u } : naive;
      return triAbstract(refined);
    }

    case 'or':
      return triAbstract(foldTri(expr.args.map((arg) => verdictsOf(evalAbstract(arg, env))), or3set));

    case 'not': {
      const inner = verdictsOf(evalAbstract(expr.args[0], env));
      return triAbstract({ t: inner.f, f: inner.t, u: inner.u });
    }

    case 'case': {
      // The evaluator treats a `U` when-arm as *not matched* and continues (D §2.5's one
      // documented deviation from strict propagation), so a possibly-unknown arm contributes
      // both its own `then` and the fallthrough.
      let out: Abstract | undefined;
      for (const arm of expr.cases) {
        const when = verdictsOf(evalAbstract(arm.when, env));
        if (when.t) {
          const then = evalAbstract(arm.then, env);
          out = out === undefined ? then : joinAbstract(out, then);
        }
        if (!when.f && !when.u) return out ?? TOP; // definitely matched: nothing below runs
      }
      const otherwise = evalAbstract(expr.else, env);
      return out === undefined ? otherwise : joinAbstract(out, otherwise);
    }

    case 'coalesce': {
      let out: Abstract | undefined;
      for (const arg of expr.args) {
        const value = evalAbstract(arg, env);
        const decided = nonNull(value);
        if (decided !== undefined) out = out === undefined ? decided : joinAbstract(out, decided);
        if (!mayBeNull(value)) return out ?? TOP;
      }
      // Every argument may be null, so the whole coalesce may be.
      return out === undefined ? NULL_VALUE : withNull(out, true);
    }

    // Everything below is deliberately `⊤`. See the header on where the line falls.
    case 'agg':
    case 'concat':
    case 'len':
    case 'lower':
    case 'upper':
    case 'trim':
    case 'starts_with':
    case 'ends_with':
    case 'str_contains':
    case 'matches':
    case 'substr':
    case 'split_count':
    case 'word_count':
    case 'date_diff':
    case 'date_add':
    case 'date_part':
    case 'date_trunc':
    case 'cast':
    case 'label_of':
    case '+':
    case '-':
    case '*':
    case '/':
    case 'mod':
    case 'pow':
    case 'neg':
    case 'abs':
    case 'floor':
    case 'ceil':
    case 'round':
    case 'min':
    case 'max':
    case 'clamp':
      return TOP;

    default: {
      const never: never = expr;
      // A node kind this module does not know is `⊤`, not a crash: `checkExpr` reports the
      // unknown kind (`LGC-T002`) and a solver that threw would take the whole publish with it.
      void never;
      return TOP;
    }
  }
}

function literalAbstract(value: LiteralValue): Abstract {
  switch (value.k) {
    case 'null':
      return NULL_VALUE;
    case 'bool':
      return value.v ? TRUE_ONLY : FALSE_ONLY;
    case 'num':
      return { k: 'num', min: value.v, max: value.v, u: false };
    case 'enum':
      return { k: 'enum', d: value.d, codes: new Set([value.v]), u: false };
    case 'set':
      return { k: 'set', d: value.d, codes: new Set(value.v), u: false };
    case 'text':
    case 'date':
      return TOP;
    default: {
      const never: never = value;
      void never;
      return TOP;
    }
  }
}

function triAbstract(tri: TriSet): Abstract {
  return { k: 'bool', t: tri.t, f: tri.f, u: tri.u };
}

function foldTri(values: readonly TriSet[], step: (a: TriSet, b: TriSet) => TriSet): TriSet {
  let acc: TriSet | undefined;
  for (const value of values) acc = acc === undefined ? value : step(acc, value);
  // An `and`/`or` with no arguments cannot arise from the AST builder; `⊤` is the safe answer.
  return acc ?? TRI_ANY;
}

/** The Kleene tables of `kleene.ts`, lifted to sets of verdicts. */
function and3set(a: TriSet, b: TriSet): TriSet {
  return {
    t: a.t && b.t,
    f: (a.f && (b.t || b.f || b.u)) || (b.f && (a.t || a.f || a.u)),
    u: (a.u && (b.t || b.u)) || (b.u && (a.t || a.u)),
  };
}

function or3set(a: TriSet, b: TriSet): TriSet {
  return {
    t: (a.t && (b.t || b.f || b.u)) || (b.t && (a.t || a.f || a.u)),
    f: a.f && b.f,
    u: (a.u && (b.f || b.u)) || (b.u && (a.f || a.u)),
  };
}

/* ---- comparisons --------------------------------------------------------- */

/**
 * The six comparisons. Any null operand makes the result `U` (`null != 5` must not be true,
 * D §2.5), so nullity is split off first and the remainder decided per kind.
 */
function compareAbstract(op: CmpOp, left: Abstract, right: Abstract): Abstract {
  const nullable = mayBeNull(left) || mayBeNull(right);
  const a = nonNull(left);
  const b = nonNull(right);
  if (a === undefined || b === undefined) return { k: 'bool', t: false, f: false, u: true };
  const decided = comparePossible(op, a, b);
  if (decided === undefined) return { k: 'bool', t: true, f: true, u: nullable };
  return { k: 'bool', t: decided.t, f: decided.f, u: nullable };
}

interface Possible {
  readonly t: boolean;
  readonly f: boolean;
}

function comparePossible(op: CmpOp, a: Abstract, b: Abstract): Possible | undefined {
  if (a.k === 'num' && b.k === 'num') return numericPossible(op, a.min, a.max, b.min, b.max);
  if (a.k === 'enum' && b.k === 'enum') {
    // Nominal domains: a cross-domain comparison is `LGC-T007` and the evaluator throws on it,
    // so there is no verdict to over-approximate and `⊤` is the only honest answer.
    if (a.d !== b.d) return undefined;
    return enumeratedPossible(op, [...a.codes], [...b.codes]);
  }
  if (a.k === 'bool' && b.k === 'bool') {
    if (op !== '==' && op !== '!=') return undefined; // ordering booleans is LGC-T003
    return enumeratedPossible(op, boolValues(a), boolValues(b));
  }
  if (a.k === 'set' && b.k === 'set') {
    if (op !== '==' && op !== '!=') return undefined;
    if (a.d !== b.d) return undefined;
    const same = sameCodes(a.codes, b.codes);
    const equal = op === '==' ? same : !same;
    return { t: equal, f: !equal };
  }
  return undefined;
}

function boolValues(a: Extract<Abstract, { k: 'bool' }>): readonly number[] {
  const out: number[] = [];
  if (a.t) out.push(1);
  if (a.f) out.push(0);
  return out;
}

/** Exact over two finite value sets: try every pair. Both sets are option-list sized. */
function enumeratedPossible(
  op: CmpOp,
  left: readonly number[],
  right: readonly number[],
): Possible {
  let t = false;
  let f = false;
  for (const x of left) {
    for (const y of right) {
      if (compareCodes(op, x, y)) t = true;
      else f = true;
      if (t && f) return { t, f };
    }
  }
  return { t, f };
}

function compareCodes(op: CmpOp, x: number, y: number): boolean {
  switch (op) {
    case '==':
      return x === y;
    case '!=':
      return x !== y;
    case '<':
      return x < y;
    case '<=':
      return x <= y;
    case '>':
      return x > y;
    case '>=':
      return x >= y;
    default: {
      const never: never = op;
      throw new Error(`unhandled comparison ${JSON.stringify(never)}`);
    }
  }
}

/**
 * Interval comparison. Each answer is "is there a pair of members for which this holds", which
 * for closed intervals reduces to a single endpoint test per direction.
 */
function numericPossible(
  op: CmpOp,
  amin: number,
  amax: number,
  bmin: number,
  bmax: number,
): Possible {
  const singletons = amin === amax && bmin === bmax;
  switch (op) {
    case '==':
      return { t: amin <= bmax && bmin <= amax, f: !(singletons && amin === bmin) };
    case '!=':
      return { t: !(singletons && amin === bmin), f: amin <= bmax && bmin <= amax };
    case '<':
      return { t: amin < bmax, f: amax >= bmin };
    case '<=':
      return { t: amin <= bmax, f: amax > bmin };
    case '>':
      return { t: amax > bmin, f: amin <= bmax };
    case '>=':
      return { t: amax >= bmin, f: amin < bmax };
    default: {
      const never: never = op;
      throw new Error(`unhandled comparison ${JSON.stringify(never)}`);
    }
  }
}

/* ---- set operations ------------------------------------------------------ */

interface Determinate {
  readonly codes: readonly number[];
  readonly d: DomainId;
}

/**
 * The exact code list a value denotes, when it denotes exactly one.
 *
 * A single enum on the left of `any_of`/`none_of` is the one-element set (D §2.3, and
 * `asCodes` in the evaluator does the same), which is why a singleton enum qualifies.
 */
function determinate(a: Abstract): Determinate | undefined {
  if (a.k === 'set' && !a.u) return { codes: [...a.codes], d: a.d };
  if (a.k === 'enum' && !a.u && a.codes.size === 1) {
    const only = [...a.codes][0];
    if (only === undefined) return undefined;
    return { codes: [only], d: a.d };
  }
  return undefined;
}

function setPredicate(
  op: 'contains' | 'any_of' | 'all_of' | 'none_of' | 'set_eq' | 'subset_of',
  left: Abstract,
  right: Abstract,
): Abstract {
  const nullable = mayBeNull(left) || mayBeNull(right);
  const a = nonNull(left);
  const b = nonNull(right);
  if (a === undefined || b === undefined) return { k: 'bool', t: false, f: false, u: true };
  const x = determinate(a);
  const y = determinate(b);
  if (x === undefined || y === undefined || x.d !== y.d) {
    return { k: 'bool', t: true, f: true, u: nullable };
  }
  const held = setPredicateHolds(op, x.codes, y.codes);
  return { k: 'bool', t: held, f: !held, u: nullable };
}

function setPredicateHolds(
  op: 'contains' | 'any_of' | 'all_of' | 'none_of' | 'set_eq' | 'subset_of',
  a: readonly number[],
  b: readonly number[],
): boolean {
  switch (op) {
    case 'contains':
      // `contains(set, element)`: the element is the second operand.
      return b.every((code) => a.includes(code));
    case 'any_of':
      return a.some((code) => b.includes(code));
    case 'none_of':
      return !a.some((code) => b.includes(code));
    case 'all_of':
      return b.every((code) => a.includes(code));
    case 'subset_of':
      return a.every((code) => b.includes(code));
    case 'set_eq':
      return a.length === b.length && a.every((code) => b.includes(code));
    default: {
      const never: never = op;
      throw new Error(`unhandled set predicate ${JSON.stringify(never)}`);
    }
  }
}

/**
 * `union` / `intersect` / `difference`, exact when both operands are and `⊤` otherwise.
 *
 * Nullity is split off first and re-attached last, never by recursing on the stripped operands:
 * `nonNull(⊤)` is `⊤`, which may still be null, so a recursive call would not terminate on an
 * un-enumerated set variable. That was a real defect, and the soundness suite now carries a
 * `set` variable whose domain is too wide to enumerate for exactly this reason.
 */
function setCombine(
  op: 'union' | 'intersect' | 'difference',
  left: Abstract,
  right: Abstract,
): Abstract {
  const nullable = mayBeNull(left) || mayBeNull(right);
  const a = nonNull(left);
  const b = nonNull(right);
  if (a === undefined || b === undefined) return NULL_VALUE;
  const x = determinate(a);
  const y = determinate(b);
  if (x === undefined || y === undefined || x.d !== y.d) return TOP;
  const codes =
    op === 'union'
      ? [...x.codes, ...y.codes]
      : op === 'intersect'
        ? x.codes.filter((code) => y.codes.includes(code))
        : x.codes.filter((code) => !y.codes.includes(code));
  return withNull({ k: 'set', d: x.d, codes: new Set(codes), u: false }, nullable);
}

/* ---- the numeric conjunction rule ---------------------------------------- */

/**
 * A range, with the strictness of each end.
 *
 * Strictness is tracked here and nowhere else in the domain, because here is the only place it
 * changes an answer: `AGE >= 18 AND AGE < 18` is `[18, ∞) ∩ (−∞, 18)`, which is empty, while the
 * closed relaxation would be `[18, 18]` and prove nothing. It is also what keeps `X > 5 AND
 * X < 6` satisfiable — the model is the reals, so `(5, 6)` is not empty and no integrality is
 * assumed anywhere.
 */
interface Bound {
  readonly min: number;
  readonly max: number;
  readonly minOpen: boolean;
  readonly maxOpen: boolean;
}

const UNBOUNDED: Bound = { min: -Infinity, max: Infinity, minOpen: false, maxOpen: false };

function isEmpty(bound: Bound): boolean {
  if (bound.min > bound.max) return true;
  return bound.min === bound.max && (bound.minOpen || bound.maxOpen);
}

function intersect(a: Bound, b: Bound): Bound {
  const min = Math.max(a.min, b.min);
  const max = Math.min(a.max, b.max);
  return {
    min,
    max,
    minOpen:
      (a.min === min && a.minOpen) || (b.min === min && b.minOpen),
    maxOpen:
      (a.max === max && a.maxOpen) || (b.max === max && b.maxOpen),
  };
}

/**
 * `true` when the conjunction cannot be `T` because its literal comparisons constrain one
 * variable to an empty range.
 *
 * Sound because `T` for an `and` requires `T` for every conjunct, and `v op literal` is `T` only
 * for a non-null `v` inside the interval `constraintOf` derives. Nested `and`s are flattened (the
 * tables are associative, D §10.1); nothing under `or` or `not` contributes, because a conjunct
 * that is a disjunction can be `T` without any particular side being `T`.
 */
function conjunctionInfeasible(args: readonly Expr[], env: AbstractEnv): boolean {
  const bounds = new Map<string, Bound>();
  const stack: Expr[] = [...args];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === undefined) break;
    if (node.op === 'and') {
      for (const arg of node.args) stack.push(arg);
      continue;
    }
    const constraint = comparisonConstraint(node, env);
    if (constraint === undefined) continue;
    const current = bounds.get(constraint.id) ?? declaredBound(constraint.id, env);
    bounds.set(constraint.id, intersect(current, constraint.bound));
  }
  for (const bound of bounds.values()) {
    if (isEmpty(bound)) return true;
  }
  return false;
}

function declaredBound(id: string, env: AbstractEnv): Bound {
  const value = env.variable(id as VariableId);
  if (value.k === 'num') return { ...UNBOUNDED, min: value.min, max: value.max };
  if (value.k === 'enum' && value.codes.size > 0) {
    const codes = [...value.codes];
    return { ...UNBOUNDED, min: Math.min(...codes), max: Math.max(...codes) };
  }
  return UNBOUNDED;
}

interface VarConstraint {
  readonly id: string;
  readonly bound: Bound;
}

function comparisonConstraint(node: Expr, env: AbstractEnv): VarConstraint | undefined {
  if (
    node.op !== '==' &&
    node.op !== '!=' &&
    node.op !== '<' &&
    node.op !== '<=' &&
    node.op !== '>' &&
    node.op !== '>='
  ) {
    return undefined;
  }
  const left = node.args[0];
  const right = node.args[1];
  const varOnLeft = left.op === 'var';
  const reference = varOnLeft ? left : right;
  const other = varOnLeft ? right : left;
  if (reference.op !== 'var' || other.op !== 'lit') return undefined;
  const literal = numericLiteral(other.v, env.variable(reference.var));
  if (literal === undefined) return undefined;
  const op = varOnLeft ? node.op : mirror(node.op);
  const bound = (partial: Partial<Bound>): VarConstraint => ({
    id: reference.var,
    bound: { ...UNBOUNDED, ...partial },
  });
  switch (op) {
    case '==':
      return bound({ min: literal, max: literal });
    case '<':
      return bound({ max: literal, maxOpen: true });
    case '<=':
      return bound({ max: literal });
    case '>':
      return bound({ min: literal, minOpen: true });
    case '>=':
      return bound({ min: literal });
    case '!=':
      // `!=` excludes one point from an interval, which this domain cannot express.
      return undefined;
    default: {
      const never: never = op;
      throw new Error(`unhandled comparison ${JSON.stringify(never)}`);
    }
  }
}

/**
 * The literal's numeric position, if it has one comparable to the variable.
 *
 * An enum literal counts only when the variable's own abstract value is an enum in the *same*
 * domain: codes are nominal (D §2.2), so comparing `dom_a` code 1 against `dom_b` code 1 is a
 * type error rather than an equality, and folding it here would prove an unsatisfiability the
 * evaluator would have thrown on instead.
 */
function numericLiteral(value: LiteralValue, variable: Abstract): number | undefined {
  if (value.k === 'num') return variable.k === 'num' ? value.v : undefined;
  if (value.k === 'enum') {
    return variable.k === 'enum' && variable.d === value.d ? value.v : undefined;
  }
  return undefined;
}

function mirror(op: CmpOp): CmpOp {
  switch (op) {
    case '<':
      return '>';
    case '<=':
      return '>=';
    case '>':
      return '<';
    case '>=':
      return '<=';
    default:
      return op;
  }
}

/* ========================================================================== */
/* 4. The case split                                                           */
/* ========================================================================== */

/**
 * Combination budget.
 *
 * 4096 is chosen against the shape of a real condition rather than against a time limit: a
 * condition over four five-point scales is 6^4 = 1296 combinations of a dozen-node tree, which
 * is microseconds, and a condition over eight is not a condition an author wrote by hand. The
 * budget is spent greedily in `readsOf` order and variables that would overrun it are simply
 * left at `⊤` — which loses precision and cannot lose soundness.
 */
export const DEFAULT_SPLIT_BUDGET = 4096;

/** Domains wider than this are not enumerated: a 60-brand list would eat the whole budget. */
const MAX_ENUM_CODES = 24;
/** A set variable enumerates its power set, so the cap is much lower. `2^6 + 1 = 65`. */
const MAX_SET_CODES = 6;

interface Split {
  readonly id: VariableId;
  readonly values: readonly Abstract[];
}

export interface SolveOptions {
  readonly item?: ItemFacts | undefined;
  readonly budget?: number | undefined;
}

function splitsFor(expr: Expr, env: TypeEnv, budget: number): readonly Split[] {
  const out: Split[] = [];
  let product = 1;
  for (const id of readsOf(expr)) {
    const decl = env.byId(id);
    if (decl === undefined) continue;
    const values = enumerateValues(decl, env);
    if (values === undefined) continue;
    if (product * values.length > budget) continue;
    product *= values.length;
    out.push({ id, values });
  }
  return out;
}

/**
 * Every value a variable can take, or `undefined` when the set is not small and finite.
 *
 * `null` is always one of them. A variable that is unanswered on some path is the normal case,
 * not the exception, and an enumeration that omitted it would prove unsatisfiability for
 * conditions that are merely unknown.
 */
function enumerateValues(decl: VarDecl, env: TypeEnv): readonly Abstract[] | undefined {
  switch (decl.type) {
    case 'boolean':
      return [TRUE_ONLY, FALSE_ONLY, NULL_VALUE];
    case 'enum': {
      const codes = domainCodes(decl.domain, env);
      const d = decl.domain;
      if (codes === undefined || d === undefined || codes.size > MAX_ENUM_CODES) return undefined;
      const out: Abstract[] = [...codes]
        .sort((a, b) => a - b)
        .map((code) => ({ k: 'enum', d, codes: new Set([code]), u: false }));
      out.push(NULL_VALUE);
      return out;
    }
    case 'set': {
      const codes = domainCodes(decl.domain, env);
      const d = decl.domain;
      if (codes === undefined || d === undefined || codes.size > MAX_SET_CODES) return undefined;
      const ordered = [...codes].sort((a, b) => a - b);
      const out: Abstract[] = [];
      for (let mask = 0; mask < 1 << ordered.length; mask += 1) {
        const subset = new Set<number>();
        ordered.forEach((code, i) => {
          if ((mask & (1 << i)) !== 0) subset.add(code);
        });
        out.push({ k: 'set', d, codes: subset, u: false });
      }
      out.push(NULL_VALUE);
      return out;
    }
    case 'number':
    case 'text':
    case 'date':
    case 'object':
      return undefined;
    default: {
      const never: never = decl.type;
      void never;
      return undefined;
    }
  }
}

/**
 * Evaluate over every combination of the enumerated variables, stopping as soon as `stop` says
 * the answer is settled.
 *
 * Iterative odometer rather than recursion, per this package's house rule, and because the
 * combination count is the one number here that a pathological survey can make large.
 */
function foldSplits(
  expr: Expr,
  env: TypeEnv,
  options: SolveOptions,
  visit: (verdicts: TriSet) => boolean,
): void {
  const splits = splitsFor(expr, env, options.budget ?? DEFAULT_SPLIT_BUDGET);
  const cursor = new Array<number>(splits.length).fill(0);
  const bound = new Map<VariableId, Abstract>();

  for (;;) {
    bound.clear();
    splits.forEach((split, i) => {
      const value = split.values[cursor[i] ?? 0];
      if (value !== undefined) bound.set(split.id, value);
    });
    const abstractEnv: AbstractEnv = {
      types: env,
      variable: (id) => {
        const assigned = bound.get(id);
        if (assigned !== undefined) return assigned;
        const decl = env.byId(id);
        return decl === undefined ? TOP : declaredAbstract(decl, env);
      },
      ...(options.item === undefined ? {} : { item: options.item }),
    };
    if (!visit(verdictsOf(evalAbstract(expr, abstractEnv)))) return;

    let axis = splits.length - 1;
    while (axis >= 0) {
      const split = splits[axis];
      const next = (cursor[axis] ?? 0) + 1;
      if (split !== undefined && next < split.values.length) {
        cursor[axis] = next;
        break;
      }
      cursor[axis] = 0;
      axis -= 1;
    }
    if (axis < 0) return;
  }
}

/* ========================================================================== */
/* 5. The two questions callers ask                                            */
/* ========================================================================== */

/**
 * `true` when no assignment makes this condition `T` — so the rule can never fire.
 *
 * "Never fires" and "always false" are different claims and this is the first one, deliberately:
 * every rule kind but `validate` collapses `U` to "do not fire" (D §2.5), so a condition that is
 * sometimes `F` and sometimes `U` and never `T` is a rule with no effect, which is what both
 * `LGC-W031` and `LGC-U002` are about.
 */
export function provablyNeverTrue(expr: Expr, env: TypeEnv, options: SolveOptions = {}): boolean {
  let possible = false;
  foldSplits(expr, env, options, (verdicts) => {
    if (verdicts.t) possible = true;
    return !possible;
  });
  return !possible;
}

/** `true` when every assignment makes this condition `T` — so the rule always fires. */
export function provablyAlwaysTrue(expr: Expr, env: TypeEnv, options: SolveOptions = {}): boolean {
  let always = true;
  foldSplits(expr, env, options, (verdicts) => {
    if (verdicts.f || verdicts.u || !verdicts.t) always = false;
    return always;
  });
  return always;
}

/* ========================================================================== */
/* 6. Content pointers                                                         */
/* ========================================================================== */

export interface QuestionSite {
  readonly question: QuestionNode;
  /** RFC 6901 pointer at the question node itself. */
  readonly path: string;
  /** The same location as segments, so an item or a mask pointer can extend it. */
  readonly segments: readonly (string | number)[];
}

/**
 * Every question, in document order, with a pointer to where it lives.
 *
 * It lives in this module rather than in a shared one because `LGC-W040` is the only diagnostic
 * in this suite that has to point *inside* a question (at one option of one axis), and the
 * never-visible check would otherwise re-walk `content` to get the same pointers — two walks
 * that can disagree about where a question is. Iterative, per this package's house rule: content
 * blocks nest, and a stack overflow in field is worse than one in CI.
 */
export function questionSites(survey: Survey): readonly QuestionSite[] {
  const out: QuestionSite[] = [];
  const stack: { readonly node: ContentNode; readonly segments: readonly (string | number)[] }[] = [];
  const pushAll = (nodes: readonly ContentNode[], base: readonly (string | number)[]): void => {
    for (let i = nodes.length - 1; i >= 0; i -= 1) {
      const node = nodes[i];
      if (node !== undefined) stack.push({ node, segments: [...base, i] });
    }
  };
  pushAll(survey.content, ['content']);

  while (stack.length > 0) {
    const frame = stack.pop();
    if (frame === undefined) break;
    const node = frame.node;
    if (node.type === 'block' || node.type === 'page') {
      pushAll(node.children, [...frame.segments, 'children']);
      continue;
    }
    if (node.type !== 'question') continue;
    out.push({ question: node, path: pointer(...frame.segments), segments: frame.segments });
  }
  return out;
}

/**
 * Rule id → the pointer at its authoring row.
 *
 * Authored rules are `logic_rules` array positions, matching what `validateStructural` and
 * `rules.ts` report against the same rows. A rule synthesized from a `QuestionNode.masks[]`
 * entry has no row, so it points at the mask — which is where the author would go to change it.
 */
export function rulePointers(survey: Survey): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  survey.logic_rules.forEach((rule, index) => {
    out.set(rule.id, pointer('logic_rules', index));
  });
  for (const site of questionSites(survey)) {
    (site.question.masks ?? []).forEach((mask, index) => {
      out.set(synthesizedMaskRuleId(mask.id), pointer(...site.segments, 'masks', index));
    });
  }
  return out;
}

/* ========================================================================== */
/* 7. The analysis                                                             */
/* ========================================================================== */

export interface ConditionsInput {
  readonly survey: Survey;
  readonly graph: FlowGraph;
  /** `buildRules`' output, so the synthesized `QuestionNode.masks` rules are present. */
  readonly rules: readonly Rule[];
  readonly env: TypeEnv;
}

export function analyzeConditions(input: ConditionsInput): readonly CompileDiagnostic[] {
  const paths = rulePointers(input.survey);
  const diagnostics: CompileDiagnostic[] = [
    ...unsatisfiableConditions(input, paths),
    ...deadOptions(input, paths),
    ...nullElseComparisons(input, paths),
  ];
  return sortCompileDiagnostics(diagnostics);
}

/**
 * A rule scoped to a flow node the respondent cannot reach is already `LGC-U001`, and it is an
 * error, so publish is blocked either way. Adding a warning about its condition would make the
 * author acknowledge a warning about a rule they are about to delete.
 */
function isLive(rule: Rule, graph: FlowGraph): boolean {
  const site = rule.flow_node_id;
  return site === undefined || graph.reachable.has(site);
}

/* ---- LGC-W031 ------------------------------------------------------------ */

function unsatisfiableConditions(
  input: ConditionsInput,
  paths: ReadonlyMap<string, string>,
): readonly CompileDiagnostic[] {
  const out: CompileDiagnostic[] = [];
  for (const rule of input.rules) {
    if (!isLive(rule, input.graph)) continue;
    // Called first and skipped, so a bare `TRUE`/`FALSE` is reported once, as `LGC-W030`.
    if (constantVerdict(rule.condition) !== undefined) continue;
    if (!provablyNeverTrue(rule.condition, input.env)) continue;
    const path = paths.get(rule.id) ?? '';
    out.push(
      fromLogicDiagnostic(
        diagnostic(
          'LGC-W031',
          `Rule ${rule.id}'s condition can never be true: no combination of the values its ` +
            'variables can hold satisfies it, so the rule can never fire and its effect is ' +
            'unreachable.',
          `${path}/condition`,
          {
            rule_id: rule.id,
            kind: rule.kind,
            target_type: rule.target.type,
            ...(rule.flow_node_id === undefined ? {} : { flow_node_id: rule.flow_node_id }),
          },
        ),
      ),
    );
  }
  return out;
}

/* ---- LGC-W040 ------------------------------------------------------------ */

interface DeadOption {
  readonly optionId: string;
  readonly path: string;
  readonly detail: { readonly [key: string]: string | number | boolean | null };
}

/**
 * `LGC-W040`, from the two surfaces that can make an item unreachable.
 *
 * **A mask that always applies and provably drops this item.** "Always applies" is a real
 * condition: a mask whose own condition is sometimes false does not exclude anything on the
 * paths where it does not fire, so only a mask that is provably always-firing can support the
 * claim. Question-authored masks (`rules.ts` synthesizes them with the literal `TRUE`, because a
 * `Mask` carries no condition) are exactly that case, which is the one that matters.
 *
 * **An `option_state` rule that always writes `visible = false`.** `opt.visible` combines with
 * `combineAbsorbingFalse`, so one false write is absorbing and no later `visible = true` can
 * undo it.
 *
 * The `show_all` fallback is honoured: a mask that empties its whole axis falls back rather than
 * rendering nothing (schema §15), so an item excluded by such a mask is still shown and must not
 * be reported. That check is per axis, which is why the whole axis is evaluated before anything
 * is emitted.
 */
function deadOptions(
  input: ConditionsInput,
  paths: ReadonlyMap<string, string>,
): readonly CompileDiagnostic[] {
  const found = new Map<string, DeadOption>();
  const sites = questionSites(input.survey);
  const byId = new Map<string, QuestionSite>();
  for (const site of sites) byId.set(site.question.id, site);

  for (const rule of input.rules) {
    if (!isLive(rule, input.graph)) continue;
    const effect = rule.effect;

    if (effect.action === 'option_state' && effect.prop === 'visible') {
      if (constantVerdict(effect.value) !== 'false') continue;
      if (!provablyAlwaysTrue(rule.condition, input.env)) continue;
      const located = locateItem(sites, effect.option_id);
      if (located === undefined) continue;
      record(found, {
        optionId: effect.option_id,
        path: located.path,
        detail: {
          rule_id: rule.id,
          question_id: located.site.question.id,
          question_ref: located.site.question.ref,
          option_id: effect.option_id,
          code: located.item.code,
          axis: located.axis,
          reason: 'option_state_always_hides',
        },
      });
      continue;
    }

    if (effect.action !== 'mask' || rule.target.type !== 'question') continue;
    if (!provablyAlwaysTrue(rule.condition, input.env)) continue;
    const site = byId.get(rule.target.id);
    if (site === undefined) continue;
    const items = axisItems(site.question, effect.applies_to);
    if (items.length === 0) continue;
    const domain = input.env.question(rule.target.id)?.domain;

    const excluded: { readonly item: QuestionItem; readonly index: number }[] = [];
    items.forEach((item, index) => {
      const facts: ItemFacts = {
        code: item.code,
        position: index,
        ...(domain === undefined ? {} : { domain }),
      };
      const drops =
        effect.mode === 'include'
          ? provablyNeverTrue(effect.per_item, input.env, { item: facts })
          : provablyAlwaysTrue(effect.per_item, input.env, { item: facts });
      if (drops) excluded.push({ item, index });
    });
    if (excluded.length === 0) continue;
    // The whole axis gone means the mask empties the question, and `show_all` then shows
    // everything: no item is unreachable, and reporting each one would be exactly backwards.
    if (excluded.length === items.length && effect.fallback.when_empty === 'show_all') continue;

    for (const entry of excluded) {
      record(found, {
        optionId: entry.item.id,
        path: pointer(...site.segments, effect.applies_to, entry.index),
        detail: {
          rule_id: rule.id,
          question_id: site.question.id,
          question_ref: site.question.ref,
          option_id: entry.item.id,
          code: entry.item.code,
          axis: effect.applies_to,
          mode: effect.mode,
          mask_rule_path: paths.get(rule.id) ?? '',
          reason: effect.mode === 'include' ? 'mask_never_includes' : 'mask_always_excludes',
        },
      });
    }
  }

  return [...found.values()].map((dead) =>
    fromLogicDiagnostic(
      diagnostic(
        'LGC-W040',
        `Option ${dead.optionId} can never be shown: every path that could make it visible is ` +
          'provably false, so a respondent never sees it and its code never appears in the data.',
        dead.path,
        dead.detail,
      ),
    ),
  );
}

/** One diagnostic per option. Two reasons for one dead option is still one defect. */
function record(found: Map<string, DeadOption>, dead: DeadOption): void {
  if (!found.has(dead.optionId)) found.set(dead.optionId, dead);
}

function axisItems(question: QuestionNode, axis: MaskAxis): readonly QuestionItem[] {
  switch (axis) {
    case 'options':
      return question.options ?? [];
    case 'rows':
      return question.rows ?? [];
    case 'columns':
      return question.columns ?? [];
    default: {
      const never: never = axis;
      throw new Error(`unhandled mask axis ${JSON.stringify(never)}`);
    }
  }
}

interface LocatedItem {
  readonly site: QuestionSite;
  readonly item: QuestionItem;
  readonly axis: MaskAxis;
  readonly path: string;
}

function locateItem(sites: readonly QuestionSite[], optionId: string): LocatedItem | undefined {
  const axes: readonly MaskAxis[] = ['options', 'rows', 'columns'];
  for (const site of sites) {
    for (const axis of axes) {
      const items = axisItems(site.question, axis);
      const index = items.findIndex((item) => item.id === optionId);
      const item = index < 0 ? undefined : items[index];
      if (item === undefined) continue;
      return { site, item, axis, path: pointer(...site.segments, axis, index) };
    }
  }
  return undefined;
}

/* ---- LGC-W014 ------------------------------------------------------------ */

/**
 * `LGC-W014`: a `case` whose `else` arm is a null literal, in an operand position of a
 * comparison.
 *
 * Purely syntactic, and deliberately so — this is not a solver question. The defect is that the
 * author wrote a total-looking classification and then compared it: for any respondent who
 * reaches the `else`, the comparison is `U`, the rule collapses to "do not fire" (D §2.5), and
 * nothing in the trace says why. The fix is either a real `else` value or an `ANSWERED` guard,
 * and both are things the author has to choose, which is why this is a warning and not a
 * rewrite.
 *
 * Only the *direct* operands of a comparison are examined. A `case` buried under arithmetic or a
 * string operation propagates its null just as far, but the syntactic pattern stops being
 * recognizable and the warning starts firing on trees where the author has already handled it.
 */
function nullElseComparisons(
  input: ConditionsInput,
  paths: ReadonlyMap<string, string>,
): readonly CompileDiagnostic[] {
  const out: CompileDiagnostic[] = [];
  for (const rule of input.rules) {
    if (!isLive(rule, input.graph)) continue;
    const base = paths.get(rule.id) ?? '';
    exprsOf(rule).forEach((expr, index) => {
      const seen = new Set<number>();
      walkExpr(expr, (node) => {
        if (!isComparison(node)) return;
        for (const operand of node.args) {
          if (operand.op !== 'case') continue;
          if (!isNullLiteral(operand.else)) continue;
          if (seen.has(operand.n)) continue;
          seen.add(operand.n);
          out.push(
            fromLogicDiagnostic(
              diagnostic(
                'LGC-W014',
                `Rule ${rule.id} compares a CASE whose ELSE is null, so for every respondent ` +
                  'who reaches the ELSE the comparison is UNKNOWN and the rule silently does ' +
                  'not fire. Give the ELSE a value, or guard the comparison.',
                `${base}${index === 0 ? '/condition' : '/effect'}`,
                {
                  rule_id: rule.id,
                  comparison: node.op,
                  node: operand.n,
                  in_condition: index === 0,
                },
              ),
            ),
          );
        }
      });
    });
  }
  return out;
}

function isComparison(node: Expr): node is Extract<Expr, { readonly op: CmpOp }> {
  return (
    node.op === '==' ||
    node.op === '!=' ||
    node.op === '<' ||
    node.op === '<=' ||
    node.op === '>' ||
    node.op === '>='
  );
}

function isNullLiteral(node: Expr): boolean {
  return node.op === 'lit' && node.v.k === 'null';
}
