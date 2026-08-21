/**
 * `fast-check` generators for the D §6.4 property suite.
 *
 * ## Why the generators produce `(builder) => Expr` rather than `Expr`
 *
 * D §2.1 item 4 requires every node to carry a *unique* stable `n`, and `astBuilder` owns that
 * counter (see `packages/logic/src/build.ts` on why hand-written node ids are a silent bug). A
 * recursive `fc.Arbitrary<Expr>` would have to allocate ids while the arbitrary is being built,
 * which means every generated subtree would share id 1 and the memo table would collide. So the
 * arbitraries produce *builders*, and the property applies one fresh `astBuilder(1)` per case. The
 * shrinker is unaffected: it shrinks the arbitraries underneath, not the closures.
 *
 * ## Why the generators are typed rather than filtered
 *
 * Properties P1, P2, P5 and P6 are all stated over *well-typed* ASTs. Generating arbitrary trees and
 * filtering out the ill-typed ones would spend most of the budget on rejects and would bias the
 * distribution towards trivial trees. So there is one generator per type — `bool`, `num`, `text`,
 * `date`, `enum<d>`, `set<d>` — and they compose only in ways D §3.3 admits. That also makes P6
 * ("zero diagnostics") a real assertion rather than a tautology: if a generator ever composes
 * something the checker rejects, P6 is the test that says so.
 *
 * Ordinality is respected: `<` is generated only against `dom_scale` and `dom_age_band`, which are
 * declared ordinal, because `<` on a brand list is `LGC-T009` (D §3.3's top-2-box bug).
 */

import fc from 'fast-check';
import type { AstBuilder, DomainId, Expr, Value, VariableId } from '@resscript/logic';
import { normalizeCodes } from '@resscript/logic';
import type { Action, NodeRef, Statement, Trivia, VarName } from '../ast.js';
import { DOM, P, Q, V } from './survey.js';

export type Build<T> = (b: AstBuilder) => T;

/* ---- variables, by type -------------------------------------------------- */

const NUM_VARS: readonly VariableId[] = [V.q6, V.age];
const TEXT_VARS: readonly VariableId[] = [V.oe, V.segment, V.prioritySegment];
const BOOL_VARS: readonly VariableId[] = [V.heavy, V.skipped, V.incompleteQ5];
const DATE_VARS: readonly VariableId[] = [V.dob, V.serverTime];
const SET_VARS: readonly VariableId[] = [V.q5set, V.q10set];

/** Ordinal domains only — `<`/`>` on a nominal domain is LGC-T009. */
const ORDINAL_ENUMS: readonly { readonly id: VariableId; readonly domain: DomainId }[] = [
  { id: V.q9, domain: DOM.scale },
  { id: V.ageBand, domain: DOM.ageBand },
];

const NOMINAL_ENUMS: readonly { readonly id: VariableId; readonly domain: DomainId }[] = [
  { id: V.s1, domain: DOM.s1 },
  { id: V.q3, domain: DOM.brand },
  { id: V.q12, domain: DOM.brand },
];

const DOMAIN_CODES: { readonly [key: string]: readonly number[] } = {
  [DOM.s1]: [1, 2],
  [DOM.fruit]: [1, 2, 3, 97, 99],
  [DOM.scale]: [1, 2, 3, 4, 5],
  [DOM.brand]: [1, 2, 3, 4],
  [DOM.ageBand]: [1, 2],
};

const oneOf = <T>(values: readonly T[]): fc.Arbitrary<T> => fc.constantFrom(...values);

const smallNum = fc.integer({ min: -20, max: 100 });
const shortText = fc.constantFrom('high', 'low', 'a b c', '', 'Ω');
const isoDate = fc.constantFrom('2026-01-01', '1990-06-15', '2026-08-20T09:00:00Z');

/* ---- expressions by type ------------------------------------------------- */

const numExpr: fc.Memo<Build<Expr>> = fc.memo((depth) => {
  const leaves: fc.Arbitrary<Build<Expr>>[] = [
    smallNum.map((v) => (b: AstBuilder) => b.numLit(v)),
    oneOf(NUM_VARS).map((id) => (b: AstBuilder) => b.variable(id)),
    fc.constant((b: AstBuilder) => b.agg({ fn: 'count', over: { kind: 'question_emits', question_id: Q.q5 } })),
    fc.constant((b: AstBuilder) => b.agg({ fn: 'sum', over: { kind: 'explicit', variable_ids: [V.q6, V.age] } })),
    fc.constant((b: AstBuilder) => b.agg({ fn: 'mean', over: { kind: 'question_emits', question_id: Q.q6 } })),
    fc.constant(
      (b: AstBuilder) =>
        b.agg({
          fn: 'count',
          over: { kind: 'question_emits', question_id: Q.q5 },
          where: b.item(),
        }),
    ),
    fc.constant(
      (b: AstBuilder) =>
        b.agg({
          fn: 'max',
          over: { kind: 'options', question_id: Q.q3 },
          select: b.itemAttr('code'),
        }),
    ),
    fc.constant(
      (b: AstBuilder) => b.agg({ fn: 'distinct_count', over: { kind: 'options', question_id: Q.q5 } }),
    ),
    // `MIN_OF(ROWS OF Q7)` is *not* num: D §3.3 gives `agg(min|max) : τ` where τ is the element
    // type, and Q7's rows are `enum<dom_scale>`. The projection is what makes it numeric.
    fc.constant(
      (b: AstBuilder) =>
        b.agg({ fn: 'min', over: { kind: 'matrix_rows', question_id: Q.q7 }, select: b.itemAttr('code') }),
    ),
  ];
  if (depth <= 1) return fc.oneof(...leaves);
  const inner = (): fc.Arbitrary<Build<Expr>> => numExpr(depth - 1);
  return fc.oneof(
    { arbitrary: fc.oneof(...leaves), weight: 6 },
    {
      arbitrary: fc
        .tuple(fc.constantFrom('+' as const, '-' as const, '*' as const, '/' as const, 'mod' as const, 'pow' as const), inner(), inner())
        .map(([op, l, r]) => (b: AstBuilder) => b.binArith(op, l(b), r(b))),
      weight: 3,
    },
    {
      arbitrary: fc
        .tuple(fc.constantFrom('neg' as const, 'abs' as const, 'floor' as const, 'ceil' as const), inner())
        .map(([op, a]) => (b: AstBuilder) => b.unArith(op, a(b))),
      weight: 1,
    },
    {
      arbitrary: fc.tuple(inner(), fc.integer({ min: 0, max: 3 })).map(
        ([a, digits]) => (b: AstBuilder) => b.round(a(b), b.numLit(digits)),
      ),
      weight: 1,
    },
    {
      arbitrary: fc
        .tuple(fc.constantFrom('min' as const, 'max' as const), inner(), inner())
        .map(([op, x, y]) => (b: AstBuilder) => b.nAryArith(op, x(b), y(b))),
      weight: 1,
    },
    {
      arbitrary: fc.tuple(inner(), inner(), inner()).map(
        ([x, lo, hi]) => (b: AstBuilder) => b.nAryArith('clamp', x(b), lo(b), hi(b)),
      ),
      weight: 1,
    },
    {
      arbitrary: textExpr(depth - 1).map((t) => (b: AstBuilder) => b.strUnary('len', t(b))),
      weight: 1,
    },
    {
      arbitrary: textExpr(depth - 1).map((t) => (b: AstBuilder) => b.strUnary('word_count', t(b))),
      weight: 1,
    },
    {
      arbitrary: fc
        .tuple(
          fc.constantFrom('day' as const, 'month' as const, 'year' as const, 'hour' as const),
          dateExpr(depth - 1),
          dateExpr(depth - 1),
        )
        .map(([unit, x, y]) => (b: AstBuilder) => b.dateDiff(unit, x(b), y(b))),
      weight: 1,
    },
    {
      arbitrary: fc
        .tuple(fc.constantFrom('year' as const, 'month' as const, 'day' as const, 'dow' as const), dateExpr(depth - 1))
        .map(([part, x]) => (b: AstBuilder) => b.datePart(part, x(b))),
      weight: 1,
    },
    {
      arbitrary: fc.tuple(textExpr(depth - 1), fc.constantFrom(',', ' ')).map(
        ([t, sep]) => (b: AstBuilder) => b.strBinary('split_count', t(b), b.textLit(sep)),
      ),
      weight: 1,
    },
    {
      arbitrary: textExpr(depth - 1).map((t) => (b: AstBuilder) => b.cast('num', t(b))),
      weight: 1,
    },
    {
      arbitrary: fc.tuple(inner(), inner()).map(([x, y]) => (b: AstBuilder) => b.coalesce(x(b), y(b))),
      weight: 1,
    },
  );
});

const textExpr: fc.Memo<Build<Expr>> = fc.memo((depth) => {
  const leaves: fc.Arbitrary<Build<Expr>>[] = [
    shortText.map((v) => (b: AstBuilder) => b.textLit(v)),
    oneOf(TEXT_VARS).map((id) => (b: AstBuilder) => b.variable(id)),
    fc.constant((b: AstBuilder) => b.labelOf(b.variable(V.q5set))),
    fc.constant((b: AstBuilder) => b.labelOf(b.variable(V.s1), 'long')),
  ];
  if (depth <= 1) return fc.oneof(...leaves);
  const inner = (): fc.Arbitrary<Build<Expr>> => textExpr(depth - 1);
  return fc.oneof(
    { arbitrary: fc.oneof(...leaves), weight: 4 },
    {
      arbitrary: fc
        .tuple(fc.constantFrom('lower' as const, 'upper' as const, 'trim' as const), inner())
        .map(([op, t]) => (b: AstBuilder) => b.strUnary(op, t(b))),
      weight: 2,
    },
    {
      arbitrary: fc.tuple(inner(), inner()).map(([x, y]) => (b: AstBuilder) => b.concat(x(b), y(b))),
      weight: 2,
    },
    {
      arbitrary: fc
        .tuple(inner(), fc.integer({ min: 0, max: 5 }), fc.option(fc.integer({ min: 1, max: 5 }), { nil: undefined }))
        .map(([t, start, length]) => (b: AstBuilder) =>
          length === undefined ? b.substr(t(b), b.numLit(start)) : b.substr(t(b), b.numLit(start), b.numLit(length)),
        ),
      weight: 1,
    },
    {
      arbitrary: numExpr(depth - 1).map((n) => (b: AstBuilder) => b.cast('text', n(b))),
      weight: 1,
    },
    {
      arbitrary: fc.tuple(inner(), inner()).map(([x, y]) => (b: AstBuilder) => b.coalesce(x(b), y(b))),
      weight: 1,
    },
  );
});

const dateExpr: fc.Memo<Build<Expr>> = fc.memo((depth) => {
  const leaves: fc.Arbitrary<Build<Expr>>[] = [
    isoDate.map((v) => (b: AstBuilder) => b.dateLit(v)),
    oneOf(DATE_VARS).map((id) => (b: AstBuilder) => b.variable(id)),
  ];
  if (depth <= 1) return fc.oneof(...leaves);
  const inner = (): fc.Arbitrary<Build<Expr>> => dateExpr(depth - 1);
  return fc.oneof(
    { arbitrary: fc.oneof(...leaves), weight: 4 },
    {
      arbitrary: fc
        .tuple(fc.constantFrom('day' as const, 'month' as const, 'year' as const), inner(), fc.integer({ min: -5, max: 5 }))
        .map(([unit, d, n]) => (b: AstBuilder) => b.dateAdd(unit, d(b), b.numLit(n))),
      weight: 2,
    },
    {
      arbitrary: fc
        .tuple(fc.constantFrom('day' as const, 'month' as const, 'year' as const), inner())
        .map(([unit, d]) => (b: AstBuilder) => b.dateTrunc(unit, d(b))),
      weight: 2,
    },
    {
      arbitrary: textExpr(depth - 1).map((t) => (b: AstBuilder) => b.cast('date', t(b))),
      weight: 1,
    },
  );
});

/** An enum-typed expression over one domain. Literals carry the domain, as D §2.2 requires. */
function enumExpr(domain: DomainId, id: VariableId, depth: number): fc.Arbitrary<Build<Expr>> {
  const codes = DOMAIN_CODES[domain] ?? [1];
  const leaves: fc.Arbitrary<Build<Expr>>[] = [
    oneOf(codes).map((code) => (b: AstBuilder) => b.enumLit(code, domain)),
    fc.constant((b: AstBuilder) => b.variable(id)),
  ];
  if (depth <= 1) return fc.oneof(...leaves);
  return fc.oneof(
    { arbitrary: fc.oneof(...leaves), weight: 6 },
    {
      arbitrary: fc.tuple(oneOf(codes), oneOf(codes)).map(
        ([a, c]) => (b: AstBuilder) => b.coalesce(b.enumLit(a, domain), b.enumLit(c, domain)),
      ),
      weight: 1,
    },
  );
}

function setExpr(depth: number): fc.Arbitrary<Build<Expr>> {
  const codes = DOMAIN_CODES[DOM.fruit] ?? [1];
  const leaves: fc.Arbitrary<Build<Expr>>[] = [
    oneOf(SET_VARS).map((id) => (b: AstBuilder) => b.variable(id)),
    fc
      .uniqueArray(oneOf(codes), { minLength: 1, maxLength: 3 })
      .map((list) => (b: AstBuilder) => b.setLit(normalizeCodes(list), DOM.fruit)),
  ];
  if (depth <= 1) return fc.oneof(...leaves);
  return fc.oneof(
    { arbitrary: fc.oneof(...leaves), weight: 5 },
    {
      arbitrary: fc
        .tuple(fc.constantFrom('union' as const, 'intersect' as const, 'difference' as const), setExpr(depth - 1), setExpr(depth - 1))
        .map(([op, l, r]) => (b: AstBuilder) => b.setOp(op, l(b), r(b))),
      weight: 1,
    },
  );
}

const boolExpr: fc.Memo<Build<Expr>> = fc.memo((depth) => {
  const fruitCodes = DOMAIN_CODES[DOM.fruit] ?? [1];
  const leaves: fc.Arbitrary<Build<Expr>>[] = [
    fc.boolean().map((v) => (b: AstBuilder) => b.boolLit(v)),
    oneOf(BOOL_VARS).map((id) => (b: AstBuilder) => b.variable(id)),
    fc
      .tuple(
        fc.constantFrom('answered' as const, 'shown' as const, 'valid' as const, 'asked' as const),
        oneOf([V.q6, V.age, V.q5set]),
      )
      .map(([kind, id]) => (b: AstBuilder) => b.probe(kind, { kind: 'variable', id })),
    fc
      .constantFrom('answered' as const, 'shown' as const)
      .map((kind) => (b: AstBuilder) => b.probe(kind, { kind: 'question', id: Q.q12 })),
    fc.constant((b: AstBuilder) => b.probe('shown', { kind: 'page', id: P.p2 })),
    fc.constant(
      (b: AstBuilder) =>
        b.agg({ fn: 'any', over: { kind: 'question_emits', question_id: Q.q5 }, where: b.item() }),
    ),
    fc.constant((b: AstBuilder) => b.agg({ fn: 'all', over: { kind: 'question_emits', question_id: Q.q5 } })),
  ];
  if (depth <= 1) return fc.oneof(...leaves);
  const inner = (): fc.Arbitrary<Build<Expr>> => boolExpr(depth - 1);
  return fc.oneof(
    { arbitrary: fc.oneof(...leaves), weight: 3 },
    // Comparisons: the most common shape in a real corpus, so the heaviest weight.
    {
      arbitrary: fc
        .tuple(
          fc.constantFrom('==' as const, '!=' as const, '<' as const, '<=' as const, '>' as const, '>=' as const),
          numExpr(depth - 1),
          numExpr(depth - 1),
        )
        .map(([op, l, r]) => (b: AstBuilder) => b.cmp(op, l(b), r(b))),
      weight: 6,
    },
    {
      arbitrary: fc
        .tuple(fc.constantFrom('==' as const, '!=' as const), oneOf(NOMINAL_ENUMS), fc.nat(3))
        .chain(([op, entry, pick]) =>
          enumExpr(entry.domain, entry.id, depth - 1).map(
            (left) => (b: AstBuilder) =>
              b.cmp(op, left(b), b.enumLit((DOMAIN_CODES[entry.domain] ?? [1])[pick % (DOMAIN_CODES[entry.domain] ?? [1]).length] ?? 1, entry.domain)),
          ),
        ),
      weight: 4,
    },
    {
      arbitrary: fc
        .tuple(
          fc.constantFrom('<' as const, '<=' as const, '>' as const, '>=' as const, '==' as const),
          oneOf(ORDINAL_ENUMS),
          fc.nat(4),
        )
        .chain(([op, entry, pick]) =>
          enumExpr(entry.domain, entry.id, depth - 1).map((left) => (b: AstBuilder) => {
            const codes = DOMAIN_CODES[entry.domain] ?? [1];
            return b.cmp(op, left(b), b.enumLit(codes[pick % codes.length] ?? 1, entry.domain));
          }),
        ),
      weight: 3,
    },
    {
      arbitrary: fc
        .tuple(fc.constantFrom('==' as const, '!=' as const), textExpr(depth - 1), textExpr(depth - 1))
        .map(([op, l, r]) => (b: AstBuilder) => b.cmp(op, l(b), r(b))),
      weight: 2,
    },
    {
      arbitrary: fc
        .tuple(fc.constantFrom('<' as const, '>=' as const, '==' as const), dateExpr(depth - 1), dateExpr(depth - 1))
        .map(([op, l, r]) => (b: AstBuilder) => b.cmp(op, l(b), r(b))),
      weight: 1,
    },
    // Set predicates.
    {
      arbitrary: fc.tuple(setExpr(depth - 1), oneOf(fruitCodes)).map(
        ([s, code]) => (b: AstBuilder) => b.setOp('contains', s(b), b.enumLit(code, DOM.fruit)),
      ),
      weight: 3,
    },
    {
      arbitrary: fc
        .tuple(
          fc.constantFrom('any_of' as const, 'all_of' as const, 'none_of' as const, 'set_eq' as const, 'subset_of' as const),
          setExpr(depth - 1),
          setExpr(depth - 1),
        )
        .map(([op, l, r]) => (b: AstBuilder) => b.setOp(op, l(b), r(b))),
      weight: 3,
    },
    // Boolean combinators, n-ary as D §2.3 requires.
    {
      arbitrary: fc.array(inner(), { minLength: 2, maxLength: 3 }).map(
        (args) => (b: AstBuilder) => b.and(...args.map((arg) => arg(b))),
      ),
      weight: 4,
    },
    {
      arbitrary: fc.array(inner(), { minLength: 2, maxLength: 3 }).map(
        (args) => (b: AstBuilder) => b.or(...args.map((arg) => arg(b))),
      ),
      weight: 3,
    },
    { arbitrary: inner().map((a) => (b: AstBuilder) => b.not(a(b))), weight: 2 },
    // Strings and casts that yield bool.
    {
      arbitrary: fc
        .tuple(
          fc.constantFrom('starts_with' as const, 'ends_with' as const, 'str_contains' as const),
          textExpr(depth - 1),
          shortText,
        )
        .map(([op, t, needle]) => (b: AstBuilder) => b.strBinary(op, t(b), b.textLit(needle))),
      weight: 1,
    },
    {
      arbitrary: fc.tuple(textExpr(depth - 1), fc.constantFrom('^[a-z]+$', '^[A-Z]{2}[0-9]{4}$')).map(
        ([t, pattern]) => (b: AstBuilder) => b.matches(t(b), pattern),
      ),
      weight: 1,
    },
    {
      // `on_fail: 'null'`, deliberately: the evaluator treats a failed `on_fail: 'error'` cast as a
      // `LogicInvariant` (a thrown exception), so a generated one would make P5 fail on the
      // *evaluator's* documented behaviour rather than on anything the printer did. The `'error'`
      // spelling is covered by the closure test instead.
      arbitrary: textExpr(depth - 1).map((t) => (b: AstBuilder) => b.cast('bool', t(b))),
      weight: 1,
    },
    // `case`, with a non-null else: D §2.3 requires the else, and a null else would trip LGC-W014.
    {
      arbitrary: fc.tuple(inner(), fc.boolean(), fc.boolean()).map(
        ([when, then, otherwise]) => (b: AstBuilder) =>
          b.caseExpr([{ when: when(b), then: b.boolLit(then) }], b.boolLit(otherwise)),
      ),
      weight: 2,
    },
    {
      arbitrary: fc.tuple(inner(), inner()).map(([x, y]) => (b: AstBuilder) => b.coalesce(x(b), y(b))),
      weight: 1,
    },
  );
});

/** A well-typed boolean expression — every rule condition is one (D §4.1: "typed bool"). */
export function arbCondition(maxDepth = 5): fc.Arbitrary<Build<Expr>> {
  return boolExpr(maxDepth);
}

export function arbNumExpr(maxDepth = 4): fc.Arbitrary<Build<Expr>> {
  return numExpr(maxDepth);
}

/* ---- statements ---------------------------------------------------------- */

const questionRef = (ref: string, id: (typeof Q)[keyof typeof Q]): NodeRef => ({
  ref,
  kind: 'question',
  id,
});

const varName = (ref: string, id: VariableId): VarName => ({ ref, id });

/** Actions that are legal as a *bare statement* — `ActionStmt` excludes `set` and `terminate`. */
type BareAction<E> = Exclude<Action<E>, { readonly a: 'set' } | { readonly a: 'terminate' }>;

const arbBareAction: fc.Arbitrary<Build<BareAction<Expr>>> = fc.oneof(
  fc.constant((): BareAction<Expr> => ({ a: 'show', target: { ref: questionRef('Q12', Q.q12) } })),
  fc.constant((): BareAction<Expr> => ({ a: 'hide', target: { ref: questionRef('Q12', Q.q12) } })),
  fc.constant(
    (): BareAction<Expr> => ({
      a: 'disable',
      target: { ref: questionRef('Q7', Q.q7), axis: 'row', codes: [2, 5] },
    }),
  ),
  fc.constant(
    (): BareAction<Expr> => ({ a: 'skip_to', ref: { ref: 'P3', kind: 'page', explicit: 'page', id: P.p3 } }),
  ),
  fc.constant((): BareAction<Expr> => ({ a: 'flag', variable: varName('incomplete_q5', V.incompleteQ5) })),
  fc.constant((): BareAction<Expr> => ({ a: 'require', ref: questionRef('Q12', Q.q12) })),
);

const arbAction: fc.Arbitrary<Build<Action<Expr>>> = fc.oneof(
  fc.constant((): Action<Expr> => ({ a: 'show', target: { ref: questionRef('Q12', Q.q12) } })),
  fc.constant((): Action<Expr> => ({ a: 'hide', target: { ref: questionRef('Q12', Q.q12) } })),
  fc.constant(
    (): Action<Expr> => ({
      a: 'disable',
      target: { ref: questionRef('Q7', Q.q7), axis: 'row', codes: [2, 5] },
    }),
  ),
  fc.constant((): Action<Expr> => ({ a: 'skip_to', ref: { ref: 'P3', kind: 'page', explicit: 'page', id: P.p3 } })),
  fc.constant((): Action<Expr> => ({ a: 'terminate', disposition: 'SCREENOUT' })),
  fc.constant((): Action<Expr> => ({ a: 'flag', variable: varName('incomplete_q5', V.incompleteQ5) })),
  fc.constant((): Action<Expr> => ({ a: 'require', ref: questionRef('Q12', Q.q12) })),
  arbCondition(2).map(
    (value) =>
      (b: AstBuilder): Action<Expr> => ({ a: 'set', variable: varName('HEAVY_BUYER', V.heavy), value: value(b) }),
  ),
  fc.constantFrom('young', 'old').map(
    (text) =>
      (b: AstBuilder): Action<Expr> => ({ a: 'set', variable: varName('SEGMENT', V.segment), value: b.textLit(text) }),
  ),
  fc.constantFrom(1, 2).map(
    (code) =>
      (b: AstBuilder): Action<Expr> => ({
        a: 'set',
        variable: varName('AGE_BAND', V.ageBand),
        value: b.enumLit(code, DOM.ageBand),
      }),
  ),
);

/**
 * A rule statement: one condition, one or two effects, optionally an else branch — the shape D §9.3
 * says desugars to one rule per effect cell and must print back exactly.
 */
export const arbRuleStatement: fc.Arbitrary<Build<Statement<Expr>>> = fc
  .tuple(
    arbCondition(4),
    fc.array(arbAction, { minLength: 1, maxLength: 2 }),
    fc.option(fc.array(arbAction, { minLength: 1, maxLength: 2 }), { nil: undefined }),
    fc.option(fc.constantFrom('SHOW' as const, 'HIDE' as const, 'FIRE' as const, 'SKIP' as const), {
      nil: undefined,
    }),
  )
  .map(
    ([condition, then, otherwise, onUnknown]) =>
      (b: AstBuilder): Statement<Expr> => ({
        s: 'rule',
        condition: condition(b),
        ...(onUnknown === undefined ? {} : { on_unknown: onUnknown }),
        then: then.map((action) => action(b)),
        ...(otherwise === undefined ? {} : { otherwise: otherwise.map((action) => action(b)) }),
      }),
  );

export const arbTerminateStatement: fc.Arbitrary<Build<Statement<Expr>>> = fc
  .tuple(fc.option(arbCondition(3), { nil: undefined }), fc.constantFrom('SCREENOUT' as const, 'QUOTA_FULL' as const, 'QUALITY' as const))
  .map(
    ([condition, disposition]) =>
      (b: AstBuilder): Statement<Expr> => ({
        s: 'terminate',
        disposition,
        ...(condition === undefined ? {} : { condition: condition(b) }),
      }),
  );

export const arbSetStatement: fc.Arbitrary<Build<Statement<Expr>>> = arbCondition(3).map(
  (value) =>
    (b: AstBuilder): Statement<Expr> => ({
      s: 'set',
      variable: varName('HEAVY_BUYER', V.heavy),
      value: value(b),
    }),
);

export const arbActionStatement: fc.Arbitrary<Build<Statement<Expr>>> = fc
  .tuple(arbBareAction, fc.option(arbCondition(2), { nil: undefined }))
  .map(
    ([action, condition]) =>
      (b: AstBuilder): Statement<Expr> => ({
        s: 'action',
        action: action(b),
        ...(condition === undefined ? {} : { condition: condition(b) }),
      }),
  );

export const arbStatement: fc.Arbitrary<Build<Statement<Expr>>> = fc.oneof(
  { arbitrary: arbRuleStatement, weight: 6 },
  { arbitrary: arbActionStatement, weight: 2 },
  { arbitrary: arbTerminateStatement, weight: 1 },
  { arbitrary: arbSetStatement, weight: 1 },
);

/** A program of independent statements, each with its own node-id space. */
export const arbProgramBuilders: fc.Arbitrary<readonly Build<Statement<Expr>>[]> = fc.array(arbStatement, {
  minLength: 1,
  maxLength: 4,
});

/* ---- trivia -------------------------------------------------------------- */

/**
 * Trivia for P4. Comment markers are drawn from all three the lexer accepts, because the point of
 * P4 is that the *author's* text survives — including which marker they chose.
 */
export const arbTrivia: fc.Arbitrary<Trivia> = fc
  .tuple(
    fc.array(fc.constantFrom('# a note', '-- client asked for this in R2', '/* wave 3 */', '#'), {
      maxLength: 2,
    }),
    fc.option(fc.constantFrom('# why', '-- see ticket 412'), { nil: undefined }),
    fc.integer({ min: 0, max: 2 }),
  )
  .map(([leading, trailing, blank]) => ({
    ...(leading.length === 0 ? {} : { leading }),
    ...(trailing === undefined ? {} : { trailing }),
    ...(blank === 0 ? {} : { blank_before: blank }),
  }));

/* ---- variable states ----------------------------------------------------- */

/**
 * A variable state, null-heavy on purpose.
 *
 * D §6.4: "P5 … 200 arbitrary variable states … including states with nulls", and P5 is the property
 * that catches an enum literal printed as a bare number that re-parses as `num` — a difference no
 * structural comparison sees, and which only shows up when a null makes the two trees disagree.
 */
export const arbVarState: fc.Arbitrary<{ readonly [id: string]: Value }> = fc
  .record({
    q6: fc.option(fc.integer({ min: -5, max: 60 }), { nil: undefined }),
    age: fc.option(fc.integer({ min: 12, max: 90 }), { nil: undefined }),
    s1: fc.option(fc.constantFrom(1, 2), { nil: undefined }),
    q3: fc.option(fc.constantFrom(1, 2, 3, 4), { nil: undefined }),
    q9: fc.option(fc.constantFrom(1, 2, 3, 4, 5), { nil: undefined }),
    q12: fc.option(fc.constantFrom(1, 2, 3, 4), { nil: undefined }),
    ageBand: fc.option(fc.constantFrom(1, 2), { nil: undefined }),
    q5: fc.option(fc.uniqueArray(fc.constantFrom(1, 2, 3, 97, 99), { maxLength: 3 }), { nil: undefined }),
    q10: fc.option(fc.uniqueArray(fc.constantFrom(1, 2, 3, 97, 99), { maxLength: 3 }), { nil: undefined }),
    oe: fc.option(fc.constantFrom('', 'a b', 'AB1234'), { nil: undefined }),
    segment: fc.option(fc.constantFrom('young', 'old'), { nil: undefined }),
    heavy: fc.option(fc.boolean(), { nil: undefined }),
    skipped: fc.option(fc.boolean(), { nil: undefined }),
    dob: fc.option(fc.constantFrom('1990-06-15', '2001-02-28'), { nil: undefined }),
  })
  .map((raw) => {
    const out: { [id: string]: Value } = {};
    const put = (id: VariableId, value: Value | undefined): void => {
      if (value !== undefined) out[id] = value;
    };
    put(V.q6, raw.q6 === undefined ? undefined : { k: 'num', v: raw.q6 });
    put(V.age, raw.age === undefined ? undefined : { k: 'num', v: raw.age });
    put(V.s1, raw.s1 === undefined ? undefined : { k: 'enum', v: raw.s1, d: DOM.s1 });
    put(V.q3, raw.q3 === undefined ? undefined : { k: 'enum', v: raw.q3, d: DOM.brand });
    put(V.q9, raw.q9 === undefined ? undefined : { k: 'enum', v: raw.q9, d: DOM.scale });
    put(V.q12, raw.q12 === undefined ? undefined : { k: 'enum', v: raw.q12, d: DOM.brand });
    put(V.ageBand, raw.ageBand === undefined ? undefined : { k: 'enum', v: raw.ageBand, d: DOM.ageBand });
    put(V.q5set, raw.q5 === undefined ? undefined : { k: 'set', v: normalizeCodes(raw.q5), d: DOM.fruit });
    put(V.q10set, raw.q10 === undefined ? undefined : { k: 'set', v: normalizeCodes(raw.q10), d: DOM.fruit });
    put(V.oe, raw.oe === undefined ? undefined : { k: 'text', v: raw.oe });
    put(V.segment, raw.segment === undefined ? undefined : { k: 'text', v: raw.segment });
    put(V.heavy, raw.heavy === undefined ? undefined : { k: 'bool', v: raw.heavy });
    put(V.skipped, raw.skipped === undefined ? undefined : { k: 'bool', v: raw.skipped });
    put(V.dob, raw.dob === undefined ? undefined : { k: 'date', v: raw.dob });
    out[V.serverTime] = { k: 'date', v: '2026-08-20T09:00:00Z' };
    return out;
  });

export const LABELS: { readonly [key: string]: string } = {
  'fruit.apple': 'Apple',
  'fruit.banana': 'Banana',
  'fruit.cherry': 'Cherry',
  'fruit.other': 'Other',
  'fruit.none': 'None of these',
  's1.yes': 'Yes',
  's1.no': 'No',
};

/**
 * Case count per property.
 *
 * The roadmap's acceptance criterion is 10,000 cases; R1's mitigation says to run P1–P8 "at 10,000
 * cases nightly, not 100 cases per PR", because a property suite slow enough to be skipped is a
 * property suite nobody runs. So the default is modest and `RESSCRIPT_PROPERTY_RUNS` raises it.
 */
export function runs(defaultRuns = 200): number {
  const raw = process.env['RESSCRIPT_PROPERTY_RUNS'];
  if (raw === undefined) return defaultRuns;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultRuns;
}
