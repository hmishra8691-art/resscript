/**
 * The fixture survey every test in this package shares.
 *
 * It is deliberately one survey rather than a per-test ad hoc registry: the interesting bugs in a
 * logic engine are interactions (a mask feeding a count feeding a display rule feeding a skip
 * counter), and interactions only appear when the pieces coexist. It carries, on purpose:
 *
 *  - an **ordinal** domain and a **nominal** one, so `<` can be legal on one and rejected on the
 *    other (D §3.3's "top 2 box on a brand list" bug),
 *  - a multi-select fanned out to booleans **plus** its derived set view (schema §1), so
 *    `Q5 ANY_OF [1,3]` and `Q5r1 == TRUE` exercise the same machinery,
 *  - a question on a later page than the rules that read it, so forward reads produce `U`,
 *  - the exact four rules of D §4.3, which is the fixture the roadmap's acceptance criteria name.
 */

import type { Expr, LiteralValue } from '../ast.js';
import { astBuilder, type AstBuilder } from '../build.js';
import {
  asDomainId,
  asOptionId,
  asPageId,
  asQuestionId,
  asRuleId,
  asVariableId,
  type OptionId,
  type VariableId,
} from '../ids.js';
import { buildTypeEnv, type LogicRegistryInput, type TypeEnv, type VarDecl } from '../registry.js';
import type { Effect, Rule, RuleKind, Target } from '../rules.js';
import type { Value } from '../value.js';

/* ---- ids ----------------------------------------------------------------- */

export const DOM = {
  s1: asDomainId('dom_s1'),
  q5: asDomainId('dom_q5'),
  scale: asDomainId('dom_scale'),
  brand: asDomainId('dom_brand'),
} as const;

export const V = {
  s1: asVariableId('var_s1'),
  age: asVariableId('var_age'),
  q9: asVariableId('var_q9'),
  q6: asVariableId('var_q6'),
  segment: asVariableId('var_segment'),
  skipped: asVariableId('var_skipped'),
  heavy: asVariableId('var_heavy'),
  q5set: asVariableId('var_q5set'),
  q5r1: asVariableId('var_q5r1'),
  q5r2: asVariableId('var_q5r2'),
  q5r3: asVariableId('var_q5r3'),
  q5r99: asVariableId('var_q5r99'),
  scale: asVariableId('var_scale'),
  brand: asVariableId('var_brand'),
  openEnd: asVariableId('var_openend'),
  dob: asVariableId('var_dob'),
  serverTime: asVariableId('var_server_time'),
  ageBand: asVariableId('var_age_band'),
} as const;

export const Q = {
  q5: asQuestionId('qst_q5'),
  q6: asQuestionId('qst_q6'),
  q9: asQuestionId('qst_q9'),
  q12: asQuestionId('qst_q12'),
} as const;

export const P = {
  p1: asPageId('pg_1'),
  p2: asPageId('pg_2'),
  p3: asPageId('pg_3'),
} as const;

export const OPT = {
  q5_1: asOptionId('opt_q5_1'),
  q5_2: asOptionId('opt_q5_2'),
  q5_3: asOptionId('opt_q5_3'),
  q5_99: asOptionId('opt_q5_99'),
  q12_4: asOptionId('opt_q12_4'),
} as const;

/* ---- registry ------------------------------------------------------------ */

function response(id: VariableId, name: string, extra: Partial<VarDecl> = {}): VarDecl {
  return { id, name, kind: 'response', type: 'text', persist: true, pii: false, ...extra };
}

const q5Options: readonly {
  readonly option_id: OptionId;
  readonly code: number;
  readonly variable_id: VariableId;
  readonly label_key: string;
  readonly position: number;
  readonly meta?: { readonly [key: string]: string | number | boolean | null };
}[] = [
  { option_id: OPT.q5_1, code: 1, variable_id: V.q5r1, label_key: 'q5.apple', position: 0 },
  { option_id: OPT.q5_2, code: 2, variable_id: V.q5r2, label_key: 'q5.banana', position: 1 },
  {
    option_id: OPT.q5_3,
    code: 3,
    variable_id: V.q5r3,
    label_key: 'q5.cherry',
    position: 2,
    meta: { discontinued: true },
  },
  {
    option_id: OPT.q5_99,
    code: 99,
    variable_id: V.q5r99,
    label_key: 'q5.none',
    position: 3,
    meta: { discontinued: false },
  },
];

export function registryInput(overrides: Partial<LogicRegistryInput> = {}): LogicRegistryInput {
  const variables: VarDecl[] = [
    response(V.s1, 'S1', { type: 'enum', domain: DOM.s1 }),
    response(V.age, 'AGE', { type: 'number', question_id: Q.q9 }),
    response(V.q9, 'Q9', { type: 'number', question_id: Q.q9 }),
    response(V.q6, 'Q6', { type: 'number', question_id: Q.q6 }),
    response(V.scale, 'SCALE', { type: 'enum', domain: DOM.scale }),
    response(V.brand, 'BRAND', { type: 'enum', domain: DOM.brand }),
    response(V.openEnd, 'OE', { type: 'text' }),
    response(V.dob, 'DOB', { type: 'date' }),
    { id: V.serverTime, name: 'SERVER_TIME', kind: 'system', type: 'date', persist: true, pii: false },
    response(V.q5set, 'Q5', {
      type: 'set',
      domain: DOM.q5,
      question_id: Q.q5,
      part: 'set_view',
    }),
    ...q5Options.map((option) =>
      response(option.variable_id, `Q5r${String(option.code)}`, {
        type: 'boolean',
        question_id: Q.q5,
        part: 'option',
        code: option.code,
        option_id: option.option_id,
      }),
    ),
    { id: V.segment, name: 'SEGMENT', kind: 'hidden', type: 'text', persist: true, pii: false },
    { id: V.skipped, name: 'SKIPPED_MAIN', kind: 'hidden', type: 'boolean', persist: true, pii: false },
    { id: V.heavy, name: 'HEAVY_BUYER', kind: 'hidden', type: 'boolean', persist: true, pii: false },
  ];

  return {
    variables,
    domains: [
      { id: DOM.s1, entries: [{ code: 1, label_key: 's1.yes' }, { code: 2, label_key: 's1.no' }], ordinal: false },
      {
        id: DOM.q5,
        entries: q5Options.map((option) => ({ code: option.code, label_key: option.label_key })),
        ordinal: false,
      },
      {
        // A Likert scale: ordinal, so `<` is legal on it (D §3.3).
        id: DOM.scale,
        entries: [1, 2, 3, 4, 5].map((code) => ({ code, label_key: `scale.${String(code)}` })),
        ordinal: true,
      },
      {
        // A brand list: nominal, so `<` on it is LGC-T009.
        id: DOM.brand,
        entries: [1, 2, 3].map((code) => ({ code, label_key: `brand.${String(code)}` })),
        ordinal: false,
      },
    ],
    questions: [
      {
        id: Q.q5,
        ref: 'Q5',
        page_id: P.p1,
        required: true,
        domain: DOM.q5,
        options: q5Options.map((option) => ({
          option_id: option.option_id,
          code: option.code,
          label_key: option.label_key,
          position: option.position,
          variable_id: option.variable_id,
          ...(option.meta === undefined ? {} : { meta: option.meta }),
        })),
        rows: [],
        columns: [],
        emits: [...q5Options.map((option) => option.variable_id), V.q5set],
      },
      { id: Q.q6, ref: 'Q6', page_id: P.p1, required: false, options: [], rows: [], columns: [], emits: [V.q6] },
      {
        id: Q.q9,
        ref: 'Q9',
        page_id: P.p3,
        required: false,
        options: [],
        rows: [],
        columns: [],
        emits: [V.q9, V.age],
      },
      { id: Q.q12, ref: 'Q12', page_id: P.p2, required: false, options: [], rows: [], columns: [], emits: [] },
    ],
    pages: [
      { id: P.p1, question_ids: [Q.q5, Q.q6] },
      { id: P.p2, question_ids: [Q.q12] },
      { id: P.p3, question_ids: [Q.q9] },
    ],
    ...overrides,
  };
}

export function env(overrides: Partial<LogicRegistryInput> = {}): TypeEnv {
  return buildTypeEnv(registryInput(overrides));
}

export const LABELS: { readonly [key: string]: string } = {
  'q5.apple': 'Apple',
  'q5.banana': 'Banana',
  'q5.cherry': 'Cherry',
  'q5.none': 'None of these',
  's1.yes': 'Yes',
  's1.no': 'No',
};

/* ---- rule construction --------------------------------------------------- */

export interface RuleSpec {
  readonly id: string;
  readonly kind: RuleKind;
  readonly target: Target;
  readonly condition: Expr;
  readonly effect: Effect;
  readonly order_key: number;
  readonly on_unknown?: 'default' | 'fire';
  readonly priority_group?: string;
  readonly label?: string;
}

export function rule(spec: RuleSpec): Rule {
  return {
    id: asRuleId(spec.id),
    kind: spec.kind,
    target: spec.target,
    condition: spec.condition,
    effect: spec.effect,
    evaluation: 'on_change',
    authored_in: 'dsl',
    order_key: spec.order_key,
    ...(spec.on_unknown === undefined ? {} : { on_unknown: spec.on_unknown }),
    ...(spec.priority_group === undefined ? {} : { priority_group: spec.priority_group }),
    ...(spec.label === undefined ? {} : { label: spec.label }),
  };
}

export function builder(): AstBuilder {
  return astBuilder(1);
}

export function lit(value: LiteralValue): Expr {
  return builder().lit(value);
}

/* ---- the D §4.3 four-rule fixture ---------------------------------------- */

/**
 * The four rules D §4.3 uses to argue that order is a real problem:
 *
 *     R1: SET SEGMENT = CASE WHEN AGE < 35 THEN "young" ELSE "old" END
 *     R2: IF SEGMENT = "young" THEN SHOW Q12
 *     R3: IF NOT SHOWN(Q12) THEN SET SKIPPED_MAIN = TRUE
 *     R4: HIDE Q12 OPTION 4 IF SEGMENT = "old"
 *
 * R3 is the load-bearing one: it makes a `value` cell depend on a `visible` cell, which inverts
 * the phase order. An implementation that treats phases as evaluation passes rather than as a
 * tie-break cannot express it, and ends up with a `shown` probe that reads last page's answer.
 */
export function fourRules(): readonly Rule[] {
  const b1 = astBuilder(100);
  const r1 = rule({
    id: 'rul_r1',
    kind: 'set_variable',
    target: { type: 'variable', id: V.segment },
    condition: b1.boolLit(true),
    effect: {
      action: 'set',
      variable_id: V.segment,
      value: b1.caseExpr(
        [{ when: b1.cmp('<', b1.variable(V.age), b1.numLit(35)), then: b1.textLit('young') }],
        b1.textLit('old'),
      ),
    },
    order_key: 1,
    label: 'Segment',
  });

  const b2 = astBuilder(200);
  const r2 = rule({
    id: 'rul_r2',
    kind: 'display',
    target: { type: 'question', id: Q.q12 },
    condition: b2.cmp('==', b2.variable(V.segment), b2.textLit('young')),
    effect: { action: 'show' },
    order_key: 2,
    label: 'Show Q12 to the young segment',
  });

  const b3 = astBuilder(300);
  const r3 = rule({
    id: 'rul_r3',
    kind: 'set_variable',
    target: { type: 'variable', id: V.skipped },
    condition: b3.not(b3.probe('shown', { kind: 'question', id: Q.q12 })),
    effect: { action: 'set', variable_id: V.skipped, value: b3.boolLit(true) },
    order_key: 3,
    label: 'Record the skip',
  });

  const b4 = astBuilder(400);
  const r4 = rule({
    id: 'rul_r4',
    kind: 'option_state',
    target: { type: 'option', id: OPT.q12_4 },
    condition: b4.cmp('==', b4.variable(V.segment), b4.textLit('old')),
    effect: { action: 'option_state', option_id: OPT.q12_4, prop: 'visible', value: b4.boolLit(false) },
    order_key: 4,
    label: 'Hide option 4 for the old segment',
  });

  return [r1, r2, r3, r4];
}

/* ---- a synthetic tracker, for the incremental and performance budgets ---- */

export interface Tracker {
  readonly env: TypeEnv;
  readonly rules: readonly Rule[];
  readonly variables: readonly VariableId[];
  /** A fully-answered state, so no cell is trivially unknown. */
  readonly answers: { readonly [id: string]: Value };
}

/**
 * `count` rules over `count` response variables, shaped like a real tracker rather than like a
 * benchmark: every rule shares one screener subexpression (so CSE has something to do, D §5.4 —
 * the measured case was a screener appearing in forty rules), one rule in five writes a hidden
 * variable that the next rule reads (so there are dependency chains rather than a flat fan-out),
 * and the rest are display rules on their own question.
 *
 * D §5.1's arithmetic for the budget assumes ~7 nodes per rule; this generator produces 6–9.
 */
export function tracker(count: number): Tracker {
  const variables: VarDecl[] = [
    response(V.s1, 'S1', { type: 'enum', domain: DOM.s1 }),
    response(V.age, 'AGE', { type: 'number' }),
  ];
  const responseVars: VariableId[] = [];
  const questionIds: string[] = [];

  for (let i = 0; i < count; i += 1) {
    const id = asVariableId(`var_t${String(i)}`);
    const questionId = asQuestionId(`qst_t${String(i)}`);
    responseVars.push(id);
    questionIds.push(questionId);
    variables.push(response(id, `T${String(i)}`, { type: 'number', question_id: questionId }));
    if (i % 5 === 0) {
      variables.push({
        id: asVariableId(`var_h${String(i)}`),
        name: `H${String(i)}`,
        kind: 'hidden',
        type: 'number',
        persist: true,
        pii: false,
      });
    }
  }

  const environment = buildTypeEnv({
    variables,
    domains: [
      { id: DOM.s1, entries: [{ code: 1, label_key: 's1.yes' }, { code: 2, label_key: 's1.no' }], ordinal: false },
    ],
    questions: questionIds.map((id, i) => ({
      id: asQuestionId(id),
      ref: `T${String(i)}`,
      required: false,
      options: [],
      rows: [],
      columns: [],
      emits: [asVariableId(`var_t${String(i)}`)],
    })),
  });

  const rules: Rule[] = [];
  for (let i = 0; i < count; i += 1) {
    const b = astBuilder(i * 100 + 1);
    const target = asVariableId(`var_t${String(i)}`);
    // The shared screener: identical subtree in every rule, which is what CSE collapses.
    const screener = b.and(
      b.cmp('==', b.variable(V.s1), b.enumLit(1, DOM.s1)),
      b.cmp('>=', b.variable(V.age), b.numLit(18)),
    );
    const own = b.cmp('>', b.variable(target), b.numLit(5));
    const chained =
      i % 5 === 0
        ? undefined
        : b.cmp('>', b.variable(asVariableId(`var_h${String(i - (i % 5))}`)), b.numLit(0));
    const condition = chained === undefined ? b.and(screener, own) : b.and(screener, own, chained);

    rules.push(
      i % 5 === 0
        ? rule({
            id: `rul_h${String(i)}`,
            kind: 'set_variable',
            target: { type: 'variable', id: asVariableId(`var_h${String(i)}`) },
            condition,
            effect: { action: 'set', variable_id: asVariableId(`var_h${String(i)}`), value: b.numLit(i + 1) },
            order_key: i,
          })
        : rule({
            id: `rul_d${String(i)}`,
            kind: 'display',
            target: { type: 'question', id: asQuestionId(`qst_t${String(i)}`) },
            condition,
            effect: { action: 'show' },
            order_key: i,
          }),
    );
  }

  const answers: { [id: string]: Value } = {
    [V.s1]: { k: 'enum', v: 1, d: DOM.s1 },
    [V.age]: { k: 'num', v: 34 },
  };
  responseVars.forEach((id, i) => {
    answers[id] = { k: 'num', v: i % 11 };
  });

  return { env: environment, rules, variables: responseVars, answers };
}

/* ---- a deterministic shuffle -------------------------------------------- */

/**
 * `Math.random` is banned in this package (ADR-006) and it would be the wrong tool anyway: a
 * shuffle test that fails on run 617 of 1,000 is only useful if run 617 can be reproduced. This is
 * a counter-based PRNG (SplitMix32) so `shuffle(xs, seed)` is a pure function — the same property
 * the runtime's randomizer has, for the same reason.
 */
export function shuffle<T>(items: readonly T[], seed: number): readonly T[] {
  const out = [...items];
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x9e3779b9) >>> 0;
    let z = state;
    z = Math.imul(z ^ (z >>> 16), 0x21f0aaad) >>> 0;
    z = Math.imul(z ^ (z >>> 15), 0x735a2d97) >>> 0;
    return (z ^ (z >>> 15)) >>> 0;
  };
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = next() % (i + 1);
    const a = out[i];
    const b = out[j];
    if (a === undefined || b === undefined) continue;
    out[i] = b;
    out[j] = a;
  }
  return out;
}
