/**
 * D §2.5's propagation table, row by row, plus the evaluation rules for every node family.
 *
 * The table is the contract. Each `it` below names the row it enforces, so a failure says which
 * line of the design broke rather than which function.
 */

import { describe, expect, it } from 'vitest';
import { astBuilder } from './build.js';
import { DOM, LABELS, OPT, P, Q, V, env, registryInput } from './__fixtures__/survey.js';
import { buildEvalSchema } from './compile.js';
import { EMPTY_SCHEMA, NO_CELLS, aggregate, evalCondition, evalExpr, type CellReader, type ExprEnv } from './evaluator.js';
import { LogicInvariant, asDomainId, asVariableId } from './ids.js';
import { buildTypeEnv } from './registry.js';
import { varStateOf, type EvalContext } from './state.js';
import { FALSE, NULL, TRUE, bool, enumValue, num, setValue, text, type Value } from './value.js';

const E = env();

function envOf(
  values: { readonly [id: string]: Value } = {},
  overrides: Partial<ExprEnv> = {},
  ctx: EvalContext = { labels: LABELS },
): ExprEnv {
  return {
    vars: varStateOf(values),
    ctx,
    cells: NO_CELLS,
    schema: buildEvalSchema(E),
    ...overrides,
  };
}

describe('cmp: any null operand → U (D §2.5, "null != 5 must not be true")', () => {
  const b = astBuilder();
  const ageLt18 = b.cmp('<', b.variable(V.age), b.numLit(18));
  const ageNe5 = b.cmp('!=', b.variable(V.age), b.numLit(5));

  it('< on an unanswered variable is U, not false', () => {
    expect(evalCondition(ageLt18, envOf({}))).toBe('U');
  });

  it('!= on an unanswered variable is U, not true', () => {
    // The single most expensive coercion bug in the industry: `null != 5` reading as true.
    expect(evalCondition(ageNe5, envOf({}))).toBe('U');
  });

  it('is decisive once the variable is answered', () => {
    expect(evalCondition(ageLt18, envOf({ [V.age]: num(16) }))).toBe('T');
    expect(evalCondition(ageLt18, envOf({ [V.age]: num(44) }))).toBe('F');
  });
});

describe('set operations (D §2.5)', () => {
  const b = astBuilder();
  const q5 = b.variable(V.q5set);
  const anyOf = b.setOp('any_of', q5, b.setLit([1, 3], DOM.q5));
  const noneOf = b.setOp('none_of', q5, b.setLit([1, 3], DOM.q5));
  const contains = b.setOp('contains', q5, b.enumLit(1, DOM.q5));

  it('a null set operand makes ANY_OF unknown', () => {
    expect(evalCondition(anyOf, envOf({}))).toBe('U');
  });

  it('a null set operand makes NONE_OF unknown, NOT true — the asymmetry D §2.5 names as the trap', () => {
    // If this were `T`, "never saw the question" would satisfy "selected none of these", and an
    // unasked respondent lands in the brand-rejector segment.
    expect(evalCondition(noneOf, envOf({}))).toBe('U');
  });

  it('an answered empty set is a real answer: ANY_OF false, NONE_OF true, COUNT 0', () => {
    const state = envOf({ [V.q5set]: setValue([], DOM.q5) });
    expect(evalCondition(anyOf, state)).toBe('F');
    expect(evalCondition(noneOf, state)).toBe('T');
    expect(evalCondition(contains, state)).toBe('F');
  });

  it('CONTAINS on a populated set', () => {
    const state = envOf({ [V.q5set]: setValue([3, 1], DOM.q5) });
    expect(evalCondition(contains, state)).toBe('T');
    expect(evalCondition(noneOf, state)).toBe('F');
  });

  it('ALL_OF, SUBSET_OF and SET_EQ', () => {
    const all = b.setOp('all_of', q5, b.setLit([1, 3], DOM.q5));
    const subset = b.setOp('subset_of', q5, b.setLit([1, 2, 3], DOM.q5));
    const eq = b.setOp('set_eq', q5, b.setLit([1, 3], DOM.q5));
    const state = envOf({ [V.q5set]: setValue([1, 3], DOM.q5) });
    expect(evalCondition(all, state)).toBe('T');
    expect(evalCondition(subset, state)).toBe('T');
    expect(evalCondition(eq, state)).toBe('T');
  });

  it('UNION, INTERSECT and DIFFERENCE produce sorted deduped sets', () => {
    const union = b.setOp('union', q5, b.setLit([2, 1], DOM.q5));
    const value = evalExpr(union, envOf({ [V.q5set]: setValue([3, 1], DOM.q5) }));
    expect(value).toEqual({ k: 'set', v: [1, 2, 3], d: DOM.q5 });
  });

  it('a domain mismatch is an invariant failure, not a false — enums are nominal (D §2.2)', () => {
    const mismatched = b.setOp('contains', q5, b.enumLit(1, DOM.brand));
    expect(() => evalExpr(mismatched, envOf({ [V.q5set]: setValue([1], DOM.q5) }))).toThrow(LogicInvariant);
  });
});

describe('arithmetic (D §2.5: any null operand → null)', () => {
  const b = astBuilder();

  it('propagates null', () => {
    const sum = b.binArith('+', b.variable(V.age), b.numLit(1));
    expect(evalExpr(sum, envOf({}))).toBe(NULL);
  });

  it('division by zero is null, not a crash and not Infinity', () => {
    // Respondent-reachable (SPEND / TRIPS with TRIPS = 0). D §2.2 forbids Infinity in a VarState.
    const div = b.binArith('/', b.numLit(1), b.variable(V.q6));
    expect(evalExpr(div, envOf({ [V.q6]: num(0) }))).toBe(NULL);
    expect(evalExpr(div, envOf({ [V.q6]: num(4) }))).toEqual(num(0.25));
  });

  it('round, min, max, clamp, mod and pow', () => {
    expect(evalExpr(b.round(b.numLit(3.14159), b.numLit(2)), envOf({}))).toEqual(num(3.14));
    expect(evalExpr(b.nAryArith('min', b.numLit(5), b.numLit(2), b.numLit(9)), envOf({}))).toEqual(num(2));
    expect(evalExpr(b.nAryArith('max', b.numLit(5), b.numLit(2)), envOf({}))).toEqual(num(5));
    expect(evalExpr(b.nAryArith('clamp', b.numLit(12), b.numLit(0), b.numLit(10)), envOf({}))).toEqual(num(10));
    expect(evalExpr(b.binArith('mod', b.numLit(7), b.numLit(3)), envOf({}))).toEqual(num(1));
    expect(evalExpr(b.binArith('pow', b.numLit(2), b.numLit(10)), envOf({}))).toEqual(num(1024));
    expect(evalExpr(b.unArith('abs', b.numLit(-4)), envOf({}))).toEqual(num(4));
    expect(evalExpr(b.unArith('neg', b.numLit(4)), envOf({}))).toEqual(num(-4));
    expect(evalExpr(b.unArith('floor', b.numLit(4.9)), envOf({}))).toEqual(num(4));
    expect(evalExpr(b.unArith('ceil', b.numLit(4.1)), envOf({}))).toEqual(num(5));
  });
});

describe('string operations (D §2.5: null input → null)', () => {
  const b = astBuilder();

  it('len(null) is null, not 0', () => {
    // 0 would make an unasked open-end indistinguishable from an answered-but-empty one, which is
    // a quality flag an analyst acts on.
    expect(evalExpr(b.strUnary('len', b.variable(V.openEnd)), envOf({}))).toBe(NULL);
    expect(evalExpr(b.strUnary('len', b.variable(V.openEnd)), envOf({ [V.openEnd]: text('abc') }))).toEqual(num(3));
  });

  it('word_count for open-end quality checks', () => {
    const wc = b.strUnary('word_count', b.variable(V.openEnd));
    expect(evalExpr(wc, envOf({ [V.openEnd]: text('  two   words  ') }))).toEqual(num(2));
    expect(evalExpr(wc, envOf({ [V.openEnd]: text('   ') }))).toEqual(num(0));
  });

  it('case folding, trim, concat, substr and split_count', () => {
    expect(evalExpr(b.strUnary('lower', b.textLit('AbC')), envOf({}))).toEqual(text('abc'));
    expect(evalExpr(b.strUnary('upper', b.textLit('AbC')), envOf({}))).toEqual(text('ABC'));
    expect(evalExpr(b.strUnary('trim', b.textLit('  x ')), envOf({}))).toEqual(text('x'));
    expect(evalExpr(b.concat(b.textLit('a'), b.textLit('b')), envOf({}))).toEqual(text('ab'));
    expect(evalExpr(b.substr(b.textLit('abcdef'), b.numLit(1), b.numLit(3)), envOf({}))).toEqual(text('bcd'));
    expect(evalExpr(b.strBinary('split_count', b.textLit('a,b,c'), b.textLit(',')), envOf({}))).toEqual(num(3));
  });

  it('predicates', () => {
    expect(evalCondition(b.strBinary('starts_with', b.textLit('abc'), b.textLit('ab')), envOf({}))).toBe('T');
    expect(evalCondition(b.strBinary('ends_with', b.textLit('abc'), b.textLit('bc')), envOf({}))).toBe('T');
    expect(evalCondition(b.strBinary('str_contains', b.textLit('abc'), b.textLit('zz')), envOf({}))).toBe('F');
    expect(evalCondition(b.matches(b.textLit('a1'), '^[a-z]\\d$'), envOf({}))).toBe('T');
    expect(evalCondition(b.matches(b.variable(V.openEnd), '^x$'), envOf({}))).toBe('U');
  });
});

describe('date operations (D §2.5: null input → null; D §2.6: no clock)', () => {
  const b = astBuilder();

  it('date_diff is (from, to), so an age reads left to right', () => {
    const age = b.dateDiff('year', b.variable(V.dob), b.variable(V.serverTime));
    const value = evalExpr(
      age,
      envOf({ [V.dob]: { k: 'date', v: '1990-06-15' }, [V.serverTime]: { k: 'date', v: '2026-06-14T00:00:00Z' } }),
    );
    expect(value).toEqual(num(35));
  });

  it('propagates null from either side', () => {
    const age = b.dateDiff('year', b.variable(V.dob), b.variable(V.serverTime));
    expect(evalExpr(age, envOf({ [V.serverTime]: { k: 'date', v: '2026-06-14' } }))).toBe(NULL);
  });

  it('date_add clamps a month-end rather than overflowing', () => {
    const added = b.dateAdd('month', b.variable(V.dob), b.numLit(1));
    expect(evalExpr(added, envOf({ [V.dob]: { k: 'date', v: '2024-01-31' } }))).toEqual({
      k: 'date',
      v: '2024-02-29',
    });
  });

  it('date_part and date_trunc', () => {
    const state = envOf({ [V.dob]: { k: 'date', v: '2024-03-10T13:45:00Z' } });
    expect(evalExpr(b.datePart('year', b.variable(V.dob)), state)).toEqual(num(2024));
    expect(evalExpr(b.datePart('month', b.variable(V.dob)), state)).toEqual(num(3));
    expect(evalExpr(b.datePart('day', b.variable(V.dob)), state)).toEqual(num(10));
    expect(evalExpr(b.datePart('dow', b.variable(V.dob)), state)).toEqual(num(0)); // a Sunday
    expect(evalExpr(b.datePart('hour', b.variable(V.dob)), state)).toEqual(num(13));
    expect(evalExpr(b.dateTrunc('month', b.variable(V.dob)), state)).toEqual({ k: 'date', v: '2024-03-01' });
  });
});

describe('case (D §2.5: an unknown `when` is not-matched, and evaluation continues)', () => {
  const b = astBuilder();
  const band = b.caseExpr(
    [
      { when: b.cmp('<', b.variable(V.age), b.numLit(35)), then: b.textLit('young') },
      { when: b.cmp('==', b.variable(V.s1), b.enumLit(1, DOM.s1)), then: b.textLit('member') },
    ],
    b.textLit('old'),
  );

  it('a later arm can still match when an earlier one is unknown', () => {
    // Strict Kleene propagation here would null out the whole classification because AGE is
    // unset, even though S1 decides it. That is the documented deviation.
    expect(evalExpr(band, envOf({ [V.s1]: enumValue(1, DOM.s1) }))).toEqual(text('member'));
  });

  it('falls through to the mandatory else when every arm is unknown', () => {
    expect(evalExpr(band, envOf({}))).toEqual(text('old'));
  });

  it('takes the first matching arm', () => {
    expect(evalExpr(band, envOf({ [V.age]: num(20), [V.s1]: enumValue(1, DOM.s1) }))).toEqual(text('young'));
  });
});

describe('coalesce and cast', () => {
  const b = astBuilder();

  it('coalesce is the explicit escape from null: first non-null, else null', () => {
    const c = b.coalesce(b.variable(V.openEnd), b.textLit('fallback'));
    expect(evalExpr(c, envOf({}))).toEqual(text('fallback'));
    expect(evalExpr(c, envOf({ [V.openEnd]: text('given') }))).toEqual(text('given'));
    expect(evalExpr(b.coalesce(b.variable(V.openEnd)), envOf({}))).toBe(NULL);
  });

  it('CODE() — a cast to num — is the deliberate escape from nominal enums (D §3.2)', () => {
    const code = b.cast('num', b.variable(V.brand));
    expect(evalExpr(code, envOf({ [V.brand]: enumValue(2, DOM.brand) }))).toEqual(num(2));
  });

  it('on_fail: null yields null; on_fail: error is the author asking for a hard stop', () => {
    const soft = b.cast('num', b.textLit('not a number'), 'null');
    const hard = b.cast('num', b.textLit('not a number'), 'error');
    expect(evalExpr(soft, envOf({}))).toBe(NULL);
    expect(() => evalExpr(hard, envOf({}))).toThrow(LogicInvariant);
  });

  it('casting null is null whatever on_fail says', () => {
    expect(evalExpr(b.cast('num', b.variable(V.openEnd), 'error'), envOf({}))).toBe(NULL);
  });
});

describe('label_of (D §2.5: label_of(null) → null)', () => {
  const b = astBuilder();

  it('resolves a code to the session language label', () => {
    expect(evalExpr(b.labelOf(b.variable(V.q5set)), envOf({ [V.q5set]: setValue([1, 3], DOM.q5) }))).toEqual(
      text('Apple, Cherry'),
    );
  });

  it('is null for a null input, so piping renders the configured empty token', () => {
    expect(evalExpr(b.labelOf(b.variable(V.q5set)), envOf({}))).toBe(NULL);
  });
});

describe('probe (D §2.3, §2.5: never null — always T or F)', () => {
  const b = astBuilder();

  it('ANSWERED is false for an unset variable and true once it has any value', () => {
    const answered = b.probe('answered', { kind: 'variable', id: V.age });
    expect(evalCondition(answered, envOf({}))).toBe('F');
    expect(evalCondition(answered, envOf({ [V.age]: num(0) }))).toBe('T');
  });

  it('ANSWERED on a question is true when any emitted variable has a value', () => {
    const answered = b.probe('answered', { kind: 'question', id: Q.q5 });
    expect(evalCondition(answered, envOf({}))).toBe('F');
    // An answered multi-select with nothing checked has a non-null set view, so it *is* answered.
    expect(evalCondition(answered, envOf({ [V.q5set]: setValue([], DOM.q5) }))).toBe('T');
  });

  it('an invalidated value does not read as answered (E §7.2)', () => {
    const answered = b.probe('answered', { kind: 'variable', id: V.age });
    const state: ExprEnv = {
      ...envOf({ [V.age]: num(30) }),
      vars: varStateOf({ [V.age]: num(30) }, { [V.age]: { p: 'invalidated', by_page: P.p1, at: 0 } }),
    };
    expect(evalCondition(answered, state)).toBe('F');
  });

  it('SHOWN reads the visible cell, and defaults to the declared default when uncomputed', () => {
    const shown = b.probe('shown', { kind: 'question', id: Q.q12 });
    expect(evalCondition(shown, envOf({}))).toBe('T');
    const hidden: CellReader = { ...NO_CELLS, visible: (id) => (id === Q.q12 ? false : undefined) };
    expect(evalCondition(shown, envOf({}, { cells: hidden }))).toBe('F');
  });

  it('SHOWN on a fan-out variable asks about its question', () => {
    const shown = b.probe('shown', { kind: 'variable', id: V.q5r1 });
    const hidden: CellReader = { ...NO_CELLS, visible: (id) => (id === Q.q5 ? false : undefined) };
    expect(evalCondition(shown, envOf({}, { cells: hidden }))).toBe('F');
  });

  it('ASKED is SHOWN plus a submitted page — that is the whole difference', () => {
    const asked = b.probe('asked', { kind: 'question', id: Q.q5 });
    expect(evalCondition(asked, envOf({}, {}, {}))).toBe('F');
    expect(evalCondition(asked, envOf({}, {}, { pageSubmitted: (id) => id === P.p1 }))).toBe('T');
  });

  it('VALID is true when nothing has said otherwise', () => {
    const valid = b.probe('valid', { kind: 'question', id: Q.q5 });
    expect(evalCondition(valid, envOf({}))).toBe('T');
    const failing: CellReader = { ...NO_CELLS, valid: () => false };
    expect(evalCondition(valid, envOf({}, { cells: failing }))).toBe('F');
  });

  it('a probe never propagates null: NOT(ANSWERED(x)) is decisive', () => {
    const guard = b.not(b.probe('answered', { kind: 'variable', id: V.age }));
    expect(evalCondition(guard, envOf({}))).toBe('T');
  });
});

describe('aggregation (D §2.4 bounded iteration, D §2.5 null modes)', () => {
  it('COUNT over a question fan-out counts selected options', () => {
    const b = astBuilder();
    // The group must be resolved at compile time (D §10.1); resolve it through the registry here,
    // which is what `compileLogic` does for a real program.
    const resolved = {
      ...b.agg({
        fn: 'count',
        over: { kind: 'question_emits', question_id: Q.q5 },
        where: b.itemAttr('selected'),
      }),
      resolved: E.groupItems({ kind: 'question_emits', question_id: Q.q5 }),
    };
    const state = envOf({ [V.q5r1]: TRUE, [V.q5r2]: FALSE, [V.q5r3]: TRUE });
    expect(evalExpr(resolved, state)).toEqual(num(2));
  });

  it('the set view is excluded from question_emits, or every count is off by one', () => {
    const items = E.groupItems({ kind: 'question_emits', question_id: Q.q5 });
    expect(items).toHaveLength(4);
    expect(items.map((item) => item.variable_id)).not.toContain(V.q5set);
  });

  it('an unresolved group is an invariant failure, not a silent zero', () => {
    const b = astBuilder();
    const count = b.agg({ fn: 'count', over: { kind: 'question_emits', question_id: Q.q5 } });
    expect(() => evalExpr(count, envOf({}))).toThrow(LogicInvariant);
  });

  it('item.code, item.label, item.position and item.meta are readable per item', () => {
    const b = astBuilder();
    const items = E.groupItems({ kind: 'options', question_id: Q.q5 });
    const discontinued = {
      ...b.agg({
        fn: 'count',
        over: { kind: 'options', question_id: Q.q5 },
        where: b.itemAttr('code', 'discontinued'),
      }),
      resolved: items,
    };
    expect(evalExpr(discontinued, envOf({}))).toEqual(num(1));

    const highCodes = {
      ...b.agg({
        fn: 'count',
        over: { kind: 'options', question_id: Q.q5 },
        where: b.cmp('>', b.itemAttr('code'), b.numLit(50)),
      }),
      resolved: items,
    };
    expect(evalExpr(highCodes, envOf({}))).toEqual(num(1));
  });

  it("item.position reads the randomizer's order, not the canonical one (ADR-006)", () => {
    const b = astBuilder();
    const items = E.groupItems({ kind: 'options', question_id: Q.q5 });
    const firstShown = {
      ...b.agg({
        fn: 'count',
        over: { kind: 'options', question_id: Q.q5 },
        where: b.cmp('==', b.itemAttr('position'), b.numLit(0)),
        select: b.itemAttr('code'),
      }),
      resolved: items,
    };
    // Canonically code 1 is first; the randomizer put 99 first for this session.
    const shuffled = envOf({}, {}, { orders: { [`${Q.q5}.options`]: [99, 3, 2, 1] } });
    const value = evalExpr({ ...firstShown, fn: 'max' }, shuffled);
    expect(value).toEqual(num(99));
  });

  describe('null modes', () => {
    const members: readonly Value[] = [num(1), NULL, num(3)];

    it("'skip' is the default and excludes nulls, SQL-style", () => {
      expect(aggregate('count', members, 'skip')).toEqual(num(2));
      expect(aggregate('sum', members, 'skip')).toEqual(num(4));
      expect(aggregate('mean', members, 'skip')).toEqual(num(2));
    });

    it('sum of an all-null group is null, not 0', () => {
      expect(aggregate('sum', [NULL, NULL], 'skip')).toBe(NULL);
      expect(aggregate('count', [NULL, NULL], 'skip')).toEqual(num(0));
    });

    it("'as_zero' is the opt-in for sum-to-100 checks", () => {
      expect(aggregate('sum', members, 'as_zero')).toEqual(num(4));
      expect(aggregate('count', members, 'as_zero')).toEqual(num(3));
      expect(aggregate('all', [TRUE, NULL], 'as_zero')).toBe(FALSE);
    });

    it("'propagate' nulls the whole aggregate — for \"all rows must be answered\"", () => {
      expect(aggregate('sum', members, 'propagate')).toBe(NULL);
      expect(aggregate('count', members, 'propagate')).toBe(NULL);
      expect(aggregate('all', [TRUE, NULL], 'propagate')).toBe(NULL);
    });

    it('ANY and ALL fold through Kleene, so an unknown member is visible under skip', () => {
      expect(aggregate('any', [FALSE, TRUE], 'skip')).toBe(TRUE);
      expect(aggregate('all', [TRUE, TRUE], 'skip')).toBe(TRUE);
      expect(aggregate('all', [TRUE, NULL], 'skip')).toBe(TRUE); // the null is skipped
    });

    it('MIN, MAX, DISTINCT_COUNT, STDEV, FIRST/LAST_ANSWERED', () => {
      expect(aggregate('min', [num(5), num(2)], 'skip')).toEqual(num(2));
      expect(aggregate('max', [num(5), num(2)], 'skip')).toEqual(num(5));
      expect(aggregate('distinct_count', [num(5), num(5), num(2)], 'skip')).toEqual(num(2));
      expect(aggregate('stdev', [num(2), num(4), num(4), num(4), num(5), num(5), num(7), num(9)], 'skip')).toEqual(
        num(Math.sqrt(32 / 7)),
      );
      expect(aggregate('stdev', [num(1)], 'skip')).toBe(NULL);
      expect(aggregate('first_answered', [NULL, num(7), num(8)], 'skip')).toEqual(num(7));
      expect(aggregate('last_answered', [NULL, num(7), num(8)], 'skip')).toEqual(num(8));
      expect(aggregate('min', [], 'skip')).toBe(NULL);
    });
  });

  it('an item whose `where` is unknown is excluded, the same direction a mask takes', () => {
    const b = astBuilder();
    const items = E.groupItems({ kind: 'question_emits', question_id: Q.q5 });
    const count = {
      ...b.agg({ fn: 'count', over: { kind: 'question_emits', question_id: Q.q5 }, where: b.itemAttr('selected') }),
      resolved: items,
    };
    // Only r1 is answered; r2, r3 and r99 are unknown and must not be counted.
    expect(evalExpr(count, envOf({ [V.q5r1]: TRUE }))).toEqual(num(1));
  });
});

describe('memoization (D §5.4)', () => {
  it('does not memoize across items, or every aggregation returns the first item repeated', () => {
    const b = astBuilder();
    const items = E.groupItems({ kind: 'options', question_id: Q.q5 });
    const distinctCodes = {
      ...b.agg({
        fn: 'distinct_count',
        over: { kind: 'options', question_id: Q.q5 },
        select: b.itemAttr('code'),
      }),
      resolved: items,
    };
    const memo = {
      epoch: 0,
      cells: [],
      memoStamp: new Int32Array(64).fill(-1),
      memoSlot: new Array<Value | undefined>(64).fill(undefined),
      fallbacks: new Map<number, never>(),
    };
    expect(evalExpr(distinctCodes, { ...envOf({}), memo })).toEqual(num(4));
  });

  it('reuses a shared subexpression within one epoch', () => {
    let reads = 0;
    const b = astBuilder();
    const shared = b.variable(V.age);
    const expr = b.and(b.cmp('>', shared, b.numLit(1)), b.cmp('<', shared, b.numLit(99)));
    const memo = {
      epoch: 1,
      cells: [],
      memoStamp: new Int32Array(64).fill(-1),
      memoSlot: new Array<Value | undefined>(64).fill(undefined),
      fallbacks: new Map<number, never>(),
    };
    const counting: ExprEnv = {
      ...envOf({}),
      vars: {
        value: (id) => {
          if (id === V.age) reads += 1;
          return num(30);
        },
      },
      memo,
    };
    expect(evalCondition(expr, counting)).toBe('T');
    expect(reads).toBe(1);
  });
});

describe('the value model (D §2.2)', () => {
  it('interns null and the booleans, because they dominate a condition tree', () => {
    expect(bool(true)).toBe(TRUE);
    expect(bool(false)).toBe(FALSE);
  });

  it('rejects a non-finite number at construction', () => {
    expect(() => num(Number.NaN)).toThrow(LogicInvariant);
    expect(() => num(Number.POSITIVE_INFINITY)).toThrow(LogicInvariant);
  });

  it('normalizes sets: sorted and deduped', () => {
    expect(setValue([3, 1, 1, 2], DOM.q5)).toEqual({ k: 'set', v: [1, 2, 3], d: DOM.q5 });
  });

  it('an enum of the same code in a different domain is a different value', () => {
    const a = enumValue(1, DOM.q5);
    const bValue = enumValue(1, DOM.brand);
    expect(a).not.toEqual(bValue);
  });
});

describe('the registry projection', () => {
  it('resolves matrix and explicit groups, and reports an unknown variable as a bare item', () => {
    const unknown = asVariableId('var_missing');
    const items = E.groupItems({ kind: 'explicit', variable_ids: [V.age, unknown] });
    expect(items).toHaveLength(2);
    expect(items[1]?.variable_id).toBe(unknown);
  });

  it('types an enum variable with no domain as never rather than crashing', () => {
    const broken = buildTypeEnv({
      variables: [
        { id: V.brand, name: 'BROKEN', kind: 'response', type: 'enum', persist: true, pii: false },
      ],
      domains: [],
    });
    const decl = broken.byId(V.brand);
    expect(decl).toBeDefined();
    expect(decl === undefined ? undefined : broken.typeOf(decl)).toEqual({ k: 'never' });
  });

  it('exposes the option label keys the evaluator needs for label_of', () => {
    const schema = buildEvalSchema(E);
    expect(schema.labelKey(DOM.q5, 1)).toBe('q5.apple');
    expect(schema.labelKey(asDomainId('dom_absent'), 1)).toBeUndefined();
    expect(schema.ownerQuestion(V.q5r1)).toBe(Q.q5);
    expect(schema.pageOf(Q.q12)).toBe(P.p2);
    expect(EMPTY_SCHEMA.declaredVisible(Q.q12)).toBe(true);
  });

  it('carries option metadata and ids through to resolved group items', () => {
    const items = E.groupItems({ kind: 'options', question_id: Q.q5 });
    expect(items[2]).toMatchObject({ option_id: OPT.q5_3, code: 3, domain: DOM.q5, meta: { discontinued: true } });
    expect(registryInput().variables.length).toBeGreaterThan(10);
  });
});
