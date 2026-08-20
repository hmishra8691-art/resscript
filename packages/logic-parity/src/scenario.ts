/**
 * The differential-testing scenario — ADR-004's claim, made checkable.
 *
 * ADR-004 says one logic engine, shipped as one TypeScript package, executed in both the client and
 * the server, and that "given the same variable state it returns the same verdict in both
 * environments, or we have a bug we can see." A claim like that is worth exactly as much as the
 * test that falsifies it, so this module is written to be **loaded and run unchanged in every
 * engine we care about**: it imports nothing but `@resscript/logic`, takes a seed, and returns a
 * digest string. The harness runs it in Node and inside QuickJS-WASM and compares the strings.
 *
 * Two consequences of that constraint shape this file:
 *
 *  - **The states are generated from the seed inside here, not passed in.** If the driver generated
 *    them and marshalled them across the WASM boundary, the boundary's own JSON coercion would be
 *    part of what is being compared, and a real divergence could be masked by it. Generating on
 *    both sides means the *generator* is under test too — and it is a counter-based PRNG, the same
 *    shape ADR-006 requires of the runtime's randomizer, for the same reason.
 *  - **The digest includes the whole cell vector, not just the verdicts.** A divergence in one
 *    intermediate cell that happens not to change a visible outcome today is still an engine bug,
 *    and it will change an outcome after the next authoring edit.
 */

import {
  asDomainId,
  asOptionId,
  asPageId,
  asQuestionId,
  asRuleId,
  asVariableId,
  astBuilder,
  buildTypeEnv,
  compileLogic,
  errorsOnly,
  evaluate,
  onAnswerChange,
  createEvalState,
  setValue,
  varStateOf,
  valueToJson,
  type LogicRegistryInput,
  type Rule,
  type Value,
} from '@resscript/logic';

const DOM_FRUIT = asDomainId('dom_fruit');
const DOM_SCALE = asDomainId('dom_scale');

const V_S1 = asVariableId('var_s1');
const V_AGE = asVariableId('var_age');
const V_SPEND = asVariableId('var_spend');
const V_TRIPS = asVariableId('var_trips');
const V_OE = asVariableId('var_oe');
const V_DOB = asVariableId('var_dob');
const V_NOW = asVariableId('var_now');
const V_FRUIT = asVariableId('var_fruit');
const V_F1 = asVariableId('var_f1');
const V_F2 = asVariableId('var_f2');
const V_F3 = asVariableId('var_f3');
const V_SEGMENT = asVariableId('var_segment');
const V_SKIPPED = asVariableId('var_skipped');
const V_HEAVY = asVariableId('var_heavy');

const Q_FRUIT = asQuestionId('qst_fruit');
const Q_MAIN = asQuestionId('qst_main');
const Q_AGE = asQuestionId('qst_age');
const P_ONE = asPageId('pg_one');

const OPT_F1 = asOptionId('opt_f1');
const OPT_F2 = asOptionId('opt_f2');
const OPT_F3 = asOptionId('opt_f3');

const VARIABLE_ORDER: readonly string[] = [
  V_S1,
  V_AGE,
  V_SPEND,
  V_TRIPS,
  V_OE,
  V_DOB,
  V_NOW,
  V_FRUIT,
  V_F1,
  V_F2,
  V_F3,
];

function registry(): LogicRegistryInput {
  return {
    variables: [
      { id: V_S1, name: 'S1', kind: 'response', type: 'enum', domain: DOM_SCALE, persist: true, pii: false },
      { id: V_AGE, name: 'AGE', kind: 'response', type: 'number', persist: true, pii: false, question_id: Q_AGE },
      { id: V_SPEND, name: 'SPEND', kind: 'response', type: 'number', persist: true, pii: false },
      { id: V_TRIPS, name: 'TRIPS', kind: 'response', type: 'number', persist: true, pii: false },
      { id: V_OE, name: 'OE', kind: 'response', type: 'text', persist: true, pii: false },
      { id: V_DOB, name: 'DOB', kind: 'response', type: 'date', persist: true, pii: false },
      { id: V_NOW, name: 'SERVER_TIME', kind: 'system', type: 'date', persist: true, pii: false },
      {
        id: V_FRUIT,
        name: 'FRUIT',
        kind: 'response',
        type: 'set',
        domain: DOM_FRUIT,
        persist: true,
        pii: false,
        question_id: Q_FRUIT,
        part: 'set_view',
      },
      fanOut(V_F1, 'FRUITr1', 1, OPT_F1),
      fanOut(V_F2, 'FRUITr2', 2, OPT_F2),
      fanOut(V_F3, 'FRUITr3', 3, OPT_F3),
      { id: V_SEGMENT, name: 'SEGMENT', kind: 'hidden', type: 'text', persist: true, pii: false },
      { id: V_SKIPPED, name: 'SKIPPED', kind: 'hidden', type: 'boolean', persist: true, pii: false },
      { id: V_HEAVY, name: 'HEAVY', kind: 'hidden', type: 'boolean', persist: true, pii: false },
    ],
    domains: [
      {
        id: DOM_FRUIT,
        entries: [
          { code: 1, label_key: 'fruit.apple' },
          { code: 2, label_key: 'fruit.banana' },
          { code: 3, label_key: 'fruit.cherry' },
        ],
        ordinal: false,
      },
      {
        id: DOM_SCALE,
        entries: [1, 2, 3, 4, 5].map((code) => ({ code, label_key: `scale.${String(code)}` })),
        ordinal: true,
      },
    ],
    questions: [
      {
        id: Q_FRUIT,
        ref: 'FRUIT',
        page_id: P_ONE,
        required: false,
        domain: DOM_FRUIT,
        options: [
          { option_id: OPT_F1, code: 1, label_key: 'fruit.apple', position: 0, variable_id: V_F1 },
          { option_id: OPT_F2, code: 2, label_key: 'fruit.banana', position: 1, variable_id: V_F2 },
          {
            option_id: OPT_F3,
            code: 3,
            label_key: 'fruit.cherry',
            position: 2,
            variable_id: V_F3,
            meta: { discontinued: true },
          },
        ],
        rows: [],
        columns: [],
        emits: [V_F1, V_F2, V_F3, V_FRUIT],
      },
      { id: Q_MAIN, ref: 'MAIN', page_id: P_ONE, required: false, options: [], rows: [], columns: [], emits: [] },
      { id: Q_AGE, ref: 'AGEQ', page_id: P_ONE, required: false, options: [], rows: [], columns: [], emits: [V_AGE] },
    ],
    pages: [{ id: P_ONE, question_ids: [Q_FRUIT, Q_MAIN, Q_AGE] }],
  };
}

function fanOut(
  id: ReturnType<typeof asVariableId>,
  name: string,
  code: number,
  optionId: ReturnType<typeof asOptionId>,
): LogicRegistryInput['variables'][number] {
  return {
    id,
    name,
    kind: 'response',
    type: 'boolean',
    persist: true,
    pii: false,
    question_id: Q_FRUIT,
    part: 'option',
    code,
    option_id: optionId,
  };
}

/**
 * Rules chosen to cover the constructs where two engines are most likely to disagree: floating
 * point (`SPEND / TRIPS`), string handling (`word_count` over a unicode-ish open end), the calendar
 * (a date-diff age), set operations, an aggregation with a per-item predicate, and a `case` whose
 * arms can be UNKNOWN. Plus the D §4.3 chain, so ordering is part of what is compared.
 */
function rules(): readonly Rule[] {
  const out: Rule[] = [];

  const b1 = astBuilder(1);
  out.push({
    id: asRuleId('rul_segment'),
    kind: 'set_variable',
    target: { type: 'variable', id: V_SEGMENT },
    condition: b1.boolLit(true),
    effect: {
      action: 'set',
      variable_id: V_SEGMENT,
      value: b1.caseExpr(
        [
          { when: b1.cmp('<', b1.variable(V_AGE), b1.numLit(35)), then: b1.textLit('young') },
          { when: b1.cmp('>=', b1.variable(V_AGE), b1.numLit(65)), then: b1.textLit('senior') },
        ],
        b1.textLit('old'),
      ),
    },
    evaluation: 'on_change',
    authored_in: 'dsl',
    order_key: 1,
  });

  const b2 = astBuilder(1000);
  out.push({
    id: asRuleId('rul_heavy'),
    kind: 'set_variable',
    target: { type: 'variable', id: V_HEAVY },
    condition: b2.and(
      b2.setOp('contains', b2.variable(V_FRUIT), b2.enumLit(1, DOM_FRUIT)),
      b2.cmp('>', b2.binArith('/', b2.variable(V_SPEND), b2.variable(V_TRIPS)), b2.numLit(12.5)),
      b2.or(
        b2.cmp('==', b2.variable(V_S1), b2.enumLit(1, DOM_SCALE)),
        b2.and(
          b2.cmp(
            '>=',
            b2.agg({
              fn: 'count',
              over: { kind: 'question_emits', question_id: Q_FRUIT },
              where: b2.itemAttr('selected'),
            }),
            b2.numLit(2),
          ),
          b2.setOp('none_of', b2.variable(V_FRUIT), b2.setLit([3], DOM_FRUIT)),
        ),
      ),
      b2.not(b2.cmp('<', b2.dateDiff('year', b2.variable(V_DOB), b2.variable(V_NOW)), b2.numLit(18))),
    ),
    effect: { action: 'set', variable_id: V_HEAVY, value: b2.boolLit(true) },
    evaluation: 'on_change',
    authored_in: 'dsl',
    order_key: 2,
  });

  const b3 = astBuilder(2000);
  out.push({
    id: asRuleId('rul_show_main'),
    kind: 'display',
    target: { type: 'question', id: Q_MAIN },
    condition: b3.or(
      b3.cmp('==', b3.variable(V_SEGMENT), b3.textLit('young')),
      b3.cmp('>=', b3.strUnary('word_count', b3.variable(V_OE)), b3.numLit(3)),
    ),
    effect: { action: 'show' },
    evaluation: 'on_change',
    authored_in: 'dsl',
    order_key: 3,
  });

  const b4 = astBuilder(3000);
  out.push({
    id: asRuleId('rul_skipped'),
    kind: 'set_variable',
    target: { type: 'variable', id: V_SKIPPED },
    condition: b4.not(b4.probe('shown', { kind: 'question', id: Q_MAIN })),
    effect: { action: 'set', variable_id: V_SKIPPED, value: b4.boolLit(true) },
    evaluation: 'on_change',
    authored_in: 'dsl',
    order_key: 4,
  });

  const b5 = astBuilder(4000);
  out.push({
    id: asRuleId('rul_mask'),
    kind: 'mask',
    target: { type: 'question', id: Q_FRUIT },
    condition: b5.cmp('!=', b5.variable(V_SEGMENT), b5.textLit('senior')),
    effect: {
      action: 'mask',
      applies_to: 'options',
      mode: 'exclude',
      per_item: b5.itemAttr('code', 'discontinued'),
      fallback: { when_empty: 'show_all' },
    },
    evaluation: 'on_change',
    authored_in: 'dsl',
    order_key: 5,
  });

  const b6 = astBuilder(5000);
  out.push({
    id: asRuleId('rul_terminate'),
    kind: 'terminate',
    target: { type: 'survey' },
    condition: b6.cmp('<', b6.variable(V_AGE), b6.numLit(18)),
    effect: { action: 'terminate', disposition: 'SCREENOUT' },
    evaluation: 'on_submit',
    authored_in: 'dsl',
    order_key: 6,
  });

  const b7 = astBuilder(6000);
  out.push({
    id: asRuleId('rul_validate'),
    kind: 'validate',
    target: { type: 'question', id: Q_FRUIT },
    condition: b7.cmp('>', b7.strUnary('len', b7.variable(V_OE)), b7.numLit(2)),
    effect: { action: 'require_valid', message_key: 'err.short', scope: 'field' },
    evaluation: 'on_submit',
    authored_in: 'dsl',
    order_key: 7,
  });

  const b8 = astBuilder(7000);
  out.push({
    id: asRuleId('rul_option'),
    kind: 'option_state',
    target: { type: 'option', id: OPT_F2 },
    condition: b8.cmp('>', b8.variable(V_TRIPS), b8.numLit(3)),
    effect: { action: 'option_state', option_id: OPT_F2, prop: 'enabled', value: b8.boolLit(false) },
    evaluation: 'on_change',
    authored_in: 'dsl',
    order_key: 8,
  });

  return out;
}

/* ========================================================================== */
/* State generation                                                           */
/* ========================================================================== */

/**
 * SplitMix32. A counter-based PRNG, so `state(seed, i)` is a pure function and a divergence found
 * at i = 417 can be re-run at i = 417 — the same replay property ADR-006 demands of the runtime.
 * `Math.random` would make a parity failure unreproducible, which is the one thing a parity test
 * must never be.
 */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x9e3779b9) >>> 0;
    let z = state;
    z = Math.imul(z ^ (z >>> 16), 0x21f0aaad) >>> 0;
    z = Math.imul(z ^ (z >>> 15), 0x735a2d97) >>> 0;
    return (z ^ (z >>> 15)) >>> 0;
  };
}

/**
 * One generated respondent. Roughly a third of the values are left unset on purpose: the states
 * that matter for parity are the null-heavy ones, because that is where the three-valued semantics
 * and the collapse are doing work.
 */
function generateState(seed: number): { readonly [id: string]: Value } {
  const next = prng(seed);
  const state: { [id: string]: Value } = {};
  const maybe = (probability: number): boolean => next() % 100 < probability;

  if (maybe(70)) state[V_S1] = { k: 'enum', v: (next() % 5) + 1, d: DOM_SCALE };
  if (maybe(70)) state[V_AGE] = { k: 'num', v: next() % 90 };
  if (maybe(65)) state[V_SPEND] = { k: 'num', v: (next() % 100000) / 100 };
  // TRIPS is deliberately allowed to be 0, so `SPEND / TRIPS` divides by zero on some states.
  if (maybe(65)) state[V_TRIPS] = { k: 'num', v: next() % 6 };
  if (maybe(60)) state[V_OE] = { k: 'text', v: OPEN_ENDS[next() % OPEN_ENDS.length] ?? '' };
  if (maybe(60)) state[V_DOB] = { k: 'date', v: DATES[next() % DATES.length] ?? '2000-01-01' };
  state[V_NOW] = { k: 'date', v: '2026-08-20T09:15:00Z' };
  if (maybe(70)) {
    const codes: number[] = [];
    for (const [index, id] of [V_F1, V_F2, V_F3].entries()) {
      const selected = next() % 2 === 0;
      state[id] = { k: 'bool', v: selected };
      if (selected) codes.push(index + 1);
    }
    state[V_FRUIT] = setValue(codes, DOM_FRUIT);
  }
  return state;
}

const OPEN_ENDS: readonly string[] = [
  '',
  '  ',
  'ok',
  'three whole words',
  'a much longer answer with several words in it',
  'ÜNICODE ünïcode',
  '\t tabbed \t answer \t',
];

const DATES: readonly string[] = [
  '1960-02-29',
  '1990-06-15',
  '2008-12-31',
  '2009-01-01',
  '2026-08-20',
  '2000-01-01T00:00:00Z',
];

/* ========================================================================== */
/* The digest                                                                 */
/* ========================================================================== */

export interface ScenarioRequest {
  readonly seed: number;
  readonly states: number;
}

/**
 * Compile once, then evaluate every generated state twice — once from scratch and once
 * incrementally from the previous state — and fold everything into one string.
 *
 * Running both paths is the point: the client patches incrementally and the server evaluates from
 * scratch on submit (ADR-004), so "same engine, same state, same verdict" has to hold *across the
 * two code paths* as well as across the two engines. A parity test that only ran full evaluations
 * would miss a dirty-set bug entirely.
 */
export function runScenario(request: ScenarioRequest): string {
  const env = buildTypeEnv(registry());
  const program = compileLogic(rules(), env);
  const errors = errorsOnly(program.diagnostics);

  const lines: string[] = [
    `diagnostics ${JSON.stringify(program.diagnostics.map((d) => `${d.code}@${d.path}`))}`,
    `errors ${String(errors.length)}`,
    `cells ${JSON.stringify(program.cellKeys)}`,
    `topo ${JSON.stringify([...program.topo].map((cell) => program.cellKeys[cell]))}`,
    `nodes ${String(program.nodeCount)}`,
  ];

  const incrementalState = createEvalState(program.cells.length, program.nodeCount);
  const carried: { [id: string]: Value } = {};
  const carriedVars = varStateOf(carried);
  evaluate(program, carriedVars, {}, { state: incrementalState });

  for (let i = 0; i < request.states; i += 1) {
    const generated = generateState(request.seed + i);

    const full = evaluate(program, varStateOf(generated), {});

    // Move the carried state to exactly `generated`, then propagate the delta.
    const changed: ReturnType<typeof asVariableId>[] = [];
    for (const id of VARIABLE_ORDER) {
      const before = carried[id];
      const after = generated[id];
      if (JSON.stringify(before ?? null) !== JSON.stringify(after ?? null)) {
        if (after === undefined) delete carried[id];
        else carried[id] = after;
        changed.push(asVariableId(id));
      }
    }
    const incremental = onAnswerChange(program, changed, carriedVars, {}, incrementalState);

    lines.push(
      [
        `#${String(i)}`,
        `in=${JSON.stringify(VARIABLE_ORDER.map((id) => valueToJson(generated[id] ?? { k: 'null' })))}`,
        `full=${JSON.stringify(full.cells)}`,
        `incr=${JSON.stringify(incremental.cells)}`,
        `term=${JSON.stringify(full.termination ?? null)}`,
        `valid=${JSON.stringify(full.validations)}`,
        `masks=${JSON.stringify(full.maskFallbacks)}`,
      ].join(' '),
    );
  }

  return lines.join('\n');
}
