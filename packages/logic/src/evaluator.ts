/**
 * The expression evaluator — D §2.5, §5.4, §10.2.
 *
 * One rule governs everything here: **`U` is a value, not an error, and it never collapses.**
 * The collapse happens exactly once, at the rule boundary (`rules.ts`, `collapseUnknown`), and
 * every propagation rule in D §2.5's table is implemented literally below so that reading this
 * file is reading the table. The reason this matters is worth restating at the top of the file
 * that could break it: coerce null to `false` at read time and `AGE < 18` is true for everyone
 * who never saw the age question, so a "terminate under-18" rule terminates the entire
 * non-asked population.
 *
 * Short-circuiting is legal and worth doing, with one subtlety (D §10.2): `and` may stop at the
 * first `false` because `false` is absorbing, but it may **not** stop at the first `U` — it has
 * to keep looking for a `false`. Same for `or` and `true`. `andAll`/`orAll` in kleene.ts encode
 * exactly that.
 */

import type { Agg, Expr, GroupItem, LiteralValue } from './ast.js';
import type { AggFn } from './ast-kinds.js';
import type { CivilTime } from './date.js';
import { dateAdd, dateDiff, dateTrunc, dayOfWeek, formatIso, parseIso } from './date.js';
import type { DomainId, PageId, QuestionId, VariableId } from './ids.js';
import { LogicInvariant, at } from './ids.js';
import { andAll, not3, orAll, triOf, triToValue, type Tri } from './kleene.js';
import type { MaskAxis, OptProp } from './rules.js';
import type { EvalContext, EvalState, VarState } from './state.js';
import {
  EMPTY_CODES,
  FALSE,
  NULL,
  TRUE,
  bool,
  compareValues,
  enumValue,
  formatValue,
  num,
  setValue,
  text,
  valueEq,
  type Value,
} from './value.js';

/* ========================================================================== */
/* What the evaluator can see                                                 */
/* ========================================================================== */

/**
 * Derived state the evaluator reads but does not compute: the cells that other rules write.
 *
 * `undefined` means "not computed in this evaluation", which is different from `false`. A
 * `shown` probe on a question whose `visible` cell has not been evaluated falls back to the
 * declared default rather than reading `false`, because "we have not looked yet" and "logic
 * hid it" are different claims and the second one drives a skip counter.
 */
export interface CellReader {
  readonly value: (id: VariableId) => Value | undefined;
  readonly visible: (nodeId: string) => boolean | undefined;
  readonly items: (questionId: QuestionId, axis: MaskAxis) => readonly number[] | undefined;
  readonly option: (optionId: string, prop: OptProp) => boolean | undefined;
  /** AND of every validation rule scoped to this node; `undefined` when there are none. */
  readonly valid: (targetId: string) => boolean | undefined;
}

export const NO_CELLS: CellReader = {
  value: () => undefined,
  visible: () => undefined,
  items: () => undefined,
  option: () => undefined,
  valid: () => undefined,
};

/**
 * Static facts the evaluator needs that are neither state nor context: the registry's shape,
 * projected down to the five questions a `probe` or a `label_of` can ask. Built once by the
 * compiler and shipped with the artifact, so the hot path holds no registry lookups (D §10.1).
 */
export interface EvalSchema {
  /** `label_key` for a code in a domain, so `label_of` can reach `ctx.labels`. */
  readonly labelKey: (domain: DomainId, code: number) => string | undefined;
  /**
   * Every code a domain declares, ascending — `recode`'s membership test.
   *
   * An EMPTY result means "this schema cannot see the domain", and `recode` answers null rather
   * than an empty set for it. A domain with no codes cannot occur in a valid survey, so the two
   * are safely conflated, and they are conflated in the safe direction.
   */
  readonly domainCodes: (domain: DomainId) => readonly number[];
  /** Every variable a question emits — how a question-scoped probe becomes value reads. */
  readonly questionVariables: (id: QuestionId) => readonly VariableId[];
  /** The questions on a page, for a page-scoped probe. */
  readonly pageQuestions: (id: PageId) => readonly QuestionId[];
  /** The question that owns a variable, so `SHOWN(Q5r2)` means `SHOWN(Q5)`. */
  readonly ownerQuestion: (id: VariableId) => QuestionId | undefined;
  /** The page a question or block sits on, so `ASKED(Q5)` can ask whether it was submitted. */
  readonly pageOf: (nodeId: string) => PageId | undefined;
  /** Whether a node is visible when no rule says otherwise. */
  readonly declaredVisible: (nodeId: string) => boolean;
}

export const EMPTY_SCHEMA: EvalSchema = {
  labelKey: () => undefined,
  domainCodes: () => [],
  questionVariables: () => [],
  pageQuestions: () => [],
  ownerQuestion: () => undefined,
  pageOf: () => undefined,
  declaredVisible: () => true,
};

/**
 * The bound `item` inside an `agg` or a per-item mask condition.
 *
 * `value` and `selected` are two different things and conflating them is a real bug, not a
 * refinement. D §2.3 says a `kind:'options'` group "iterate[s] options, not vars", so inside one
 * `item` is the *option* — its code in the question's domain — while `item.selected` is still the
 * respondent's answer for that option (the fan-out boolean, schema §1). Making `item` the variable
 * value instead would make `COUNT(options of Q5 WHERE item.meta.x)` count zero, because the
 * projection would be an unanswered variable rather than the option itself.
 */
export interface ItemBindingValue {
  readonly item: GroupItem;
  /** What `item` evaluates to: the option's code for an `options` group, else the member's value. */
  readonly value: Value;
  /** What `item.selected` evaluates to: the member's boolean answer, or null if it has none. */
  readonly selected: Value;
  /** Display order for the enclosing axis, from the seeded randomizer (ADR-006). */
  readonly order?: readonly number[];
}

export interface ExprEnv {
  readonly vars: VarState;
  readonly ctx: EvalContext;
  readonly cells: CellReader;
  readonly schema: EvalSchema;
  /** Memo table, epoch-stamped (D §5.4). Omit to evaluate without memoization. */
  readonly memo?: EvalState;
  readonly item?: ItemBindingValue;
}

/* ========================================================================== */
/* Entry points                                                               */
/* ========================================================================== */

export function evalExpr(e: Expr, env: ExprEnv): Value {
  // Memoization is skipped inside an item binding: within an `agg`, the same node id evaluates
  // to a different value per item, so a memo keyed on the node id alone would return the first
  // item's answer for every subsequent one. This is the single most dangerous interaction in
  // D §5.4 and it is silent — the count is simply wrong.
  const memo = env.item === undefined ? env.memo : undefined;
  if (memo !== undefined && e.n < memo.memoStamp.length && memo.memoStamp[e.n] === memo.epoch) {
    const hit = memo.memoSlot[e.n];
    if (hit !== undefined) return hit;
  }
  const value = compute(e, env);
  if (memo !== undefined && e.n < memo.memoStamp.length) {
    memo.memoStamp[e.n] = memo.epoch;
    memo.memoSlot[e.n] = value;
  }
  return value;
}

/** The three-valued verdict of a boolean expression. The only caller is the rule boundary. */
export function evalCondition(e: Expr, env: ExprEnv): Tri {
  return triOf(evalExpr(e, env));
}

/**
 * Evaluate an expression that reads no state (`check.ts`'s `constantVerdict` guarantees it).
 * Exported so the checker can fold a constant condition without importing an environment.
 */
export function evalStateFree(e: Expr): Value {
  return evalExpr(e, {
    vars: { value: () => NULL },
    ctx: {},
    cells: NO_CELLS,
    schema: EMPTY_SCHEMA,
  });
}

/* ========================================================================== */
/* The node switch                                                            */
/* ========================================================================== */

function compute(e: Expr, env: ExprEnv): Value {
  switch (e.op) {
    case 'lit':
      return literalValue(e.v);

    case 'var':
      // A written cell shadows the stored answer: a `derived` variable and a `set_variable`
      // target both live in a cell, and reading the raw state there would read last epoch's
      // value — the R2-reads-SEGMENT-before-R1-wrote-it bug from D §4.3.
      return env.cells.value(e.var) ?? env.vars.value(e.var);

    case 'probe':
      return bool(evalProbe(e.kind, e.target, env));

    case 'item': {
      if (env.item === undefined) throw new LogicInvariant('`item` evaluated with no item bound');
      return env.item.value;
    }

    case 'item_attr':
      return evalItemAttr(e.attr, e.meta_key, env);

    case '==':
    case '!=': {
      const a = evalExpr(e.args[0], env);
      const b = evalExpr(e.args[1], env);
      if (a.k === 'null' || b.k === 'null') return NULL; // D §2.5: `null != 5` must not be true
      const same = strictEq(a, b);
      return bool(e.op === '==' ? same : !same);
    }

    case '<':
    case '<=':
    case '>':
    case '>=': {
      const a = evalExpr(e.args[0], env);
      const b = evalExpr(e.args[1], env);
      if (a.k === 'null' || b.k === 'null') return NULL;
      const cmp = compareValues(a, b);
      if (cmp === undefined) {
        throw new LogicInvariant(`cannot order ${formatValue(a)} against ${formatValue(b)}`);
      }
      switch (e.op) {
        case '<':
          return bool(cmp < 0);
        case '<=':
          return bool(cmp <= 0);
        case '>':
          return bool(cmp > 0);
        default:
          return bool(cmp >= 0);
      }
    }

    case 'contains': {
      const set = evalExpr(e.args[0], env);
      const element = evalExpr(e.args[1], env);
      if (set.k === 'null' || element.k === 'null') return NULL;
      const codes = asCodes(set);
      if (element.k !== 'enum') throw new LogicInvariant(`CONTAINS element is ${element.k}`);
      assertDomain(set, element);
      return bool(codes.includes(element.v));
    }

    case 'any_of': {
      const left = evalExpr(e.args[0], env);
      const right = evalExpr(e.args[1], env);
      if (left.k === 'null' || right.k === 'null') return NULL;
      const a = asCodes(left);
      const b = asCodes(right);
      assertDomain(left, right);
      // An answered multi-select with nothing checked is a real answer: `any_of` is FALSE, not
      // unknown, and it must be distinguishable from never-asked (D §2.5).
      return bool(a.some((code) => b.includes(code)));
    }

    case 'none_of': {
      const left = evalExpr(e.args[0], env);
      const right = evalExpr(e.args[1], env);
      // The asymmetry with `any_of` is the trap D §2.5 calls out by name: a null left operand
      // is `U`, **not** `T`. Making it true means "never saw the question" satisfies "selected
      // none of these", which is how an unasked respondent lands in a brand-rejector segment.
      if (left.k === 'null' || right.k === 'null') return NULL;
      const a = asCodes(left);
      const b = asCodes(right);
      assertDomain(left, right);
      return bool(!a.some((code) => b.includes(code)));
    }

    case 'all_of': {
      const left = evalExpr(e.args[0], env);
      const right = evalExpr(e.args[1], env);
      if (left.k === 'null' || right.k === 'null') return NULL;
      assertDomain(left, right);
      const a = asCodes(left);
      return bool(asCodes(right).every((code) => a.includes(code)));
    }

    case 'subset_of': {
      const left = evalExpr(e.args[0], env);
      const right = evalExpr(e.args[1], env);
      if (left.k === 'null' || right.k === 'null') return NULL;
      assertDomain(left, right);
      const b = asCodes(right);
      return bool(asCodes(left).every((code) => b.includes(code)));
    }

    case 'set_eq': {
      const left = evalExpr(e.args[0], env);
      const right = evalExpr(e.args[1], env);
      if (left.k === 'null' || right.k === 'null') return NULL;
      assertDomain(left, right);
      return bool(codesEq(asCodes(left), asCodes(right)));
    }

    case 'union':
    case 'intersect':
    case 'difference': {
      const left = evalExpr(e.args[0], env);
      const right = evalExpr(e.args[1], env);
      if (left.k === 'null' || right.k === 'null') return NULL;
      assertDomain(left, right);
      const a = asCodes(left);
      const b = asCodes(right);
      const domain = domainOf(left) ?? domainOf(right);
      if (domain === undefined) throw new LogicInvariant('set operation on domainless values');
      const codes =
        e.op === 'union'
          ? [...a, ...b]
          : e.op === 'intersect'
            ? a.filter((code) => b.includes(code))
            : a.filter((code) => !b.includes(code));
      return setValue(codes, domain);
    }

    case 'and':
      return triToValue(andAll(e.args.map((arg) => triOf(evalExpr(arg, env)))));

    case 'or':
      return triToValue(orAll(e.args.map((arg) => triOf(evalExpr(arg, env)))));

    case 'not':
      return triToValue(not3(triOf(evalExpr(e.args[0], env))));

    case '+':
    case '-':
    case '*':
    case '/':
    case 'mod':
    case 'pow': {
      const a = numOrNull(evalExpr(e.args[0], env));
      const b = numOrNull(evalExpr(e.args[1], env));
      if (a === undefined || b === undefined) return NULL; // D §2.5: any null operand → null
      return finiteOrNull(binaryArith(e.op, a, b));
    }

    case 'neg':
    case 'abs':
    case 'floor':
    case 'ceil': {
      const a = numOrNull(evalExpr(e.args[0], env));
      if (a === undefined) return NULL;
      return finiteOrNull(
        e.op === 'neg' ? -a : e.op === 'abs' ? Math.abs(a) : e.op === 'floor' ? Math.floor(a) : Math.ceil(a),
      );
    }

    case 'round': {
      const a = numOrNull(evalExpr(e.args[0], env));
      const digits = numOrNull(evalExpr(e.args[1], env));
      if (a === undefined || digits === undefined) return NULL;
      const factor = Math.pow(10, Math.trunc(digits));
      return finiteOrNull(Math.round(a * factor) / factor);
    }

    case 'min':
    case 'max':
    case 'clamp': {
      const args = e.args.map((arg) => numOrNull(evalExpr(arg, env)));
      if (args.some((a) => a === undefined)) return NULL;
      const nums = args.filter((a): a is number => a !== undefined);
      if (e.op === 'clamp') {
        const [value, lo, hi] = nums;
        if (value === undefined || lo === undefined || hi === undefined) {
          throw new LogicInvariant('CLAMP requires exactly three operands');
        }
        return finiteOrNull(Math.min(Math.max(value, lo), hi));
      }
      if (nums.length === 0) return NULL;
      return finiteOrNull(e.op === 'min' ? Math.min(...nums) : Math.max(...nums));
    }

    case 'agg':
      return evalAgg(e, env);

    case 'concat': {
      const parts: string[] = [];
      for (const arg of e.args) {
        const v = evalExpr(arg, env);
        if (v.k === 'null') return NULL;
        parts.push(asText(v));
      }
      return text(parts.join(''));
    }

    case 'len': {
      const v = evalExpr(e.args[0], env);
      // `len(null)` is `null`, not `0` (D §2.5). Zero would make an unasked open-end look like
      // an answered-but-empty one, which is a quality flag an analyst acts on.
      return v.k === 'null' ? NULL : num(asText(v).length);
    }

    case 'lower':
    case 'upper':
    case 'trim': {
      const v = evalExpr(e.args[0], env);
      if (v.k === 'null') return NULL;
      const s = asText(v);
      return text(e.op === 'lower' ? s.toLowerCase() : e.op === 'upper' ? s.toUpperCase() : s.trim());
    }

    case 'word_count': {
      const v = evalExpr(e.args[0], env);
      if (v.k === 'null') return NULL;
      const trimmed = asText(v).trim();
      return num(trimmed === '' ? 0 : trimmed.split(/\s+/u).length);
    }

    case 'starts_with':
    case 'ends_with':
    case 'str_contains': {
      const a = evalExpr(e.args[0], env);
      const b = evalExpr(e.args[1], env);
      if (a.k === 'null' || b.k === 'null') return NULL;
      const haystack = asText(a);
      const needle = asText(b);
      return bool(
        e.op === 'starts_with'
          ? haystack.startsWith(needle)
          : e.op === 'ends_with'
            ? haystack.endsWith(needle)
            : haystack.includes(needle),
      );
    }

    case 'matches': {
      const v = evalExpr(e.args[0], env);
      if (v.k === 'null') return NULL;
      return bool(compiledRegex(e.pattern, e.flags).test(asText(v)));
    }

    case 'substr': {
      const args: readonly Expr[] = e.args;
      const source = args[0];
      const from = args[1];
      if (source === undefined || from === undefined) throw new LogicInvariant('SUBSTR needs two operands');
      const v = evalExpr(source, env);
      const start = numOrNull(evalExpr(from, env));
      if (v.k === 'null' || start === undefined) return NULL;
      const lengthExpr = args[2];
      const length = lengthExpr === undefined ? undefined : numOrNull(evalExpr(lengthExpr, env));
      if (lengthExpr !== undefined && length === undefined) return NULL;
      const s = asText(v);
      const begin = Math.max(0, Math.trunc(start));
      return text(length === undefined ? s.slice(begin) : s.slice(begin, begin + Math.max(0, Math.trunc(length))));
    }

    case 'split_count': {
      const a = evalExpr(e.args[0], env);
      const b = evalExpr(e.args[1], env);
      if (a.k === 'null' || b.k === 'null') return NULL;
      const separator = asText(b);
      if (separator === '') throw new LogicInvariant('SPLIT_COUNT separator is empty');
      return num(asText(a).split(separator).length);
    }

    case 'date_diff': {
      const from = dateOrNull(evalExpr(e.args[0], env));
      const to = dateOrNull(evalExpr(e.args[1], env));
      if (from === undefined || to === undefined) return NULL;
      // Argument order is (from, to), so the result is positive when the second is later —
      // the same direction as SQL's `DATEDIFF(unit, start, end)` and as the reading of
      // `DATE_DIFF('year', DOB, SERVER_TIME)` an author expects for an age.
      return num(dateDiff(e.unit, from, to));
    }

    case 'date_add': {
      const base = dateOrNull(evalExpr(e.args[0], env));
      const amount = numOrNull(evalExpr(e.args[1], env));
      if (base === undefined || amount === undefined) return NULL;
      return { k: 'date', v: formatIso(dateAdd(e.unit, base, amount)) };
    }

    case 'date_part': {
      const t = dateOrNull(evalExpr(e.args[0], env));
      if (t === undefined) return NULL;
      switch (e.part) {
        case 'year':
          return num(t.year);
        case 'month':
          return num(t.month);
        case 'day':
          return num(t.day);
        case 'dow':
          return num(dayOfWeek(t));
        case 'hour':
          return num(t.hour);
        default: {
          const never: never = e.part;
          throw new LogicInvariant(`unhandled date part ${JSON.stringify(never)}`);
        }
      }
    }

    case 'date_trunc': {
      const t = dateOrNull(evalExpr(e.args[0], env));
      if (t === undefined) return NULL;
      return { k: 'date', v: formatIso(dateTrunc(e.unit, t)) };
    }

    case 'case': {
      // The one documented deviation from strict Kleene propagation (D §2.5): a `when` that
      // evaluates to `U` is treated as *not matched* and evaluation continues to the next arm.
      // Strict propagation would let one unknown input null out an otherwise total
      // classification even when a later arm would have matched on a different variable — and
      // `else` is mandatory, so the author has already declared the catch-all.
      for (const arm of e.cases) {
        if (triOf(evalExpr(arm.when, env)) === 'T') return evalExpr(arm.then, env);
      }
      return evalExpr(e.else, env);
    }

    case 'coalesce': {
      for (const arg of e.args) {
        const v = evalExpr(arg, env);
        if (v.k !== 'null') return v;
      }
      return NULL;
    }

    case 'cast':
      return evalCast(e.to, e.on_fail, evalExpr(e.args[0], env));

    case 'recode':
      return evalRecode(e.to, evalExpr(e.args[0], env), env);

    case 'label_of': {
      const v = evalExpr(e.args[0], env);
      if (v.k === 'null') return NULL; // piping renders the configured empty-token
      return labelOf(v, env);
    }

    default: {
      // The `never` guard: a new AST kind is a compile error here, not a silent fallthrough
      // that would return `undefined` and be read as a null answer in field.
      const never: never = e;
      throw new LogicInvariant(`unhandled AST node ${JSON.stringify(never)}`);
    }
  }
}

/* ========================================================================== */
/* Leaves                                                                     */
/* ========================================================================== */

export function literalValue(v: LiteralValue): Value {
  switch (v.k) {
    case 'null':
      return NULL;
    case 'bool':
      return v.v ? TRUE : FALSE;
    case 'num':
      return num(v.v);
    case 'text':
      return text(v.v);
    case 'date':
      return { k: 'date', v: v.v };
    case 'enum':
      return enumValue(v.v, v.d);
    case 'set':
      return setValue(v.v, v.d);
    default: {
      const never: never = v;
      throw new LogicInvariant(`unhandled literal ${JSON.stringify(never)}`);
    }
  }
}

/**
 * Probes — D §2.3, §2.5. **Never null. Always T or F.** That is the point of them: they are how
 * an author interrogates nullity without triggering propagation, and the preferred alternative
 * to an `ON UNKNOWN` override.
 *
 *  - `answered` — the respondent supplied a value. An invalidated value (E §7.2, orphaned by a
 *    back-navigation) is not answered even if a stale value is still in the state.
 *  - `shown`    — the question survived display rules, masks and flow: its `visible` cell.
 *  - `valid`    — every validation scoped to it passed.
 *  - `asked`    — shown **and** the page was submitted, which is what separates a respondent
 *    who declined to answer from one who abandoned on the page.
 */
function evalProbe(
  kind: 'answered' | 'shown' | 'valid' | 'asked',
  target: { readonly kind: 'variable' | 'question' | 'page'; readonly id: string },
  env: ExprEnv,
): boolean {
  switch (kind) {
    case 'answered':
      return isAnswered(target, env);
    case 'shown':
      return isShown(target, env);
    case 'valid':
      return env.cells.valid(target.id) ?? true;
    case 'asked':
      return isShown(target, env) && isSubmitted(target, env);
    default: {
      const never: never = kind;
      throw new LogicInvariant(`unhandled probe kind ${JSON.stringify(never)}`);
    }
  }
}

function isAnswered(
  target: { readonly kind: 'variable' | 'question' | 'page'; readonly id: string },
  env: ExprEnv,
): boolean {
  switch (target.kind) {
    case 'variable': {
      const id = target.id as VariableId;
      if (env.vars.provenance?.(id)?.p === 'invalidated') return false;
      return (env.cells.value(id) ?? env.vars.value(id)).k !== 'null';
    }
    case 'question': {
      // Any emitted variable carrying a value counts. An answered multi-select with zero
      // selections has a non-null set view, so it is answered — which is the distinction
      // D §2.5 insists on between "checked nothing" and "never asked".
      const vars = env.schema.questionVariables(target.id as QuestionId);
      return vars.some((id) => isAnswered({ kind: 'variable', id }, env));
    }
    case 'page': {
      // A page is answered when every question on it that was actually shown is answered.
      const questions = env.schema.pageQuestions(target.id as PageId);
      const shown = questions.filter((id) => isShown({ kind: 'question', id }, env));
      return shown.length > 0 && shown.every((id) => isAnswered({ kind: 'question', id }, env));
    }
    default: {
      const never: never = target.kind;
      throw new LogicInvariant(`unhandled probe target ${JSON.stringify(never)}`);
    }
  }
}

function isShown(
  target: { readonly kind: 'variable' | 'question' | 'page'; readonly id: string },
  env: ExprEnv,
): boolean {
  // A variable is not shown or hidden — its *question* is. `SHOWN(Q5r2)` therefore asks about
  // Q5, which is what an author writing a rule against one matrix row means.
  const node =
    target.kind === 'variable' ? (env.schema.ownerQuestion(target.id as VariableId) ?? target.id) : target.id;
  return env.cells.visible(node) ?? env.schema.declaredVisible(node);
}

function isSubmitted(
  target: { readonly kind: 'variable' | 'question' | 'page'; readonly id: string },
  env: ExprEnv,
): boolean {
  const submitted = env.ctx.pageSubmitted;
  // No submission record means no page has been submitted yet, so nothing has been *asked*.
  // Defaulting the other way would make `ASKED(Q5)` true on the page Q5 is being answered on,
  // which is the one place the distinction from `SHOWN` matters.
  if (submitted === undefined) return false;
  if (target.kind === 'page') return submitted(target.id as PageId);
  const question =
    target.kind === 'variable' ? env.schema.ownerQuestion(target.id as VariableId) : (target.id as QuestionId);
  const page = question === undefined ? undefined : env.schema.pageOf(question);
  return page === undefined ? false : submitted(page);
}

function evalItemAttr(
  attr: 'code' | 'label' | 'position' | 'selected',
  metaKey: string | undefined,
  env: ExprEnv,
): Value {
  const binding = env.item;
  if (binding === undefined) throw new LogicInvariant('`item_attr` evaluated with no item bound');
  if (metaKey !== undefined) {
    const raw = binding.item.meta?.[metaKey];
    if (raw === undefined || raw === null) return NULL;
    return typeof raw === 'number' ? num(raw) : typeof raw === 'boolean' ? bool(raw) : text(raw);
  }
  switch (attr) {
    case 'code':
      return binding.item.code === undefined ? NULL : num(binding.item.code);
    case 'label': {
      const key = binding.item.label_key;
      if (key === undefined) return NULL;
      const label = env.ctx.labels?.[key];
      return label === undefined ? NULL : text(label);
    }
    case 'position': {
      // The *display* position, from the randomizer's precomputed order (ADR-006). Falling back
      // to the canonical position when no order was supplied keeps an unrandomized question
      // working without the caller having to synthesise an identity permutation.
      const code = binding.item.code;
      if (binding.order !== undefined && code !== undefined) {
        const index = binding.order.indexOf(code);
        if (index >= 0) return num(index);
      }
      return binding.item.position === undefined ? NULL : num(binding.item.position);
    }
    case 'selected': {
      // Selectedness is the member's own boolean value: a multi-select emits one boolean per
      // option (schema §1), so `item.selected` and `Q2r1 == TRUE` are the same machinery.
      const v = binding.selected;
      if (v.k === 'null') return NULL;
      if (v.k === 'bool') return v;
      throw new LogicInvariant(`item.selected on a ${v.k} member`);
    }
    default: {
      const never: never = attr;
      throw new LogicInvariant(`unhandled item attribute ${JSON.stringify(never)}`);
    }
  }
}

/* ========================================================================== */
/* Aggregation                                                                */
/* ========================================================================== */

/**
 * Bounded iteration — the only iteration in the language (D §2.4). The group resolved to a
 * concrete item list at compile time, so the cost of an `agg` is statically known, which is what
 * makes D §10's <5 ms budget a provable property rather than an aspiration.
 */
function evalAgg(e: Agg, env: ExprEnv): Value {
  const items = e.resolved;
  if (items === undefined) {
    throw new LogicInvariant(
      `agg node ${String(e.n)} was not group-resolved at compile time; the evaluator does not ` +
        'hold a registry (D §10.1 moves group resolution off the hot path)',
    );
  }
  const nulls = e.nulls ?? 'skip';
  const order = orderFor(e, env);

  const iteratesOptions = e.over.kind === 'options';
  const projected: Value[] = [];
  for (const item of items) {
    const binding: ItemBindingValue = {
      ...bindItem(item, env, iteratesOptions),
      ...(order === undefined ? {} : { order }),
    };
    const inner: ExprEnv = { ...env, item: binding };
    if (e.where !== undefined) {
      // An item whose predicate is `U` is *excluded*: the same conservative direction as a
      // mask under `mode:'include'` (D §2.5). Counting an item we cannot prove belongs would
      // inflate a screener count on exactly the respondents with missing data.
      if (triOf(evalExpr(e.where, inner)) !== 'T') continue;
    }
    projected.push(e.select === undefined ? binding.value : evalExpr(e.select, inner));
  }

  return aggregate(e.fn, projected, nulls);
}

function orderFor(e: Agg, env: ExprEnv): readonly number[] | undefined {
  const orders = env.ctx.orders;
  if (orders === undefined) return undefined;
  const group = e.over;
  switch (group.kind) {
    case 'options':
    case 'question_emits':
      return orders[`${group.question_id}.options`];
    case 'matrix_rows':
      return orders[`${group.question_id}.rows`];
    case 'matrix_cols':
      return orders[`${group.question_id}.columns`];
    default:
      return undefined;
  }
}

/**
 * Bind one group member. `iteratesOptions` selects which of the two readings of "the item's
 * value" applies — see `ItemBindingValue`.
 */
export function bindItem(
  item: GroupItem,
  env: ExprEnv,
  iteratesOptions: boolean,
): { readonly item: GroupItem; readonly value: Value; readonly selected: Value } {
  const answer =
    item.variable_id === undefined
      ? NULL
      : (env.cells.value(item.variable_id) ?? env.vars.value(item.variable_id));
  const asOption =
    item.code !== undefined && item.domain !== undefined ? enumValue(item.code, item.domain) : NULL;
  return { item, value: iteratesOptions ? asOption : answer, selected: answer };
}

export function aggregate(fn: AggFn, members: readonly Value[], nulls: 'skip' | 'propagate' | 'as_zero'): Value {
  if (nulls === 'propagate' && members.some((m) => m.k === 'null')) return NULL;
  const values =
    nulls === 'skip'
      ? members.filter((m) => m.k !== 'null')
      : members.map((m) => (m.k === 'null' ? zeroFor(fn) : m));

  switch (fn) {
    case 'count':
      return num(values.length);
    case 'distinct_count': {
      const distinct: Value[] = [];
      for (const v of values) if (!distinct.some((d) => valueEq(d, v))) distinct.push(v);
      return num(distinct.length);
    }
    case 'sum': {
      // `sum` of an all-null group is `null`, not `0` (D §2.5) — SQL semantics, because
      // analysts already know them, and because a fabricated 0 is indistinguishable from a
      // real one in an export.
      if (values.length === 0) return NULL;
      let total = 0;
      for (const v of values) total += requireNum(v, 'SUM');
      return num(total);
    }
    case 'mean': {
      if (values.length === 0) return NULL;
      let total = 0;
      for (const v of values) total += requireNum(v, 'MEAN');
      return num(total / values.length);
    }
    case 'stdev': {
      // Sample standard deviation (n-1). A single observation has no sample deviation, so the
      // answer is null rather than 0 — a 0 would read as "no variance", which is a
      // straightliner signal an analyst acts on.
      if (values.length < 2) return NULL;
      const nums = values.map((v) => requireNum(v, 'STDEV'));
      const mean = nums.reduce((a, b) => a + b, 0) / nums.length;
      const variance = nums.reduce((acc, x) => acc + (x - mean) * (x - mean), 0) / (nums.length - 1);
      return num(Math.sqrt(variance));
    }
    case 'min':
    case 'max': {
      if (values.length === 0) return NULL;
      let best = at(values, 0);
      for (const v of values.slice(1)) {
        const cmp = compareValues(v, best);
        if (cmp === undefined) throw new LogicInvariant(`${fn.toUpperCase()} over unordered members`);
        if (fn === 'min' ? cmp < 0 : cmp > 0) best = v;
      }
      return best;
    }
    case 'any':
      return triToValue(orAll(values.map((v) => triOf(v))));
    case 'all':
      return triToValue(andAll(values.map((v) => triOf(v))));
    case 'first_answered':
      return values.length === 0 ? NULL : at(values, 0);
    case 'last_answered':
      return values.length === 0 ? NULL : at(values, values.length - 1);
    default: {
      const never: never = fn;
      throw new LogicInvariant(`unhandled aggregation ${JSON.stringify(never)}`);
    }
  }
}

/** `nulls: 'as_zero'` contributes `0` to numeric folds and `false` to boolean ones (D §2.5). */
function zeroFor(fn: AggFn): Value {
  return fn === 'any' || fn === 'all' ? FALSE : num(0);
}

function requireNum(v: Value, fn: string): number {
  if (v.k === 'num') return v.v;
  if (v.k === 'enum') return v.v;
  if (v.k === 'bool') return v.v ? 1 : 0;
  throw new LogicInvariant(`${fn} over a ${v.k} member`);
}

/* ========================================================================== */
/* Scalar helpers                                                             */
/* ========================================================================== */

function binaryArith(op: '+' | '-' | '*' | '/' | 'mod' | 'pow', a: number, b: number): number {
  switch (op) {
    case '+':
      return a + b;
    case '-':
      return a - b;
    case '*':
      return a * b;
    case '/':
      return a / b;
    case 'mod':
      return a % b;
    case 'pow':
      return Math.pow(a, b);
    default: {
      const never: never = op;
      throw new LogicInvariant(`unhandled arithmetic ${JSON.stringify(never)}`);
    }
  }
}

/**
 * A non-finite arithmetic result becomes `null`, not an invariant failure.
 *
 * D §2.2 forbids NaN and Infinity from appearing in a `VarState`, and division by zero is
 * respondent-reachable (`SPEND / TRIPS` with `TRIPS = 0`). Throwing there would take a live
 * survey down over ordinary missing data; `null` is what the datum actually is — undefined —
 * and it propagates visibly through every downstream condition.
 */
function finiteOrNull(value: number): Value {
  return Number.isFinite(value) ? num(value) : NULL;
}

function numOrNull(v: Value): number | undefined {
  switch (v.k) {
    case 'null':
      return undefined;
    case 'num':
      return v.v;
    case 'enum':
      // Reachable only through a `cast` to num or an aggregation over enum members; the checker
      // rejects bare arithmetic on an enum (LGC-T005).
      return v.v;
    default:
      throw new LogicInvariant(`arithmetic on a ${v.k} value`);
  }
}

function dateOrNull(v: Value): CivilTime | undefined {
  if (v.k === 'null') return undefined;
  if (v.k !== 'date') throw new LogicInvariant(`date operation on a ${v.k} value`);
  const parsed = parseIso(v.v);
  if (parsed === undefined) {
    // A malformed date reached a VarState. It is not respondent-reachable through a date
    // question (the plugin validates), so it means a hand-edited artifact or a bad import.
    throw new LogicInvariant(`not an ISO-8601 UTC instant: ${JSON.stringify(v.v)}`);
  }
  return parsed;
}

function asText(v: Value): string {
  switch (v.k) {
    case 'text':
    case 'date':
      return v.v;
    case 'num':
      return String(v.v);
    case 'bool':
      return v.v ? 'true' : 'false';
    default:
      throw new LogicInvariant(`string operation on a ${v.k} value`);
  }
}

function asCodes(v: Value): readonly number[] {
  switch (v.k) {
    case 'set':
      return v.v;
    case 'enum':
      // A single enum on the left of `any_of`/`none_of` is the one-element set (D §2.3).
      return [v.v];
    case 'null':
      return EMPTY_CODES;
    default:
      throw new LogicInvariant(`set operation on a ${v.k} value`);
  }
}

function domainOf(v: Value): DomainId | undefined {
  return v.k === 'set' || v.k === 'enum' ? v.d : undefined;
}

/**
 * Enums carry their domain at runtime for exactly this check (D §2.2): `Q3 == Q4` between two
 * questions that both happen to use codes 1..5 is caught **even when the checker was bypassed**
 * — a hand-edited artifact, or one written by an older schema version. It is an invariant
 * failure rather than `false`, because `false` is the answer that ships the bug: a copy-pasted
 * rule from Q3 would silently "work" on Q4.
 */
function assertDomain(a: Value, b: Value): void {
  const left = domainOf(a);
  const right = domainOf(b);
  if (left !== undefined && right !== undefined && left !== right) {
    throw new LogicInvariant(`enum domain mismatch: ${left} vs ${right}`);
  }
}

function codesEq(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

function strictEq(a: Value, b: Value): boolean {
  if (a.k === 'enum' || a.k === 'set' || b.k === 'enum' || b.k === 'set') assertDomain(a, b);
  if (a.k !== b.k) {
    // The checker rejects cross-type equality (LGC-T003) and never coerces, so this is a
    // bypassed-checker path. Unequal kinds are unequal — no coercion happens here either.
    return false;
  }
  return valueEq(a, b);
}

/**
 * `RECODE(x, d)` — the same codes, reinterpreted in domain `d`.
 *
 * Three outcomes, and the difference between the last two is the point:
 *
 *  - a code the target declares is kept, retagged to `d`;
 *  - a code it does not declare is DROPPED from a set and NULLS an enum — a recode is a
 *    translation, and a term with no translation is absent, not zero;
 *  - a target the schema cannot see at all is NULL, never an empty set. "Cannot recode" and
 *    "recoded to nothing" have opposite consequences downstream: an empty set satisfies
 *    `NONE OF` and fires a mask's `when_empty`, a null propagates and is excluded. Guessing the
 *    permissive one on a missing domain is how a mask silently shows everything.
 */
function evalRecode(to: DomainId, value: Value, env: ExprEnv): Value {
  if (value.k === 'null') return NULL;
  const declared = env.schema.domainCodes(to);
  if (declared.length === 0) return NULL;
  const allowed = new Set(declared);
  if (value.k === 'enum') return allowed.has(value.v) ? enumValue(value.v, to) : NULL;
  if (value.k === 'set') return setValue(value.v.filter((code) => allowed.has(code)), to);
  // Anything else is a checker failure that reached the evaluator; null rather than a throw,
  // for the same reason `T_NEVER` exists — one mistake should not become an outage.
  return NULL;
}

function evalCast(to: 'num' | 'text' | 'date' | 'bool', onFail: 'null' | 'error', v: Value): Value {
  if (v.k === 'null') return NULL;
  const result = tryCast(to, v);
  if (result !== undefined) return result;
  if (onFail === 'null') return NULL;
  // `on_fail: 'error'` is the author asking for a hard stop. The engine's only failure channel
  // is `LogicInvariant` (D §1), and the runtime turns it into an error page rather than a
  // silently-null datum. An author who does not want that writes `on_fail: 'null'`.
  throw new LogicInvariant(`cast of ${formatValue(v)} to ${to} failed`);
}

function tryCast(to: 'num' | 'text' | 'date' | 'bool', v: Value): Value | undefined {
  switch (to) {
    case 'num': {
      if (v.k === 'num') return v;
      if (v.k === 'enum') return num(v.v); // this is the `CODE()` escape of D §3.2
      if (v.k === 'bool') return num(v.v ? 1 : 0);
      if (v.k === 'text') {
        const trimmed = v.v.trim();
        if (trimmed === '') return undefined;
        const parsed = Number(trimmed);
        return Number.isFinite(parsed) ? num(parsed) : undefined;
      }
      return undefined;
    }
    case 'text': {
      if (v.k === 'text') return v;
      if (v.k === 'set') return text(v.v.join(','));
      if (v.k === 'obj') return undefined;
      return text(asText(v.k === 'enum' ? num(v.v) : v));
    }
    case 'bool': {
      if (v.k === 'bool') return v;
      if (v.k === 'num') return bool(v.v !== 0);
      if (v.k === 'text') {
        const lowered = v.v.trim().toLowerCase();
        if (lowered === 'true' || lowered === '1') return TRUE;
        if (lowered === 'false' || lowered === '0') return FALSE;
        return undefined;
      }
      return undefined;
    }
    case 'date': {
      if (v.k === 'date') return v;
      if (v.k === 'text') return parseIso(v.v) === undefined ? undefined : { k: 'date', v: v.v };
      return undefined;
    }
    default: {
      const never: never = to;
      throw new LogicInvariant(`unhandled cast target ${JSON.stringify(never)}`);
    }
  }
}

function labelOf(v: Value, env: ExprEnv): Value {
  const lookup = (domain: DomainId, code: number): string | undefined => {
    const key = env.schema.labelKey(domain, code);
    return key === undefined ? undefined : env.ctx.labels?.[key];
  };
  if (v.k === 'enum') {
    const label = lookup(v.d, v.v);
    return label === undefined ? NULL : text(label);
  }
  if (v.k === 'set') {
    const labels = v.v.map((code) => lookup(v.d, code)).filter((l): l is string => l !== undefined);
    return labels.length === 0 ? NULL : text(labels.join(', '));
  }
  return text(asText(v));
}

/* ========================================================================== */
/* Regex cache                                                                */
/* ========================================================================== */

/**
 * A pure function cache: `(pattern, flags) -> RegExp`.
 *
 * Module-level state in a package that prides itself on purity needs a justification. This one
 * is observationally invisible — the same key always yields an equivalent object, and the
 * checker rejects the `g` and `y` flags (`LGC-T025`), which are the only way a `RegExp` carries
 * state between calls through `lastIndex`. Without the cache, `matches` allocates a compiled
 * regex per node visit, which D §10.3 forbids on the steady-state path. The cap keeps a
 * long-lived worker serving thousands of artifacts from growing without bound.
 */
const REGEX_CACHE = new Map<string, RegExp>();
const REGEX_CACHE_CAP = 512;

function compiledRegex(pattern: string, flags?: string): RegExp {
  const key = JSON.stringify([flags ?? '', pattern]);
  const hit = REGEX_CACHE.get(key);
  if (hit !== undefined) return hit;
  const compiled = new RegExp(pattern, flags);
  if (REGEX_CACHE.size >= REGEX_CACHE_CAP) REGEX_CACHE.clear();
  REGEX_CACHE.set(key, compiled);
  return compiled;
}
