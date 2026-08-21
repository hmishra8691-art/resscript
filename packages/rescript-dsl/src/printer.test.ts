/**
 * Printer tests — the golden output, and the four things T2 forbids changing.
 *
 * The goldens are here rather than in files on purpose: a printer's output *is* the product surface
 * for code mode, and a change to it should be visible in a diff of this file with a reason attached,
 * not discovered by regenerating a snapshot.
 */

import { describe, expect, it } from 'vitest';
import { format, parse } from './index.js';
import { print, printExpr } from './printer.js';
import { registry } from './__fixtures__/survey.js';

const REG = registry();

/** `print(parse(s))` — what format-on-save does. */
const fmt = (source: string): string => format(source, REG).source;

describe('golden output', () => {
  it('prints a rule on one line when it fits', () => {
    // Keywords are case-insensitive; refs are not (D §6.2), so `S1` stays exactly as typed.
    expect(fmt('if   S1=1   then show   Q12')).toBe('IF S1 = 1 THEN SHOW Q12\n');
  });

  it('breaks a long rule at the top-level connective, D §9.2 style', () => {
    const source =
      'IF Q5 CONTAINS Q5.Apple AND Q6 > 10 AND (S1 = 1 OR (COUNT(Q5) >= 3 AND Q5 NONE OF [99])) AND NOT (AGE < 18) THEN SHOW Q12 AND SET HEAVY_BUYER = TRUE ELSE HIDE Q12';
    expect(fmt(source)).toBe(
      [
        'IF Q5 CONTAINS Q5.Apple',
        '   AND Q6 > 10',
        '   AND (S1 = 1 OR (COUNT(Q5) >= 3 AND Q5 NONE OF [99]))',
        '   AND NOT (AGE < 18)',
        '  THEN SHOW Q12',
        '   AND SET HEAVY_BUYER = TRUE',
        '  ELSE HIDE Q12',
        '',
      ].join('\n'),
    );
  });

  it('prints a question definition with a fixed clause order and two-space indents', () => {
    const source = 'QUESTION Q5 OPTIONS 1 "Apple" 99 "None" EXCLUSIVE ANCHOR LAST LABEL "Fruits?" TYPE MULTI REQUIRED END';
    expect(fmt(source)).toBe(
      [
        'QUESTION Q5',
        '  TYPE MULTI',
        '  LABEL "Fruits?"',
        '  REQUIRED',
        '  OPTIONS',
        '    1 "Apple"',
        '    99 "None" EXCLUSIVE ANCHOR LAST',
        'END',
        '',
      ].join('\n'),
    );
  });

  it('indents nested statements inside BLOCK, PAGE and PRIORITY GROUP', () => {
    const source = 'BLOCK MAIN LABEL "M" PAGE P2 IF S1 = 1 THEN SHOW Q12 END END\nPRIORITY GROUP g { SET SEGMENT = "a" }';
    expect(fmt(source)).toBe(
      [
        'BLOCK MAIN',
        '  LABEL "M"',
        '  PAGE P2',
        '    IF S1 = 1 THEN SHOW Q12',
        '  END',
        'END',
        'PRIORITY GROUP g {',
        '  SET SEGMENT = "a"',
        '}',
        '',
      ].join('\n'),
    );
  });

  it('normalizes == to = and <> to !=, and uppercases keywords', () => {
    expect(fmt('if Q6==1 and OE<>"x" then show Q12')).toBe('IF Q6 = 1 AND OE != "x" THEN SHOW Q12\n');
  });

  it('drops redundant parentheses the author did not write', () => {
    const parsed = parse('IF S1 = 1 AND AGE >= 18 THEN SHOW Q12', REG);
    // No parens in, none out. The printer only adds what precedence demands.
    expect(print(parsed.program, REG)).toBe('IF S1 = 1 AND AGE >= 18 THEN SHOW Q12\n');
  });
});

describe('what T2 forbids the printer from changing', () => {
  it('keeps comments, their marker and their attachment point', () => {
    const source = ['# leading', '-- also leading', 'IF S1 = 1 THEN SHOW Q12 /* trailing */', ''].join('\n');
    expect(fmt(source)).toBe(source);
  });

  it('keeps blank-line grouping, capped at two', () => {
    expect(fmt('SHOW Q12\n\nHIDE Q12\n')).toBe('SHOW Q12\n\nHIDE Q12\n');
    expect(fmt('SHOW Q12\n\n\n\n\nHIDE Q12\n')).toBe('SHOW Q12\n\n\nHIDE Q12\n');
  });

  it('keeps the author’s redundant parentheses (D §6.4 paren_hints)', () => {
    expect(fmt('IF (S1 = 1 AND Q6 > 10) OR AGE >= 65 THEN SHOW Q12')).toBe(
      'IF (S1 = 1 AND Q6 > 10) OR AGE >= 65 THEN SHOW Q12\n',
    );
    expect(fmt('IF (S1 = 1) THEN SHOW Q12')).toBe('IF (S1 = 1) THEN SHOW Q12\n');
  });

  it('keeps the author’s choice of symbolic vs numeric option refs', () => {
    expect(fmt('IF Q5 CONTAINS Q5.Apple THEN SHOW Q12')).toBe('IF Q5 CONTAINS Q5.Apple THEN SHOW Q12\n');
    expect(fmt('IF Q5 CONTAINS 1 THEN SHOW Q12')).toBe('IF Q5 CONTAINS 1 THEN SHOW Q12\n');
    expect(fmt('IF Q5 ANY OF [Q5.Apple, 3] THEN SHOW Q12')).toBe('IF Q5 ANY OF [Q5.Apple, 3] THEN SHOW Q12\n');
  });

  it('never elides a CASE else, per D §2.5', () => {
    expect(fmt('SET SEGMENT = CASE WHEN AGE < 35 THEN "young" ELSE "old" END')).toBe(
      'SET SEGMENT = CASE WHEN AGE < 35 THEN "young" ELSE "old" END\n',
    );
  });
});

describe('shapes that only round-trip because the printer is careful', () => {
  it('parenthesizes a nested same-operator boolean so it does not flatten', () => {
    const first = parse('IF S1 = 1 OR (Q6 > 1 OR AGE > 2) THEN SHOW Q12', REG);
    const printed = print(first.program, REG);
    expect(printed).toBe('IF S1 = 1 OR (Q6 > 1 OR AGE > 2) THEN SHOW Q12\n');
    const second = parse(printed, REG);
    const statement = second.program.statements[0];
    if (statement === undefined || statement.s !== 'rule') throw new Error('expected a rule');
    expect(statement.condition.op).toBe('or');
    expect(statement.condition.op === 'or' ? statement.condition.args.length : 0).toBe(2);
  });

  it('parenthesizes a double negation, which would otherwise print as a comment', () => {
    expect(fmt('IF -(-Q6) > 0 THEN SHOW Q12')).toBe('IF -(-Q6) > 0 THEN SHOW Q12\n');
  });

  it('parenthesizes a negated numeric literal so it does not fold into the literal', () => {
    expect(fmt('IF -(5) > 0 THEN SHOW Q12')).toBe('IF -(5) > 0 THEN SHOW Q12\n');
    expect(fmt('IF -5 > 0 THEN SHOW Q12')).toBe('IF -5 > 0 THEN SHOW Q12\n');
  });

  it('brackets a single-variable aggregation group so it cannot re-parse as a question', () => {
    // `Q5` names both the multi-select question and its derived set view. An unbracketed group would
    // re-parse as `question_emits`, not `explicit`.
    expect(fmt('IF COUNT([Q5]) > 0 THEN SHOW Q12')).toBe('IF COUNT([Q5]) > 0 THEN SHOW Q12\n');
    expect(fmt('IF COUNT(Q5) > 0 THEN SHOW Q12')).toBe('IF COUNT(Q5) > 0 THEN SHOW Q12\n');
  });

  it('disambiguates a question probe from a variable probe of the same name', () => {
    expect(fmt('IF ANSWERED(QUESTION Q12) THEN SHOW Q12')).toBe('IF ANSWERED(QUESTION Q12) THEN SHOW Q12\n');
    expect(fmt('IF ANSWERED(Q12) THEN SHOW Q12')).toBe('IF ANSWERED(Q12) THEN SHOW Q12\n');
  });

  it('anchors a domain when no operand can supply it', () => {
    // Both operands are literals, so a bare `1` would re-parse as `num` and the comparison would
    // change type. The printer emits the symbolic form instead.
    const parsed = parse('IF Q5 ANY OF [1] THEN SHOW Q12', REG);
    const statement = parsed.program.statements[0];
    if (statement === undefined || statement.s !== 'rule') throw new Error('expected a rule');
    // Reconstruct `[1] ANY OF [1]`, which no author would write but a builder can produce.
    const both = print(
      {
        statements: [
          {
            ...statement,
            condition:
              statement.condition.op === 'any_of'
                ? { ...statement.condition, args: [statement.condition.args[1], statement.condition.args[1]] }
                : statement.condition,
            trivia: {},
          },
        ],
      },
      REG,
    );
    expect(both).toBe('IF [Q5.Apple] ANY OF [1] THEN SHOW Q12\n');
    expect(parse(both, REG).diagnostics).toEqual([]);
  });
});

describe('printExpr', () => {
  it('prints a bare expression for a diagnostic or a flow-graph branch label', () => {
    const statement = parse('IF S1 = 1 AND AGE >= 18 THEN SHOW Q12', REG).program.statements[0];
    if (statement === undefined || statement.s !== 'rule') throw new Error('expected a rule');
    expect(printExpr(statement.condition, REG)).toBe('S1 = 1 AND AGE >= 18');
  });
});

describe('format', () => {
  it('is idempotent, which is what makes format-on-save safe', () => {
    const source = 'if s1=1 then show Q12 else hide Q12';
    const once = fmt(source);
    expect(fmt(once)).toBe(once);
  });

  it('reports diagnostics without refusing to format, and without rewriting the author’s text', () => {
    const result = format('IF NOPE = 1 THEN SHOW Q12', REG);
    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((d) => d.code)).toContain('LGC-T001');
    // An unresolvable ref prints back as itself. A formatter that turned a typo into `NULL` would be
    // deleting the author's work.
    expect(result.source).toBe('IF NOPE = 1 THEN SHOW Q12\n');
  });

  it('is case-sensitive about refs, so a mis-cased ref is a diagnostic and not a silent rename', () => {
    const result = format('IF s1 = 1 THEN SHOW Q12', REG);
    expect(result.diagnostics.map((d) => d.code)).toContain('LGC-T001');
    expect(result.source).toBe('IF s1 = 1 THEN SHOW Q12\n');
  });
});
