/**
 * The single coercion point — D §2.5's rule-boundary table.
 *
 * This file contains the test the P1-06 acceptance criteria name explicitly:
 *
 *   "A rule reading a question the respondent never saw evaluates to `U`, and `NOT` of it stays
 *    `U`, so a 'terminate under-18' rule does **not** fire for a respondent who never saw the age
 *    question — asserted as a named test."
 *
 * Everything else here enforces the rest of that table, one row per `it`, plus the property that
 * makes the table meaningful: **three-valued logic never leaves the expression layer.** Every cell
 * in a verdict is two-valued, because the collapse happened exactly once on the way in.
 */

import { describe, expect, it } from 'vitest';
import { astBuilder } from './build.js';
import { DOM, OPT, P, Q, V, env, rule } from './__fixtures__/survey.js';
import { compileLogic } from './compile.js';
import { evaluate } from './engine.js';
import { checkExpr } from './check.js';
import { evalCondition, NO_CELLS, type ExprEnv } from './evaluator.js';
import { buildEvalSchema } from './compile.js';
import { errorsOnly } from './diagnostics.js';
import { asFlowNodeId } from './ids.js';
import { varStateOf } from './state.js';
import { FALSE, NULL, TRUE, num, setValue, text, type Value } from './value.js';
import type { Rule } from './rules.js';

const E = env();

function exprEnv(values: { readonly [id: string]: Value }): ExprEnv {
  return { vars: varStateOf(values), ctx: {}, cells: NO_CELLS, schema: buildEvalSchema(E) };
}

function run(rules: readonly Rule[], values: { readonly [id: string]: Value } = {}) {
  const program = compileLogic(rules, E);
  expect(errorsOnly(program.diagnostics)).toEqual([]);
  return evaluate(program, varStateOf(values), {});
}

/* ========================================================================== */

function terminateUnder18(onUnknown?: 'fire'): Rule {
  const b = astBuilder();
  return rule({
    id: 'rul_screen_age',
    kind: 'terminate',
    target: { type: 'survey' },
    condition: b.cmp('<', b.variable(V.age), b.numLit(18)),
    effect: { action: 'terminate', disposition: 'SCREENOUT' },
    order_key: 10,
    label: 'Terminate under-18',
    ...(onUnknown === undefined ? {} : { on_unknown: onUnknown }),
  });
}

describe('the canonical failure: terminate under-18 for a respondent who never saw the age question', () => {
  it('does NOT fire when AGE was never asked (P1-06 acceptance criterion)', () => {
    // This is the incident every survey platform has a version of: the condition coerces to
    // false-or-true at read time, a thousand respondents get screened out, and the client's
    // sample is gone. Under Kleene semantics the condition is UNKNOWN, and `terminate` collapses
    // UNKNOWN to "do not fire".
    const verdict = run([terminateUnder18()], {});
    expect(verdict.termination).toBeUndefined();
  });

  it('the condition itself is U, not false — the distinction is the whole point', () => {
    const b = astBuilder();
    const under18 = b.cmp('<', b.variable(V.age), b.numLit(18));
    expect(evalCondition(under18, exprEnv({}))).toBe('U');
  });

  it('NOT of it stays U, so double negation cannot smuggle the termination back in', () => {
    const b = astBuilder();
    const notUnder18 = b.not(b.cmp('<', b.variable(V.age), b.numLit(18)));
    expect(evalCondition(notUnder18, exprEnv({}))).toBe('U');
    // Under coercion-at-read-time this would be `NOT(0 < 18)` = false, and an "adult only" gate
    // built on it would silently admit nobody.
    expect(evalCondition(b.not(notUnder18), exprEnv({}))).toBe('U');
  });

  it('the trace records the collapse, so a reviewer can see why it did not fire', () => {
    const program = compileLogic([terminateUnder18()], E);
    const verdict = evaluate(program, varStateOf({}), {});
    const entry = verdict.trace.find((t) => t.cell.startsWith('terminate('));
    expect(entry?.writers[0]).toMatchObject({
      verdict: 'U',
      collapsed: { from: 'U', to: false, reason: 'kind=terminate, no ON UNKNOWN override' },
    });
  });

  it('fires for a respondent who did answer and is under 18', () => {
    const verdict = run([terminateUnder18()], { [V.age]: num(16) });
    expect(verdict.termination).toMatchObject({ disposition: 'SCREENOUT' });
  });

  it('does not fire for a respondent who answered and is over 18', () => {
    expect(run([terminateUnder18()], { [V.age]: num(44) }).termination).toBeUndefined();
  });

  it('fires on UNKNOWN only when the author explicitly asked for it (ON UNKNOWN)', () => {
    // The override exists because "show unless proven ineligible" is a legitimate pattern, and an
    // override the author wrote is far better than an author discovering the default and working
    // around it with double negation.
    const verdict = run([terminateUnder18('fire')], {});
    expect(verdict.termination).toMatchObject({ disposition: 'SCREENOUT' });
  });
});

describe('the collapse direction, per rule kind (D §2.5)', () => {
  it('display: U does not fire, so the target keeps its declared default', () => {
    const b = astBuilder();
    const show = rule({
      id: 'rul_show',
      kind: 'display',
      target: { type: 'question', id: Q.q12 },
      condition: b.cmp('>', b.variable(V.q9), b.numLit(3)),
      effect: { action: 'show' },
      order_key: 1,
    });
    // A question with a SHOW rule is base-hidden, so an unknown condition leaves it hidden.
    expect(run([show], {}).visible(Q.q12)).toBe(false);
    expect(run([show], { [V.q9]: num(5) }).visible(Q.q12)).toBe(true);
    expect(run([show], { [V.q9]: num(1) }).visible(Q.q12)).toBe(false);
  });

  it('display: a HIDE rule on an unknown condition does not hide', () => {
    const b = astBuilder();
    const hide = rule({
      id: 'rul_hide',
      kind: 'display',
      target: { type: 'question', id: Q.q12 },
      condition: b.cmp('>', b.variable(V.q9), b.numLit(3)),
      effect: { action: 'hide' },
      order_key: 1,
    });
    expect(run([hide], {}).visible(Q.q12)).toBe(true);
    expect(run([hide], { [V.q9]: num(5) }).visible(Q.q12)).toBe(false);
  });

  it('validate: U **passes** — blocking a respondent on an unknown is an unrecoverable dead end', () => {
    const b = astBuilder();
    const validate = rule({
      id: 'rul_validate',
      kind: 'validate',
      target: { type: 'question', id: Q.q6 },
      // The condition of a validate rule IS the requirement (`VALIDATE REQUIRE expr`, D §6.2), so
      // "the safe direction" is the requirement holding, which is `true`. This is the one effect
      // whose unknowns fall the other way, and getting it backwards means a respondent sees an
      // error they cannot clear.
      condition: b.cmp('>', b.variable(V.q6), b.numLit(0)),
      effect: { action: 'require_valid', message_key: 'err.positive', scope: 'field' },
      order_key: 1,
    });
    expect(run([validate], {}).validations).toEqual([]);
    expect(run([validate], { [V.q6]: num(5) }).validations).toEqual([]);
    expect(run([validate], { [V.q6]: num(0) }).validations).toEqual([
      { rule_id: 'rul_validate', message_key: 'err.positive', scope: 'field', target: Q.q6 },
    ]);
  });

  it('set_variable: U assigns null rather than fabricating a value', () => {
    const b = astBuilder();
    const set = rule({
      id: 'rul_set',
      kind: 'set_variable',
      target: { type: 'variable', id: V.segment },
      condition: b.cmp('<', b.variable(V.age), b.numLit(35)),
      effect: { action: 'set', variable_id: V.segment, value: b.textLit('young') },
      order_key: 1,
    });
    // Not "left alone" and not "young": null. Fabricating a value here is how bad data is born —
    // a hidden segment silently set for everyone who skipped the question is indistinguishable
    // from a real answer in the export.
    expect(run([set], {}).value(V.segment)).toBe(NULL);
    expect(run([set], { [V.age]: num(20) }).value(V.segment)).toEqual(text('young'));
    // A decisive FALSE leaves whatever was already there.
    expect(run([set], { [V.age]: num(50), [V.segment]: text('preset') }).value(V.segment)).toEqual(text('preset'));
  });

  it('option_state: U leaves the authored literal default in place', () => {
    const b = astBuilder();
    const disable = rule({
      id: 'rul_opt',
      kind: 'option_state',
      target: { type: 'option', id: OPT.q5_3 },
      condition: b.cmp('>=', b.variable(V.age), b.numLit(18)),
      effect: { action: 'option_state', option_id: OPT.q5_3, prop: 'enabled', value: b.boolLit(false) },
      order_key: 1,
    });
    expect(run([disable], {}).option(OPT.q5_3, 'enabled')).toBe(true);
    expect(run([disable], { [V.age]: num(20) }).option(OPT.q5_3, 'enabled')).toBe(false);
  });

  it('mask: a per-item U excludes the item under include and retains it under exclude', () => {
    const b = astBuilder();
    const include = rule({
      id: 'rul_mask_in',
      kind: 'mask',
      target: { type: 'question', id: Q.q5 },
      condition: b.boolLit(true),
      effect: {
        action: 'mask',
        applies_to: 'options',
        mode: 'include',
        // `item.meta.discontinued` is absent on options 1 and 2, so their per-item condition is U.
        per_item: b.itemAttr('code', 'discontinued'),
        fallback: { when_empty: 'skip_question' },
      },
      order_key: 1,
    });
    expect(run([include], {}).items(Q.q5, 'options')).toEqual([3]);

    const b2 = astBuilder();
    const exclude = rule({
      id: 'rul_mask_out',
      kind: 'mask',
      target: { type: 'question', id: Q.q5 },
      condition: b2.boolLit(true),
      effect: {
        action: 'mask',
        applies_to: 'options',
        mode: 'exclude',
        per_item: b2.itemAttr('code', 'discontinued'),
        fallback: { when_empty: 'skip_question' },
      },
      order_key: 1,
    });
    // Only the item that *proved* it matches is removed; the unknowns are retained.
    expect(run([exclude], {}).items(Q.q5, 'options')).toEqual([1, 2, 99]);
  });

  it('mask: an emptied axis reports its fallback, and show_all restores the base list', () => {
    const b = astBuilder();
    const impossible = rule({
      id: 'rul_mask_empty',
      kind: 'mask',
      target: { type: 'question', id: Q.q5 },
      condition: b.boolLit(true),
      effect: {
        action: 'mask',
        applies_to: 'options',
        mode: 'include',
        per_item: b.cmp('>', b.itemAttr('code'), b.numLit(1000)),
        fallback: { when_empty: 'show_all' },
      },
      order_key: 1,
    });
    const verdict = run([impossible], {});
    expect(verdict.items(Q.q5, 'options')).toEqual([1, 2, 3, 99]);
    expect(verdict.maskFallbacks).toEqual([
      { question_id: Q.q5, axis: 'options', rule_id: 'rul_mask_empty', when_empty: 'show_all', restored: true },
    ]);
  });

  it('mask: a skip_question fallback is reported rather than silently leaving an empty question', () => {
    const b = astBuilder();
    const impossible = rule({
      id: 'rul_mask_dead',
      kind: 'mask',
      target: { type: 'question', id: Q.q5 },
      condition: b.boolLit(true),
      effect: {
        action: 'mask',
        applies_to: 'options',
        mode: 'include',
        per_item: b.cmp('>', b.itemAttr('code'), b.numLit(1000)),
        fallback: { when_empty: 'skip_question' },
      },
      order_key: 1,
    });
    const verdict = run([impossible], {});
    expect(verdict.items(Q.q5, 'options')).toEqual([]);
    expect(verdict.maskFallbacks[0]).toMatchObject({ when_empty: 'skip_question', restored: false });
  });

  it('skip: U does not skip, because skipping on unknown silently drops content', () => {
    const b = astBuilder();
    const skip: Rule = {
      ...rule({
        id: 'rul_skip',
        kind: 'skip',
        target: { type: 'page', id: P.p2 },
        condition: b.cmp('>', b.variable(V.q9), b.numLit(3)),
        effect: { action: 'skip_to', node_id: P.p3 },
        order_key: 1,
      }),
      flow_node_id: asFlowNodeId('fn_p1'),
    };
    const flowCell = (values: { readonly [id: string]: Value }): string | null => {
      const verdict = run([skip], values);
      const index = compileLogic([skip], E).cellKeys.indexOf('flow(fn_p1)');
      const cell = verdict.cells[index];
      return cell !== undefined && cell.c === 'target' ? cell.node_id : null;
    };
    expect(flowCell({})).toBeNull();
    expect(flowCell({ [V.q9]: num(5) })).toBe(P.p3);
    expect(flowCell({ [V.q9]: num(1) })).toBeNull();
  });
});

describe('three-valued logic does not leak past the boundary', () => {
  it('every cell in a verdict is two-valued', () => {
    const b = astBuilder();
    const rules: readonly Rule[] = [
      rule({
        id: 'rul_leak_show',
        kind: 'display',
        target: { type: 'question', id: Q.q12 },
        condition: b.cmp('>', b.variable(V.q9), b.numLit(3)),
        effect: { action: 'show' },
        order_key: 1,
      }),
      rule({
        id: 'rul_leak_opt',
        kind: 'option_state',
        target: { type: 'option', id: OPT.q5_1 },
        condition: b.setOp('contains', b.variable(V.q5set), b.enumLit(1, DOM.q5)),
        effect: { action: 'option_state', option_id: OPT.q5_1, prop: 'preselected', value: b.boolLit(true) },
        order_key: 2,
      }),
      terminateUnder18(),
    ];
    const verdict = run(rules, {});
    for (const cell of verdict.cells) {
      expect(cell).toBeDefined();
      if (cell === undefined) continue;
      if (cell.c === 'bool') expect(typeof cell.on).toBe('boolean');
      if (cell.c === 'codes') expect(Array.isArray(cell.codes)).toBe(true);
    }
    // The *values* may of course still be null: nullity is data, and it propagates. What must not
    // survive is a three-valued verdict on an effect.
    expect(verdict.visible(Q.q12)).toBe(false);
    expect(verdict.option(OPT.q5_1, 'preselected')).toBe(false);
  });

  it('an unknown inside a condition is absorbed by a decisive operand, unchanged at the boundary', () => {
    const b = astBuilder();
    // `S1 = 2 AND Q9 > 3` is cleanly FALSE for a respondent screened out at S1, with no guard.
    const condition = b.and(
      b.cmp('==', b.variable(V.s1), b.enumLit(2, DOM.s1)),
      b.cmp('>', b.variable(V.q9), b.numLit(3)),
    );
    expect(checkExpr(condition, E).diagnostics).toEqual([]);
    expect(evalCondition(condition, exprEnv({ [V.s1]: { k: 'enum', v: 1, d: DOM.s1 } }))).toBe('F');
    expect(evalCondition(condition, exprEnv({ [V.s1]: { k: 'enum', v: 2, d: DOM.s1 } }))).toBe('U');
  });

  it('an empty answered multi-select is decisive, an unasked one is not', () => {
    const b = astBuilder();
    const noneOfFruit = b.setOp('none_of', b.variable(V.q5set), b.setLit([1, 2], DOM.q5));
    expect(evalCondition(noneOfFruit, exprEnv({}))).toBe('U');
    expect(evalCondition(noneOfFruit, exprEnv({ [V.q5set]: setValue([], DOM.q5) }))).toBe('T');
    expect(evalCondition(noneOfFruit, exprEnv({ [V.q5set]: setValue([1], DOM.q5) }))).toBe('F');
  });
});

describe('effect lattices are order-independent (D §4.6)', () => {
  it('hide wins over show, whichever rule is applied first', () => {
    const b1 = astBuilder(1);
    const b2 = astBuilder(50);
    const show = rule({
      id: 'rul_a_show',
      kind: 'display',
      target: { type: 'question', id: Q.q12 },
      condition: b1.boolLit(true),
      effect: { action: 'show' },
      order_key: 1,
    });
    const hide = rule({
      id: 'rul_b_hide',
      kind: 'display',
      target: { type: 'question', id: Q.q12 },
      condition: b2.boolLit(true),
      effect: { action: 'hide' },
      order_key: 2,
    });
    expect(run([show, hide], {}).visible(Q.q12)).toBe(false);
    expect(run([hide, show], {}).visible(Q.q12)).toBe(false);
    // And the reversed order_keys make no difference either.
    expect(run([{ ...show, order_key: 9 }, hide], {}).visible(Q.q12)).toBe(false);
  });

  it('opt.visible is absorbing-false while opt.preselected is OR', () => {
    const b = astBuilder();
    const rules: readonly Rule[] = [
      rule({
        id: 'rul_pre_a',
        kind: 'option_state',
        target: { type: 'option', id: OPT.q5_1 },
        condition: b.boolLit(true),
        effect: { action: 'option_state', option_id: OPT.q5_1, prop: 'preselected', value: b.boolLit(false) },
        order_key: 1,
      }),
      rule({
        id: 'rul_pre_b',
        kind: 'option_state',
        target: { type: 'option', id: OPT.q5_1 },
        condition: b.boolLit(true),
        effect: { action: 'option_state', option_id: OPT.q5_1, prop: 'preselected', value: b.boolLit(true) },
        order_key: 2,
      }),
    ];
    expect(run(rules, {}).option(OPT.q5_1, 'preselected')).toBe(true);
    expect(run([...rules].reverse(), {}).option(OPT.q5_1, 'preselected')).toBe(true);
  });

  it('the first termination in topo order wins and the rest are recorded as suppressed', () => {
    const b1 = astBuilder(1);
    const b2 = astBuilder(50);
    const first = rule({
      id: 'rul_term_a',
      kind: 'terminate',
      target: { type: 'survey' },
      condition: b1.boolLit(true),
      effect: { action: 'terminate', disposition: 'SCREENOUT' },
      order_key: 1,
    });
    const second = rule({
      id: 'rul_term_b',
      kind: 'terminate',
      target: { type: 'survey' },
      condition: b2.boolLit(true),
      effect: { action: 'terminate', disposition: 'QUALITY' },
      order_key: 2,
    });
    for (const order of [[first, second], [second, first]]) {
      const verdict = run(order, {});
      expect(verdict.termination).toMatchObject({ rule_id: 'rul_term_a', disposition: 'SCREENOUT' });
      expect(verdict.suppressedTerminations).toEqual(['rul_term_b']);
    }
  });

  it('successive masks intersect, and the intersection is order-independent', () => {
    const b1 = astBuilder(1);
    const b2 = astBuilder(50);
    const dropHigh = rule({
      id: 'rul_m1',
      kind: 'mask',
      target: { type: 'question', id: Q.q5 },
      condition: b1.boolLit(true),
      effect: {
        action: 'mask',
        applies_to: 'options',
        mode: 'include',
        per_item: b1.cmp('<', b1.itemAttr('code'), b1.numLit(50)),
        fallback: { when_empty: 'show_all' },
      },
      order_key: 1,
    });
    const dropOdd = rule({
      id: 'rul_m2',
      kind: 'mask',
      target: { type: 'question', id: Q.q5 },
      condition: b2.boolLit(true),
      effect: {
        action: 'mask',
        applies_to: 'options',
        mode: 'include',
        per_item: b2.cmp('==', b2.binArith('mod', b2.itemAttr('code'), b2.numLit(2)), b2.numLit(0)),
        fallback: { when_empty: 'show_all' },
      },
      order_key: 2,
    });
    expect(run([dropHigh, dropOdd], {}).items(Q.q5, 'options')).toEqual([2]);
    expect(run([dropOdd, dropHigh], {}).items(Q.q5, 'options')).toEqual([2]);
  });

  it('all validation failures are collected, not short-circuited', () => {
    const b1 = astBuilder(1);
    const b2 = astBuilder(50);
    const rules: readonly Rule[] = [
      rule({
        id: 'rul_v1',
        kind: 'validate',
        target: { type: 'question', id: Q.q6 },
        condition: b1.boolLit(false),
        effect: { action: 'require_valid', message_key: 'err.one', scope: 'field' },
        order_key: 1,
      }),
      rule({
        id: 'rul_v2',
        kind: 'validate',
        target: { type: 'question', id: Q.q6 },
        condition: b2.boolLit(false),
        effect: { action: 'require_valid', message_key: 'err.two', scope: 'page' },
        order_key: 2,
      }),
    ];
    const verdict = run(rules, {});
    expect(verdict.validations.map((v) => v.message_key).sort()).toEqual(['err.one', 'err.two']);
  });

  it('a VALID probe reads the AND of the validations scoped to its target', () => {
    const b = astBuilder();
    const failing = rule({
      id: 'rul_v_fail',
      kind: 'validate',
      target: { type: 'question', id: Q.q6 },
      condition: b.cmp('>', b.variable(V.q6), b.numLit(0)),
      effect: { action: 'require_valid', message_key: 'err.positive', scope: 'field' },
      order_key: 1,
    });
    const flag = rule({
      id: 'rul_v_flag',
      kind: 'set_variable',
      target: { type: 'variable', id: V.skipped },
      condition: b.not(b.probe('valid', { kind: 'question', id: Q.q6 })),
      effect: { action: 'set', variable_id: V.skipped, value: b.boolLit(true) },
      order_key: 2,
    });
    expect(run([failing, flag], { [V.q6]: num(0) }).value(V.skipped)).toBe(TRUE);
    expect(run([failing, flag], { [V.q6]: num(5) }).value(V.skipped)).toBe(NULL);
    // And an unknown requirement passes, so the flag is not raised.
    expect(run([failing, flag], {}).value(V.skipped)).toBe(NULL);
    expect(FALSE).toBeDefined();
  });
});
