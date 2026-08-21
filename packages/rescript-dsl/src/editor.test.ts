/**
 * The editor-facing surface: `contextAt` (09-ui §7.4's completion driver) and the round-trip
 * fidelity report (D §6.4's last paragraph).
 */

import { describe, expect, it } from 'vitest';
import { contextAt } from './context.js';
import { fidelityOfProgram, fidelityReport } from './fidelity.js';
import { parse } from './index.js';
import { DOM, registry } from './__fixtures__/survey.js';

const REG = registry();

/** The context at the end of `source`, which is where a cursor usually is while typing. */
const at = (source: string): ReturnType<typeof contextAt> => contextAt(source, source.length, REG);

describe('contextAt', () => {
  it('expects a statement at the start of a file and after a newline', () => {
    expect(at('').expecting).toBe('statement');
    expect(at('IF S1 = 1 THEN SHOW Q12\n').expecting).toBe('statement');
  });

  it('expects a variable after IF, AND, OR and NOT', () => {
    for (const prefix of ['IF ', 'IF S1 = 1 AND ', 'IF S1 = 1 OR ', 'IF NOT ']) {
      expect(at(prefix).expecting, prefix).toBe('variable');
    }
  });

  it('expects an operator after a variable, and reports its type so illegal ones are not offered', () => {
    const numeric = at('IF AGE ');
    expect(numeric.expecting).toBe('operator');
    expect(numeric.leftType).toEqual({ k: 'num' });

    const set = at('IF Q5 ');
    expect(set.expecting).toBe('operator');
    expect(set.leftType).toEqual({ k: 'set', d: DOM.fruit });
  });

  it('expects an enum code after a comparison on an enum, and names the domain', () => {
    const context = at('IF S1 = ');
    expect(context.expecting).toBe('enum_code');
    expect(context.domainId).toBe(DOM.s1);
  });

  it('expects an enum code after CONTAINS on a set, and names the domain', () => {
    const context = at('IF Q5 CONTAINS ');
    expect(context.expecting).toBe('enum_code');
    expect(context.domainId).toBe(DOM.fruit);
  });

  it('expects a variable, not a code, after a comparison on a number', () => {
    expect(at('IF AGE >= ').expecting).toBe('variable');
  });

  it('expects a content node after an action keyword, and says which kind', () => {
    expect(at('SHOW ')).toEqual(expect.objectContaining({ expecting: 'question', targetKind: 'question' }));
    expect(at('SHOW PAGE ')).toEqual(expect.objectContaining({ expecting: 'question', targetKind: 'page' }));
    expect(at('RANDOMIZE BLOCK ')).toEqual(expect.objectContaining({ expecting: 'question', targetKind: 'block' }));
  });

  it('expects a quota ref after QUOTA, even though quotas are P2-06', () => {
    expect(at('QUOTA ').expecting).toBe('quota_ref');
  });

  it('reports the flow position, so completion can rank variables set earlier first', () => {
    const source = 'QUESTION Q5\nEND\nIF S1 = 1 THEN SHOW Q12\nIF ';
    expect(contextAt(source, source.length, REG).flowPosition).toBeGreaterThan(0);
  });

  it('returns the span of the token under the cursor, for a replacement range', () => {
    const source = 'IF AGE';
    const context = contextAt(source, source.length - 1, REG);
    expect(context.span?.start).toBe(3);
    expect(context.span?.end).toBe(6);
  });

  it('does not throw on broken input, because it runs on every keystroke', () => {
    for (const source of ['IF (', 'QUESTION', '"', '(((', 'IF Q5 ANY OF [', '@']) {
      expect(() => contextAt(source, source.length, REG), source).not.toThrow();
    }
  });
});

describe('the fidelity report', () => {
  it('says exactly what D §6.4 says it should say', () => {
    const rules = [
      ...Array.from({ length: 3 }, (_, i) => ({ id: `rul_v${String(i)}`, authored_in: 'visual' as const })),
      ...Array.from({ length: 37 }, (_, i) => ({
        id: `rul_d${String(i)}`,
        authored_in: 'dsl' as const,
        trivia: { leading: ['-- a note'] },
      })),
    ];
    const report = fidelityReport(rules);
    expect(report.total).toBe(40);
    expect(report.reformatted).toBe(3);
    expect(report.preserved).toBe(37);
    expect(report.summary).toBe('3 of your 40 rules were edited in the builder and have been reformatted.');
  });

  it('distinguishes “authored in the builder” from “trivia lost on the way through it”', () => {
    const report = fidelityReport([
      { id: 'a', authored_in: 'visual' },
      { id: 'b', authored_in: 'dsl' },
      { id: 'c', authored_in: 'dsl', trivia: { trailing: '# why' } },
    ]);
    expect(report.entries.map((e) => e.reason)).toEqual(['authored_in_visual', 'trivia_lost']);
    expect(report.preserved).toBe(1);
  });

  it('says nothing when nothing was reformatted', () => {
    const report = fidelityReport([{ id: 'a', authored_in: 'dsl', trivia: { blank_before: 1 } }]);
    expect(report.reformatted).toBe(0);
    expect(report.summary).toBe('');
  });

  it('reports over a parsed program, which is what format-on-save wants', () => {
    const source = '-- keep me\nIF S1 = 1 THEN SHOW Q12\nHIDE Q12\n';
    const report = fidelityOfProgram(parse(source, REG).program.statements);
    expect(report.total).toBe(2);
    // The first statement carries a comment; the second carries nothing to lose.
    expect(report.preserved).toBe(1);
    expect(report.reformatted).toBe(1);
  });
});
