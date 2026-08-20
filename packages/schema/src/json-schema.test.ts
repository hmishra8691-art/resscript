/**
 * Drift tests for the schema descriptor.
 *
 * The compiler already enforces the descriptor-to-type correspondence (see `FieldsOf`), so
 * these tests cover what the type system cannot: that the emitted JSON Schema is well formed,
 * that every `ref` resolves, and that the descriptor accepts the real fixture without
 * complaining about fields it has never heard of.
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { SCHEMA_DEFS, fieldNamesOf, toJsonSchema, validateShape, type SchemaDesc } from './json-schema.js';
import { makeMiniSurvey } from './__fixtures__/mini.js';

function loadAcceptanceFixture(): unknown {
  const text = readFileSync(new URL('./__fixtures__/acceptance-survey.json', import.meta.url), 'utf8');
  return JSON.parse(text);
}

function walk(desc: SchemaDesc, visit: (d: SchemaDesc) => void): void {
  visit(desc);
  switch (desc.kind) {
    case 'array':
      walk(desc.items, visit);
      return;
    case 'record':
      walk(desc.values, visit);
      return;
    case 'object':
      for (const field of Object.values(desc.fields)) walk(field.desc, visit);
      return;
    case 'union':
      for (const variant of desc.variants) walk(variant, visit);
      return;
    default:
      return;
  }
}

describe('the descriptor', () => {
  it('resolves every ref it uses', () => {
    const missing: string[] = [];
    for (const desc of Object.values(SCHEMA_DEFS)) {
      walk(desc, (d) => {
        if (d.kind === 'ref' && SCHEMA_DEFS[d.name] === undefined) missing.push(d.name);
      });
    }
    expect(missing).toEqual([]);
  });

  it('accepts the acceptance fixture with no unknown-field complaints', () => {
    // The other direction of drift: a field the model gained but the descriptor never learned
    // would show up here as SCH-0102 the moment the fixture used it.
    expect(validateShape(loadAcceptanceFixture())).toEqual([]);
  });

  it('accepts a minimal survey', () => {
    expect(validateShape(JSON.parse(JSON.stringify(makeMiniSurvey())))).toEqual([]);
  });

  it('knows exactly the fields of a question, so a silent widening fails here', () => {
    expect(fieldNamesOf('QuestionNode')).toEqual([
      'cells',
      'columns',
      'config',
      'emits',
      'flags',
      'id',
      'instruction',
      'label',
      'masks',
      'options',
      'question_type',
      'randomize_columns',
      'randomize_options',
      'randomize_rows',
      'ref',
      'required',
      'rows',
      'scripts',
      'type',
      'validation',
    ]);
  });

  it('knows exactly the fields of an option', () => {
    expect(fieldNamesOf('QuestionItem')).toEqual([
      'anchor',
      'behaviour',
      'code',
      'custom_class',
      'exclusive',
      'id',
      'label',
      'media',
      'meta',
      'other_specify',
      'position',
      'ref',
      'value_override',
    ]);
  });

  it('closes every object it describes, so unknown fields cannot slip through', () => {
    const open: string[] = [];
    for (const [name, desc] of Object.entries(SCHEMA_DEFS)) {
      walk(desc, (d) => {
        if (d.kind === 'object' && d.additional === true) open.push(name);
      });
    }
    expect(open).toEqual([]);
  });
});

describe('the emitted JSON Schema', () => {
  const schema = toJsonSchema();

  it('is draft 2020-12 and rooted at Survey', () => {
    expect(schema['$schema']).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(schema['$ref']).toBe('#/$defs/Survey');
  });

  it('emits a definition for every descriptor def', () => {
    const defs = schema['$defs'] as Record<string, unknown>;
    expect(Object.keys(defs).sort()).toEqual(Object.keys(SCHEMA_DEFS).sort());
  });

  it('is JSON-serializable and stable across calls', () => {
    expect(JSON.stringify(toJsonSchema())).toBe(JSON.stringify(schema));
  });

  it('marks required fields and forbids extra ones on a question', () => {
    const defs = schema['$defs'] as Record<string, Record<string, unknown>>;
    const question = defs['QuestionNode'];
    expect(question?.['additionalProperties']).toBe(false);
    expect(question?.['required']).toEqual(['id', 'type', 'ref', 'question_type', 'required']);
  });

  it('encodes the id pattern from Deliverable B rather than a loose string', () => {
    const defs = schema['$defs'] as Record<string, Record<string, unknown>>;
    const properties = defs['SurveyMeta']?.['properties'] as Record<string, Record<string, unknown>>;
    expect(properties['id']?.['pattern']).toBe('^svy_[0-7][0-9A-HJKMNP-TV-Z]{25}$');
  });
});

describe('the runtime validator', () => {
  it('reports a precise pointer for a nested failure', () => {
    const document = JSON.parse(JSON.stringify(makeMiniSurvey())) as Record<string, unknown>;
    const blocks = document['content'] as Record<string, unknown>[];
    const block = blocks[0] as Record<string, unknown>;
    const pages = block['children'] as Record<string, unknown>[];
    const page = pages[0] as Record<string, unknown>;
    const questions = page['children'] as Record<string, unknown>[];
    (questions[0] as Record<string, unknown>)['required'] = 'yes';
    const diagnostics = validateShape(document);
    expect(diagnostics.map((d) => d.path)).toEqual(['/content/0/children/0/children/0/required']);
  });

  it('selects a union variant by its discriminator', () => {
    const document = JSON.parse(JSON.stringify(makeMiniSurvey())) as Record<string, unknown>;
    const flow = document['flow'] as Record<string, unknown>;
    const nodes = flow['nodes'] as Record<string, unknown>[];
    (nodes[0] as Record<string, unknown>)['type'] = 'nonsense';
    const diagnostics = validateShape(document);
    expect(diagnostics[0]?.code).toBe('SCH-0103');
    expect(diagnostics[0]?.path).toBe('/flow/nodes/0/type');
  });

  it('rejects a logic expression with no op', () => {
    const document = JSON.parse(JSON.stringify(makeMiniSurvey())) as Record<string, unknown>;
    document['logic_rules'] = [
      {
        id: 'rul_0000000000000000000000000',
        kind: 'display',
        target: { type: 'survey' },
        condition: { nope: true },
        effect: { action: 'show' },
      },
    ];
    const diagnostics = validateShape(document);
    expect(diagnostics.map((d) => d.path)).toContain('/logic_rules/0/condition/op');
  });
});
