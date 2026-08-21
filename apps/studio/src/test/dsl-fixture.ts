/**
 * The registry the code-editor suite shares.
 *
 * `packages/rescript-dsl` has a richer fixture (`src/__fixtures__/survey.ts`), but it is not part
 * of that package's `exports` map and reaching into a sibling's source would couple this app to
 * another package's test layout. So this is a deliberately small restatement carrying only the
 * shapes the editor services actually branch on:
 *
 *  - a **nominal** enum domain (`dom_s1`) and an **ordinal** one (`dom_scale`), so
 *    "which operators are legal here" has a case that differs between two enums — D §3.3's
 *    top-2-box bug is the reason completion must not offer `<` on a brand list;
 *  - a `set<enum>` variable (`Q5`) with real option labels, so an enum-code completion has
 *    something to put in `detail` and `documentation` (§7.4);
 *  - a question on a **later page** (`Q_AGE` on P3) plus a flow order, so forward-reference
 *    marking is testable rather than vacuous;
 *  - a hidden variable (`HEAVY_BUYER`), which is set at entry and therefore never forward.
 */

import type {
  EnumDomain,
  ItemDecl,
  LogicRegistryInput,
  QuestionDecl,
  QuestionId,
  VarDecl,
} from '@resscript/logic';
import {
  asDomainId,
  asOptionId,
  asPageId,
  asQuestionId,
  asVariableId,
} from '@resscript/logic';
import { dslRegistry, type DslRegistry, type NodeIndex } from '@resscript/rescript-dsl';
import type { FlowOrder } from '@/code-editor/completion';

export const DOM = {
  s1: asDomainId('dom_s1'),
  fruit: asDomainId('dom_fruit'),
  scale: asDomainId('dom_scale'),
} as const;

export const Q = {
  s1: asQuestionId('qst_s1'),
  q5: asQuestionId('qst_q5'),
  q9: asQuestionId('qst_q9'),
  q12: asQuestionId('qst_q12'),
  age: asQuestionId('qst_age'),
} as const;

export const P = {
  p1: asPageId('pg_1'),
  p2: asPageId('pg_2'),
  p3: asPageId('pg_3'),
} as const;

export const V = {
  s1: asVariableId('var_s1'),
  q5: asVariableId('var_q5'),
  q9: asVariableId('var_q9'),
  age: asVariableId('var_age'),
  heavy: asVariableId('var_heavy_buyer'),
  segment: asVariableId('var_segment'),
} as const;

interface Item {
  readonly ref: string;
  readonly code: number;
  readonly labelKey: string;
}

export const FRUIT: readonly Item[] = [
  { ref: 'Alpha', code: 1, labelKey: 'fruit.alpha' },
  { ref: 'Beta', code: 2, labelKey: 'fruit.beta' },
  { ref: 'Gamma', code: 3, labelKey: 'fruit.gamma' },
  { ref: 'None', code: 99, labelKey: 'fruit.none' },
];

const SCALE: readonly Item[] = [1, 2, 3, 4, 5].map((code) => ({
  ref: `p${String(code)}`,
  code,
  labelKey: `scale.${String(code)}`,
}));

const YES_NO: readonly Item[] = [
  { ref: 'Yes', code: 1, labelKey: 's1.yes' },
  { ref: 'No', code: 2, labelKey: 's1.no' },
];

function items(prefix: string, list: readonly Item[]): readonly ItemDecl[] {
  return list.map((item, index) => ({
    option_id: asOptionId(`opt_${prefix}_${String(item.code)}`),
    code: item.code,
    label_key: item.labelKey,
    position: index,
    ref: item.ref,
  }));
}

export function registryInput(): LogicRegistryInput {
  const variables: readonly VarDecl[] = [
    { id: V.s1, name: 'S1', kind: 'response', type: 'enum', domain: DOM.s1, persist: true, pii: false, question_id: Q.s1 },
    { id: V.q5, name: 'Q5', kind: 'response', type: 'set', domain: DOM.fruit, persist: true, pii: false, question_id: Q.q5, part: 'set_view' },
    { id: V.q9, name: 'Q9', kind: 'response', type: 'enum', domain: DOM.scale, persist: true, pii: false, question_id: Q.q9 },
    { id: V.age, name: 'AGE', kind: 'response', type: 'number', persist: true, pii: false, question_id: Q.age },
    { id: V.heavy, name: 'HEAVY_BUYER', kind: 'hidden', type: 'boolean', persist: true, pii: false },
    { id: V.segment, name: 'SEGMENT', kind: 'hidden', type: 'text', persist: true, pii: false },
  ];

  const domains: readonly EnumDomain[] = [
    { id: DOM.s1, entries: YES_NO.map((i) => ({ code: i.code, label_key: i.labelKey })), ordinal: false },
    // Nominal: `Q5 < …` must be LGC-T009, and completion must therefore not offer `<`.
    { id: DOM.fruit, entries: FRUIT.map((i) => ({ code: i.code, label_key: i.labelKey })), ordinal: false },
    // Ordinal: `Q9 > 3` is legal.
    { id: DOM.scale, entries: SCALE.map((i) => ({ code: i.code, label_key: i.labelKey })), ordinal: true },
  ];

  const questions: readonly QuestionDecl[] = [
    { id: Q.s1, ref: 'S1', page_id: P.p1, required: true, domain: DOM.s1, options: items('s1', YES_NO), rows: [], columns: [], emits: [V.s1] },
    { id: Q.q5, ref: 'Q5', page_id: P.p1, required: true, domain: DOM.fruit, options: items('q5', FRUIT), rows: [], columns: [], emits: [V.q5] },
    { id: Q.q9, ref: 'Q9', page_id: P.p2, required: false, domain: DOM.scale, options: items('q9', SCALE), rows: [], columns: [], emits: [V.q9] },
    { id: Q.q12, ref: 'Q12', page_id: P.p2, required: false, options: [], rows: [], columns: [], emits: [] },
    // Last page on purpose: a rule on P1 that reads AGE is a real forward reference.
    { id: Q.age, ref: 'Q_AGE', page_id: P.p3, required: false, options: [], rows: [], columns: [], emits: [V.age] },
  ];

  return {
    variables,
    domains,
    questions,
    pages: [
      { id: P.p1, question_ids: [Q.s1, Q.q5] },
      { id: P.p2, question_ids: [Q.q9, Q.q12] },
      { id: P.p3, question_ids: [Q.age] },
    ],
  };
}

const PAGE_REFS: { readonly [ref: string]: (typeof P)[keyof typeof P] } = { P1: P.p1, P2: P.p2, P3: P.p3 };

export function nodeIndex(): NodeIndex {
  return {
    pageByRef: (ref) => PAGE_REFS[ref],
    refOfPage: (id) => Object.keys(PAGE_REFS).find((ref) => PAGE_REFS[ref] === id),
  };
}

export function fixtureRegistry(): DslRegistry {
  return dslRegistry(registryInput(), nodeIndex());
}

/**
 * Document order of the questions, as the studio's tree would supply it. `here` is a rule on P1,
 * so `Q9`, `Q12` and `AGE` are all forward references from it.
 */
export function fixtureFlowOrder(here = 1): FlowOrder {
  const order = new Map<QuestionId, number>([
    [Q.s1, 0],
    [Q.q5, 1],
    [Q.q9, 2],
    [Q.q12, 3],
    [Q.age, 4],
  ]);
  return { questionOrder: order, here };
}
