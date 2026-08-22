/**
 * The condition tree editor — 09-ui §7.1, roadmap P1-12.
 *
 * Renders a condition AST as nested AND/OR groups with leaf rows, and edits it IMMUTABLY:
 * every change builds a new tree, renumbers it densely (`renumber` — D §6.4's `≡` ignores node
 * ids, so renumbering is free, and the evaluator's memo table wants dense ids), and hands it
 * up. The component holds no tree state of its own; the pane owns the AST, the way `source` on
 * `RuleModeToggle` is owned by the parent "so a keystroke is not lost on a re-render".
 *
 * ## The editable subset, and everything else
 *
 * Controls exist for what the recognizer (`leafOfExpr`) recognizes: `AND`/`OR` groups, `NOT`
 * over a recognized leaf, `var OP literal` comparisons, set membership, and `ANSWERED`. Any
 * other subtree — an `agg`, arithmetic on the left side, `var OP var` — renders read-only
 * through the closed `RENDERERS` registry with its remove button still live. That is the
 * §7.3 division of labour: the builder never *breaks* an advanced rule it cannot edit, and the
 * code pane is one toggle away.
 *
 * The operator dropdown is constrained by the operand type (`operatorsFor` — the checker's own
 * table), and the value input is typed to the operand: an enum offers its options by label, a
 * number gets a numeric input, a boolean a TRUE/FALSE choice. The builder therefore cannot
 * construct a leaf the checker rejects — the same property the DSL gets from types, delivered
 * through the UI's affordances.
 */

'use client';

import { useMemo } from 'react';
import type { Expr } from '@resscript/logic';
import { astBuilder, renumber } from '@resscript/logic';
import type { Leaf, LeafVariable } from './operators';
import { OPERATOR_LABELS, defaultLeaf, leafExpr, leafOfExpr, operatorsFor, valueForOperator } from './operators';
import { ExprView, type RenderCtx } from './renderers';

export interface ConditionTreeEditorProps {
  readonly root: Expr;
  readonly variables: readonly LeafVariable[];
  readonly ctx: RenderCtx;
  readonly onChange: (next: Expr) => void;
}

/** A fresh builder per fragment; the whole tree is renumbered after every edit anyway. */
function build(): ReturnType<typeof astBuilder> {
  return astBuilder(1);
}

export function ConditionTreeEditor(props: ConditionTreeEditorProps): React.JSX.Element {
  const { root, variables, ctx, onChange } = props;
  const byId = useMemo(() => new Map(variables.map((v) => [v.id, v])), [variables]);

  const commit = (next: Expr): void => {
    onChange(renumber(next, 1));
  };

  const firstVariable = variables[0];

  return (
    <div data-testid="condition-tree">
      <NodeEditor
        node={root}
        byId={byId}
        variables={variables}
        ctx={ctx}
        replace={commit}
        remove={
          // The root cannot be removed — a rule always has a condition. Resetting to a default
          // leaf is the closest honest gesture, offered only when there is a variable to name.
          firstVariable === undefined
            ? undefined
            : () => commit(leafExpr(defaultLeaf(firstVariable), firstVariable, build()))
        }
      />
      {isGroup(root) || firstVariable === undefined ? null : (
        <button
          type="button"
          className="rs-button"
          data-testid="wrap-in-group"
          onClick={() =>
            commit({ n: 0, op: 'and', args: [root, leafExpr(defaultLeaf(firstVariable), firstVariable, build())] })
          }
        >
          + AND another condition
        </button>
      )}
    </div>
  );
}

function isGroup(node: Expr): node is Extract<Expr, { readonly op: 'and' | 'or' }> {
  return node.op === 'and' || node.op === 'or';
}

interface NodeEditorProps {
  readonly node: Expr;
  readonly byId: ReadonlyMap<string, LeafVariable>;
  readonly variables: readonly LeafVariable[];
  readonly ctx: RenderCtx;
  readonly replace: (next: Expr) => void;
  readonly remove?: (() => void) | undefined;
}

function NodeEditor(props: NodeEditorProps): React.JSX.Element {
  const { node, byId, variables, ctx, replace, remove } = props;

  if (isGroup(node)) {
    return <GroupEditor {...props} node={node} />;
  }

  const leaf = leafOfExpr(node);
  const variable = leaf === undefined ? undefined : byId.get(leaf.variable_id);
  if (leaf !== undefined && variable !== undefined) {
    return (
      <LeafEditor
        leaf={leaf}
        variable={variable}
        variables={variables}
        byId={byId}
        onChange={(next, nextVariable) => replace(leafExpr(next, nextVariable, build()))}
        {...(remove === undefined ? {} : { remove })}
      />
    );
  }

  // Not editable here — an agg, arithmetic, an unknown variable. Shown faithfully, never lost.
  return (
    <div className="rs-card" data-testid="opaque-expr" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
      <ExprView node={node} ctx={ctx} />
      <span className="rs-muted">advanced — edit as code</span>
      {remove === undefined ? null : (
        <button type="button" className="rs-button" aria-label="Remove condition" onClick={remove}>
          ✕
        </button>
      )}
    </div>
  );
}

function GroupEditor(
  props: NodeEditorProps & { readonly node: Extract<Expr, { readonly op: 'and' | 'or' }> },
): React.JSX.Element {
  const { node, byId, variables, ctx, replace, remove } = props;
  const firstVariable = variables[0];

  const setArg = (index: number, next: Expr): void => {
    replace({ ...node, args: node.args.map((arg, i) => (i === index ? next : arg)) });
  };
  const removeArg = (index: number): void => {
    const rest = node.args.filter((_, i) => i !== index);
    // The checker wants ≥2 operands (LGC-T006): one survivor dissolves the group around it.
    const sole = rest[0];
    if (rest.length === 1 && sole !== undefined) replace(sole);
    else replace({ ...node, args: rest });
  };

  return (
    <fieldset className="rs-card" data-testid={`group-${node.op}`} style={{ display: 'grid', gap: 4 }}>
      <legend>
        <select
          className="rs-input"
          aria-label="Group operator"
          value={node.op}
          onChange={(event) => replace({ ...node, op: event.target.value as 'and' | 'or' } as Expr)}
        >
          <option value="and">ALL of these (AND)</option>
          <option value="or">ANY of these (OR)</option>
        </select>
      </legend>
      {node.args.map((arg, index) => (
        <NodeEditor
          // Position is the identity here: ids are renumbered on every edit, so they cannot key.
          key={index}
          node={arg}
          byId={byId}
          variables={variables}
          ctx={ctx}
          replace={(next) => setArg(index, next)}
          remove={() => removeArg(index)}
        />
      ))}
      <div style={{ display: 'flex', gap: 4 }}>
        {firstVariable === undefined ? null : (
          <button
            type="button"
            className="rs-button"
            data-testid="add-condition"
            onClick={() =>
              replace({ ...node, args: [...node.args, leafExpr(defaultLeaf(firstVariable), firstVariable, build())] })
            }
          >
            + condition
          </button>
        )}
        {firstVariable === undefined ? null : (
          <button
            type="button"
            className="rs-button"
            data-testid="add-group"
            onClick={() =>
              replace({
                ...node,
                args: [
                  ...node.args,
                  {
                    n: 0,
                    op: node.op === 'and' ? 'or' : 'and',
                    args: [
                      leafExpr(defaultLeaf(firstVariable), firstVariable, build()),
                      leafExpr(defaultLeaf(firstVariable), firstVariable, build()),
                    ],
                  },
                ],
              })
            }
          >
            + group
          </button>
        )}
        {remove === undefined ? null : (
          <button type="button" className="rs-button" aria-label="Remove group" onClick={remove}>
            ✕ group
          </button>
        )}
      </div>
    </fieldset>
  );
}

interface LeafEditorProps {
  readonly leaf: Leaf;
  readonly variable: LeafVariable;
  readonly variables: readonly LeafVariable[];
  readonly byId: ReadonlyMap<string, LeafVariable>;
  readonly onChange: (leaf: Leaf, variable: LeafVariable) => void;
  readonly remove?: () => void;
}

function LeafEditor(props: LeafEditorProps): React.JSX.Element {
  const { leaf, variable, variables, byId, onChange, remove } = props;
  const operators = operatorsFor(variable);

  return (
    <div data-testid="leaf-row" style={{ display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' }}>
      <select
        className="rs-input"
        aria-label="Variable"
        value={leaf.variable_id}
        onChange={(event) => {
          const next = byId.get(event.target.value);
          if (next !== undefined) onChange(defaultLeaf(next), next);
        }}
      >
        {variables.map((v) => (
          <option key={v.id} value={v.id}>
            {v.name}
          </option>
        ))}
      </select>
      <select
        className="rs-input"
        aria-label="Operator"
        value={leaf.operator}
        onChange={(event) => {
          const operator = event.target.value as Leaf['operator'];
          onChange({ ...leaf, operator, value: valueForOperator(leaf, operator, variable) }, variable);
        }}
      >
        {operators.map((op) => (
          <option key={op} value={op}>
            {OPERATOR_LABELS[op]}
          </option>
        ))}
      </select>
      <ValueInput leaf={leaf} variable={variable} onChange={(next) => onChange(next, variable)} />
      {remove === undefined ? null : (
        <button type="button" className="rs-button" aria-label="Remove condition" onClick={remove}>
          ✕
        </button>
      )}
    </div>
  );
}

/** The value control, typed to the operand — the (c) of the roadmap's leaf spec. */
function ValueInput({
  leaf,
  variable,
  onChange,
}: {
  readonly leaf: Leaf;
  readonly variable: LeafVariable;
  readonly onChange: (leaf: Leaf) => void;
}): React.JSX.Element | null {
  const value = leaf.value;
  switch (value.k) {
    case 'none':
      return null;
    case 'code':
      return (
        <select
          className="rs-input"
          aria-label="Option"
          value={value.v}
          onChange={(event) => onChange({ ...leaf, value: { k: 'code', v: Number(event.target.value) } })}
        >
          {(variable.options ?? []).map((option) => (
            <option key={option.code} value={option.code}>
              {option.label}
            </option>
          ))}
        </select>
      );
    case 'codes':
      return (
        <span style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap' }} role="group" aria-label="Options">
          {(variable.options ?? []).map((option) => {
            const checked = value.v.includes(option.code);
            return (
              <label key={option.code} className="rs-chip">
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => {
                    const codes = checked ? value.v.filter((code) => code !== option.code) : [...value.v, option.code];
                    onChange({ ...leaf, value: { k: 'codes', v: codes } });
                  }}
                />
                {option.label}
              </label>
            );
          })}
        </span>
      );
    case 'num':
      return (
        <input
          className="rs-input"
          aria-label="Number"
          type="number"
          value={value.v}
          onChange={(event) => onChange({ ...leaf, value: { k: 'num', v: Number(event.target.value) } })}
        />
      );
    case 'bool':
      return (
        <select
          className="rs-input"
          aria-label="Boolean value"
          value={value.v ? 'true' : 'false'}
          onChange={(event) => onChange({ ...leaf, value: { k: 'bool', v: event.target.value === 'true' } })}
        >
          <option value="true">TRUE</option>
          <option value="false">FALSE</option>
        </select>
      );
    case 'date':
      return (
        <input
          className="rs-input"
          aria-label="Date"
          type="date"
          value={value.v}
          onChange={(event) => onChange({ ...leaf, value: { k: 'date', v: event.target.value } })}
        />
      );
    case 'text':
      return (
        <input
          className="rs-input"
          aria-label="Text"
          type="text"
          value={value.v}
          onChange={(event) => onChange({ ...leaf, value: { k: 'text', v: event.target.value } })}
        />
      );
    default: {
      const never: never = value;
      throw new Error(`unhandled value ${JSON.stringify(never)}`);
    }
  }
}
