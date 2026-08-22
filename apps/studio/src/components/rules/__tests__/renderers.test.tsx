/**
 * D §7.2's third closure leg, asserted at runtime as well as compile time.
 *
 * The COMPILE-TIME test is the type of `RENDERERS` itself: `Renderers` maps over `AstKind`, so
 * a kind added to `AST_KINDS` without a renderer fails `pnpm --filter @resscript/studio build`
 * before any test runs, and `RENDERER_REGISTRY` re-checks the same value against the
 * `AstRendererRegistry` type P1-07 published. What a type cannot assert is that the values are
 * usable — that every entry is a function and renders without throwing — so this file walks the
 * runtime list too, the same double the evaluator's own closure test does.
 */

import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { astBuilder, AST_KINDS } from '@resscript/logic';
import type { Expr } from '@resscript/logic';
import { ExprView, RENDERERS, RENDERER_REGISTRY, type RenderCtx } from '../renderers';

afterEach(cleanup);

function ctx(): RenderCtx {
  const self: RenderCtx = {
    variableName: (id) => (id === 'var_s1' ? 'S1' : id),
    nodeRef: (id) => (id === 'qst_q12' ? 'Q12' : id),
    optionLabel: (_domain, code) => `opt${String(code)}`,
    child: (node) => <ExprView node={node} ctx={self} />,
  };
  return self;
}

describe('RENDERERS', () => {
  it('has a renderer for every AST_KINDS entry — the runtime half of the closure', () => {
    for (const kind of AST_KINDS) {
      expect(typeof RENDERERS[kind], `renderer for ${kind}`).toBe('function');
    }
    // The published registry type and the map are one value — no second table to drift.
    expect(RENDERER_REGISTRY).toBe(RENDERERS);
    expect(Object.keys(RENDERERS).sort()).toEqual([...AST_KINDS].sort());
  });

  it('renders a composite condition with names, never raw ids', () => {
    const b = astBuilder(1);
    const expr: Expr = b.and(
      b.cmp('==', b.variable('var_s1' as never), b.enumLit(1, 'dom_s1' as never)),
      b.not(b.probe('answered', { kind: 'question', id: 'qst_q12' as never })),
      b.setOp('contains', b.variable('var_s1' as never), b.enumLit(2, 'dom_s1' as never)),
    );
    const { container } = render(<ExprView node={expr} ctx={ctx()} />);
    const text = container.textContent ?? '';
    expect(text).toContain('S1');
    expect(text).toContain('opt1');
    expect(text).toContain('NOT');
    expect(text).toContain('ANSWERED(Q12)');
    expect(text).not.toContain('var_s1');
    expect(text).not.toContain('qst_q12');
  });

  it('renders every kind without throwing, on a representative node of that kind', () => {
    const b = astBuilder(1);
    const one = b.numLit(1);
    const yes = b.boolLit(true);
    const text = b.textLit('x');
    const date = b.dateLit('2026-01-01');
    const samples: { readonly [K in (typeof AST_KINDS)[number]]: Expr } = {
      lit: one,
      var: b.variable('var_s1' as never),
      probe: b.probe('shown', { kind: 'page', id: 'pg_1' as never }),
      item: b.item(),
      item_attr: b.itemAttr('code'),
      '==': b.cmp('==', one, one),
      '!=': b.cmp('!=', one, one),
      '<': b.cmp('<', one, one),
      '<=': b.cmp('<=', one, one),
      '>': b.cmp('>', one, one),
      '>=': b.cmp('>=', one, one),
      contains: b.setOp('contains', b.variable('var_q5' as never), one),
      any_of: b.setOp('any_of', b.variable('var_q5' as never), b.setLit([1], 'dom_q5' as never)),
      all_of: b.setOp('all_of', b.variable('var_q5' as never), b.setLit([1], 'dom_q5' as never)),
      none_of: b.setOp('none_of', b.variable('var_q5' as never), b.setLit([1], 'dom_q5' as never)),
      set_eq: b.setOp('set_eq', b.variable('var_q5' as never), b.setLit([1], 'dom_q5' as never)),
      subset_of: b.setOp('subset_of', b.variable('var_q5' as never), b.setLit([1], 'dom_q5' as never)),
      union: b.setOp('union', b.variable('var_q5' as never), b.variable('var_q5' as never)),
      intersect: b.setOp('intersect', b.variable('var_q5' as never), b.variable('var_q5' as never)),
      difference: b.setOp('difference', b.variable('var_q5' as never), b.variable('var_q5' as never)),
      and: b.and(yes, yes),
      or: b.or(yes, yes),
      not: b.not(yes),
      '+': b.binArith('+', one, one),
      '-': b.binArith('-', one, one),
      '*': b.binArith('*', one, one),
      '/': b.binArith('/', one, one),
      mod: b.binArith('mod', one, one),
      pow: b.binArith('pow', one, one),
      neg: b.unArith('neg', one),
      abs: b.unArith('abs', one),
      floor: b.unArith('floor', one),
      ceil: b.unArith('ceil', one),
      round: b.round(one, one),
      min: b.nAryArith('min', one, one),
      max: b.nAryArith('max', one, one),
      clamp: b.nAryArith('clamp', one, one, one),
      agg: b.agg({ fn: 'count', over: { kind: 'question_emits', question_id: 'qst_q5' as never }, where: yes }),
      concat: b.concat(text, text),
      len: b.strUnary('len', text),
      lower: b.strUnary('lower', text),
      upper: b.strUnary('upper', text),
      trim: b.strUnary('trim', text),
      starts_with: b.strBinary('starts_with', text, text),
      ends_with: b.strBinary('ends_with', text, text),
      str_contains: b.strBinary('str_contains', text, text),
      matches: b.matches(text, '^a+$'),
      substr: b.substr(text, one, one),
      split_count: b.strBinary('split_count', text, text),
      word_count: b.strUnary('word_count', text),
      date_diff: b.dateDiff('day', date, date),
      date_add: b.dateAdd('day', date, one),
      date_part: b.datePart('year', date),
      date_trunc: b.dateTrunc('month', date),
      case: b.caseExpr([{ when: yes, then: one }], one),
      coalesce: b.coalesce(one, one),
      cast: b.cast('num', text),
      label_of: b.labelOf(b.variable('var_s1' as never)),
    };
    for (const kind of AST_KINDS) {
      const { container } = render(<ExprView node={samples[kind]} ctx={ctx()} />);
      expect(container.textContent, `render of ${kind}`).not.toBe('');
      cleanup();
    }
  });
});
