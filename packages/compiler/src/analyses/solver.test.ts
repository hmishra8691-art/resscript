/**
 * The solver's tests, in the order of how much they are worth.
 *
 * **The soundness suite is the point of this file.** The solver's whole specification is one
 * direction — it may answer "don't know" freely and must never claim a satisfiable condition is
 * unsatisfiable — so the test is not a table of expected answers but a differential against the
 * real thing: forty-odd conditions over a small variable set, every combination of concrete
 * values run through `@resscript/logic`'s own `evalCondition`, and two assertions.
 *
 *  1. **Pointwise.** For each assignment, the abstract verdict set computed with each variable
 *     bound to its *exact* value must contain the verdict the evaluator actually produced. This
 *     is what catches a wrong possibility rule inside one operator, even when the top-level
 *     claim is "don't know" and no diagnostic would have been emitted.
 *  2. **Globally.** Whenever `provablyNeverTrue` says yes, the brute force must have found no
 *     satisfying assignment; whenever `provablyAlwaysTrue` says yes, every assignment must be
 *     `T`. Never the converse — incompleteness is the design, and asserting it would freeze the
 *     precision of every operator at today's value.
 *
 * The conditions are hand-written rather than generated, and the reason is coverage of a
 * different kind: `fast-check` would explore shapes, and what needs covering is *operators* —
 * every comparison, every set predicate, every boolean form, `case`, `coalesce`, and at least
 * one member of each family the solver widens to `⊤`. A generator tuned to hit all of those is
 * a list of the operators with extra steps.
 *
 * Diagnostics are asserted by code and `detail`, never by message prose.
 */

import { describe, expect, it } from 'vitest';
import type {
  ContentNode,
  Expr as SchemaExpr,
  FlowNode,
  IdFactory,
  LogicRule,
  Mask,
  PageNode,
  QuestionItem,
  QuestionNode,
  RuleTarget,
  Survey,
  Variable,
} from '@resscript/schema';
import {
  EMPTY_SCHEMA,
  NO_CELLS,
  NULL,
  asDomainId,
  asFlowNodeId,
  asPageId,
  asRuleId,
  asVariableId,
  astBuilder,
  bool,
  buildTypeEnv,
  enumValue,
  evalCondition,
  num,
  readsOf,
  setValue,
  text,
  type DomainId,
  type Expr,
  type Rule,
  type Tri,
  type TypeEnv,
  type Value,
  type VariableId,
} from '@resscript/logic';

import { deterministicIds } from '../../../schema/src/__fixtures__/mini.js';
import type { CompileDiagnostic } from '../diagnostics.js';
import { buildFlowGraph } from '../flow.js';
import { buildTypeEnvFor } from '../registry.js';
import { buildRules } from '../rules.js';
import type { FlowGraph } from '../types.js';
import {
  FALSE_ONLY,
  NULL_VALUE,
  TOP,
  TRUE_ONLY,
  analyzeConditions,
  evalAbstract,
  provablyAlwaysTrue,
  provablyNeverTrue,
  verdictsOf,
  type Abstract,
} from './solver.js';

/* ========================================================================== */
/* The soundness suite                                                         */
/* ========================================================================== */

const DOM = asDomainId('dom_x');
/** Eight codes: past `MAX_SET_CODES`, so a `set` over it is never enumerated and stays `⊤`. */
const DOM_WIDE = asDomainId('dom_wide');

const A = asVariableId('var_01HAAAAAAAAAAAAAAAAAAAAAAA');
const B = asVariableId('var_01HBBBBBBBBBBBBBBBBBBBBBBB');
const S1 = asVariableId('var_01HS1S1S1S1S1S1S1S1S1S1S1');
const S2 = asVariableId('var_01HS2S2S2S2S2S2S2S2S2S2S2');
const M = asVariableId('var_01HMMMMMMMMMMMMMMMMMMMMMM');
const TXT = asVariableId('var_01HTTTTTTTTTTTTTTTTTTTTTT');
const WIDE = asVariableId('var_01HWWWWWWWWWWWWWWWWWWWWWW');

/**
 * Six variables, one domain, three codes.
 *
 * Small on purpose: the brute force is a product over the variables a condition reads, and the
 * point is to cover operators exhaustively rather than to cover a wide survey. `ordinal: true`
 * so ordered comparisons on the enum are the well-typed case rather than `LGC-T009`.
 */
const SOUNDNESS_ENV: TypeEnv = buildTypeEnv({
  variables: [
    { id: A, name: 'A', kind: 'response', type: 'number', persist: true, pii: false },
    { id: B, name: 'B', kind: 'response', type: 'boolean', persist: true, pii: false },
    { id: S1, name: 'S1', kind: 'response', type: 'enum', domain: DOM, persist: true, pii: false },
    { id: S2, name: 'S2', kind: 'response', type: 'enum', domain: DOM, persist: true, pii: false },
    { id: M, name: 'M', kind: 'response', type: 'set', domain: DOM, persist: true, pii: false },
    { id: TXT, name: 'T', kind: 'response', type: 'text', persist: true, pii: false },
    {
      id: WIDE,
      name: 'WIDE',
      kind: 'response',
      type: 'set',
      domain: DOM_WIDE,
      persist: true,
      pii: false,
    },
  ],
  domains: [
    {
      id: DOM,
      entries: [
        { code: 1, label_key: 'x.1' },
        { code: 2, label_key: 'x.2' },
        { code: 3, label_key: 'x.3' },
      ],
      ordinal: true,
    },
    {
      id: DOM_WIDE,
      entries: [1, 2, 3, 4, 5, 6, 7, 8].map((code) => ({
        code,
        label_key: `wide.${String(code)}`,
      })),
      ordinal: false,
    },
  ],
});

/** Every concrete value each variable can take in the brute force. `null` is always one. */
const VALUES: { readonly [id: string]: readonly Value[] } = {
  [A]: [NULL, num(0), num(5), num(18)],
  [B]: [NULL, bool(true), bool(false)],
  [S1]: [NULL, enumValue(1, DOM), enumValue(2, DOM), enumValue(3, DOM)],
  [S2]: [NULL, enumValue(1, DOM), enumValue(2, DOM), enumValue(3, DOM)],
  [M]: [
    NULL,
    setValue([], DOM),
    setValue([1], DOM),
    setValue([2], DOM),
    setValue([3], DOM),
    setValue([1, 2], DOM),
    setValue([1, 3], DOM),
    setValue([2, 3], DOM),
    setValue([1, 2, 3], DOM),
  ],
  [TXT]: [NULL, text('abc')],
  [WIDE]: [NULL, setValue([], DOM_WIDE), setValue([1], DOM_WIDE), setValue([1, 2], DOM_WIDE)],
};

/** The tightest abstract value for one concrete value: what the pointwise assertion binds. */
function exactAbstract(value: Value): Abstract {
  switch (value.k) {
    case 'null':
      return NULL_VALUE;
    case 'bool':
      return value.v ? TRUE_ONLY : FALSE_ONLY;
    case 'num':
      return { k: 'num', min: value.v, max: value.v, u: false };
    case 'enum':
      return { k: 'enum', d: value.d, codes: new Set([value.v]), u: false };
    case 'set':
      return { k: 'set', d: value.d, codes: new Set(value.v), u: false };
    default:
      // text, date, obj: the solver models none of them, and neither does this.
      return TOP;
  }
}

interface Named {
  readonly label: string;
  readonly expr: Expr;
}

/**
 * The condition set.
 *
 * One entry per operator the solver interprets, plus one per family it widens to `⊤`, plus the
 * handful of correlated shapes that only a case split can decide. Each is well-typed: the
 * evaluator throws a `LogicInvariant` on a comparison it cannot order or a domain mismatch, so
 * an ill-typed fixture would fail as a crash rather than as a soundness violation and would say
 * nothing about the solver.
 */
function conditions(): readonly Named[] {
  const out: Named[] = [];
  const add = (label: string, build: (b: ReturnType<typeof astBuilder>) => Expr): void => {
    out.push({ label, expr: build(astBuilder()) });
  };

  /* comparisons on an enum */
  add('S1 == 1', (b) => b.cmp('==', b.variable(S1), b.enumLit(1, DOM)));
  add('S1 != 1', (b) => b.cmp('!=', b.variable(S1), b.enumLit(1, DOM)));
  add('S1 < 2', (b) => b.cmp('<', b.variable(S1), b.enumLit(2, DOM)));
  add('S1 <= 2', (b) => b.cmp('<=', b.variable(S1), b.enumLit(2, DOM)));
  add('S1 > 2', (b) => b.cmp('>', b.variable(S1), b.enumLit(2, DOM)));
  add('S1 >= 2', (b) => b.cmp('>=', b.variable(S1), b.enumLit(2, DOM)));
  add('S1 == S2', (b) => b.cmp('==', b.variable(S1), b.variable(S2)));
  add('S1 == 9 (code outside the domain)', (b) => b.cmp('==', b.variable(S1), b.enumLit(9, DOM)));

  /* comparisons on a number */
  add('A > 5', (b) => b.cmp('>', b.variable(A), b.numLit(5)));
  add('A == 5', (b) => b.cmp('==', b.variable(A), b.numLit(5)));
  add('5 < A', (b) => b.cmp('<', b.numLit(5), b.variable(A)));
  add('A >= 0 AND A <= 18', (b) =>
    b.and(b.cmp('>=', b.variable(A), b.numLit(0)), b.cmp('<=', b.variable(A), b.numLit(18))),
  );

  /* the correlated shapes */
  add('S1 == 1 AND S1 == 2', (b) =>
    b.and(b.cmp('==', b.variable(S1), b.enumLit(1, DOM)), b.cmp('==', b.variable(S1), b.enumLit(2, DOM))),
  );
  add('S1 == 1 OR S1 == 2', (b) =>
    b.or(b.cmp('==', b.variable(S1), b.enumLit(1, DOM)), b.cmp('==', b.variable(S1), b.enumLit(2, DOM))),
  );
  add('S1 == 1 AND S2 == 2', (b) =>
    b.and(b.cmp('==', b.variable(S1), b.enumLit(1, DOM)), b.cmp('==', b.variable(S2), b.enumLit(2, DOM))),
  );
  add('NOT (S1 == 1 AND S1 == 2)', (b) =>
    b.not(
      b.and(
        b.cmp('==', b.variable(S1), b.enumLit(1, DOM)),
        b.cmp('==', b.variable(S1), b.enumLit(2, DOM)),
      ),
    ),
  );
  add('A >= 18 AND A < 18', (b) =>
    b.and(b.cmp('>=', b.variable(A), b.numLit(18)), b.cmp('<', b.variable(A), b.numLit(18))),
  );
  add('A == 5 AND A == 18', (b) =>
    b.and(b.cmp('==', b.variable(A), b.numLit(5)), b.cmp('==', b.variable(A), b.numLit(18))),
  );
  add('A > 5 AND A < 5', (b) =>
    b.and(b.cmp('>', b.variable(A), b.numLit(5)), b.cmp('<', b.variable(A), b.numLit(5))),
  );
  add('NOT (A >= 18 AND A < 18)', (b) =>
    b.not(b.and(b.cmp('>=', b.variable(A), b.numLit(18)), b.cmp('<', b.variable(A), b.numLit(18)))),
  );

  /* booleans */
  add('B', (b) => b.variable(B));
  add('NOT B', (b) => b.not(b.variable(B)));
  add('B AND S1 == 1', (b) => b.and(b.variable(B), b.cmp('==', b.variable(S1), b.enumLit(1, DOM))));
  add('B OR NOT B', (b) => b.or(b.variable(B), b.not(b.variable(B))));
  add('B == TRUE', (b) => b.cmp('==', b.variable(B), b.boolLit(true)));
  add('TRUE', (b) => b.boolLit(true));
  add('TRUE AND S1 == 1', (b) => b.and(b.boolLit(true), b.cmp('==', b.variable(S1), b.enumLit(1, DOM))));
  add('FALSE OR S1 == 1', (b) => b.or(b.boolLit(false), b.cmp('==', b.variable(S1), b.enumLit(1, DOM))));
  add('B AND NOT B', (b) => b.and(b.variable(B), b.not(b.variable(B))));

  /* nullity */
  add('S1 == NULL', (b) => b.cmp('==', b.variable(S1), b.nullLit()));
  add('NOT (S1 == NULL)', (b) => b.not(b.cmp('==', b.variable(S1), b.nullLit())));

  /* set predicates */
  add('CONTAINS(M, S1)', (b) => b.setOp('contains', b.variable(M), b.variable(S1)));
  add('CONTAINS(M, 1)', (b) => b.setOp('contains', b.variable(M), b.enumLit(1, DOM)));
  add('ANY_OF(M, {1,2})', (b) => b.setOp('any_of', b.variable(M), b.setLit([1, 2], DOM)));
  add('NONE_OF(M, {1})', (b) => b.setOp('none_of', b.variable(M), b.setLit([1], DOM)));
  add('ALL_OF(M, {1,2})', (b) => b.setOp('all_of', b.variable(M), b.setLit([1, 2], DOM)));
  add('SUBSET_OF(M, {1,2,3})', (b) => b.setOp('subset_of', b.variable(M), b.setLit([1, 2, 3], DOM)));
  add('SET_EQ(M, {1,2})', (b) => b.setOp('set_eq', b.variable(M), b.setLit([1, 2], DOM)));
  add('ANY_OF(S1, {1,3})', (b) => b.setOp('any_of', b.variable(S1), b.setLit([1, 3], DOM)));
  add('M == {1,2}', (b) => b.cmp('==', b.variable(M), b.setLit([1, 2], DOM)));
  add('CONTAINS(M, S1) AND NONE_OF(M, {1,2,3})', (b) =>
    b.and(
      b.setOp('contains', b.variable(M), b.variable(S1)),
      b.setOp('none_of', b.variable(M), b.setLit([1, 2, 3], DOM)),
    ),
  );

  /* set algebra */
  add('CONTAINS(M UNION {1}, S1)', (b) =>
    b.setOp('contains', b.setOp('union', b.variable(M), b.setLit([1], DOM)), b.variable(S1)),
  );
  add('CONTAINS(M INTERSECT {1,2}, S1)', (b) =>
    b.setOp('contains', b.setOp('intersect', b.variable(M), b.setLit([1, 2], DOM)), b.variable(S1)),
  );
  add('CONTAINS(M DIFFERENCE {1}, S1)', (b) =>
    b.setOp('contains', b.setOp('difference', b.variable(M), b.setLit([1], DOM)), b.variable(S1)),
  );
  add('CONTAINS({} , S1)', (b) => b.setOp('contains', b.setLit([], DOM), b.variable(S1)));

  /* a set the split cannot enumerate, so every operand below it is `⊤` */
  add('ANY_OF(WIDE, {1,2})', (b) => b.setOp('any_of', b.variable(WIDE), b.setLit([1, 2], DOM_WIDE)));
  add('CONTAINS(WIDE UNION {1}, 1)', (b) =>
    b.setOp(
      'contains',
      b.setOp('union', b.variable(WIDE), b.setLit([1], DOM_WIDE)),
      b.enumLit(1, DOM_WIDE),
    ),
  );
  add('SET_EQ(WIDE INTERSECT {1}, {})', (b) =>
    b.setOp('set_eq', b.setOp('intersect', b.variable(WIDE), b.setLit([1], DOM_WIDE)), b.setLit([], DOM_WIDE)),
  );

  /* conditionals */
  add('CASE WHEN B THEN 1 ELSE 2 END == A', (b) =>
    b.cmp('==', b.caseExpr([{ when: b.variable(B), then: b.numLit(1) }], b.numLit(2)), b.variable(A)),
  );
  add('CASE WHEN B THEN 1 ELSE NULL END == 1', (b) =>
    b.cmp('==', b.caseExpr([{ when: b.variable(B), then: b.numLit(1) }], b.nullLit()), b.numLit(1)),
  );
  add('CASE WHEN TRUE THEN 1 ELSE 2 END == 1', (b) =>
    b.cmp('==', b.caseExpr([{ when: b.boolLit(true), then: b.numLit(1) }], b.numLit(1)), b.numLit(1)),
  );
  add('CASE WHEN TRUE THEN 1 ELSE 2 END == 2', (b) =>
    b.cmp('==', b.caseExpr([{ when: b.boolLit(true), then: b.numLit(1) }], b.numLit(2)), b.numLit(2)),
  );
  add('COALESCE(S1, S2) == 1', (b) =>
    b.cmp('==', b.coalesce(b.variable(S1), b.variable(S2)), b.enumLit(1, DOM)),
  );
  add('COALESCE(A, 0) > 5', (b) => b.cmp('>', b.coalesce(b.variable(A), b.numLit(0)), b.numLit(5)));

  /* probes */
  add('ANSWERED(S1)', (b) => b.probe('answered', { kind: 'variable', id: S1 }));
  add('ANSWERED(S1) AND S1 == 1', (b) =>
    b.and(
      b.probe('answered', { kind: 'variable', id: S1 }),
      b.cmp('==', b.variable(S1), b.enumLit(1, DOM)),
    ),
  );

  /* the families widened to `⊤` */
  add('STARTS_WITH(T, "a")', (b) => b.strBinary('starts_with', b.variable(TXT), b.textLit('a')));
  add('LEN(T) > 2', (b) => b.cmp('>', b.strUnary('len', b.variable(TXT)), b.numLit(2)));
  add('ABS(A) == 5', (b) => b.cmp('==', b.unArith('abs', b.variable(A)), b.numLit(5)));
  add('MIN(A, 5) > 3', (b) => b.cmp('>', b.nAryArith('min', b.variable(A), b.numLit(5)), b.numLit(3)));
  add('DATE_PART(year, 2024-01-01) == 2024', (b) =>
    b.cmp('==', b.datePart('year', b.dateLit('2024-01-01')), b.numLit(2024)),
  );

  return out;
}

function exprEnvFor(assignment: ReadonlyMap<VariableId, Value>): Parameters<typeof evalCondition>[1] {
  return {
    vars: { value: (id) => assignment.get(id) ?? NULL },
    ctx: {},
    cells: NO_CELLS,
    schema: EMPTY_SCHEMA,
  };
}

/** Every assignment over the variables the expression actually reads. */
function assignments(expr: Expr): readonly ReadonlyMap<VariableId, Value>[] {
  const ids = readsOf(expr).filter((id) => VALUES[id] !== undefined);
  let out: ReadonlyMap<VariableId, Value>[] = [new Map()];
  for (const id of ids) {
    const next: ReadonlyMap<VariableId, Value>[] = [];
    for (const base of out) {
      for (const value of VALUES[id] ?? []) {
        const extended = new Map(base);
        extended.set(id, value);
        next.push(extended);
      }
    }
    out = next;
  }
  return out;
}

describe('the abstract domain is sound', () => {
  it('never excludes a verdict the real evaluator produces, on any assignment', () => {
    const unsound: string[] = [];
    for (const condition of conditions()) {
      for (const assignment of assignments(condition.expr)) {
        const concrete = evalCondition(condition.expr, exprEnvFor(assignment));
        const abstract = verdictsOf(
          evalAbstract(condition.expr, {
            types: SOUNDNESS_ENV,
            variable: (id) => {
              const value = assignment.get(id);
              return value === undefined ? TOP : exactAbstract(value);
            },
          }),
        );
        if (!admits(abstract, concrete)) {
          unsound.push(`${condition.label}: concrete=${concrete} abstract=${show(abstract)}`);
        }
      }
    }
    expect(unsound).toEqual([]);
  });

  it('never claims unsatisfiable for a condition the brute force satisfies', () => {
    const wrong: string[] = [];
    for (const condition of conditions()) {
      const observed = new Set<Tri>();
      for (const assignment of assignments(condition.expr)) {
        observed.add(evalCondition(condition.expr, exprEnvFor(assignment)));
      }
      if (provablyNeverTrue(condition.expr, SOUNDNESS_ENV) && observed.has('T')) {
        wrong.push(`${condition.label}: claimed unsatisfiable, brute force found T`);
      }
      if (provablyAlwaysTrue(condition.expr, SOUNDNESS_ENV) && [...observed].some((t) => t !== 'T')) {
        wrong.push(`${condition.label}: claimed always true, brute force found ${[...observed].join()}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('is incomplete in the permitted direction, and the suite covers both answers', () => {
    // Not an assertion about precision so much as a guard against the suite becoming vacuous:
    // if nothing is ever proven unsatisfiable, the two tests above pass trivially.
    const proven = conditions().filter((c) => provablyNeverTrue(c.expr, SOUNDNESS_ENV));
    expect(proven.map((c) => c.label).sort()).toEqual([
      'A == 5 AND A == 18',
      'A > 5 AND A < 5',
      'A >= 18 AND A < 18',
      'B AND NOT B',
      'CASE WHEN TRUE THEN 1 ELSE 2 END == 2',
      'CONTAINS(M, S1) AND NONE_OF(M, {1,2,3})',
      'CONTAINS({} , S1)',
      'NOT (S1 == NULL)',
      'S1 == 1 AND S1 == 2',
      'S1 == 9 (code outside the domain)',
      'S1 == NULL',
    ]);
    expect(
      conditions()
        .filter((c) => provablyAlwaysTrue(c.expr, SOUNDNESS_ENV))
        .map((c) => c.label),
    ).toEqual(['TRUE', 'CASE WHEN TRUE THEN 1 ELSE 2 END == 1']);
  });
});

function admits(set: { t: boolean; f: boolean; u: boolean }, verdict: Tri): boolean {
  return verdict === 'T' ? set.t : verdict === 'F' ? set.f : set.u;
}

function show(set: { t: boolean; f: boolean; u: boolean }): string {
  return `{${[set.t ? 'T' : '', set.f ? 'F' : '', set.u ? 'U' : ''].filter((s) => s !== '').join()}}`;
}

/* ========================================================================== */
/* Fixtures for the three diagnostics                                          */
/* ========================================================================== */

interface Scene {
  readonly survey: Survey;
  readonly graph: FlowGraph;
  readonly env: TypeEnv;
  readonly rules: readonly Rule[];
  readonly diagnostics: readonly CompileDiagnostic[];
}

interface SceneSpec {
  readonly content: readonly ContentNode[];
  readonly nodes: readonly FlowNode[];
  readonly variables: readonly Variable[];
  readonly rules?: readonly LogicRule[];
  /** Replaces the lowered rules entirely, for the hand-built cases. */
  readonly override?: (scene: Omit<Scene, 'diagnostics'>) => readonly Rule[];
}

function scene(ids: IdFactory, spec: SceneSpec): Scene {
  const survey: Survey = {
    meta: { id: ids.next('survey'), ref: 'SOLV', name: 'Solver fixture' },
    schema_version: 2,
    settings: {
      navigation: { back_allowed: true },
      resume: { enabled: false, window_s: 3600, position: 'last_page' },
      progress_bar: { mode: 'none' },
      screenout: { show_message: false },
    },
    languages: {
      base: 'en',
      available: [{ code: 'en' }],
      bundles: { en: {} },
      policy: { on_missing: 'fallback_to_base', block_publish_if_incomplete: false },
    },
    variables: spec.variables,
    content: spec.content,
    flow: { nodes: spec.nodes },
    logic_rules: spec.rules ?? [],
  };
  const env = buildTypeEnvFor(survey).env;
  const graph = buildFlowGraph(survey);
  const lowered = buildRules(survey, graph, env).rules;
  const base = { survey, graph, env, rules: lowered };
  const rules = spec.override === undefined ? lowered : spec.override(base);
  return { ...base, rules, diagnostics: analyzeConditions({ survey, graph, rules, env }) };
}

function item(ids: IdFactory, ref: string, code: number): QuestionItem {
  return { id: ids.next('option'), ref, code, label: { key: `o.${ref}` }, position: code };
}

/** A single-select question and the scalar enum variable it emits, domain and all. */
interface Selected {
  readonly node: QuestionNode;
  readonly variable: Variable;
  readonly id: VariableId;
  readonly domain: DomainId;
}

function select(
  ids: IdFactory,
  ref: string,
  codes: readonly number[],
  masks?: readonly Mask[],
): Selected {
  const options = codes.map((code) => item(ids, `o${code}`, code));
  const node: QuestionNode = {
    id: ids.next('question'),
    type: 'question',
    ref,
    question_type: 'single_select',
    label: { key: `${ref}.label` },
    required: false,
    options,
    ...(masks === undefined ? {} : { masks }),
  };
  const variable: Variable = {
    id: ids.next('variable'),
    name: ref,
    kind: 'response',
    type: 'enum',
    source: { question_id: node.id, part: { kind: 'scalar' } },
    enum_domain: options.map((option) => ({ code: option.code, label_key: `o.${option.ref}` })),
    export: { include: true, column: ref },
    pii: false,
    persist: true,
  };
  return { node, variable, id: asVariableId(variable.id), domain: asDomainId(`dom_${node.id}`) };
}

function page(ids: IdFactory, ref: string, children: readonly QuestionNode[]): PageNode {
  return { id: ids.next('page'), type: 'page', ref, children };
}

function toSchema(expression: Expr): SchemaExpr {
  return expression as unknown as SchemaExpr;
}

function hideRule(id: string, target: RuleTarget, condition: SchemaExpr): LogicRule {
  return { id, kind: 'display', target, condition, effect: { action: 'hide' } } as LogicRule;
}

function codes(diagnostics: readonly CompileDiagnostic[]): readonly string[] {
  return diagnostics.map((d) => d.code);
}

function only(
  diagnostics: readonly CompileDiagnostic[],
  code: string,
): readonly CompileDiagnostic[] {
  return diagnostics.filter((d) => d.code === code);
}

/** One page, one single-select, one rule. Enough for every condition-level diagnostic. */
function onePager(
  build: (q: Selected) => readonly LogicRule[],
  options: { readonly masks?: (q: { readonly options: readonly QuestionItem[] }) => readonly Mask[] } = {},
): Scene {
  const ids = deterministicIds();
  const probe = select(ids, 'Q1', [1, 2, 3]);
  const masks = options.masks?.({ options: probe.node.options ?? [] });
  const q =
    masks === undefined
      ? probe
      : { ...probe, node: { ...probe.node, masks } };
  const p1 = page(ids, 'P1', [q.node]);
  const blockId = ids.next('block');
  const startId = ids.next('flow_node');
  const seqId = ids.next('flow_node');
  const endId = ids.next('flow_node');
  return scene(ids, {
    content: [{ id: blockId, type: 'block', ref: 'B1', children: [p1] }],
    nodes: [
      { id: startId, type: 'start', next: seqId },
      { id: seqId, type: 'sequence', target_id: p1.id, next: endId },
      { id: endId, type: 'end', disposition: 'COMPLETE' },
    ],
    variables: [q.variable],
    rules: build(q),
  });
}

/* ========================================================================== */
/* LGC-W031                                                                    */
/* ========================================================================== */

describe('LGC-W031, the unsatisfiable condition', () => {
  it('reports the canonical `S1 == 1 AND S1 == 2`', () => {
    const built = onePager((q) => {
      const b = astBuilder();
      return [
        hideRule(
          'rul_R1',
          { type: 'question', id: q.node.id },
          toSchema(
            b.and(
              b.cmp('==', b.variable(q.id), b.enumLit(1, q.domain)),
              b.cmp('==', b.variable(q.id), b.enumLit(2, q.domain)),
            ),
          ),
        ),
      ];
    });
    expect(codes(built.diagnostics)).toEqual(['LGC-W031']);
    expect(built.diagnostics[0]?.severity).toBe('warning');
    expect(built.diagnostics[0]?.path).toBe('/logic_rules/0/condition');
    expect(built.diagnostics[0]?.detail?.['rule_id']).toBe('rul_R1');
    expect(built.diagnostics[0]?.detail?.['kind']).toBe('display');
  });

  it('says nothing about a satisfiable condition', () => {
    const built = onePager((q) => {
      const b = astBuilder();
      return [
        hideRule(
          'rul_R1',
          { type: 'question', id: q.node.id },
          toSchema(
            b.or(
              b.cmp('==', b.variable(q.id), b.enumLit(1, q.domain)),
              b.cmp('==', b.variable(q.id), b.enumLit(2, q.domain)),
            ),
          ),
        ),
      ];
    });
    expect(built.diagnostics).toEqual([]);
  });

  it('leaves a bare literal condition to LGC-W030 and adds nothing', () => {
    const built = onePager((q) => [
      hideRule('rul_R1', { type: 'question', id: q.node.id }, toSchema(astBuilder().boolLit(false))),
    ]);
    expect(built.diagnostics).toEqual([]);
  });

  it('reports a code the enum domain does not contain', () => {
    const built = onePager((q) => {
      const b = astBuilder();
      return [
        hideRule(
          'rul_R1',
          { type: 'question', id: q.node.id },
          toSchema(b.cmp('==', b.variable(q.id), b.enumLit(99, q.domain))),
        ),
      ];
    });
    expect(codes(built.diagnostics)).toEqual(['LGC-W031']);
  });

  it('says nothing about a rule scoped to an unreachable flow node', () => {
    const ids = deterministicIds();
    const q = select(ids, 'Q1', [1, 2]);
    const p1 = page(ids, 'P1', [q.node]);
    const blockId = ids.next('block');
    const startId = ids.next('flow_node');
    const seqId = ids.next('flow_node');
    const islandId = ids.next('flow_node');
    const built = scene(ids, {
      content: [{ id: blockId, type: 'block', ref: 'B1', children: [p1] }],
      nodes: [
        { id: startId, type: 'start', next: seqId },
        { id: seqId, type: 'sequence', target_id: p1.id, next: null },
        { id: islandId, type: 'end', disposition: 'COMPLETE' },
      ],
      variables: [q.variable],
      override: () => {
        const b = astBuilder();
        return [
          {
            id: asRuleId('rul_DEAD'),
            kind: 'display',
            target: { type: 'page', id: asPageId(p1.id) },
            condition: b.and(
              b.cmp('==', b.variable(q.id), b.enumLit(1, q.domain)),
              b.cmp('==', b.variable(q.id), b.enumLit(2, q.domain)),
            ),
            effect: { action: 'hide' },
            evaluation: 'on_change',
            authored_in: 'visual',
            order_key: 0,
            flow_node_id: asFlowNodeId(islandId),
          },
        ];
      },
    });
    expect(built.graph.reachable.has(islandId)).toBe(false);
    expect(built.diagnostics).toEqual([]);
  });
});

/* ========================================================================== */
/* LGC-W040                                                                    */
/* ========================================================================== */

describe('LGC-W040, the option that can never be shown', () => {
  it('reports the items an always-applying include mask drops', () => {
    const built = onePager(() => [], {
      masks: ({ options }) => {
        const first = options[0];
        if (first === undefined) throw new Error('bad fixture');
        return [
          {
            id: 'msk_01HMASKMASKMASKMASKMASKMA' as Mask['id'],
            applies_to: 'options',
            mode: 'include',
            source: { kind: 'explicit', item_ids: [first.id] },
            fallback: { when_empty: 'skip_question' },
          },
        ];
      },
    });
    const found = only(built.diagnostics, 'LGC-W040');
    expect(found.map((d) => d.detail?.['code'])).toEqual([2, 3]);
    expect(found.map((d) => d.detail?.['reason'])).toEqual([
      'mask_never_includes',
      'mask_never_includes',
    ]);
    expect(found.map((d) => d.path)).toEqual([
      '/content/0/children/0/children/0/options/1',
      '/content/0/children/0/children/0/options/2',
    ]);
    expect(found[0]?.severity).toBe('warning');
    expect(found[0]?.detail?.['question_ref']).toBe('Q1');
    expect(found[0]?.detail?.['axis']).toBe('options');
  });

  it('honours the show_all fallback when a mask empties the whole axis', () => {
    const empty = (fallback: Mask['fallback']['when_empty']) =>
      onePager(() => [], {
        masks: () => [
          {
            id: 'msk_01HMASKMASKMASKMASKMASKMA' as Mask['id'],
            applies_to: 'options',
            mode: 'include',
            source: { kind: 'explicit', item_ids: [] },
            fallback: { when_empty: fallback },
          },
        ],
      });
    // Every item dropped, and the fallback shows all of them: no item is unreachable.
    expect(only(empty('show_all').diagnostics, 'LGC-W040')).toEqual([]);
    // The same mask with a fallback that does not show everything: all three are unreachable.
    expect(only(empty('skip_question').diagnostics, 'LGC-W040').length).toBe(3);
  });

  it('says nothing when the mask keeps every item', () => {
    const built = onePager(() => [], {
      masks: ({ options }) => [
        {
          id: 'msk_01HMASKMASKMASKMASKMASKMA' as Mask['id'],
          applies_to: 'options',
          mode: 'include',
          source: { kind: 'explicit', item_ids: options.map((option) => option.id) },
          fallback: { when_empty: 'skip_question' },
        },
      ],
    });
    expect(only(built.diagnostics, 'LGC-W040')).toEqual([]);
  });

  it('reports an option_state rule that always writes visible = false', () => {
    const built = onePager((q) => {
      const options = q.node.options ?? [];
      const second = options[1];
      if (second === undefined) throw new Error('bad fixture');
      return [
        {
          id: 'rul_R1',
          kind: 'option_state',
          target: { type: 'option', id: second.id },
          condition: toSchema(astBuilder().boolLit(true)),
          effect: { action: 'hide' },
        } as LogicRule,
      ];
    });
    const found = only(built.diagnostics, 'LGC-W040');
    expect(found.map((d) => d.detail?.['reason'])).toEqual(['option_state_always_hides']);
    expect(found[0]?.detail?.['code']).toBe(2);
    expect(found[0]?.path).toBe('/content/0/children/0/children/0/options/1');
  });
});

/* ========================================================================== */
/* LGC-W014                                                                    */
/* ========================================================================== */

describe('LGC-W014, a case with a null else feeding a comparison', () => {
  it('reports the comparison and the case node', () => {
    const built = onePager((q) => {
      const b = astBuilder();
      const classify = b.caseExpr(
        [{ when: b.cmp('==', b.variable(q.id), b.enumLit(1, q.domain)), then: b.numLit(1) }],
        b.nullLit(),
      );
      return [
        hideRule(
          'rul_R1',
          { type: 'question', id: q.node.id },
          toSchema(b.cmp('==', classify, b.numLit(1))),
        ),
      ];
    });
    const found = only(built.diagnostics, 'LGC-W014');
    expect(found.length).toBe(1);
    expect(found[0]?.severity).toBe('warning');
    expect(found[0]?.detail?.['rule_id']).toBe('rul_R1');
    expect(found[0]?.detail?.['comparison']).toBe('==');
    expect(found[0]?.detail?.['in_condition']).toBe(true);
    expect(found[0]?.path).toBe('/logic_rules/0/condition');
  });

  it('says nothing when the else arm has a value', () => {
    const built = onePager((q) => {
      const b = astBuilder();
      const classify = b.caseExpr(
        [{ when: b.cmp('==', b.variable(q.id), b.enumLit(1, q.domain)), then: b.numLit(1) }],
        b.numLit(0),
      );
      return [
        hideRule(
          'rul_R1',
          { type: 'question', id: q.node.id },
          toSchema(b.cmp('==', classify, b.numLit(1))),
        ),
      ];
    });
    expect(only(built.diagnostics, 'LGC-W014')).toEqual([]);
  });

  it('says nothing when the case is not compared', () => {
    const built = onePager((q) => {
      const b = astBuilder();
      return [
        {
          id: 'rul_R1',
          kind: 'terminate',
          target: { type: 'survey' },
          condition: toSchema(
            b.caseExpr(
              [{ when: b.cmp('==', b.variable(q.id), b.enumLit(1, q.domain)), then: b.boolLit(true) }],
              b.nullLit(),
            ),
          ),
          effect: { action: 'terminate', disposition: 'SCREENOUT' },
        } as LogicRule,
      ];
    });
    expect(only(built.diagnostics, 'LGC-W014')).toEqual([]);
  });
});
