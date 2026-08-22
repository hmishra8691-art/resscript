/**
 * THE P1-12 round trip: a rule built with the builder's own AST-construction helpers, printed
 * to ResScript, parsed back, and compared — D §6.4's `≡`, exactly as the DSL's own P1 property
 * states it (`structuralStatement`: canonical node ids, no trivia, no spans).
 *
 * This is the acceptance criterion end to end at the model layer: "a rule authored in the
 * builder, printed to ResScript, edited in ResScript, and reopened in the builder is the same
 * rule". The pieces under test are exactly the pieces the pane wires together — `leafExpr` and
 * the group nodes (what the tree editor emits), `statementFromRule` (view as ResScript),
 * `print`/`parse` (the DSL, used here in-process with the studio's fixture registry; the pane
 * calls the same pair over `/v1/dsl/*`), and `ruleFromStatements` (what POST/PATCH `{source}`
 * store).
 */

import { describe, expect, it } from 'vitest';
import { astBuilder, exprEq, renumber, type Expr } from '@resscript/logic';
import { parse, printStatement, structuralStatement, type Statement } from '@resscript/rescript-dsl';
import { ruleFromStatements, statementFromRule, type RefNames } from '@/lib/rule-statement';
import { DOM, FRUIT, P, Q, V, fixtureRegistry } from '@/test/dsl-fixture';
import { leafExpr, type Leaf, type LeafVariable } from '../operators';

const REG = fixtureRegistry();

const S1: LeafVariable = {
  id: V.s1,
  name: 'S1',
  vtype: 'enum',
  domain: DOM.s1,
  options: [
    { code: 1, label: 'Yes' },
    { code: 2, label: 'No' },
  ],
};
const Q5: LeafVariable = {
  id: V.q5,
  name: 'Q5',
  vtype: 'set',
  domain: DOM.fruit,
  options: FRUIT.map((item) => ({ code: item.code, label: item.ref })),
};
const AGE: LeafVariable = { id: V.age, name: 'AGE', vtype: 'number' };
const SEGMENT: LeafVariable = { id: V.segment, name: 'SEGMENT', vtype: 'text' };

const NAMES: RefNames = {
  nodeRef: (id) => {
    if (id === Q.q12) return { ref: 'Q12', kind: 'question' };
    if (id === Q.q5) return { ref: 'Q5', kind: 'question' };
    if (id === P.p3) return { ref: 'P3', kind: 'page' };
    return undefined;
  },
  variableName: (id) => [S1, Q5, AGE, SEGMENT].find((v) => v.id === id)?.name,
};

function leaf(variable: LeafVariable, partial: Omit<Leaf, 'variable_id'>): Expr {
  return leafExpr({ variable_id: variable.id, ...partial }, variable, astBuilder(1));
}

/**
 * The non-trivial condition the builder would produce: a nested OR inside an AND, four leaf
 * shapes (enum equality, set membership, numeric ordering, a negated probe), renumbered the
 * way every editor commit renumbers.
 */
function builderCondition(): Expr {
  const group: Expr = {
    n: 0,
    op: 'and',
    args: [
      {
        n: 0,
        op: 'or',
        args: [
          leaf(S1, { operator: '==', value: { k: 'code', v: 1 } }),
          leaf(Q5, { operator: 'contains', value: { k: 'code', v: 1 } }),
        ],
      },
      leaf(AGE, { operator: '>=', value: { k: 'num', v: 18 } }),
      leaf(SEGMENT, { operator: 'not_answered', value: { k: 'none' } }),
    ],
  };
  return renumber(group, 1);
}

interface ModelRule {
  readonly kind: 'display' | 'skip' | 'validate' | 'option_state' | 'terminate' | 'set_variable' | 'mask';
  readonly target_node_id: string | null;
  readonly target_variable_id: string | null;
  readonly condition: Expr;
  readonly effect: Record<string, unknown>;
}

function printThenParse(rule: ModelRule): { readonly printed: string; readonly statement: Statement } {
  const statement = statementFromRule(rule, NAMES);
  expect(statement.ok).toBe(true);
  if (!statement.ok) throw new Error(statement.reason);
  const printed = printStatement(statement.statement, REG);
  const parsed = parse(printed, REG);
  expect(
    parsed.diagnostics.filter((d) => d.severity === 'error'),
    `parse errors in:\n${printed}`,
  ).toEqual([]);
  expect(parsed.program.statements).toHaveLength(1);
  const first = parsed.program.statements[0];
  if (first === undefined) throw new Error('unreachable: length asserted');
  return { printed, statement: first };
}

describe('builder → print → parse → deep-equal (D §6.4 T1 over builder output)', () => {
  it('round-trips a non-trivial display rule as the SAME statement', () => {
    const rule: ModelRule = {
      kind: 'display',
      target_node_id: Q.q12,
      target_variable_id: null,
      condition: builderCondition(),
      effect: { action: 'hide' },
    };
    const original = statementFromRule(rule, NAMES);
    if (!original.ok) throw new Error(original.reason);
    const { statement } = printThenParse(rule);
    // The comparison the DSL's own P1 property uses: canonical ids, trivia and spans dropped.
    expect(structuralStatement(statement)).toEqual(structuralStatement(original.statement));
  });

  it('round-trips a skip-to-page rule, explicit PAGE keyword and all', () => {
    const rule: ModelRule = {
      kind: 'skip',
      target_node_id: P.p3,
      target_variable_id: null,
      condition: renumber(leaf(S1, { operator: '==', value: { k: 'code', v: 2 } }), 1),
      effect: { action: 'skip_to', target_id: P.p3 },
    };
    const original = statementFromRule(rule, NAMES);
    if (!original.ok) throw new Error(original.reason);
    const { statement } = printThenParse(rule);
    expect(structuralStatement(statement)).toEqual(structuralStatement(original.statement));
  });

  it('the full acceptance loop: parse maps back to the SAME rule (kind, target, effect, condition)', () => {
    const rule: ModelRule = {
      kind: 'display',
      target_node_id: Q.q12,
      target_variable_id: null,
      condition: builderCondition(),
      effect: { action: 'hide' },
    };
    const { statement } = printThenParse(rule);
    const mapped = ruleFromStatements([statement as Statement<Expr>]);
    expect(mapped.ok).toBe(true);
    if (!mapped.ok) throw new Error(mapped.message);
    expect(mapped.rule.kind).toBe('display');
    expect(mapped.rule.target).toEqual({ target_kind: 'node', target_node_id: Q.q12 });
    expect(mapped.rule.effect).toEqual({ action: 'hide' });
    // `≡` for the condition itself: structural equality ignoring node ids and cached types.
    expect(exprEq(mapped.rule.condition, rule.condition)).toBe(true);
  });

  it('a terminate rule keeps its disposition through the trip; its target rides outside the text', () => {
    const rule: ModelRule = {
      kind: 'terminate',
      target_node_id: Q.q5,
      target_variable_id: null,
      condition: renumber(leaf(Q5, { operator: 'none_of', value: { k: 'codes', v: [1, 2] } }), 1),
      effect: { action: 'terminate', disposition: 'SCREENOUT' },
    };
    const { statement } = printThenParse(rule);
    const mapped = ruleFromStatements([statement as Statement<Expr>]);
    expect(mapped.ok).toBe(true);
    if (!mapped.ok) throw new Error(mapped.message);
    expect(mapped.rule.kind).toBe('terminate');
    expect(mapped.rule.effect).toEqual({ action: 'terminate', disposition: 'SCREENOUT' });
    // TERMINATE names no content target — the caller's stands (the route enforces exactly this).
    expect(mapped.rule.target).toBeUndefined();
    expect(exprEq(mapped.rule.condition, rule.condition)).toBe(true);
  });

  it('"edited in ResScript, reopened in the builder": the edit is the ONLY change', () => {
    const rule: ModelRule = {
      kind: 'display',
      target_node_id: Q.q12,
      target_variable_id: null,
      condition: renumber(leaf(AGE, { operator: '>=', value: { k: 'num', v: 18 } }), 1),
      effect: { action: 'show' },
    };
    const { printed } = printThenParse(rule);
    expect(printed).toContain('18');
    const edited = printed.replace('18', '21');
    const parsed = parse(edited, REG);
    expect(parsed.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const mapped = ruleFromStatements(parsed.program.statements);
    expect(mapped.ok).toBe(true);
    if (!mapped.ok) throw new Error(mapped.message);
    const expected = renumber(leaf(AGE, { operator: '>=', value: { k: 'num', v: 21 } }), 1);
    expect(exprEq(mapped.rule.condition, expected)).toBe(true);
    expect(exprEq(mapped.rule.condition, rule.condition)).toBe(false);
  });
});
