/**
 * A `content.*` registry for the `/v1/dsl/*` suite, in **row** shape.
 *
 * Deliberately not the logic-shaped fixture in `dsl-fixture.ts`: these are the columns 0007
 * actually stores, so every route test also exercises `src/server/dsl/registry.ts`'s mapping —
 * including the part with real consequences, the synthesis of a nominal enum domain id from the
 * emitting question (see that file's header).
 *
 * Ids are ULID-shaped because `ulidIdSchema` polices the version id in the request body and a
 * fixture that uses `qst_1` would pass here and fail against Postgres.
 */

import type { VersionRegistryRows } from '@/server/repo/types';

// 23 chars + a 3-char suffix = the 26 a real ULID has — `ulidIdSchema` now polices rule
// TARGETS too (P1-12), so a fixture id one character short would 422 before any route logic.
const ULID = (suffix: string): string => `01JC8KX9Q2M4V7ZB3F0T5NX${suffix}`;

export const IDS = {
  blockMain: `blk_${ULID('6R1')}`,
  page1: `pg_${ULID('6R2')}`,
  page2: `pg_${ULID('6R3')}`,
  questionS1: `qst_${ULID('6R4')}`,
  questionQ5: `qst_${ULID('6R5')}`,
  questionAge: `qst_${ULID('6R6')}`,
  questionQ12: `qst_${ULID('6R7')}`,
  varS1: `var_${ULID('6R8')}`,
  varQ5: `var_${ULID('6R9')}`,
  varAge: `var_${ULID('6RA')}`,
  varHeavy: `var_${ULID('6RB')}`,
} as const;

const YES_NO = [
  { ref: 'Yes', code: 1, label_key: 's1.yes' },
  { ref: 'No', code: 2, label_key: 's1.no' },
];

const FRUIT = [
  { ref: 'Alpha', code: 1, label_key: 'fruit.alpha' },
  { ref: 'Beta', code: 2, label_key: 'fruit.beta' },
  { ref: 'None', code: 99, label_key: 'fruit.none' },
];

export function registryRowsFor(versionId: string): VersionRegistryRows {
  return {
    survey_version_id: versionId,
    variables: [
      {
        id: IDS.varS1,
        name: 'S1',
        kind: 'response',
        vtype: 'enum',
        enum_domain: YES_NO.map((item) => ({ code: item.code, label_key: item.label_key })),
        source_question_id: IDS.questionS1,
        source_item_id: null,
        source_part: { kind: 'scalar' },
        pii: false,
        persist: true,
        sort_key: 'a0',
      },
      {
        id: IDS.varQ5,
        name: 'Q5',
        kind: 'response',
        vtype: 'set',
        enum_domain: FRUIT.map((item) => ({ code: item.code, label_key: item.label_key })),
        source_question_id: IDS.questionQ5,
        source_item_id: null,
        source_part: { kind: 'set_view' },
        pii: false,
        persist: true,
        sort_key: 'a1',
      },
      {
        id: IDS.varAge,
        name: 'AGE',
        kind: 'response',
        vtype: 'number',
        enum_domain: null,
        source_question_id: IDS.questionAge,
        source_item_id: null,
        source_part: { kind: 'scalar' },
        pii: false,
        persist: true,
        sort_key: 'a2',
      },
      {
        id: IDS.varHeavy,
        name: 'HEAVY_BUYER',
        kind: 'hidden',
        vtype: 'boolean',
        enum_domain: null,
        source_question_id: null,
        source_item_id: null,
        source_part: null,
        pii: false,
        persist: true,
        sort_key: 'a3',
      },
    ],
    nodes: [
      { id: IDS.blockMain, node_kind: 'block', parent_id: null, ref: 'MAIN', required: null, emits: [], sort_key: 'a0' },
      { id: IDS.page1, node_kind: 'page', parent_id: IDS.blockMain, ref: 'P1', required: null, emits: [], sort_key: 'a1' },
      { id: IDS.questionS1, node_kind: 'question', parent_id: IDS.page1, ref: 'S1', required: true, emits: [IDS.varS1], sort_key: 'a2' },
      { id: IDS.questionQ5, node_kind: 'question', parent_id: IDS.page1, ref: 'Q5', required: true, emits: [IDS.varQ5], sort_key: 'a3' },
      { id: IDS.page2, node_kind: 'page', parent_id: IDS.blockMain, ref: 'P2', required: null, emits: [], sort_key: 'a4' },
      { id: IDS.questionQ12, node_kind: 'question', parent_id: IDS.page2, ref: 'Q12', required: false, emits: [], sort_key: 'a5' },
      { id: IDS.questionAge, node_kind: 'question', parent_id: IDS.page2, ref: 'Q_AGE', required: false, emits: [IDS.varAge], sort_key: 'a6' },
    ],
    items: [
      ...YES_NO.map((item, index) => ({
        id: `opt_${ULID(`7A${String(index)}`)}`,
        question_id: IDS.questionS1,
        item_kind: 'option' as const,
        ref: item.ref,
        code: item.code,
        label_key: item.label_key,
        sort_key: `a${String(index)}`,
      })),
      ...FRUIT.map((item, index) => ({
        id: `opt_${ULID(`7B${String(index)}`)}`,
        question_id: IDS.questionQ5,
        item_kind: 'option' as const,
        ref: item.ref,
        code: item.code,
        label_key: item.label_key,
        sort_key: `a${String(index)}`,
      })),
    ],
  };
}
