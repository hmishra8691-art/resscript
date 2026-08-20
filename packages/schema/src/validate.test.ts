/**
 * One test per diagnostic code, plus a coverage assertion at the end so a new code cannot be
 * added without a test that produces it.
 */

import { describe, expect, it } from 'vitest';

import { ALL_DIAGNOSTIC_CODES, type Diagnostic, type DiagnosticCode } from './diagnostics.js';
import { validateShape } from './json-schema.js';
import { parse, parseValue } from './serialize.js';
import type { Survey } from './types/survey.js';
import { validateStructural } from './validate.js';
import { makeMiniSurvey } from './__fixtures__/mini.js';

/** Codes asserted anywhere in this file, checked for completeness by the last test. */
const covered = new Set<DiagnosticCode>();

function expectCode(diagnostics: readonly Diagnostic[], code: DiagnosticCode): Diagnostic {
  covered.add(code);
  const hit = diagnostics.find((d) => d.code === code);
  expect(
    hit,
    `expected ${code}, got ${JSON.stringify(diagnostics.map((d) => `${d.code} ${d.path}`))}`,
  ).toBeDefined();
  return hit as Diagnostic;
}

/**
 * Deep-clone a survey into a loosely typed document. The negative tests exist to hand the
 * validators values the TypeScript types forbid, which is exactly what an untrusted JSON
 * import does — so the reinterpretation below is the honest simulation of that boundary.
 */
function doc(survey: Survey): Record<string, unknown> {
  return JSON.parse(JSON.stringify(survey)) as Record<string, unknown>;
}
function asSurvey(document: Record<string, unknown>): Survey {
  return document as unknown as Survey;
}

/** A well-formed id with an arbitrary body, for references that are meant to dangle. */
function fakeId(prefix: string, n: number): string {
  return `${prefix}_0${String(n).padStart(25, '0')}`;
}

function firstQuestion(document: Record<string, unknown>): Record<string, unknown> {
  const blocks = document['content'] as Record<string, unknown>[];
  const block = blocks[0] as Record<string, unknown>;
  const pages = block['children'] as Record<string, unknown>[];
  const page = pages[0] as Record<string, unknown>;
  const children = page['children'] as Record<string, unknown>[];
  return children[0] as Record<string, unknown>;
}

function variables(document: Record<string, unknown>): Record<string, unknown>[] {
  return document['variables'] as Record<string, unknown>[];
}

describe('the baseline is clean', () => {
  it('a valid survey produces no diagnostics at all', () => {
    expect(validateStructural(makeMiniSurvey())).toEqual([]);
    expect(validateShape(JSON.parse(JSON.stringify(makeMiniSurvey())))).toEqual([]);
  });
});

describe('document-level diagnostics', () => {
  it('SCH-0001 — the document is not JSON', () => {
    const result = parse('{ this is not json');
    expect(result.ok).toBe(false);
    expectCode(result.diagnostics, 'SCH-0001');
  });

  it('SCH-0002 — the root is not an object', () => {
    const result = parseValue([1, 2, 3]);
    expect(result.ok).toBe(false);
    expectCode(result.diagnostics, 'SCH-0002');
  });
});

describe('shape diagnostics', () => {
  it('SCH-0100 — a required field is missing', () => {
    const document = doc(makeMiniSurvey());
    const meta = document['meta'] as Record<string, unknown>;
    delete meta['name'];
    const found = expectCode(validateShape(document), 'SCH-0100');
    expect(found.path).toBe('/meta/name');
  });

  it('SCH-0101 — a field has the wrong type', () => {
    const document = doc(makeMiniSurvey());
    document['schema_version'] = '2';
    const found = expectCode(validateShape(document), 'SCH-0101');
    expect(found.path).toBe('/schema_version');
  });

  it('SCH-0102 — an unknown field is present', () => {
    const document = doc(makeMiniSurvey());
    firstQuestion(document)['sortKey'] = 'a0';
    const found = expectCode(validateShape(document), 'SCH-0102');
    expect(found.path).toMatch(/sortKey$/);
  });

  it('SCH-0103 — a value is outside its allowed set', () => {
    const document = doc(makeMiniSurvey());
    const settings = document['settings'] as Record<string, unknown>;
    settings['progress_bar'] = { mode: 'rainbow' };
    const found = expectCode(validateShape(document), 'SCH-0103');
    expect(found.path).toBe('/settings/progress_bar/mode');
  });

  it('SCH-0104 — a value does not match its pattern', () => {
    const document = doc(makeMiniSurvey());
    const meta = document['meta'] as Record<string, unknown>;
    meta['ref'] = '1_starts_with_a_digit';
    const found = expectCode(validateShape(document), 'SCH-0104');
    expect(found.path).toBe('/meta/ref');
  });
});

describe('structural diagnostics', () => {
  it('SCH-1001 — a ref is used twice', () => {
    const document = doc(makeMiniSurvey());
    const blocks = document['content'] as Record<string, unknown>[];
    const page = ((blocks[0] as Record<string, unknown>)['children'] as Record<string, unknown>[])[0];
    const children = (page as Record<string, unknown>)['children'] as Record<string, unknown>[];
    (children[1] as Record<string, unknown>)['ref'] = 'q1'; // same handle, different case
    const found = expectCode(validateStructural(asSurvey(document)), 'SCH-1001');
    expect(found.message).toContain('q1');
  });

  it('SCH-1002 — an id carries the wrong prefix', () => {
    const document = doc(makeMiniSurvey());
    firstQuestion(document)['id'] = fakeId('pg', 0);
    const found = expectCode(validateStructural(asSurvey(document)), 'SCH-1002');
    expect(found.message).toContain('Expected a qst_ id');
  });

  it('SCH-1003 — a variable shadows a reserved system name', () => {
    const document = doc(makeMiniSurvey());
    variables(document).push({
      id: fakeId('var', 0),
      name: 'respondent_id',
      kind: 'hidden',
      type: 'text',
      export: { include: true, column: 'respondent_id' },
      pii: false,
      persist: true,
    });
    const found = expectCode(validateStructural(asSurvey(document)), 'SCH-1003');
    expect(found.message).toContain('respondent_id');
    expect(found.detail?.['reserved']).toBe('respondent_id');
  });

  it('SCH-1004 — a reference points at an id that does not exist', () => {
    const document = doc(makeMiniSurvey());
    firstQuestion(document)['masks'] = [
      {
        id: fakeId('msk', 0),
        applies_to: 'options',
        mode: 'include',
        source: { kind: 'selected_in', variable_id: fakeId('var', 1) },
        fallback: { when_empty: 'skip_question' },
      },
    ];
    const found = expectCode(validateStructural(asSurvey(document)), 'SCH-1004');
    expect(found.message).toContain(fakeId('var', 1));
  });

  it('SCH-1005 — a mask has no fallback.when_empty', () => {
    const document = doc(makeMiniSurvey());
    const variableId = (variables(document)[0] as Record<string, unknown>)['id'];
    firstQuestion(document)['masks'] = [
      {
        id: fakeId('msk', 0),
        applies_to: 'options',
        mode: 'include',
        source: { kind: 'selected_in', variable_id: variableId },
      },
    ];
    const found = expectCode(validateStructural(asSurvey(document)), 'SCH-1005');
    expect(found.message).toContain('no safe default');
  });

  it('SCH-1006 — two options of one question share a code', () => {
    const document = doc(makeMiniSurvey());
    const options = firstQuestion(document)['options'] as Record<string, unknown>[];
    (options[1] as Record<string, unknown>)['code'] = 1;
    const found = expectCode(validateStructural(asSurvey(document)), 'SCH-1006');
    expect(found.message).toContain('Code 1');
  });

  it('SCH-1007 — an enum variable has an empty domain', () => {
    const document = doc(makeMiniSurvey());
    const variable = variables(document)[0] as Record<string, unknown>;
    variable['enum_domain'] = [];
    expectCode(validateStructural(asSurvey(document)), 'SCH-1007');
  });

  it('SCH-1008 — a referenced i18n key is not in the base bundle', () => {
    const document = doc(makeMiniSurvey());
    (firstQuestion(document)['label'] as Record<string, unknown>)['key'] = 'q1.missing';
    const found = expectCode(validateStructural(asSurvey(document)), 'SCH-1008');
    expect(found.message).toContain('q1.missing');
  });

  it('SCH-1009 — one id is used by two nodes', () => {
    const document = doc(makeMiniSurvey());
    const blocks = document['content'] as Record<string, unknown>[];
    const page = ((blocks[0] as Record<string, unknown>)['children'] as Record<string, unknown>[])[0];
    const children = (page as Record<string, unknown>)['children'] as Record<string, unknown>[];
    const first = children[0] as Record<string, unknown>;
    (children[1] as Record<string, unknown>)['id'] = first['id'];
    expectCode(validateStructural(asSurvey(document)), 'SCH-1009');
  });

  it('SCH-1010 — a stored variable name disagrees with the derivation rule', () => {
    const document = doc(makeMiniSurvey());
    const variable = variables(document)[0] as Record<string, unknown>;
    variable['name'] = 'HANDWRITTEN';
    const found = expectCode(validateStructural(asSurvey(document)), 'SCH-1010');
    expect(found.message).toContain('expected "Q1"');
  });

  it('SCH-1011 — a bundle exists for a language that is not declared', () => {
    const document = doc(makeMiniSurvey());
    const languages = document['languages'] as Record<string, unknown>;
    (languages['bundles'] as Record<string, unknown>)['fr'] = {};
    const found = expectCode(validateStructural(asSurvey(document)), 'SCH-1011');
    expect(found.path).toBe('/languages/bundles/fr');
  });

  it('SCH-1012 — the quota policy has no explicit counter_scope', () => {
    const document = doc(makeMiniSurvey());
    document['quotas'] = {
      policy: {
        count_at: 'reservation',
        reservation_ttl_s: 5400,
        on_store_unavailable: 'fail_closed',
      },
      dimensions: [],
      plans: [],
    };
    const found = expectCode(validateStructural(asSurvey(document)), 'SCH-1012');
    expect(found.message).toContain('no safe default');
  });

  it('SCH-1013 — two exported variables claim one export column', () => {
    const document = doc(makeMiniSurvey());
    const list = variables(document);
    const second = list[1] as Record<string, unknown>;
    second['export'] = { include: true, column: 'Q1' };
    expectCode(validateStructural(asSurvey(document)), 'SCH-1013');
  });

  it('SCH-1014 — a ref cannot be used as a column name', () => {
    const document = doc(makeMiniSurvey());
    firstQuestion(document)['ref'] = '1st_question';
    const found = expectCode(validateStructural(asSurvey(document)), 'SCH-1014');
    expect(found.message).toContain('must start with a letter');
  });

  it('SCH-1015 — an authored derived variable has no expression', () => {
    const document = doc(makeMiniSurvey());
    variables(document).push({
      id: fakeId('var', 2),
      name: 'AGE_BAND',
      kind: 'derived',
      type: 'text',
      export: { include: true, column: 'AGE_BAND' },
      pii: false,
      persist: false,
    });
    const found = expectCode(validateStructural(asSurvey(document)), 'SCH-1015');
    expect(found.message).toContain('no expression');
  });

  it('does not demand an expression for a structurally derived variable', () => {
    // The multi-select set view and the NPS band are synthesized by the compiler from the
    // question's structure; Deliverable D has no authorable operator for them.
    const survey = makeMiniSurvey();
    expect(validateStructural(survey).filter((d) => d.code === 'SCH-1015')).toEqual([]);
  });

  it('sorts diagnostics deterministically', () => {
    const document = doc(makeMiniSurvey());
    firstQuestion(document)['ref'] = '1st';
    (firstQuestion(document)['label'] as Record<string, unknown>)['key'] = 'nope';
    const diagnostics = validateStructural(asSurvey(document));
    const sorted = [...diagnostics].sort(
      (a, b) => a.code.localeCompare(b.code) || a.path.localeCompare(b.path),
    );
    expect(diagnostics).toEqual(sorted);
    expect(validateStructural(asSurvey(document))).toEqual(diagnostics);
  });
});

describe('diagnostic coverage', () => {
  it('every code in the catalogue is produced by a test in this file', () => {
    const missing = ALL_DIAGNOSTIC_CODES.filter((code) => !covered.has(code));
    expect(missing).toEqual([]);
  });
});
