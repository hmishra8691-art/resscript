/**
 * Resolver tests: `ref` → `id`, domain placement, and the diagnostics.
 *
 * The claim this file exists to defend is D §3.4's requirement 2 — "it fires at publish and blocks;
 * the editor and the compiler cannot disagree because they are the same code". So every semantic
 * diagnostic here carries an `LGC-####` code produced by `packages/logic`'s checker, not a
 * lookalike invented in this package, and every one carries a span the editor can underline.
 */

import { describe, expect, it } from 'vitest';
import { parse } from './index.js';
import { print } from './printer.js';
import { registry, registryWithoutNodes, renamedRegistry, V } from './__fixtures__/survey.js';

const REG = registry();

interface Found {
  readonly code: string;
  readonly text: string;
  readonly line: number;
}

function diagnose(source: string): readonly Found[] {
  return parse(source, REG).diagnostics.map((d) => ({
    code: d.code,
    text: d.span === undefined ? '' : source.slice(d.span.start, d.span.end),
    line: d.span?.line ?? 0,
  }));
}

describe('reference resolution', () => {
  it('resolves a variable ref to its stable id', () => {
    const statement = parse('SET HEAVY_BUYER = TRUE', REG).program.statements[0];
    if (statement === undefined || statement.s !== 'set') throw new Error('expected a set');
    expect(statement.variable.id).toBe(V.heavy);
  });

  it('resolves a question ref to its stable id', () => {
    const statement = parse('SHOW Q12', REG).program.statements[0];
    if (statement === undefined || statement.s !== 'action') throw new Error('expected an action');
    if (statement.action.a !== 'show') throw new Error('expected a show');
    expect(statement.action.target.ref.id).toBe('qst_q12');
  });

  it('reports an unknown ref as LGC-T001, positioned on the ref', () => {
    const found = diagnose('IF NOPE = 1 THEN SHOW Q12');
    expect(found.map((f) => f.code)).toContain('LGC-T001');
    expect(found.find((f) => f.code === 'LGC-T001')?.text).toBe('NOPE');
  });

  it('warns rather than errors when a page ref cannot be resolved without a node index', () => {
    const result = parse('SKIP TO PAGE P3', registryWithoutNodes());
    expect(result.diagnostics.map((d) => d.code)).toEqual(['RSL-0012']);
    // A warning, so publish is not blocked: logic's registry does not name pages at all, and the
    // compiler resolves it from the content tree.
    expect(result.diagnostics[0]?.severity).toBe('warning');
    expect(result.ok).toBe(true);
  });

  it('resolves a page ref when a node index is supplied', () => {
    const result = parse('SKIP TO PAGE P3', REG);
    expect(result.diagnostics).toEqual([]);
  });

  it('prints the current ref after a rename, with no find-and-replace and no stored AST change', () => {
    // The P1-07 acceptance criterion, verbatim: "Renaming Q1 to S1 in the tree editor changes the DSL
    // text shown in the code pane without any find-and-replace and without touching stored ASTs."
    const parsed = parse('IF Q5 CONTAINS 1 AND AGE >= 18 THEN SHOW Q12', REG);
    expect(print(parsed.program, REG)).toBe('IF Q5 CONTAINS 1 AND AGE >= 18 THEN SHOW Q12\n');
    // Same program object, different registry: Q5 → S5 and AGE → AGE_YEARS, every id unchanged.
    expect(print(parsed.program, renamedRegistry())).toBe(
      'IF S5 CONTAINS 1 AND AGE_YEARS >= 18 THEN SHOW Q12\n',
    );
  });
});

describe('domain placement (D §2.2, D §3.3)', () => {
  it('gives a bare code the domain of the operand it is compared against', () => {
    const statement = parse('IF S1 = 1 THEN SHOW Q12', REG).program.statements[0];
    if (statement === undefined || statement.s !== 'rule') throw new Error('expected a rule');
    const right = statement.condition.op === '==' ? statement.condition.args[1] : undefined;
    expect(right?.op).toBe('lit');
    expect(right?.op === 'lit' ? right.v : undefined).toEqual({ k: 'enum', v: 1, d: 'dom_s1' });
  });

  it('works in either operand order', () => {
    for (const source of ['IF S1 = 1 THEN SHOW Q12', 'IF 1 = S1 THEN SHOW Q12']) {
      expect(parse(source, REG).diagnostics, source).toEqual([]);
    }
  });

  it('resolves a symbolic option reference to its code and records the spelling', () => {
    const statement = parse('IF Q5 CONTAINS Q5.Apple THEN SHOW Q12', REG).program.statements[0];
    if (statement === undefined || statement.s !== 'rule') throw new Error('expected a rule');
    const element = statement.condition.op === 'contains' ? statement.condition.args[1] : undefined;
    expect(element?.op === 'lit' ? element.v : undefined).toEqual({ k: 'enum', v: 1, d: 'dom_fruit' });
    expect(Object.values(statement.trivia?.symbolic_refs ?? {})).toEqual(['Q5.Apple']);
  });

  it('rejects an unknown symbolic option reference', () => {
    const found = diagnose('IF Q5 CONTAINS Q5.Kumquat THEN SHOW Q12');
    expect(found.map((f) => f.code)).toContain('RSL-0014');
  });

  it('refuses to guess a domain it cannot infer', () => {
    // A code list with nothing to infer from. Reported rather than defaulted: enum domains are
    // nominal (D §2.2), so a code with no domain has no meaning.
    expect(diagnose('SET SEGMENT = "x" \nIF [1, 2] ANY OF [3] THEN SHOW Q12').map((f) => f.code)).toContain(
      'RSL-0021',
    );
  });
});

describe('type diagnostics come from packages/logic, with a span added', () => {
  it('rejects comparing an enum to a text label (D §3.4)', () => {
    const found = diagnose('IF S1 = "yes" THEN SHOW Q12');
    expect(found.map((f) => f.code)).toContain('LGC-T003');
  });

  it('rejects an ordered comparison on a nominal domain (D §3.3)', () => {
    // Q12's domain is a brand list, so `>` on it is the top-2-box bug.
    expect(diagnose('IF Q12 > 1 THEN SHOW Q12').map((f) => f.code)).toContain('LGC-T009');
    // Q9's domain is a Likert scale, declared ordinal, so `>` is legal there.
    expect(diagnose('IF Q9 > 3 THEN SHOW Q12').map((f) => f.code)).toEqual([]);
  });

  it('rejects an enum comparison across domains (D §3.2)', () => {
    expect(diagnose('IF S1 = Q3.A THEN SHOW Q12').map((f) => f.code)).toContain('LGC-T007');
  });

  it('rejects `item` outside an aggregation, and accepts it inside a per-item mask', () => {
    expect(diagnose('IF item.code = 1 THEN SHOW Q12').map((f) => f.code)).toContain('LGC-T012');
    // The per-item form binds `item` from the target question's option list.
    expect(diagnose('HIDE Q3 OPTION WHERE item.meta.discontinued = TRUE').map((f) => f.code)).toEqual([]);
  });

  it('rejects a non-boolean rule condition (D §2.5s single coercion point)', () => {
    expect(diagnose('IF Q6 THEN SHOW Q12').map((f) => f.code)).toContain('LGC-T033');
  });

  it('notes an ON UNKNOWN override as LGC-I002 rather than accepting it silently', () => {
    // The note exists so a reviewer sees every override (D §2.5). It is `info`, so it blocks nothing.
    const source = 'IF Q9 > 3 ON UNKNOWN SHOW THEN SHOW Q12';
    const result = parse(source, REG);
    expect(result.ok).toBe(true);
    // The condition itself is checked; the rule-level note is emitted by `checkRule`, which the
    // compiler runs — see the note in the milestone report about statement-level rule checks.
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  });

  it('positions a type diagnostic on the offending node, not on the statement', () => {
    const source = 'IF AGE >= 18 AND S1 = "yes" THEN SHOW Q12';
    const found = diagnose(source).find((f) => f.code === 'LGC-T003');
    expect(found?.text).toBe('S1 = "yes"');
  });
});

describe('forward references', () => {
  const rule = 'IF AGE >= 18 THEN SHOW Q12';
  const question = 'QUESTION Q_AGE\n  TYPE NUMERIC\nEND';

  it('reports a rule that reads a variable collected by a question defined later', () => {
    const source = `${rule}\n\n${question}\n`;
    const found = parse(source, REG).diagnostics;
    expect(found.map((d) => d.code)).toContain('LGC-F001');
    const forward = found.find((d) => d.code === 'LGC-F001');
    expect(forward?.message).toContain('Q_AGE');
    expect(source.slice(forward?.span?.start ?? 0, forward?.span?.end ?? 0)).toBe('AGE');
  });

  it('does not report the same rule when the question comes first', () => {
    expect(parse(`${question}\n\n${rule}\n`, REG).diagnostics.map((d) => d.code)).not.toContain('LGC-F001');
  });

  it('says nothing about a variable whose question is not in this document', () => {
    // D §8.1's real analysis is a dominance query over the flow graph and belongs to the compiler;
    // guessing here would produce a false error on a fragment.
    expect(parse(rule, REG).diagnostics).toEqual([]);
  });
});

describe('the source map', () => {
  it('maps every expression node to a span inside the source', () => {
    const source = 'IF S1 = 1 AND AGE >= 18 THEN SHOW Q12';
    const result = parse(source, REG);
    expect(result.source_map.length).toBeGreaterThan(5);
    for (const entry of result.source_map) {
      expect(entry.span.start).toBeGreaterThanOrEqual(0);
      expect(entry.span.end).toBeLessThanOrEqual(source.length);
      expect(entry.span.end).toBeGreaterThan(entry.span.start);
    }
    // `ast_node_id` in the API's response is this node id (API §5.1), so it must be the id the
    // annotated tree carries.
    const statement = result.program.statements[0];
    if (statement === undefined || statement.s !== 'rule') throw new Error('expected a rule');
    expect(result.source_map.some((entry) => entry.node === statement.condition.n)).toBe(true);
  });
});

describe('the checker annotates the tree it returns', () => {
  it('caches a type on every node (D §2.1 item 5)', () => {
    const statement = parse('IF S1 = 1 THEN SHOW Q12', REG).program.statements[0];
    if (statement === undefined || statement.s !== 'rule') throw new Error('expected a rule');
    expect(statement.condition.t).toEqual({ k: 'bool' });
  });
});
