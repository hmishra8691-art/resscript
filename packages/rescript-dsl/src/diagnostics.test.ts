/**
 * The diagnostic catalogue's own invariants.
 *
 * Codes are a public contract — UI copy, docs links and CI allowlists key off them — so the things
 * asserted here are the things a future edit could break silently: a code with no severity, a
 * duplicate, a code that no longer sorts where a golden file expects it.
 */

import { describe, expect, it } from 'vitest';
import { ALL_LGC_CODES } from '@resscript/logic';
import {
  ALL_RSL_CODES,
  RSL_DIAGNOSTIC_CODES,
  RSL_SEVERITY,
  hasDslErrors,
  rslDiagnostic,
  sortDslDiagnostics,
  spanCovers,
  type DslDiagnostic,
} from './diagnostics.js';

const span = (start: number, end: number, line = 1) => ({ start, end, line, col: start + 1 });

describe('the RSL catalogue', () => {
  it('gives every code a severity', () => {
    for (const code of ALL_RSL_CODES) expect(RSL_SEVERITY[code]).toBeDefined();
    expect(Object.keys(RSL_SEVERITY)).toEqual([...ALL_RSL_CODES]);
  });

  it('has unique, sorted, non-empty descriptions', () => {
    expect(new Set(ALL_RSL_CODES).size).toBe(ALL_RSL_CODES.length);
    expect([...ALL_RSL_CODES]).toEqual([...ALL_RSL_CODES].sort());
    for (const code of ALL_RSL_CODES) expect(RSL_DIAGNOSTIC_CODES[code].length).toBeGreaterThan(10);
  });

  it('does not collide with the LGC catalogue', () => {
    // The two families are disjoint by construction — RSL is lexical and syntactic, LGC is
    // semantic — and a collision would make one of them unrenderable in a shared UI.
    const lgc = new Set<string>(ALL_LGC_CODES);
    for (const code of ALL_RSL_CODES) expect(lgc.has(code)).toBe(false);
  });

  it('makes the page/block resolution gap a warning, not an error', () => {
    // logic's registry does not name pages or blocks at all (see registry.ts), so an unresolved page
    // ref is a fact about the caller's registry, not a defect in the source. An error here would
    // block publish on a valid statement.
    expect(RSL_SEVERITY['RSL-0012']).toBe('warning');
  });
});

describe('sorting and predicates', () => {
  it('sorts by position, because that is the order an editor and a human want', () => {
    const later = rslDiagnostic('RSL-0001', 'later', span(40, 44));
    const earlier = rslDiagnostic('RSL-0015', 'earlier', span(2, 3));
    expect(sortDslDiagnostics([later, earlier]).map((d) => d.message)).toEqual(['earlier', 'later']);
  });

  it('puts an unpositioned diagnostic first and still totally orders', () => {
    const positioned = rslDiagnostic('RSL-0001', 'a', span(0, 1));
    const floating: DslDiagnostic = { code: 'LGC-T001', severity: 'error', message: 'b', path: '' };
    expect(sortDslDiagnostics([positioned, floating]).map((d) => d.message)).toEqual(['b', 'a']);
  });

  it('reports errors distinctly from warnings', () => {
    expect(hasDslErrors([rslDiagnostic('RSL-0012', 'w', span(0, 1))])).toBe(false);
    expect(hasDslErrors([rslDiagnostic('RSL-0001', 'e', span(0, 1))])).toBe(true);
  });

  it('covers an offset inside a span, and a zero-width span at its own point', () => {
    expect(spanCovers(span(2, 5), 2)).toBe(true);
    expect(spanCovers(span(2, 5), 4)).toBe(true);
    expect(spanCovers(span(2, 5), 5)).toBe(false);
    expect(spanCovers(span(3, 3), 3)).toBe(true);
    expect(spanCovers(span(3, 3), 4)).toBe(false);
  });
});
