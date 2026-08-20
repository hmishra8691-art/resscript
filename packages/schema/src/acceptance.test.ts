/**
 * The P1-02 acceptance criteria, asserted against a committed fixture.
 *
 * From the roadmap: "A hand-written 30-question survey JSON file including a mixed matrix, a
 * multi-select with an 'other, specify', an NPS question and two hidden variables parses,
 * produces the exact variable list from schema §1's table, serializes back byte-identically,
 * and survives a rename of one question's `ref` with every internal reference intact and every
 * derived variable name updated. A survey declaring a variable named `respondent_id` is
 * rejected with a reserved-name diagnostic naming the collision."
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import type { QuestionId } from './ids.js';
import { parse, serialize } from './serialize.js';
import type { Survey } from './types/survey.js';
import type { QuestionNode } from './types/content.js';
import { flattenContent, renameRef } from './variables.js';
import { validateStructural } from './validate.js';

const SURVEY_PATH = new URL('./__fixtures__/acceptance-survey.json', import.meta.url);
const VARIABLES_PATH = new URL('./__fixtures__/acceptance-variables.json', import.meta.url);

const rawSurvey = readFileSync(SURVEY_PATH, 'utf8');

interface ExpectedVariable {
  readonly name: string;
  readonly kind: string;
  readonly type: string;
  readonly pii: boolean;
  readonly export_column: string;
}

const expectedVariables = JSON.parse(readFileSync(VARIABLES_PATH, 'utf8')) as ExpectedVariable[];

function loadSurvey(): Survey {
  const result = parse(rawSurvey);
  if (!result.ok) {
    throw new Error(`fixture did not parse: ${JSON.stringify(result.diagnostics.slice(0, 5), null, 2)}`);
  }
  return result.survey;
}

function questions(survey: Survey): readonly QuestionNode[] {
  return flattenContent(survey.content).filter((n): n is QuestionNode => n.type === 'question');
}

describe('the acceptance fixture', () => {
  it('parses with no diagnostics', () => {
    const result = parse(rawSurvey);
    expect(
      result.ok,
      `diagnostics: ${JSON.stringify(result.diagnostics.slice(0, 5), null, 2)}`,
    ).toBe(true);
    expect(result.diagnostics).toEqual([]);
  });

  it('is a 30-question survey with the shapes the milestone calls for', () => {
    const survey = loadSurvey();
    const all = questions(survey);
    expect(all).toHaveLength(30);

    // a mixed matrix: one numeric row, one text row, one single-select row
    const mixed = all.find((q) => q.question_type === 'matrix_mixed');
    expect(mixed?.cells?.map((c) => c.control.question_type)).toEqual([
      'numeric',
      'text',
      'single_select',
    ]);

    // a multi-select with other-specify
    const multi = all.filter((q) => q.question_type === 'multi_select');
    expect(multi.some((q) => (q.options ?? []).some((o) => o.other_specify === true))).toBe(true);

    // an NPS question
    expect(all.some((q) => q.question_type === 'nps')).toBe(true);

    // two hidden variables
    expect(survey.variables.filter((v) => v.kind === 'hidden').map((v) => v.name)).toEqual([
      'VENDOR_PID',
      'SAMPLE_WAVE',
    ]);

    // and an instruction node, which must emit nothing
    expect(flattenContent(survey.content).some((n) => n.type === 'text')).toBe(true);
  });

  it('produces exactly the expected variable list', () => {
    const survey = loadSurvey();
    const actual = survey.variables.map((v) => ({
      name: v.name,
      kind: v.kind,
      type: v.type,
      pii: v.pii,
      export_column: v.export.column,
    }));
    expect(actual).toEqual(expectedVariables);
  });

  it('has every emitted variable owned by exactly one question', () => {
    const survey = loadSurvey();
    const emitted = questions(survey).flatMap((q) => q.emits ?? []);
    expect(new Set(emitted).size).toBe(emitted.length);
    const response = survey.variables.filter((v) => v.source?.question_id !== undefined);
    expect(emitted.length).toBe(response.length);
  });

  it('serializes back byte-identically', () => {
    expect(serialize(loadSurvey())).toBe(rawSurvey);
  });

  it('is structurally valid', () => {
    expect(validateStructural(loadSurvey())).toEqual([]);
  });
});

describe('renaming a question ref in the fixture', () => {
  it('updates every derived variable name, changes no id, and keeps every reference intact', () => {
    const before = loadSurvey();
    const q3 = questions(before).find((q) => q.ref === 'Q3');
    expect(q3).toBeDefined();
    if (q3 === undefined) return;

    const outcome = renameRef(before, q3.id as QuestionId, 'GRID_AGREE');
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const after = outcome.survey;

    // Ids: identical set, identical order.
    expect(after.variables.map((v) => v.id)).toEqual(before.variables.map((v) => v.id));
    expect(flattenContent(after.content).map((n) => n.id)).toEqual(
      flattenContent(before.content).map((n) => n.id),
    );

    // Derived names: exactly the renamed question's variables moved.
    expect(outcome.variables.map((v) => [v.from, v.to])).toEqual([
      ['Q3r1', 'GRID_AGREEr1'],
      ['Q3r2', 'GRID_AGREEr2'],
      ['Q3r3', 'GRID_AGREEr3'],
    ]);
    const untouched = before.variables
      .filter((v) => !v.name.startsWith('Q3'))
      .map((v) => v.name);
    expect(after.variables.filter((v) => !v.name.startsWith('GRID_AGREE')).map((v) => v.name)).toEqual(
      untouched,
    );

    // Internal references are by id, so nothing about them changes.
    expect(after.logic_rules).toEqual(before.logic_rules);
    expect(after.quotas).toEqual(before.quotas);
    expect(after.flow).toEqual(before.flow);
    const rule = after.logic_rules[0];
    expect(rule?.target).toEqual({ type: 'question', id: q3.id });

    // And the result is still a valid, round-trippable survey.
    expect(validateStructural(after)).toEqual([]);
    const reparsed = parse(serialize(after));
    expect(reparsed.ok).toBe(true);
    if (reparsed.ok) expect(reparsed.survey).toStrictEqual(after);
  });

  it('renames the export columns that were defaults', () => {
    const before = loadSurvey();
    const q3 = questions(before).find((q) => q.ref === 'Q3');
    if (q3 === undefined) throw new Error('Q3 missing');
    const outcome = renameRef(before, q3.id as QuestionId, 'GRID_AGREE');
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.export_columns.map((c) => c.to)).toEqual([
      'GRID_AGREEr1',
      'GRID_AGREEr2',
      'GRID_AGREEr3',
    ]);
  });
});

describe('the reserved-namespace acceptance criterion', () => {
  it('rejects a survey declaring a variable named respondent_id, naming the collision', () => {
    const document = JSON.parse(rawSurvey) as Record<string, unknown>;
    const variables = document['variables'] as Record<string, unknown>[];
    const template = variables.at(-1) as Record<string, unknown>;
    variables.push({
      ...template,
      id: 'var_00000000000000000000000009',
      name: 'respondent_id',
      export: { include: true, column: 'respondent_id' },
    });

    const result = parse(JSON.stringify(document));
    expect(result.ok).toBe(false);
    const collision = result.diagnostics.find((d) => d.code === 'SCH-1003');
    expect(collision).toBeDefined();
    expect(collision?.message).toContain('respondent_id');
    expect(collision?.detail?.['reserved']).toBe('respondent_id');
    expect(collision?.path).toMatch(/^\/variables\/\d+\/name$/);
  });

  it('rejects a differently-cased shadow too, because the database index is on lower(name)', () => {
    const document = JSON.parse(rawSurvey) as Record<string, unknown>;
    const variables = document['variables'] as Record<string, unknown>[];
    const template = variables.at(-1) as Record<string, unknown>;
    variables.push({
      ...template,
      id: 'var_00000000000000000000000010',
      name: 'Duration_S',
      export: { include: true, column: 'Duration_S' },
    });
    const result = parse(JSON.stringify(document));
    expect(result.ok).toBe(false);
    expect(result.diagnostics.some((d) => d.code === 'SCH-1003')).toBe(true);
  });
});
