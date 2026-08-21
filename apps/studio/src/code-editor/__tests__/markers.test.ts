/**
 * Diagnostic → marker mapping. The property under test is that a marker lands on **the span the
 * DSL reported**, in Monaco's coordinates (1-based line/column over UTF-16 code units).
 *
 * Two failure modes this suite exists for, both of which produce underlines that drift away from
 * the text they describe:
 *
 *  - off-by-one on the column, because Monaco is 1-based and every offset in the DSL is 0-based;
 *  - a byte-vs-code-unit assumption, which is invisible in English and wrong in every survey with
 *    a non-ASCII label. `packages/rescript-dsl`'s diagnostics.ts records the same decision.
 */

import { describe, expect, it } from 'vitest';
import { parse } from '@resscript/rescript-dsl';
import { MARKER_OWNER, docsUrlFor, offsetAt, positionAt, spanToRange, toMarkers } from '@/code-editor/markers';
import { fixtureRegistry } from '@/test/dsl-fixture';

describe('positionAt / offsetAt', () => {
  it('is 1-based and counts UTF-16 code units, like Monaco', () => {
    const source = 'IF S1 = 1\nTHEN SHOW Q12\n';
    expect(positionAt(source, 0)).toEqual({ lineNumber: 1, column: 1 });
    expect(positionAt(source, 3)).toEqual({ lineNumber: 1, column: 4 });
    expect(positionAt(source, 10)).toEqual({ lineNumber: 2, column: 1 });
    // Round trip: what Monaco would hand back for the same place.
    expect(offsetAt(source, positionAt(source, 15))).toBe(15);
  });

  it('counts an astral-plane character as the two code units Monaco counts', () => {
    // A survey label can contain anything; an emoji is the cheapest way to write a surrogate pair.
    const source = '# 🎯 target\nIF S1 = 1 THEN SHOW Q12\n';
    const secondLine = source.indexOf('IF');
    expect(positionAt(source, secondLine)).toEqual({ lineNumber: 2, column: 1 });
    // The comment line is 11 characters as JavaScript counts them (the emoji is two), and a
    // byte-oriented implementation would put the newline at 13.
    expect(source.slice(0, 11)).toBe('# 🎯 target');
    expect(positionAt(source, 11)).toEqual({ lineNumber: 1, column: 12 });
  });
});

describe('toMarkers', () => {
  it('puts an unknown-variable diagnostic exactly on the offending token', () => {
    const registry = fixtureRegistry();
    // `NOPE` is not in the registry, so the resolver reports LGC-T001 at its span.
    const source = 'IF NOPE = 1 THEN SHOW Q12\n';
    const { diagnostics } = parse(source, registry);
    const unknown = diagnostics.find((d) => d.code === 'LGC-T001');
    expect(unknown, 'the fixture must produce the diagnostic this test is about').toBeDefined();

    const markers = toMarkers(source, diagnostics);
    const marker = markers.find((m) => m.code.value === 'LGC-T001');
    expect(marker).toBeDefined();
    if (marker === undefined || unknown?.span === undefined) return;

    // The span the DSL reported, in Monaco's coordinates — asserted against the text rather than
    // against hard-coded numbers, so a change in the parser's span moves both sides together.
    expect(source.slice(unknown.span.start, unknown.span.end)).toBe('NOPE');
    expect(marker.startLineNumber).toBe(1);
    expect(marker.startColumn).toBe(source.indexOf('NOPE') + 1);
    expect(marker.endColumn).toBe(source.indexOf('NOPE') + 'NOPE'.length + 1);
    expect(marker.severity).toBe(8); // MarkerSeverity.Error
    expect(marker.source).toBe(MARKER_OWNER);
    expect(marker.code.target).toBe(docsUrlFor('LGC-T001'));
  });

  it('maps severities to Monaco: error 8, warning 4, info 2', () => {
    const source = 'IF S1 = 1 THEN SKIP TO PAGE P9\n';
    const registry = fixtureRegistry();
    const { diagnostics } = parse(source, registry);
    const markers = toMarkers(source, diagnostics);
    for (const marker of markers) {
      expect([2, 4, 8]).toContain(marker.severity);
    }
    // `P9` is not in the node index, which is an RSL-0012 *warning* — never an error, because a
    // page ref the studio cannot resolve yet must not block anything.
    const unresolved = markers.find((m) => m.code.value === 'RSL-0012');
    expect(unresolved?.severity).toBe(4);
  });

  it('widens a zero-width span so the squiggle is visible', () => {
    const source = 'IF';
    const range = spanToRange(source, { start: 2, end: 2, line: 1, col: 3 });
    expect(range.startColumn).toBe(3);
    expect(range.endColumn).toBeGreaterThan(range.startColumn);
  });

  it('still produces a marker for a diagnostic with no span', () => {
    const markers = toMarkers('IF S1 = 1 THEN SHOW Q12\n', [
      { code: 'LGC-T001', severity: 'error', message: 'no span here', path: '' },
    ]);
    expect(markers).toHaveLength(1);
    expect(markers[0]?.startLineNumber).toBe(1);
  });

  it('never places a marker outside the document', () => {
    const source = 'IF S1 = 1\n';
    const markers = toMarkers(source, [
      { code: 'RSL-0005', severity: 'error', message: 'past the end', path: '', span: { start: 999, end: 1200, line: 9, col: 9 } },
    ]);
    const marker = markers[0];
    expect(marker?.startLineNumber).toBe(2);
    expect(marker?.startColumn).toBe(1);
  });
});
