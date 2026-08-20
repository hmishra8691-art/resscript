/**
 * The type checker, one test per diagnostic it can emit (D §3.5).
 *
 * The reason for the shape of this file: a checker's value is entirely in what it *rejects*, and
 * a test suite that only feeds it well-typed input measures nothing. So every code in the
 * catalogue that the checker is responsible for gets a fixture that must produce it, by code —
 * plus the negative case, because a checker that rejects everything is also useless.
 */

import { describe, expect, it } from 'vitest';
import { astBuilder } from './build.js';
import { DOM, OPT, P, Q, V, env, rule } from './__fixtures__/survey.js';
import { checkExpr, checkRule, constantVerdict, mayBeUnknown, regexDiagnosis, unify } from './check.js';
import { LGC_DIAGNOSTIC_CODES, LGC_SEVERITY, type LgcCode, type LgcDiagnostic } from './diagnostics.js';
import { asQuestionId, asVariableId } from './ids.js';
import { T_NEVER, T_NUM, T_TEXT, type Expr } from './ast.js';

const E = env();

function codes(diagnostics: readonly LgcDiagnostic[]): readonly LgcCode[] {
  return diagnostics.map((d) => d.code);
}

function checkOf(expr: Expr): readonly LgcCode[] {
  return codes(checkExpr(expr, E).diagnostics);
}

describe('well-typed expressions produce no diagnostics', () => {
  it('accepts the D §9.2 screener condition', () => {
    const b = astBuilder();
    const condition = b.and(
      b.setOp('contains', b.variable(V.q5set), b.enumLit(1, DOM.q5)),
      b.cmp('>', b.variable(V.q6), b.numLit(10)),
      b.or(
        b.cmp('==', b.variable(V.s1), b.enumLit(1, DOM.s1)),
        b.and(
          b.cmp(
            '>=',
            b.agg({
              fn: 'count',
              over: { kind: 'question_emits', question_id: Q.q5 },
              where: b.itemAttr('selected'),
            }),
            b.numLit(3),
          ),
          b.setOp('none_of', b.variable(V.q5set), b.setLit([99], DOM.q5)),
        ),
      ),
      b.not(b.cmp('<', b.variable(V.age), b.numLit(18))),
    );
    const result = checkExpr(condition, E);
    expect(result.diagnostics).toEqual([]);
    expect(result.type).toEqual({ k: 'bool' });
  });

  it('annotates every node with its type', () => {
    const b = astBuilder();
    const result = checkExpr(b.cmp('>', b.variable(V.q6), b.numLit(10)), E);
    expect(result.expr.t).toEqual({ k: 'bool' });
    const args = (result.expr as { readonly args: readonly Expr[] }).args;
    expect(args[0]?.t).toEqual({ k: 'num' });
    expect(args[1]?.t).toEqual({ k: 'num' });
  });

  it('resolves an aggregation group onto the node, so the evaluator needs no registry', () => {
    const b = astBuilder();
    const result = checkExpr(
      b.agg({ fn: 'count', over: { kind: 'question_emits', question_id: Q.q5 } }),
      E,
    );
    expect(result.expr.op).toBe('agg');
    expect((result.expr as { readonly resolved?: readonly unknown[] }).resolved).toHaveLength(4);
  });
});

describe('LGC-T001 — unknown variable', () => {
  it('rejects a variable id that is not in the registry', () => {
    const b = astBuilder();
    expect(checkOf(b.variable(asVariableId('var_nope')))).toContain('LGC-T001');
  });
});

describe('LGC-T002 — unknown AST kind', () => {
  it('rejects a node whose op is not in AST_KINDS', () => {
    const bogus = { n: 1, op: 'frobnicate', args: [] } as unknown as Expr;
    expect(checkOf(bogus)).toContain('LGC-T002');
  });
});

describe('LGC-T003 — incompatible comparison', () => {
  it('rejects `Q1 == "yes"`: an option-bearing question stores codes, not labels', () => {
    // D §3.4 worked example. Labels are translated, so a label match breaks in every non-base
    // language — this is never coerced in either direction.
    const b = astBuilder();
    const diagnostics = checkExpr(b.cmp('==', b.variable(V.s1), b.textLit('yes')), E).diagnostics;
    expect(codes(diagnostics)).toContain('LGC-T003');
    expect(diagnostics[0]?.message).toContain('integer codes, not labels');
  });

  it('rejects `<` on text', () => {
    const b = astBuilder();
    expect(checkOf(b.cmp('<', b.variable(V.openEnd), b.textLit('m')))).toContain('LGC-T003');
  });

  it('accepts a comparison against null, because every type is nullable', () => {
    const b = astBuilder();
    expect(checkOf(b.cmp('==', b.variable(V.s1), b.nullLit()))).toEqual([]);
  });
});

describe('LGC-T007 — enum comparison across domains', () => {
  it('rejects comparing two questions whose codes merely overlap', () => {
    const b = astBuilder();
    const diagnostics = checkExpr(b.cmp('==', b.variable(V.scale), b.variable(V.brand)), E).diagnostics;
    expect(codes(diagnostics)).toContain('LGC-T007');
    expect(diagnostics[0]?.message).toContain('nominal');
    expect(diagnostics[0]?.detail).toMatchObject({ left_domain: DOM.scale, right_domain: DOM.brand });
  });

  it('suggests the CODE() escape, which is the deliberate way to say "I mean the number"', () => {
    const b = astBuilder();
    const diagnostics = checkExpr(b.cmp('==', b.variable(V.scale), b.variable(V.brand)), E).diagnostics;
    expect(diagnostics[0]?.message).toContain('CODE(');
    // And the escape itself type-checks.
    const b2 = astBuilder();
    expect(checkOf(b2.cmp('==', b2.cast('num', b2.variable(V.scale)), b2.cast('num', b2.variable(V.brand))))).toEqual(
      [],
    );
  });
});

describe('LGC-T009 — ordered comparison on a nominal domain', () => {
  it('rejects `<` on a brand list — the "top 2 box on a brand list" bug', () => {
    const b = astBuilder();
    const diagnostics = checkExpr(b.cmp('<', b.variable(V.brand), b.enumLit(2, DOM.brand)), E).diagnostics;
    expect(codes(diagnostics)).toContain('LGC-T009');
    expect(diagnostics[0]?.message).toContain('top 2 box');
  });

  it('accepts `<` on a Likert scale, because the domain is declared ordinal', () => {
    const b = astBuilder();
    expect(checkOf(b.cmp('<', b.variable(V.scale), b.enumLit(3, DOM.scale)))).toEqual([]);
  });

  it('rejects MIN over a nominal enum for the same reason', () => {
    const b = astBuilder();
    const agg = b.agg({
      fn: 'min',
      over: { kind: 'explicit', variable_ids: [V.brand] },
    });
    expect(checkOf(agg)).toContain('LGC-T009');
  });
});

describe('LGC-T004, T005, T008, T010, T011 — operand kinds', () => {
  const b = astBuilder();
  it('AND needs booleans', () => {
    expect(checkOf(b.and(b.variable(V.q6), b.boolLit(true)))).toContain('LGC-T004');
  });
  it('arithmetic needs numbers', () => {
    expect(checkOf(b.binArith('+', b.variable(V.openEnd), b.numLit(1)))).toContain('LGC-T005');
  });
  it('string operations need text', () => {
    expect(checkOf(b.strUnary('upper', b.variable(V.q6)))).toContain('LGC-T008');
  });
  it('date operations need dates', () => {
    expect(checkOf(b.datePart('year', b.variable(V.q6)))).toContain('LGC-T010');
  });
  it('set operations need sets', () => {
    expect(checkOf(b.setOp('contains', b.variable(V.q6), b.enumLit(1, DOM.q5)))).toContain('LGC-T011');
  });
});

describe('LGC-T006 — arity', () => {
  it('rejects a one-operand AND', () => {
    const bogus = { n: 1, op: 'and', args: [{ n: 2, op: 'lit', v: { k: 'bool', v: true } }] } as unknown as Expr;
    expect(checkOf(bogus)).toContain('LGC-T006');
  });
  it('rejects a three-operand comparison', () => {
    const b = astBuilder();
    const bogus = {
      n: 99,
      op: '==',
      args: [b.numLit(1), b.numLit(2), b.numLit(3)],
    } as unknown as Expr;
    expect(checkOf(bogus)).toContain('LGC-T006');
  });
});

describe('LGC-T012 — item outside an aggregation', () => {
  it('rejects a bare `item`', () => {
    const b = astBuilder();
    expect(checkOf(b.item())).toContain('LGC-T012');
  });
  it('rejects a bare `item_attr`', () => {
    const b = astBuilder();
    expect(checkOf(b.itemAttr('code'))).toContain('LGC-T012');
  });
  it('accepts them inside an aggregation predicate', () => {
    const b = astBuilder();
    const agg = b.agg({
      fn: 'count',
      over: { kind: 'options', question_id: Q.q5 },
      where: b.cmp('>', b.itemAttr('code'), b.numLit(0)),
    });
    expect(checkOf(agg)).toEqual([]);
  });
});

describe('LGC-T013 — item meta', () => {
  it('rejects a meta key no item in the group declares', () => {
    const b = astBuilder();
    const agg = b.agg({
      fn: 'count',
      over: { kind: 'options', question_id: Q.q5 },
      where: b.itemAttr('code', 'nonexistent'),
    });
    expect(checkOf(agg)).toContain('LGC-T013');
  });

  it('infers a declared meta key from the group and accepts it', () => {
    const b = astBuilder();
    const agg = b.agg({
      fn: 'count',
      over: { kind: 'options', question_id: Q.q5 },
      where: b.itemAttr('code', 'discontinued'),
    });
    expect(checkOf(agg)).toEqual([]);
  });

  it('rejects a meta key whose type differs across items in the group', () => {
    const inconsistent = env({
      questions: [
        {
          id: Q.q5,
          ref: 'Q5',
          required: false,
          domain: DOM.q5,
          options: [
            { option_id: OPT.q5_1, code: 1, label_key: 'a', position: 0, meta: { tier: 1 } },
            { option_id: OPT.q5_2, code: 2, label_key: 'b', position: 1, meta: { tier: 'premium' } },
          ],
          rows: [],
          columns: [],
          emits: [],
        },
      ],
    });
    const b = astBuilder();
    const agg = b.agg({
      fn: 'count',
      over: { kind: 'options', question_id: Q.q5 },
      where: b.itemAttr('code', 'tier'),
    });
    expect(codes(checkExpr(agg, inconsistent).diagnostics)).toContain('LGC-T013');
  });
});

describe('LGC-T014 / T015 — branch unification', () => {
  it('rejects a CASE whose branches return different types — the schema §19 AGE_BAND defect', () => {
    // D §11 note 1: AGE_BAND is declared enum but its branches yield text literals. Under strict
    // unification that is an error, not a stringly-typed union.
    const b = astBuilder();
    const caseExpr = b.caseExpr(
      [
        { when: b.cmp('<', b.variable(V.age), b.numLit(25)), then: b.numLit(1) },
        { when: b.cmp('<', b.variable(V.age), b.numLit(35)), then: b.textLit('25_34') },
      ],
      b.numLit(3),
    );
    expect(checkOf(caseExpr)).toContain('LGC-T014');
  });

  it('accepts a CASE whose branches agree, and types it as that type', () => {
    const b = astBuilder();
    const caseExpr = b.caseExpr(
      [{ when: b.cmp('<', b.variable(V.age), b.numLit(35)), then: b.textLit('young') }],
      b.textLit('old'),
    );
    const result = checkExpr(caseExpr, E);
    expect(result.diagnostics).toEqual([]);
    expect(result.type).toEqual(T_TEXT);
  });

  it('treats a null branch as compatible with anything', () => {
    const b = astBuilder();
    const caseExpr = b.caseExpr([{ when: b.boolLit(true), then: b.nullLit() }], b.numLit(3));
    const result = checkExpr(caseExpr, E);
    expect(result.diagnostics).toEqual([]);
    expect(result.type).toEqual(T_NUM);
  });

  it('rejects a COALESCE over incompatible types', () => {
    const b = astBuilder();
    expect(checkOf(b.coalesce(b.variable(V.q6), b.variable(V.openEnd)))).toContain('LGC-T015');
  });
});

describe('LGC-T016 — probe target', () => {
  it('rejects a probe on a question that does not exist', () => {
    const b = astBuilder();
    expect(checkOf(b.probe('shown', { kind: 'question', id: asQuestionId('qst_ghost') }))).toContain('LGC-T016');
  });
  it('accepts a probe on a real question', () => {
    const b = astBuilder();
    expect(checkOf(b.probe('shown', { kind: 'question', id: Q.q12 }))).toEqual([]);
  });
});

describe('LGC-T018 — empty aggregation group', () => {
  it('rejects an aggregation whose group resolves to nothing', () => {
    const b = astBuilder();
    const agg = b.agg({ fn: 'count', over: { kind: 'question_emits', question_id: Q.q12 } });
    expect(checkOf(agg)).toContain('LGC-T018');
  });
});

describe('LGC-T019 — aggregation element type', () => {
  it('rejects SUM over booleans', () => {
    const b = astBuilder();
    const agg = b.agg({ fn: 'sum', over: { kind: 'question_emits', question_id: Q.q5 } });
    expect(checkOf(agg)).toContain('LGC-T019');
  });
  it('rejects ALL over numbers', () => {
    const b = astBuilder();
    const agg = b.agg({ fn: 'all', over: { kind: 'explicit', variable_ids: [V.q6] } });
    expect(checkOf(agg)).toContain('LGC-T019');
  });
  it('accepts ALL over the boolean fan-out of a multi-select', () => {
    const b = astBuilder();
    const agg = b.agg({ fn: 'all', over: { kind: 'question_emits', question_id: Q.q5 } });
    expect(checkOf(agg)).toEqual([]);
  });
});

describe('LGC-T021 — set element domain', () => {
  it('rejects `Q5 CONTAINS "apple"` — the D §9.1 worked example', () => {
    const b = astBuilder();
    const diagnostics = checkExpr(b.setOp('contains', b.variable(V.q5set), b.textLit('apple')), E).diagnostics;
    expect(codes(diagnostics)).toContain('LGC-T021');
    expect(diagnostics[0]?.message).toContain('labels are translated');
  });

  it('rejects a set literal from another domain', () => {
    const b = astBuilder();
    expect(checkOf(b.setOp('any_of', b.variable(V.q5set), b.setLit([1], DOM.brand)))).toContain('LGC-T021');
  });

  it('rejects an enum element from another domain', () => {
    const b = astBuilder();
    expect(checkOf(b.setOp('contains', b.variable(V.q5set), b.enumLit(1, DOM.brand)))).toContain('LGC-T021');
  });
});

describe('LGC-T025 — regex safety', () => {
  it('rejects a pattern that does not compile', () => {
    const b = astBuilder();
    expect(checkOf(b.matches(b.variable(V.openEnd), '([a-'))).toContain('LGC-T025');
  });

  it('rejects a nested quantifier, which can backtrack exponentially', () => {
    expect(regexDiagnosis('(a+)+$')).toContain('backtrack');
  });

  it('rejects the g and y flags, because they make a RegExp stateful through lastIndex', () => {
    // A cached global regex returns different answers for identical inputs on successive calls —
    // exactly the impurity ADR-004's divergence detector exists to catch.
    expect(regexDiagnosis('a', 'g')).toContain('stateful');
    expect(regexDiagnosis('a', 'y')).toContain('stateful');
    expect(regexDiagnosis('a', 'i')).toBeUndefined();
    expect(regexDiagnosis('a', 'z')).toContain('unsupported');
  });

  it('accepts ordinary patterns, including a quantified group with no inner quantifier', () => {
    expect(regexDiagnosis('^\\d{3}-\\d{4}$')).toBeUndefined();
    expect(regexDiagnosis('(ab|cd)*')).toBeUndefined();
    expect(regexDiagnosis('[a+]+')).toBeUndefined();
  });
});

describe('rule-level checks', () => {
  const b = astBuilder();

  it('LGC-T030 — rejects SET on a response variable', () => {
    const result = checkRule(
      rule({
        id: 'rul_t030',
        kind: 'set_variable',
        target: { type: 'variable', id: V.age },
        condition: b.boolLit(true),
        effect: { action: 'set', variable_id: V.age, value: astBuilder().numLit(1) },
        order_key: 1,
      }),
      E,
    );
    expect(codes(result.diagnostics)).toContain('LGC-T030');
  });

  it('LGC-T030 — rejects SET on a system variable', () => {
    const local = astBuilder();
    const result = checkRule(
      rule({
        id: 'rul_t030b',
        kind: 'set_variable',
        target: { type: 'variable', id: V.serverTime },
        condition: local.boolLit(true),
        effect: { action: 'set', variable_id: V.serverTime, value: local.dateLit('2026-01-01') },
        order_key: 1,
      }),
      E,
    );
    expect(codes(result.diagnostics)).toContain('LGC-T030');
  });

  it('LGC-T031 — rejects a SET whose value type does not match the target', () => {
    const local = astBuilder();
    const result = checkRule(
      rule({
        id: 'rul_t031',
        kind: 'set_variable',
        target: { type: 'variable', id: V.segment },
        condition: local.boolLit(true),
        effect: { action: 'set', variable_id: V.segment, value: local.numLit(1) },
        order_key: 1,
      }),
      E,
    );
    expect(codes(result.diagnostics)).toContain('LGC-T031');
  });

  it('LGC-T032 — rejects a mask with no fallback.when_empty', () => {
    const local = astBuilder();
    const result = checkRule(
      rule({
        id: 'rul_t032',
        kind: 'mask',
        target: { type: 'question', id: Q.q5 },
        condition: local.boolLit(true),
        effect: {
          action: 'mask',
          applies_to: 'options',
          mode: 'include',
          per_item: local.boolLit(true),
          fallback: {} as never,
        },
        order_key: 1,
      }),
      E,
    );
    expect(codes(result.diagnostics)).toContain('LGC-T032');
  });

  it('LGC-T033 — rejects a non-boolean condition: there is no implicit truthiness', () => {
    const local = astBuilder();
    const result = checkRule(
      rule({
        id: 'rul_t033',
        kind: 'display',
        target: { type: 'question', id: Q.q12 },
        condition: local.variable(V.q6),
        effect: { action: 'show' },
        order_key: 1,
      }),
      E,
    );
    expect(codes(result.diagnostics)).toContain('LGC-T033');
  });

  it('LGC-T034 — rejects a display rule targeting an option', () => {
    const local = astBuilder();
    const result = checkRule(
      rule({
        id: 'rul_t034',
        kind: 'display',
        target: { type: 'option', id: OPT.q5_1 },
        condition: local.boolLit(true),
        effect: { action: 'show' },
        order_key: 1,
      }),
      E,
    );
    expect(codes(result.diagnostics)).toContain('LGC-T034');
  });

  it('LGC-I002 — notes every ON UNKNOWN override so a reviewer sees it', () => {
    const local = astBuilder();
    const result = checkRule(
      rule({
        id: 'rul_i002',
        kind: 'display',
        target: { type: 'question', id: Q.q12 },
        condition: local.cmp('>', local.variable(V.q9), local.numLit(3)),
        effect: { action: 'show' },
        order_key: 1,
        on_unknown: 'fire',
      }),
      E,
    );
    expect(codes(result.diagnostics)).toContain('LGC-I002');
    expect(LGC_SEVERITY['LGC-I002']).toBe('info');
  });

  it('LGC-W030 — flags a condition left as TRUE after a debugging session', () => {
    const local = astBuilder();
    const result = checkRule(
      rule({
        id: 'rul_w030',
        kind: 'display',
        target: { type: 'question', id: Q.q12 },
        condition: local.boolLit(true),
        effect: { action: 'show' },
        order_key: 1,
      }),
      E,
    );
    expect(codes(result.diagnostics)).toContain('LGC-W030');
  });

  it('checks the per-item condition of a mask with `item` bound', () => {
    const local = astBuilder();
    const result = checkRule(
      rule({
        id: 'rul_mask_ok',
        kind: 'mask',
        target: { type: 'question', id: Q.q5 },
        condition: local.boolLit(true),
        effect: {
          action: 'mask',
          applies_to: 'options',
          mode: 'include',
          per_item: local.cmp('<', local.itemAttr('code'), local.numLit(50)),
          fallback: { when_empty: 'show_all' },
        },
        order_key: 1,
      }),
      E,
    );
    // W030 is expected (the rule's own condition is constant TRUE); nothing else should fire.
    expect(codes(result.diagnostics)).toEqual(['LGC-W030']);
  });
});

describe('LGC-W021 — a terminate rule that can be UNKNOWN', () => {
  it('warns on an unguarded terminate condition', () => {
    const b = astBuilder();
    const result = checkRule(
      rule({
        id: 'rul_w021',
        kind: 'terminate',
        target: { type: 'survey' },
        condition: b.cmp('<', b.variable(V.age), b.numLit(18)),
        effect: { action: 'terminate', disposition: 'SCREENOUT' },
        order_key: 1,
      }),
      E,
    );
    expect(codes(result.diagnostics)).toContain('LGC-W021');
  });

  it('does not warn when the author eliminated the unknown with ANSWERED — the preferred form', () => {
    // D §2.5 recommends `IF ANSWERED(Q9) AND Q9 > 3` over an ON UNKNOWN override. A warning that
    // fired on the recommended form would train authors to ignore it.
    const b = astBuilder();
    const result = checkRule(
      rule({
        id: 'rul_w021_guarded',
        kind: 'terminate',
        target: { type: 'survey' },
        condition: b.and(
          b.probe('answered', { kind: 'variable', id: V.age }),
          b.cmp('<', b.variable(V.age), b.numLit(18)),
        ),
        effect: { action: 'terminate', disposition: 'SCREENOUT' },
        order_key: 1,
      }),
      E,
    );
    expect(codes(result.diagnostics)).not.toContain('LGC-W021');
  });

  it('mayBeUnknown is a sound over-approximation', () => {
    const b = astBuilder();
    expect(mayBeUnknown(b.probe('answered', { kind: 'page', id: P.p1 }), E)).toBe(false);
    expect(mayBeUnknown(b.boolLit(true), E)).toBe(false);
    expect(mayBeUnknown(b.nullLit(), E)).toBe(true);
    expect(mayBeUnknown(b.variable(V.age), E)).toBe(true);
  });
});

describe('helpers the checker exposes', () => {
  it('unify treats null as compatible and never as quiet', () => {
    expect(unify(T_NUM, T_NUM)).toEqual(T_NUM);
    expect(unify(T_NEVER, T_NUM)).toEqual(T_NUM);
    expect(unify({ k: 'null' }, T_TEXT)).toEqual(T_TEXT);
    expect(unify(T_NUM, T_TEXT)).toBeUndefined();
  });

  it('constantVerdict only answers when no state is read', () => {
    const b = astBuilder();
    expect(constantVerdict(b.boolLit(false))).toBe('false');
    expect(constantVerdict(b.variable(V.age))).toBeUndefined();
    expect(constantVerdict(b.probe('answered', { kind: 'variable', id: V.age }))).toBeUndefined();
  });

  it('every catalogue code has a severity, and codes are never re-used', () => {
    const all = Object.keys(LGC_DIAGNOSTIC_CODES) as readonly LgcCode[];
    expect(new Set(all).size).toBe(all.length);
    for (const code of all) expect(LGC_SEVERITY[code]).toBeDefined();
  });
});
