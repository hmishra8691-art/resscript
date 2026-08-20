import { describe, expect, it } from 'vitest';

import { createIdFactory } from './ids.js';
import type { IdFactory, OptionId, QuestionId } from './ids.js';
import type { QuestionItem, QuestionNode } from './types/content.js';
import type { Survey } from './types/survey.js';
import type { Variable, VariablePart } from './types/variables.js';
import {
  applyVariableRegistry,
  buildVariableRegistry,
  deriveVariableName,
  findReservedNameCollisions,
  planQuestionEmissions,
  renameRef,
} from './variables.js';
import { validateStructural } from './validate.js';

function factory(): IdFactory {
  let a = 99;
  return createIdFactory({
    now: () => 1_700_000_000_000,
    random: () => {
      a = (a * 1103515245 + 12345) % 2147483648;
      return a / 2147483648;
    },
  });
}

const ids = factory();

function item(ref: string, code: number, extra: Partial<QuestionItem> = {}): QuestionItem {
  return {
    id: ids.next('option'),
    ref,
    code,
    label: { key: `k.${ref}` },
    position: code,
    ...extra,
  };
}

function items(prefix: string, count: number): QuestionItem[] {
  return Array.from({ length: count }, (_u, i) => item(`${prefix}${i + 1}`, i + 1));
}

function question(
  ref: string,
  questionType: string,
  extra: Partial<QuestionNode> = {},
): QuestionNode {
  return {
    id: ids.next('question'),
    type: 'question',
    ref,
    question_type: questionType,
    label: { key: `${ref}.label` },
    required: true,
    ...extra,
  };
}

/** Names + types a question emits, in order. The shape Deliverable C §1's table asserts. */
function emitted(q: QuestionNode): readonly [string, string, string][] {
  return planQuestionEmissions(q).map((planned) => [
    deriveVariableName({ ref: q.ref, part: planned.part }),
    planned.type,
    planned.kind,
  ]);
}

describe('deriveVariableName — Deliverable C §1 table, row by row', () => {
  const cases: readonly { readonly label: string; readonly part: VariablePart; readonly expect: string }[] = [
    { label: 'single select emits one scalar', part: { kind: 'scalar' }, expect: 'Q1' },
    {
      label: 'multi-select option fan-out',
      part: { kind: 'option', option_id: 'opt_x' as OptionId, code: 3 },
      expect: 'Q2r3',
    },
    { label: 'derived set view over the fan-out', part: { kind: 'set_view' }, expect: 'Q2' },
    {
      label: 'matrix row',
      part: { kind: 'row', row_id: 'opt_x' as OptionId, code: 2 },
      expect: 'Q3r2',
    },
    {
      label: 'matrix column (§3)',
      part: { kind: 'column', column_id: 'opt_x' as OptionId, code: 4 },
      expect: 'Q3c4',
    },
    {
      label: 'row x column grid cell',
      part: {
        kind: 'cell',
        row_id: 'opt_r' as OptionId,
        row_code: 1,
        column_id: 'opt_c' as OptionId,
        column_code: 2,
      },
      expect: 'Q3r1c2',
    },
    { label: 'other-specify on the question', part: { kind: 'other_specify' }, expect: 'Q6_other' },
    {
      label: 'other-specify on one option of a fan-out',
      part: { kind: 'other_specify', option_id: 'opt_x' as OptionId, code: 5 },
      expect: 'Q2r5_other',
    },
    { label: 'plugin companion (NPS band)', part: { kind: 'suffix', suffix: 'band' }, expect: 'Q7_band' },
    {
      label: 'MaxDiff task slot',
      part: { kind: 'design_task', task: 1, role: 'best' },
      expect: 'MD_t1_best',
    },
  ];

  for (const testCase of cases) {
    it(testCase.label, () => {
      const ref = testCase.expect.startsWith('MD') ? 'MD' : testCase.expect.slice(0, 2);
      expect(deriveVariableName({ ref, part: testCase.part })).toBe(testCase.expect);
    });
  }

  it('applies the loop naming template (§13)', () => {
    expect(deriveVariableName({ ref: 'Q7', part: { kind: 'scalar' }, iteration: 2 })).toBe('Q7_2');
    expect(
      deriveVariableName({
        ref: 'Q7',
        part: { kind: 'row', row_id: 'opt_x' as OptionId, code: 3 },
        iteration: 4,
      }),
    ).toBe('Q7r3_4');
    expect(
      deriveVariableName({
        ref: 'Q7',
        part: { kind: 'scalar' },
        iteration: 3,
        loop_naming: '{ref}_i{iteration}',
      }),
    ).toBe('Q7_i3');
  });

  it('names r{n} from the item code, not its display position', () => {
    // Reordering must never rewrite a column name: the name is an exported value.
    const part: VariablePart = { kind: 'option', option_id: 'opt_x' as OptionId, code: 7 };
    expect(deriveVariableName({ ref: 'Q2', part })).toBe('Q2r7');
  });
});

describe('question emission — the same table, end to end', () => {
  it('Q1 single select, 4 options -> one enum', () => {
    expect(emitted(question('Q1', 'single_select', { options: items('o', 4) }))).toEqual([
      ['Q1', 'enum', 'response'],
    ]);
  });

  it('Q2 multi select, 5 options -> five booleans plus a derived set view', () => {
    expect(emitted(question('Q2', 'multi_select', { options: items('o', 5) }))).toEqual([
      ['Q2r1', 'boolean', 'response'],
      ['Q2r2', 'boolean', 'response'],
      ['Q2r3', 'boolean', 'response'],
      ['Q2r4', 'boolean', 'response'],
      ['Q2r5', 'boolean', 'response'],
      ['Q2', 'set', 'derived'],
    ]);
  });

  it('Q3 matrix, 3 rows x 5-point scale -> three enums', () => {
    expect(
      emitted(question('Q3', 'matrix', { rows: items('r', 3), columns: items('c', 5) })),
    ).toEqual([
      ['Q3r1', 'enum', 'response'],
      ['Q3r2', 'enum', 'response'],
      ['Q3r3', 'enum', 'response'],
    ]);
  });

  it('Q4 numeric list, 4 rows -> four numbers', () => {
    expect(emitted(question('Q4', 'numeric_list', { rows: items('r', 4) }))).toEqual([
      ['Q4r1', 'number', 'response'],
      ['Q4r2', 'number', 'response'],
      ['Q4r3', 'number', 'response'],
      ['Q4r4', 'number', 'response'],
    ]);
  });

  it('Q5 mixed matrix (row A numeric, row B text, row C select) -> one variable per row type', () => {
    const rows = items('r', 3);
    const q = question('Q5', 'matrix_mixed', {
      rows,
      columns: items('c', 5),
      cells: [
        { row_ref: 'r1', control: { question_type: 'numeric', config: { min: 0, max: 100 } } },
        { row_ref: 'r2', control: { question_type: 'text', config: { max_len: 200 } } },
        { row_ref: 'r3', control: { question_type: 'single_select', use_columns: true } },
      ],
    });
    expect(emitted(q)).toEqual([
      ['Q5r1', 'number', 'response'],
      ['Q5r2', 'text', 'response'],
      ['Q5r3', 'enum', 'response'],
    ]);
  });

  it('Q6 single select with "other, specify" -> enum plus text', () => {
    const options = [...items('o', 3), item('o4', 4, { other_specify: true })];
    expect(emitted(question('Q6', 'single_select', { options }))).toEqual([
      ['Q6', 'enum', 'response'],
      ['Q6_other', 'text', 'response'],
    ]);
  });

  it('a MaxDiff task set -> best/worst per task', () => {
    const q = question('MD', 'maxdiff', { options: items('i', 6), config: { tasks: 2 } });
    expect(emitted(q)).toEqual([
      ['MD_t1_best', 'enum', 'design'],
      ['MD_t1_worst', 'enum', 'design'],
      ['MD_t2_best', 'enum', 'design'],
      ['MD_t2_worst', 'enum', 'design'],
    ]);
  });

  it('a display-only node emits nothing', () => {
    expect(emitted(question('T1', 'display_text'))).toEqual([]);
  });

  it('an NPS question emits the score plus a derived band', () => {
    expect(emitted(question('Q7', 'nps'))).toEqual([
      ['Q7', 'number', 'response'],
      ['Q7_band', 'enum', 'derived'],
    ]);
  });

  it('flags open-ends as PII by default and honours an explicit override', () => {
    const on = planQuestionEmissions(question('Q8', 'open_text'));
    expect(on[0]?.pii).toBe(true);
    const off = planQuestionEmissions(question('Q8', 'open_text', { flags: { pii: false } }));
    expect(off[0]?.pii).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* reserved namespace                                                         */
/* -------------------------------------------------------------------------- */

describe('reserved variable names (Deliverable K §6)', () => {
  it('detects collisions case-insensitively, matching the database index on lower(name)', () => {
    expect(findReservedNameCollisions(['respondent_id'])).toEqual([
      { name: 'respondent_id', reserved: 'respondent_id' },
    ]);
    expect(findReservedNameCollisions(['Respondent_Id'])).toEqual([
      { name: 'Respondent_Id', reserved: 'respondent_id' },
    ]);
    expect(findReservedNameCollisions(['RESPONDENT_ID2', 'Q1'])).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* registry and rename                                                        */
/* -------------------------------------------------------------------------- */

function miniSurvey(): Survey {
  const local = factory();
  const options = [
    { id: local.next('option'), ref: 'o1', code: 1, label: { key: 'q2.o1' }, position: 1 },
    { id: local.next('option'), ref: 'o2', code: 2, label: { key: 'q2.o2' }, position: 2 },
    { id: local.next('option'), ref: 'o3', code: 3, label: { key: 'q2.o3' }, position: 3, other_specify: true },
  ];
  const q1: QuestionNode = {
    id: local.next('question'),
    type: 'question',
    ref: 'Q1',
    question_type: 'single_select',
    label: { key: 'q1.label' },
    required: true,
    options: [
      { id: local.next('option'), ref: 'y', code: 1, label: { key: 'q1.y' }, position: 1 },
      { id: local.next('option'), ref: 'n', code: 2, label: { key: 'q1.n' }, position: 2 },
    ],
  };
  const q2: QuestionNode = {
    id: local.next('question'),
    type: 'question',
    ref: 'Q2',
    question_type: 'multi_select',
    label: { key: 'q2.label' },
    required: true,
    options,
  };
  const pageId = local.next('page');
  const blockId = local.next('block');
  const startId = local.next('flow_node');
  const seqId = local.next('flow_node');
  const endId = local.next('flow_node');

  const bare: Survey = {
    meta: { id: local.next('survey'), ref: 'MINI', name: 'Mini' },
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
      bundles: {
        en: {
          'q1.label': 'Q1',
          'q1.y': 'Yes',
          'q1.n': 'No',
          'q2.label': 'Q2',
          'q2.o1': 'A',
          'q2.o2': 'B',
          'q2.o3': 'Other',
        },
      },
      policy: { on_missing: 'fallback_to_base', block_publish_if_incomplete: false },
    },
    variables: [],
    content: [
      {
        id: blockId,
        type: 'block',
        ref: 'B1',
        children: [{ id: pageId, type: 'page', ref: 'P1', children: [q1, q2] }],
      },
    ],
    flow: {
      nodes: [
        { id: startId, type: 'start', next: seqId },
        { id: seqId, type: 'sequence', target_id: blockId, next: endId },
        { id: endId, type: 'end', disposition: 'COMPLETE' },
      ],
    },
    logic_rules: [],
  };
  return applyVariableRegistry(bare, { ids: local });
}

describe('buildVariableRegistry', () => {
  it('orders variables in document order and writes emits back onto questions', () => {
    const survey = miniSurvey();
    expect(survey.variables.map((v) => v.name)).toEqual([
      'Q1',
      'Q2r1',
      'Q2r2',
      'Q2r3',
      'Q2',
      'Q2r3_other',
    ]);
    const questions = survey.content
      .flatMap((b) => (b.type === 'block' ? b.children : []))
      .flatMap((p) => (p.type === 'page' ? p.children : []))
      .filter((n): n is QuestionNode => n.type === 'question');
    expect(questions[0]?.emits).toEqual([survey.variables[0]?.id]);
    expect(questions[1]?.emits).toHaveLength(5);
  });

  it('is idempotent: rebuilding changes nothing, including ids', () => {
    const survey = miniSurvey();
    const again = applyVariableRegistry(survey);
    expect(again.variables).toEqual(survey.variables);
  });

  it('keeps authored hidden variables and puts them after the response columns', () => {
    const survey = miniSurvey();
    const hidden: Variable = {
      id: createIdFactory({ now: () => 1, random: () => 0.25 }).next('variable'),
      name: 'VENDOR_PID',
      kind: 'hidden',
      type: 'text',
      export: { include: true, column: 'VENDOR_PID' },
      pii: true,
      persist: true,
    };
    const withHidden = applyVariableRegistry({
      ...survey,
      variables: [...survey.variables, hidden],
    });
    expect(withHidden.variables.at(-1)?.name).toBe('VENDOR_PID');
    expect(withHidden.variables.filter((v) => v.kind === 'hidden')).toHaveLength(1);
  });

  it('produces a survey that passes structural validation', () => {
    expect(validateStructural(miniSurvey())).toEqual([]);
  });
});

describe('renameRef', () => {
  it('changes exactly the derived variable names and no id', () => {
    const before = miniSurvey();
    const questionId = before.variables.find((v) => v.name === 'Q2')?.source?.question_id;
    expect(questionId).toBeDefined();

    const outcome = renameRef(before, questionId as QuestionId, 'BRANDS');
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    // Every id is untouched — this is the property the whole id/ref split exists to give.
    expect(outcome.survey.variables.map((v) => v.id)).toEqual(before.variables.map((v) => v.id));

    expect(outcome.survey.variables.map((v) => v.name)).toEqual([
      'Q1',
      'BRANDSr1',
      'BRANDSr2',
      'BRANDSr3',
      'BRANDS',
      'BRANDSr3_other',
    ]);
    expect(outcome.variables.map((v) => [v.from, v.to])).toEqual([
      ['Q2r1', 'BRANDSr1'],
      ['Q2r2', 'BRANDSr2'],
      ['Q2r3', 'BRANDSr3'],
      ['Q2', 'BRANDS'],
      ['Q2r3_other', 'BRANDSr3_other'],
    ]);
    // Q1 is untouched: a rename is not a global rewrite.
    expect(outcome.variables.some((v) => v.from === 'Q1')).toBe(false);
  });

  it('moves export columns that were defaults and leaves deliberate ones alone', () => {
    const before = miniSurvey();
    const pinned = before.variables.map((v) =>
      v.name === 'Q2r1' ? { ...v, export: { ...v.export, column: 'LEGACY_BRAND_A' } } : v,
    );
    const questionId = before.variables.find((v) => v.name === 'Q2')?.source?.question_id;
    const outcome = renameRef({ ...before, variables: pinned }, questionId as QuestionId, 'BRANDS');
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const columns = new Map(outcome.survey.variables.map((v) => [v.name, v.export.column]));
    expect(columns.get('BRANDSr1')).toBe('LEGACY_BRAND_A');
    expect(columns.get('BRANDSr2')).toBe('BRANDSr2');
  });

  it('refuses a rename that would collide with another ref', () => {
    const survey = miniSurvey();
    const questionId = survey.variables.find((v) => v.name === 'Q2')?.source?.question_id;
    expect(renameRef(survey, questionId as QuestionId, 'q1')).toEqual({
      ok: false,
      reason: 'duplicate_ref',
    });
  });

  it('reports an unknown node rather than silently doing nothing', () => {
    expect(renameRef(miniSurvey(), 'qst_01H0000000000000000000000', 'X')).toEqual({
      ok: false,
      reason: 'not_found',
    });
  });

  it('leaves the survey structurally valid after a rename', () => {
    const survey = miniSurvey();
    const questionId = survey.variables.find((v) => v.name === 'Q1')?.source?.question_id;
    const outcome = renameRef(survey, questionId as QuestionId, 'SCREEN1');
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(validateStructural(outcome.survey)).toEqual([]);
  });
});

describe('buildVariableRegistry id stability', () => {
  it('reuses ids by source signature, not by name', () => {
    const survey = miniSurvey();
    const renamed = renameRef(survey, survey.variables[1]?.source?.question_id as QuestionId, 'ZZ');
    expect(renamed.ok).toBe(true);
    if (!renamed.ok) return;
    const rebuilt = buildVariableRegistry(renamed.survey);
    expect(rebuilt.variables.map((v) => v.id)).toEqual(survey.variables.map((v) => v.id));
  });
});
