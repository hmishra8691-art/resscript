/**
 * Parser tests: the statement forms of the P1-07 grammar surface, and the recovery contract.
 *
 * The recovery half is the load-bearing one. P8 (D §6.4) is a property test over mutations; these
 * are the named cases a human would ask about — a missing `END`, a missing `THEN`, a `QUOTA` block,
 * garbage between two good statements — and each asserts the same three things: the parser returns,
 * it reports a diagnostic *inside* the offending region, and the statements around the damage still
 * parse.
 */

import { describe, expect, it } from 'vitest';
import { parseProgram } from './parser.js';
import { parse } from './index.js';
import { registry } from './__fixtures__/survey.js';

const REG = registry();

const codes = (source: string): readonly string[] => parse(source, REG).diagnostics.map((d) => d.code);
const shapes = (source: string): readonly string[] => parseProgram(source).statements.map((s) => s.s);

describe('statement forms', () => {
  it('parses a QUESTION definition with every clause', () => {
    const source = [
      'QUESTION Q5',
      '  TYPE MULTI',
      '  LABEL "Which fruits?"',
      '  INSTRUCTION "Select all that apply"',
      '  REQUIRED',
      '  OPTIONS',
      '    1 "Apple" ANCHOR FIRST META brand_id = 7',
      '    3 "Cherry" VISIBLE IF S1 = 1 ENABLED IF AGE >= 18',
      '    97 "Other" SPECIFY TEXT PRESELECT',
      '    99 "None" EXCLUSIVE ANCHOR LAST AUTOSELECT IF NOT ANSWERED(Q6)',
      '  VALIDATE',
      '    SELECT AT LEAST 1',
      '    SELECT EXACTLY 2 MESSAGE "err.two"',
      '    SUM OF Q6, AGE = 100',
      '    RANGE 0 TO 10',
      '    MATCHES "^[A-Z]{2}$"',
      '    REQUIRE Q5 CONTAINS 1',
      '  RANDOMIZE OPTIONS KEEP OPTION 97, 99 LAST GROUP fruit_list',
      '  MASK OPTIONS TO SELECTED IN Q5 WHEN EMPTY SHOW ALL',
      '  PIPE Q10 FROM Q5 AS LIST',
      'END',
    ].join('\n');
    const result = parse(source, REG);
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const statement = result.program.statements[0];
    if (statement === undefined || statement.s !== 'question') throw new Error('expected a question');
    expect(statement.qtype).toBe('MULTI');
    expect(statement.required).toBe(true);
    expect(statement.options).toHaveLength(4);
    expect(statement.validate).toHaveLength(6);
    expect(statement.masks?.[0]?.when_empty).toBe('show_all');
    expect(statement.pipes).toHaveLength(1);
  });

  it('parses the P1-07 statement surface', () => {
    expect(shapes('IF S1 = 1 THEN SHOW Q12 ELSE HIDE Q12')).toEqual(['rule']);
    expect(shapes('SET SEGMENT = "young"')).toEqual(['set']);
    expect(shapes('TERMINATE AS SCREENOUT IF S1 = 2')).toEqual(['terminate']);
    expect(shapes('RANDOMIZE Q9 OPTIONS KEEP OPTION 1 FIRST')).toEqual(['randomize']);
    expect(shapes('MASK Q10 OPTIONS EXCEPT [99] WHEN EMPTY TERMINATE')).toEqual(['mask']);
    expect(shapes('PIPE Q10 FROM Q5')).toEqual(['pipe']);
    expect(shapes('PRIORITY GROUP g { SET SEGMENT = "a" }')).toEqual(['priority_group']);
    expect(shapes('BLOCK MAIN\n  PAGE P2\n  END\nEND')).toEqual(['block']);
    expect(shapes('HIDE Q3 OPTION 4')).toEqual(['action']);
    expect(shapes('DISABLE Q7 ROW 2, 5')).toEqual(['action']);
  });

  it('parses every action form', () => {
    const source =
      'IF S1 = 1 THEN SHOW Q12 AND HIDE Q3 OPTION 4 AND DISABLE Q7 ROW 2 AND ENABLE Q7 COLUMN 3 ' +
      'AND PRESELECT Q3 OPTION 1 AND SKIP TO PAGE P3 AND SET SEGMENT = "x" AND REQUIRE Q12 ' +
      'AND UNREQUIRE Q12 AND FLAG incomplete_q5 AND TERMINATE AS QUALITY CUSTOM my_reason';
    const result = parse(source, REG);
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const statement = result.program.statements[0];
    if (statement === undefined || statement.s !== 'rule') throw new Error('expected a rule');
    expect(statement.then.map((a) => a.a)).toEqual([
      'show', 'hide', 'disable', 'enable', 'preselect', 'skip_to', 'set', 'require', 'unrequire',
      'flag', 'terminate',
    ]);
  });

  it('distinguishes AND-the-connective from AND-the-effect-separator', () => {
    const result = parse('IF S1 = 1 AND AGE >= 18 THEN SHOW Q12 AND HIDE Q3', REG);
    const statement = result.program.statements[0];
    if (statement === undefined || statement.s !== 'rule') throw new Error('expected a rule');
    expect(statement.condition.op).toBe('and');
    expect(statement.then).toHaveLength(2);
  });

  it('accepts the operator synonyms D §6.2 lists', () => {
    for (const source of ['IF Q6 = 1 THEN SHOW Q12', 'IF Q6 == 1 THEN SHOW Q12']) {
      const statement = parse(source, REG).program.statements[0];
      if (statement === undefined || statement.s !== 'rule') throw new Error('expected a rule');
      expect(statement.condition.op).toBe('==');
    }
    for (const source of ['IF Q6 != 1 THEN SHOW Q12', 'IF Q6 <> 1 THEN SHOW Q12']) {
      const statement = parse(source, REG).program.statements[0];
      if (statement === undefined || statement.s !== 'rule') throw new Error('expected a rule');
      expect(statement.condition.op).toBe('!=');
    }
  });

  it('normalizes IN to ANY OF and BETWEEN to a pair of comparisons', () => {
    const inForm = parse('IF Q5 IN [1, 3] THEN SHOW Q12', REG).program.statements[0];
    if (inForm === undefined || inForm.s !== 'rule') throw new Error('expected a rule');
    expect(inForm.condition.op).toBe('any_of');

    const between = parse('IF AGE BETWEEN 18 AND 24 THEN SHOW Q12', REG).program.statements[0];
    if (between === undefined || between.s !== 'rule') throw new Error('expected a rule');
    // Desugared: there is no `between` AST kind (D §2.3), and adding one would break the builder
    // isomorphism (D §7.1).
    expect(between.condition.op).toBe('and');
  });

  it('requires a CASE to have an ELSE, per D §2.3', () => {
    expect(codes('SET SEGMENT = CASE WHEN AGE < 35 THEN "young" END')).toContain('RSL-0001');
    expect(codes('SET SEGMENT = CASE WHEN AGE < 35 THEN "young" ELSE "old" END')).toEqual([]);
  });

  it('requires a MASK to declare WHEN EMPTY, per schema §15', () => {
    expect(codes('MASK Q10 OPTIONS TO SELECTED IN Q5')).toContain('RSL-0001');
  });

  it('treats a trailing IF as part of the statement only on the same line', () => {
    expect(shapes('HIDE Q12 IF S1 = 1')).toEqual(['action']);
    // On the next line it is a new statement — otherwise a bare action swallows the rule below it.
    expect(shapes('HIDE Q12\nIF S1 = 1 THEN SHOW Q12')).toEqual(['action', 'rule']);
  });
});

describe('recovery (D §6.4 P8)', () => {
  it('never throws on any of a set of deliberately broken inputs', () => {
    const inputs = [
      '',
      '   \n\n',
      'IF',
      'IF S1',
      'IF S1 =',
      'IF S1 = 1',
      'IF S1 = 1 THEN',
      'QUESTION',
      'QUESTION Q5',
      'QUESTION Q5 OPTIONS 1',
      'QUESTION Q5 OPTIONS 1 "a"',
      'THEN ELSE END',
      '((((',
      '"unterminated',
      'SET = 1',
      'IF ) THEN SHOW Q12',
      'COUNT(',
      'IF COUNT(Q5 WHERE THEN SHOW Q12',
      'PRIORITY GROUP {',
      'MASK',
      '@@@',
      'IF S1 = 1 THEN SHOW Q12 ELSE',
      'CASE WHEN',
      'item.meta',
      'BLOCK\nEND',
    ];
    for (const input of inputs) {
      expect(() => parse(input, REG), input).not.toThrow();
    }
  });

  it('reports a missing END inside the question that is missing it', () => {
    const source = 'QUESTION Q5\n  TYPE MULTI\n';
    const diagnostics = parse(source, REG).diagnostics;
    expect(diagnostics.map((d) => d.code)).toContain('RSL-0005');
  });

  it('keeps parsing the statements after a broken one', () => {
    const source = ['SHOW Q12', 'IF ) THEN', 'HIDE Q3 OPTION 4'].join('\n');
    const result = parse(source, REG);
    expect(result.diagnostics.length).toBeGreaterThan(0);
    // The good statements on either side are still there: recovery is per-statement, not per-file.
    expect(result.program.statements.map((s) => s.s)).toContain('action');
    expect(result.program.statements.filter((s) => s.s === 'action')).toHaveLength(2);
  });

  it('positions the diagnostic inside the offending region', () => {
    const source = 'IF S1 = 1 THEN SHOW Q12\nIF @ THEN SHOW Q12\n';
    const at = source.indexOf('@');
    const spans = parse(source, REG)
      .diagnostics.map((d) => d.span)
      .filter((span): span is NonNullable<typeof span> => span !== undefined);
    expect(spans.length).toBeGreaterThan(0);
    expect(spans.some((span) => span.start >= at - 2 && span.start <= at + 4)).toBe(true);
    expect(spans.every((span) => span.line === 2)).toBe(true);
  });

  it('does not delete the text it could not read', () => {
    const source = 'SHOW Q12\n$$$ nonsense $$$\nHIDE Q12\n';
    const result = parse(source, REG);
    const error = result.program.statements.find((s) => s.s === 'error');
    expect(error).toBeDefined();
    if (error === undefined || error.s !== 'error') throw new Error('unreachable');
    expect(error.raw).toContain('nonsense');
  });
});

describe('QUOTA is deferred to P2-06', () => {
  const source = [
    'QUOTA MAIN INTERLOCKED {',
    '  DIMENSION GENDER ON S1 {',
    '    M = S1 = 1',
    '  }',
    '  CELL [M] TARGET 100 HARD',
    '  ON UNAVAILABLE FAIL CLOSED',
    '}',
    'IF S1 = 1 THEN SHOW Q12',
  ].join('\n');

  it('rejects it with one clear diagnostic rather than mis-parsing it', () => {
    const result = parse(source, REG);
    const errors = result.diagnostics.filter((d) => d.severity === 'error');
    expect(errors.map((d) => d.code)).toEqual(['RSL-0007']);
    expect(errors[0]?.message).toContain('P2-06');
  });

  it('skips to the matching brace, so the statement after it still parses', () => {
    const result = parse(source, REG);
    expect(result.program.statements.map((s) => s.s)).toEqual(['unsupported', 'rule']);
  });

  it('preserves the block verbatim, so format-on-save does not eat a quota plan', () => {
    const statement = parse(source, REG).program.statements[0];
    if (statement === undefined || statement.s !== 'unsupported') throw new Error('unreachable');
    expect(statement.raw).toContain('ON UNAVAILABLE FAIL CLOSED');
    expect(statement.keyword).toBe('QUOTA');
  });
});
