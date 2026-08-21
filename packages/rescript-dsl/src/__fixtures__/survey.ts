/**
 * The fixture survey every test in this package shares.
 *
 * It is one survey rather than a per-test registry, for the same reason `packages/logic`'s fixture
 * is: the interesting failures are interactions, and interactions only appear when the pieces
 * coexist. It is shaped to satisfy the D §6.3 illustrated program *and* the D §9.2 worked example,
 * so the corpus files under `fixtures/corpus/` are near-verbatim copies of the design document
 * rather than paraphrases — which is the only way a corpus regression test can catch a divergence
 * from the design.
 *
 * It carries, on purpose:
 *
 *  - a **shared option list** (`dom_fruit` on both Q5 and Q10), so `MASK Q10 OPTIONS TO SELECTED IN
 *    Q5` type-checks — a mask across two questions with *different* domains is `LGC-T021`, and the
 *    fixture has to be able to express the legal case,
 *  - an **ordinal** domain (`dom_scale`) and a **nominal** one (`dom_brand`), so `Q9 > 3` is legal
 *    and `Q12 > 1` is `LGC-T009` (D §3.3's "top 2 box on a brand list" bug),
 *  - **option `meta`** on one option, for `HIDE Q3 OPTION WHERE item.meta.discontinued = TRUE`,
 *  - a question on a **later page** (`Q_AGE` on P3), so the forward-reference analysis has something
 *    real to find,
 *  - a `NodeIndex` naming pages and blocks, because `logic`'s registry cannot (see registry.ts).
 */

import type {
  BlockId,
  EnumDomain,
  ItemDecl,
  LogicRegistryInput,
  OptionId,
  PageId,
  QuestionDecl,
  QuestionId,
  VarDecl,
  VariableId,
} from '@resscript/logic';
import {
  asBlockId,
  asDomainId,
  asOptionId,
  asPageId,
  asQuestionId,
  asVariableId,
  buildTypeEnv,
} from '@resscript/logic';
import { dslRegistry, type DslRegistry, type NodeIndex } from '../registry.js';

export const DOM = {
  s1: asDomainId('dom_s1'),
  fruit: asDomainId('dom_fruit'),
  scale: asDomainId('dom_scale'),
  brand: asDomainId('dom_brand'),
  ageBand: asDomainId('dom_age_band'),
} as const;

export const Q = {
  s1: asQuestionId('qst_s1'),
  q3: asQuestionId('qst_q3'),
  q5: asQuestionId('qst_q5'),
  q6: asQuestionId('qst_q6'),
  q7: asQuestionId('qst_q7'),
  q9: asQuestionId('qst_q9'),
  q10: asQuestionId('qst_q10'),
  q12: asQuestionId('qst_q12'),
  qAge: asQuestionId('qst_age'),
  qOe: asQuestionId('qst_oe'),
} as const;

export const P = {
  p1: asPageId('pg_1'),
  p2: asPageId('pg_2'),
  p3: asPageId('pg_3'),
} as const;

export const B = {
  main: asBlockId('blk_main'),
  screener: asBlockId('blk_screener'),
} as const;

export const V = {
  s1: asVariableId('var_s1'),
  q3: asVariableId('var_q3'),
  q5set: asVariableId('var_q5'),
  q6: asVariableId('var_q6'),
  q9: asVariableId('var_q9'),
  q10set: asVariableId('var_q10'),
  q12: asVariableId('var_q12'),
  age: asVariableId('var_age'),
  ageBand: asVariableId('var_age_band'),
  oe: asVariableId('var_oe'),
  dob: asVariableId('var_dob'),
  serverTime: asVariableId('var_server_time'),
  heavy: asVariableId('var_heavy_buyer'),
  segment: asVariableId('var_segment'),
  prioritySegment: asVariableId('var_priority_segment'),
  skipped: asVariableId('var_skipped_main'),
  incompleteQ5: asVariableId('var_incomplete_q5'),
} as const;

interface FruitOption {
  readonly ref: string;
  readonly code: number;
  readonly labelKey: string;
  readonly meta?: { readonly [key: string]: string | number | boolean | null };
}

const FRUIT: readonly FruitOption[] = [
  { ref: 'Apple', code: 1, labelKey: 'fruit.apple' },
  { ref: 'Banana', code: 2, labelKey: 'fruit.banana' },
  { ref: 'Cherry', code: 3, labelKey: 'fruit.cherry' },
  { ref: 'Other', code: 97, labelKey: 'fruit.other' },
  { ref: 'None', code: 99, labelKey: 'fruit.none' },
];

const BRANDS: readonly FruitOption[] = [
  { ref: 'A', code: 1, labelKey: 'brand.a' },
  { ref: 'B', code: 2, labelKey: 'brand.b' },
  { ref: 'C', code: 3, labelKey: 'brand.c', meta: { discontinued: true } },
  { ref: 'D', code: 4, labelKey: 'brand.d', meta: { discontinued: false } },
];

const SCALE: readonly FruitOption[] = [1, 2, 3, 4, 5].map((code) => ({
  ref: `p${String(code)}`,
  code,
  labelKey: `scale.${String(code)}`,
}));

function response(id: VariableId, name: string, extra: Partial<VarDecl> = {}): VarDecl {
  return { id, name, kind: 'response', type: 'text', persist: true, pii: false, ...extra };
}

function hidden(id: VariableId, name: string, type: VarDecl['type']): VarDecl {
  return { id, name, kind: 'hidden', type, persist: true, pii: false };
}

/** Option declarations for a question, with one fan-out variable per option when asked for. */
function items(
  prefix: string,
  options: readonly FruitOption[],
  fanOut?: (option: FruitOption) => VariableId,
): readonly ItemDecl[] {
  return options.map((option, index) => ({
    option_id: asOptionId(`opt_${prefix}_${String(option.code)}`) as OptionId,
    code: option.code,
    label_key: option.labelKey,
    position: index,
    ref: option.ref,
    ...(option.meta === undefined ? {} : { meta: option.meta }),
    ...(fanOut === undefined ? {} : { variable_id: fanOut(option) }),
  }));
}

const q5Fan = (option: FruitOption): VariableId => asVariableId(`var_q5r${String(option.code)}`);
const q10Fan = (option: FruitOption): VariableId => asVariableId(`var_q10r${String(option.code)}`);
const q7Fan = (row: FruitOption): VariableId => asVariableId(`var_q7r${String(row.code)}`);

function question(decl: QuestionDecl): QuestionDecl {
  return decl;
}

export function registryInput(): LogicRegistryInput {
  const variables: VarDecl[] = [
    response(V.s1, 'S1', { type: 'enum', domain: DOM.s1, question_id: Q.s1 }),
    response(V.q3, 'Q3', { type: 'enum', domain: DOM.brand, question_id: Q.q3 }),
    response(V.q6, 'Q6', { type: 'number', question_id: Q.q6 }),
    response(V.q9, 'Q9', { type: 'enum', domain: DOM.scale, question_id: Q.q9 }),
    response(V.q12, 'Q12', { type: 'enum', domain: DOM.brand, question_id: Q.q12 }),
    response(V.age, 'AGE', { type: 'number', question_id: Q.qAge }),
    response(V.oe, 'OE', { type: 'text', question_id: Q.qOe, pii: true }),
    response(V.dob, 'DOB', { type: 'date', question_id: Q.qAge }),
    { id: V.serverTime, name: 'SERVER_TIME', kind: 'system', type: 'date', persist: true, pii: false },
    // The multi-select fan-out plus its derived set view (schema §1), so `Q5 ANY OF [1, 3]` and
    // `Q5r1 = TRUE` exercise the same machinery.
    response(V.q5set, 'Q5', { type: 'set', domain: DOM.fruit, question_id: Q.q5, part: 'set_view' }),
    ...FRUIT.map((option) =>
      response(q5Fan(option), `Q5r${String(option.code)}`, {
        type: 'boolean',
        question_id: Q.q5,
        part: 'option',
        code: option.code,
        option_id: asOptionId(`opt_q5_${String(option.code)}`),
      }),
    ),
    response(V.q10set, 'Q10', { type: 'set', domain: DOM.fruit, question_id: Q.q10, part: 'set_view' }),
    ...FRUIT.map((option) =>
      response(q10Fan(option), `Q10r${String(option.code)}`, {
        type: 'boolean',
        question_id: Q.q10,
        part: 'option',
        code: option.code,
        option_id: asOptionId(`opt_q10_${String(option.code)}`),
      }),
    ),
    // A matrix: one enum per row over the shared scale domain.
    ...SCALE.map((row) =>
      response(q7Fan(row), `Q7r${String(row.code)}`, {
        type: 'enum',
        domain: DOM.scale,
        question_id: Q.q7,
        part: 'row',
        code: row.code,
      }),
    ),
    hidden(V.heavy, 'HEAVY_BUYER', 'boolean'),
    hidden(V.segment, 'SEGMENT', 'text'),
    hidden(V.prioritySegment, 'PRIORITY_SEGMENT', 'text'),
    hidden(V.skipped, 'SKIPPED_MAIN', 'boolean'),
    // Lower case on purpose: D §6.3 writes `FLAG incomplete_q5`, and refs are case-sensitive
    // (D §6.2), so the declared name has to match the source exactly.
    hidden(V.incompleteQ5, 'incomplete_q5', 'boolean'),
    {
      id: V.ageBand,
      name: 'AGE_BAND',
      kind: 'derived',
      type: 'enum',
      domain: DOM.ageBand,
      persist: true,
      pii: false,
    },
  ];

  const domains: readonly EnumDomain[] = [
    { id: DOM.s1, entries: [{ code: 1, label_key: 's1.yes' }, { code: 2, label_key: 's1.no' }], ordinal: false },
    { id: DOM.fruit, entries: FRUIT.map((o) => ({ code: o.code, label_key: o.labelKey })), ordinal: false },
    // A Likert scale: ordinal, so `Q9 > 3` is legal (D §3.3).
    { id: DOM.scale, entries: SCALE.map((o) => ({ code: o.code, label_key: o.labelKey })), ordinal: true },
    // A brand list: nominal, so `Q12 > 1` is LGC-T009.
    { id: DOM.brand, entries: BRANDS.map((o) => ({ code: o.code, label_key: o.labelKey })), ordinal: false },
    {
      id: DOM.ageBand,
      entries: [{ code: 1, label_key: 'ab.18_24' }, { code: 2, label_key: 'ab.25_plus' }],
      ordinal: true,
    },
  ];

  const questions: readonly QuestionDecl[] = [
    question({
      id: Q.s1,
      ref: 'S1',
      page_id: P.p1,
      required: true,
      domain: DOM.s1,
      options: items('s1', [
        { ref: 'Yes', code: 1, labelKey: 's1.yes' },
        { ref: 'No', code: 2, labelKey: 's1.no' },
      ]),
      rows: [],
      columns: [],
      emits: [V.s1],
    }),
    question({
      id: Q.q3,
      ref: 'Q3',
      page_id: P.p1,
      required: false,
      domain: DOM.brand,
      options: items('q3', BRANDS),
      rows: [],
      columns: [],
      emits: [V.q3],
    }),
    question({
      id: Q.q5,
      ref: 'Q5',
      page_id: P.p1,
      required: true,
      domain: DOM.fruit,
      options: items('q5', FRUIT, q5Fan),
      rows: [],
      columns: [],
      emits: [...FRUIT.map(q5Fan), V.q5set],
    }),
    question({
      id: Q.q6,
      ref: 'Q6',
      page_id: P.p1,
      required: false,
      options: [],
      rows: [],
      columns: [],
      emits: [V.q6],
    }),
    question({
      id: Q.q7,
      ref: 'Q7',
      page_id: P.p2,
      required: false,
      domain: DOM.scale,
      options: [],
      rows: items('q7row', SCALE, q7Fan),
      columns: items('q7col', SCALE),
      emits: SCALE.map(q7Fan),
    }),
    question({
      id: Q.q9,
      ref: 'Q9',
      page_id: P.p2,
      required: false,
      domain: DOM.scale,
      options: items('q9', SCALE),
      rows: [],
      columns: [],
      emits: [V.q9],
    }),
    question({
      id: Q.q10,
      ref: 'Q10',
      page_id: P.p2,
      required: false,
      domain: DOM.fruit,
      options: items('q10', FRUIT, q10Fan),
      rows: [],
      columns: [],
      emits: [...FRUIT.map(q10Fan), V.q10set],
    }),
    question({
      id: Q.q12,
      ref: 'Q12',
      page_id: P.p2,
      required: false,
      domain: DOM.brand,
      options: items('q12', BRANDS),
      rows: [],
      columns: [],
      emits: [V.q12],
    }),
    // On the *last* page, so a rule that reads AGE before it is a genuine forward reference.
    question({
      id: Q.qAge,
      ref: 'Q_AGE',
      page_id: P.p3,
      required: false,
      options: [],
      rows: [],
      columns: [],
      emits: [V.age, V.dob],
    }),
    question({
      id: Q.qOe,
      ref: 'Q_OE',
      page_id: P.p3,
      required: false,
      options: [],
      rows: [],
      columns: [],
      emits: [V.oe],
    }),
  ];

  return {
    variables,
    domains,
    questions,
    pages: [
      { id: P.p1, block_id: B.screener, question_ids: [Q.s1, Q.q3, Q.q5, Q.q6] },
      { id: P.p2, block_id: B.main, question_ids: [Q.q7, Q.q9, Q.q10, Q.q12] },
      { id: P.p3, block_id: B.main, question_ids: [Q.qAge, Q.qOe] },
    ],
    blocks: [
      { id: B.screener, page_ids: [P.p1] },
      { id: B.main, page_ids: [P.p2, P.p3] },
    ],
  };
}

const PAGE_REFS: { readonly [ref: string]: PageId } = { P1: P.p1, P2: P.p2, P3: P.p3 };
const BLOCK_REFS: { readonly [ref: string]: BlockId } = { MAIN: B.main, SCREENER: B.screener };

/**
 * The `NodeIndex` a caller with the content tree supplies.
 *
 * Tests that omit it are testing the degraded path — page and block refs kept as text with an
 * `RSL-0012` warning — which is the path the studio takes before a tree is loaded.
 */
export function nodeIndex(): NodeIndex {
  const reverse = <T extends string>(map: { readonly [ref: string]: T }) => (id: T): string | undefined =>
    Object.keys(map).find((ref) => map[ref] === id);
  return {
    pageByRef: (ref) => PAGE_REFS[ref],
    blockByRef: (ref) => BLOCK_REFS[ref],
    refOfPage: reverse(PAGE_REFS),
    refOfBlock: reverse(BLOCK_REFS),
  };
}

export function registry(): DslRegistry {
  return dslRegistry(registryInput(), nodeIndex());
}

/** Without a node index: page and block refs cannot resolve. Used by the RSL-0012 tests. */
export function registryWithoutNodes(): DslRegistry {
  return dslRegistry(registryInput());
}

/**
 * A registry in which `Q5` has been renamed to `S5` and `AGE` to `AGE_YEARS`, with **every id
 * unchanged**.
 *
 * This is the fixture for the rename acceptance criterion: "Renaming `Q1` to `S1` in the tree editor
 * changes the DSL text shown in the code pane without any find-and-replace and without touching
 * stored ASTs."
 */
export function renamedRegistry(): DslRegistry {
  const base = registryInput();
  const variables = base.variables.map((decl) => {
    if (decl.id === V.q5set) return { ...decl, name: 'S5' };
    if (decl.id === V.age) return { ...decl, name: 'AGE_YEARS' };
    if (decl.name.startsWith('Q5r')) return { ...decl, name: `S5r${decl.name.slice(3)}` };
    return decl;
  });
  const questions = (base.questions ?? []).map((q) => (q.id === Q.q5 ? { ...q, ref: 'S5' } : q));
  const env = buildTypeEnv({ ...base, variables, questions });
  return { env, nodes: nodeIndex() };
}

export function typeEnv(): ReturnType<typeof buildTypeEnv> {
  return buildTypeEnv(registryInput());
}

export const QUESTION_IDS: readonly QuestionId[] = Object.values(Q);
