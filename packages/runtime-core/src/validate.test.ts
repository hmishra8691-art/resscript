/**
 * Tests for the validation executor (C §14, run at E §5 step 4).
 */

import { describe, expect, it } from 'vitest';
import { runValidations, type ValidateInput, type ValidateQuestion } from './validate.js';

function q(over: Partial<ValidateQuestion> & { id: string }): ValidateQuestion {
  return { ref: over.id.toUpperCase(), emits: [`var_${over.id}`], ...over };
}

function input(over: Partial<ValidateInput> = {}): ValidateInput {
  return {
    questions: [],
    shown: new Set(),
    vars: {},
    written: new Set(),
    ...over,
  };
}

describe('required', () => {
  it('the question flag fails an unanswered shown question', () => {
    const r = runValidations(
      input({ questions: [q({ id: 'q1', required: true })], shown: new Set(['q1']) }),
    );
    expect(r).toEqual([
      { rule_id: 'req:q1', question_id: 'q1', type: 'required',
        message_key: 'err.required', scope: 'field' },
    ]);
  });

  it('an answered question passes, and empty-shaped values do not count as answers', () => {
    for (const [value, answered] of [
      [3, true], [0, true], ['text', true], [[1], true],
      [null, false], ['', false], ['   ', false], [[], false],
    ] as const) {
      const r = runValidations(
        input({
          questions: [q({ id: 'q1', required: true })],
          shown: new Set(['q1']),
          vars: { var_q1: value },
        }),
      );
      expect(r.length, JSON.stringify(value)).toBe(answered ? 0 : 1);
    }
  });

  it('required-but-not-shown is impossible by construction', () => {
    // The shown set came from the AUTHORITATIVE re-evaluation; a hidden required question
    // simply is not in it, so it cannot trap the respondent (E §5 step 4).
    const r = runValidations(
      input({ questions: [q({ id: 'q1', required: true })], shown: new Set() }),
    );
    expect(r).toEqual([]);
  });

  it('an explicit required rule wins on message_key', () => {
    const r = runValidations(
      input({
        questions: [q({
          id: 'q1', required: true,
          validation: [{ id: 'val_1', type: 'required', message_key: 'err.custom' }],
        })],
        shown: new Set(['q1']),
      }),
    );
    expect(r).toEqual([
      { rule_id: 'val_1', question_id: 'q1', type: 'required',
        message_key: 'err.custom', scope: 'field' },
    ]);
  });
});

describe('field rules', () => {
  it('min/max selections bound a set answer', () => {
    const question = q({
      id: 'q1',
      validation: [
        { id: 'v_min', type: 'min_selections', params: { n: 2 } },
        { id: 'v_max', type: 'max_selections', params: { n: 3 } },
      ],
    });
    const run = (value: unknown) =>
      runValidations(
        input({ questions: [question], shown: new Set(['q1']), vars: { var_q1: value } }),
      ).map(f => f.rule_id);

    expect(run([1])).toEqual(['v_min']);
    expect(run([1, 2])).toEqual([]);
    expect(run([1, 2, 3, 4])).toEqual(['v_max']);
  });

  it('min_selections does not make an optional question required', () => {
    const question = q({
      id: 'q1',
      validation: [{ id: 'v_min', type: 'min_selections', params: { n: 2 } }],
    });
    const r = runValidations(
      input({ questions: [question], shown: new Set(['q1']), vars: {} }),
    );
    expect(r).toEqual([]);
  });

  it('min/max value bound a numeric, with transport strings coerced', () => {
    const question = q({
      id: 'q1',
      validation: [
        { id: 'v_lo', type: 'min_value', params: { value: 18 } },
        { id: 'v_hi', type: 'max_value', params: { value: 99 } },
      ],
    });
    const run = (value: unknown) =>
      runValidations(
        input({ questions: [question], shown: new Set(['q1']), vars: { var_q1: value } }),
      ).map(f => f.rule_id);

    expect(run(17)).toEqual(['v_lo']);
    expect(run('120')).toEqual(['v_hi']);
    expect(run(34)).toEqual([]);
  });

  it('regex applies to entered text, not to absence', () => {
    const question = q({
      id: 'q1',
      validation: [{ id: 'v_re', type: 'regex', params: { pattern: '^[A-Z]{2}\\d{4}$' } }],
    });
    const run = (value: unknown) =>
      runValidations(
        input({ questions: [question], shown: new Set(['q1']), vars: { var_q1: value } }),
      );

    expect(run('AB1234')).toEqual([]);
    expect(run('nope').length).toBe(1);
    expect(run('')).toEqual([]); // absence is required's business, not format's
  });

  it('a malformed pattern cannot trap the respondent', () => {
    const question = q({
      id: 'q1',
      validation: [{ id: 'v_re', type: 'regex', params: { pattern: '(' } }],
    });
    const r = runValidations(
      input({ questions: [question], shown: new Set(['q1']), vars: { var_q1: 'anything' } }),
    );
    expect(r).toEqual([]);
  });

  it('an expression rule fails on FALSE and passes on UNKNOWN', () => {
    // UNKNOWN passing is D §2.5's collapse direction for validations: a rule that cannot be
    // evaluated must not be a dead end.
    const question = q({
      id: 'q1',
      validation: [{ id: 'v_x', type: 'expression', condition: { k: 'c' } }],
    });
    const run = (verdict: boolean | null) =>
      runValidations(
        input({
          questions: [question], shown: new Set(['q1']),
          vars: { var_q1: 1 }, evalCondition: () => verdict,
        }),
      );

    expect(run(false).length).toBe(1);
    expect(run(true)).toEqual([]);
    expect(run(null)).toEqual([]);
  });

  it('an unknown plugin type passes rather than blocking', () => {
    const question = q({
      id: 'q1',
      validation: [{ id: 'v_p', type: 'plugin_special' }],
    });
    const r = runValidations(
      input({ questions: [question], shown: new Set(['q1']), vars: { var_q1: 1 } }),
    );
    expect(r).toEqual([]);
  });
});

describe('page scope and ordering', () => {
  const grid = q({
    id: 'q1',
    emits: ['var_a', 'var_b', 'var_c'],
    validation: [
      { id: 'v_sum', type: 'sum_equals', scope: 'page',
        params: { value: 100, variables: ['var_a', 'var_b', 'var_c'] } },
    ],
  });

  it('sum_equals fails a wrong total and passes an exact one', () => {
    const run = (vars: Record<string, unknown>) =>
      runValidations(input({ questions: [grid], shown: new Set(['q1']), vars }));

    expect(run({ var_a: 40, var_b: 40, var_c: 30 }).length).toBe(1);
    expect(run({ var_a: 40, var_b: 40, var_c: 20 })).toEqual([]);
    expect(run({})).toEqual([]); // emptiness is required's business
  });

  it('page-scope rules are skipped while any field rule fails', () => {
    // A sum over a field that failed a range check is a total that will change anyway;
    // reporting both directs the respondent at the wrong fix first.
    const withRange = q({
      id: 'q1',
      emits: ['var_a', 'var_b', 'var_c'],
      validation: [
        { id: 'v_lo', type: 'min_value', params: { value: 0, variables: ['var_a'] } },
        { id: 'v_sum', type: 'sum_equals', scope: 'page',
          params: { value: 100, variables: ['var_a', 'var_b', 'var_c'] } },
      ],
    });
    const r = runValidations(
      input({
        questions: [withRange], shown: new Set(['q1']),
        vars: { var_a: -5, var_b: 40, var_c: 30 },
      }),
    );

    expect(r.map(f => f.rule_id)).toEqual(['v_lo']);
  });

  it('cross_question at page scope fails on FALSE', () => {
    const question = q({
      id: 'q1',
      validation: [{ id: 'v_cq', type: 'cross_question', scope: 'page', condition: {} }],
    });
    const r = runValidations(
      input({
        questions: [question], shown: new Set(['q1']),
        vars: { var_q1: 1 }, evalCondition: () => false,
      }),
    );

    expect(r).toEqual([
      { rule_id: 'v_cq', question_id: 'q1', type: 'cross_question',
        message_key: 'err.invalid', scope: 'page' },
    ]);
  });

  it('failures follow document order', () => {
    const r = runValidations(
      input({
        questions: [q({ id: 'q2', required: true }), q({ id: 'q1', required: true })],
        shown: new Set(['q1', 'q2']),
      }),
    );
    expect(r.map(f => f.question_id)).toEqual(['q2', 'q1']);
  });

  it('a hidden question contributes no rules at any scope', () => {
    const r = runValidations(
      input({
        questions: [grid, q({ id: 'q9', required: true })],
        shown: new Set(['q9']),
        vars: { var_a: 1, var_q9: 'answered' },
      }),
    );
    expect(r).toEqual([]);
  });
});
