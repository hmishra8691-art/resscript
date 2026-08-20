/**
 * The round-trip property. This is the milestone's central guarantee: whatever the editor,
 * the DSL or an importer builds, writing it out and reading it back yields the same survey —
 * and writing it twice yields the same bytes, so an artifact hash is a function of content.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { arbitrarySurvey } from './__fixtures__/arbitrary.js';
import { parse, serialize, stableStringify } from './serialize.js';
import { validateStructural } from './validate.js';

const RUNS = 200;

describe('round trip (property)', () => {
  it('serialize -> parse -> deep equal', () => {
    fc.assert(
      fc.property(arbitrarySurvey, (survey) => {
        const result = parse(serialize(survey));
        if (!result.ok) {
          throw new Error(
            `parse rejected a generated survey: ${JSON.stringify(result.diagnostics.slice(0, 3))}`,
          );
        }
        expect(result.survey).toStrictEqual(survey);
      }),
      { numRuns: RUNS },
    );
  });

  it('serialize twice -> byte identical', () => {
    fc.assert(
      fc.property(arbitrarySurvey, (survey) => {
        const once = serialize(survey);
        const result = parse(once);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(serialize(result.survey)).toBe(once);
      }),
      { numRuns: RUNS },
    );
  });

  it('the generator only produces structurally valid surveys', () => {
    // If this ever fails, the two properties above have quietly stopped testing anything
    // interesting, because `parse` would be rejecting the input before comparing.
    fc.assert(
      fc.property(arbitrarySurvey, (survey) => {
        expect(validateStructural(survey)).toEqual([]);
      }),
      { numRuns: RUNS },
    );
  });
});

describe('canonical form', () => {
  it('key order does not depend on insertion order', () => {
    const a = stableStringify({ b: 1, a: 2, id: 3 });
    const b = stableStringify({ a: 2, id: 3, b: 1 });
    expect(a).toBe(b);
  });

  it('hoists identifying keys so a diff hunk names its node', () => {
    const text = stableStringify({ zzz: 1, question_type: 'nps', ref: 'Q1', id: 'qst_x', aaa: 2 });
    expect(text.split('\n').slice(1, 5).map((l) => l.trim().split(':')[0])).toEqual([
      '"id"',
      '"ref"',
      '"question_type"',
      '"aaa"',
    ]);
  });

  it('preserves array order, which is semantic everywhere in this model', () => {
    expect(stableStringify([3, 1, 2])).toBe('[\n  3,\n  1,\n  2\n]\n');
  });

  it('drops undefined rather than emitting null, and ends with exactly one newline', () => {
    const text = stableStringify({ a: 1, b: undefined });
    expect(text).toBe('{\n  "a": 1\n}\n');
  });

  it('refuses to serialize a non-finite number instead of writing null', () => {
    expect(() => stableStringify({ a: Number.NaN })).toThrow(/non-finite/);
    expect(() => stableStringify({ a: Number.POSITIVE_INFINITY })).toThrow(/non-finite/);
  });

  it('escapes keys per RFC 8259 and keeps empty containers compact', () => {
    expect(stableStringify({ 'a/b': [], c: {} })).toBe('{\n  "a/b": [],\n  "c": {}\n}\n');
  });
});

describe('parse diagnostics', () => {
  it('reports every shape problem at once rather than the first', () => {
    const result = parse('{"meta":{},"schema_version":"x"}');
    expect(result.ok).toBe(false);
    expect(result.diagnostics.length).toBeGreaterThan(2);
  });

  it('can skip structural validation for a mid-edit document', () => {
    const survey = fc.sample(arbitrarySurvey, 1)[0];
    if (survey === undefined) throw new Error('no sample');
    const text = serialize(survey);
    expect(parse(text, { structural: false }).ok).toBe(true);
  });
});
