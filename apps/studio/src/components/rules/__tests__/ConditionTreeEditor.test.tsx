/**
 * The tree editor's contract: every interaction emits a NEW, well-formed AST upward — the
 * operator dropdown offers only what `operatorsFor` allows for the picked variable, the value
 * input is typed to the operand, groups keep the checker's ≥2-operand invariant by dissolving
 * around a sole survivor, and the input tree is never mutated.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { astBuilder, renumber, type Expr } from '@resscript/logic';
import { ConditionTreeEditor } from '../ConditionTreeEditor';
import { leafExpr, leafOfExpr, type LeafVariable } from '../operators';
import { ExprView, type RenderCtx } from '../renderers';

afterEach(cleanup);

const S1: LeafVariable = {
  id: 'var_s1',
  name: 'S1',
  vtype: 'enum',
  domain: 'dom_s1',
  options: [
    { code: 1, label: 'Yes' },
    { code: 2, label: 'No' },
  ],
};
const AGE: LeafVariable = { id: 'var_age', name: 'AGE', vtype: 'number' };
const VARIABLES = [S1, AGE];

function ctx(): RenderCtx {
  const self: RenderCtx = {
    variableName: (id) => id,
    nodeRef: (id) => id,
    optionLabel: (_d, code) => String(code),
    child: (node) => <ExprView node={node} ctx={self} />,
  };
  return self;
}

function s1Leaf(): Expr {
  return renumber(leafExpr({ variable_id: S1.id, operator: '==', value: { k: 'code', v: 1 } }, S1, astBuilder(1)), 1);
}

describe('ConditionTreeEditor', () => {
  it('constrains the operator dropdown by the operand type', () => {
    render(<ConditionTreeEditor root={s1Leaf()} variables={VARIABLES} ctx={ctx()} onChange={vi.fn()} />);
    const options = [...screen.getByLabelText('Operator').querySelectorAll('option')].map((o) => o.value);
    // A nominal enum: equality and probes, never ordering (the checker's LGC-T009).
    expect(options).toEqual(['==', '!=', 'answered', 'not_answered']);
  });

  it('an enum leaf gets an option dropdown; switching the variable to a number gets a numeric input', () => {
    const onChange = vi.fn<(next: Expr) => void>();
    render(<ConditionTreeEditor root={s1Leaf()} variables={VARIABLES} ctx={ctx()} onChange={onChange} />);
    expect(screen.getByLabelText('Option')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Variable'), { target: { value: AGE.id } });
    const next = onChange.mock.calls[0]?.[0];
    expect(next).toBeDefined();
    expect(leafOfExpr(next as Expr)).toEqual({
      variable_id: AGE.id,
      operator: '==',
      value: { k: 'num', v: 0 },
    });
  });

  it('edits immutably: the original AST object is untouched', () => {
    const root = s1Leaf();
    const before = JSON.stringify(root);
    const onChange = vi.fn<(next: Expr) => void>();
    render(<ConditionTreeEditor root={root} variables={VARIABLES} ctx={ctx()} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText('Operator'), { target: { value: '!=' } });
    expect(JSON.stringify(root)).toBe(before);
    const next = onChange.mock.calls[0]?.[0] as Expr;
    expect(leafOfExpr(next)?.operator).toBe('!=');
    expect(next).not.toBe(root);
  });

  it('adding to a leaf wraps it in an AND group; removing back down dissolves the group', () => {
    const onChange = vi.fn<(next: Expr) => void>();
    const { rerender } = render(
      <ConditionTreeEditor root={s1Leaf()} variables={VARIABLES} ctx={ctx()} onChange={onChange} />,
    );
    fireEvent.click(screen.getByTestId('wrap-in-group'));
    const grouped = onChange.mock.calls[0]?.[0] as Expr;
    expect(grouped.op).toBe('and');
    expect((grouped as { args: readonly Expr[] }).args).toHaveLength(2);

    rerender(<ConditionTreeEditor root={grouped} variables={VARIABLES} ctx={ctx()} onChange={onChange} />);
    const removeButtons = screen.getAllByRole('button', { name: 'Remove condition' });
    expect(removeButtons).toHaveLength(2);
    fireEvent.click(removeButtons[1] as HTMLElement);
    const dissolved = onChange.mock.calls[1]?.[0] as Expr;
    // One survivor: the group dissolves rather than leaving an AND the checker rejects.
    expect(dissolved.op).not.toBe('and');
    expect(leafOfExpr(dissolved)).not.toBeUndefined();
  });

  it('renders an unrecognized subtree read-only instead of guessing', () => {
    const b = astBuilder(1);
    const opaque = b.and(
      b.cmp('==', b.variable(S1.id as never), b.variable(S1.id as never)),
      renumber(leafExpr({ variable_id: AGE.id, operator: '>', value: { k: 'num', v: 3 } }, AGE, astBuilder(100)), 100),
    );
    render(<ConditionTreeEditor root={opaque} variables={VARIABLES} ctx={ctx()} onChange={vi.fn()} />);
    expect(screen.getByTestId('opaque-expr')).toHaveTextContent('advanced — edit as code');
    // The recognizable sibling still gets controls.
    expect(screen.getByLabelText('Variable')).toBeInTheDocument();
  });
});
