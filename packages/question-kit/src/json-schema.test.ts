/**
 * The config-schema validator.
 *
 * It exists instead of Ajv for the reasons in `json-schema.ts`'s header, and that choice is only
 * defensible if it is *correct* on the keyword surface it claims to implement. The tests below are
 * mostly about the cases a hand-rolled validator gets wrong: `integer` versus `number`, code points
 * versus UTF-16 units, `additionalProperties: false` against a missing property, and unsupported
 * keywords being reported rather than ignored.
 */

import { describe, expect, it } from 'vitest';
import {
  applySchemaDefaults,
  compileSchema,
  createSchemaCache,
  RANDOMIZATION_SPEC_SCHEMA,
  type JsonSchema,
} from './json-schema.js';
import { SINGLE_SELECT_CONFIG_SCHEMA } from './plugins/single-select/core.js';

const valid = (schema: JsonSchema, value: unknown): boolean =>
  compileSchema(schema).validate(value).valid;

describe('types', () => {
  it('accepts an integer where a number is required, but not the reverse', () => {
    // Draft 2020-12's rule, and the one most often got wrong by hand-rolled validators.
    expect(valid({ type: 'number' }, 3)).toBe(true);
    expect(valid({ type: 'number' }, 3.5)).toBe(true);
    expect(valid({ type: 'integer' }, 3)).toBe(true);
    expect(valid({ type: 'integer' }, 3.5)).toBe(false);
  });

  it('treats null as its own type, not as absent', () => {
    expect(valid({ type: 'null' }, null)).toBe(true);
    expect(valid({ type: 'string' }, null)).toBe(false);
    expect(valid({ type: ['string', 'null'] }, null)).toBe(true);
  });

  it('does not confuse an array with an object', () => {
    expect(valid({ type: 'object' }, [])).toBe(false);
    expect(valid({ type: 'array' }, {})).toBe(false);
  });

  it('reports one issue per field rather than piling on after a type miss', () => {
    const result = compileSchema({ type: 'integer', minimum: 5 }).validate('nope');
    expect(result.issues.map((issue) => issue.keyword)).toEqual(['type']);
  });
});

describe('objects', () => {
  const schema: JsonSchema = {
    type: 'object',
    additionalProperties: false,
    required: ['a'],
    properties: { a: { type: 'string' }, b: { type: 'integer' } },
  };

  it('rejects an unknown property, so a typo is not silently ignored', () => {
    const result = compileSchema(schema).validate({ a: 'x', bb: 1 });
    expect(result.issues.map((issue) => [issue.path, issue.keyword])).toEqual([
      ['/bb', 'additionalProperties'],
    ]);
  });

  it('points a missing-required issue at the property, so the editor can focus it', () => {
    const result = compileSchema(schema).validate({ b: 1 });
    expect(result.issues[0]).toMatchObject({ path: '/a', keyword: 'required' });
  });

  it('escapes pointer segments per RFC 6901', () => {
    const result = compileSchema({
      type: 'object',
      properties: { 'a/b': { type: 'integer' } },
    }).validate({ 'a/b': 'x' });
    expect(result.issues[0]?.path).toBe('/a~1b');
  });
});

describe('strings and numbers', () => {
  it('counts string length in code points', () => {
    // A maxLength counting UTF-16 units rejects a perfectly good emoji at 199 characters, and
    // nobody finds it until a respondent in field does.
    expect(valid({ type: 'string', maxLength: 2 }, '👍👍')).toBe(true);
    expect(valid({ type: 'string', maxLength: 1 }, '👍👍')).toBe(false);
  });

  it('applies pattern with unicode semantics', () => {
    expect(valid({ type: 'string', pattern: '^[a-z]+$' }, 'abc')).toBe(true);
    expect(valid({ type: 'string', pattern: '^[a-z]+$' }, 'abc1')).toBe(false);
  });

  it('applies numeric bounds inclusively and exclusively as declared', () => {
    expect(valid({ type: 'integer', minimum: 1, maximum: 4 }, 4)).toBe(true);
    expect(valid({ type: 'integer', minimum: 1, maximum: 4 }, 5)).toBe(false);
    expect(valid({ type: 'integer', exclusiveMinimum: 1 }, 1)).toBe(false);
    expect(valid({ type: 'integer', multipleOf: 5 }, 7)).toBe(false);
  });
});

describe('combinators and refs', () => {
  it('handles anyOf / oneOf / not', () => {
    expect(valid({ anyOf: [{ type: 'string' }, { type: 'integer' }] }, 3)).toBe(true);
    expect(valid({ anyOf: [{ type: 'string' }, { type: 'integer' }] }, true)).toBe(false);
    expect(valid({ oneOf: [{ type: 'integer' }, { type: 'number' }] }, 3)).toBe(false);
    expect(valid({ not: { type: 'string' } }, 3)).toBe(true);
  });

  it('resolves the built-in randomization-spec ref', () => {
    const schema: JsonSchema = {
      type: 'object',
      properties: { randomize: { $ref: 'resscript://schema/randomization-spec' } },
    };
    const compiled = compileSchema(schema);
    expect(compiled.unsupported).toEqual([]);
    expect(compiled.validate({ randomize: { mode: 'shuffle' } }).valid).toBe(true);
    expect(compiled.validate({ randomize: { mode: 'nope' } }).valid).toBe(false);
    // The modes come from schema's own constant, so this cannot drift from `RANDOMIZATION_MODES`.
    expect(RANDOMIZATION_SPEC_SCHEMA.properties?.['mode']).toBeDefined();
  });

  it('records an unresolvable ref instead of throwing', () => {
    const compiled = compileSchema({ $ref: 'resscript://schema/nope' });
    expect(compiled.unsupported).toEqual(['$ref:resscript://schema/nope']);
    // Degrades to "this subtree is unconstrained" rather than a 500 at a request boundary.
    expect(compiled.validate({ anything: true }).valid).toBe(true);
  });

  it('reports unsupported keywords rather than ignoring them', () => {
    const compiled = compileSchema({
      type: 'string',
      format: 'email',
      contentEncoding: 'base64',
    } as JsonSchema);
    expect(compiled.unsupported).toEqual(['contentEncoding', 'format']);
  });
});

describe('applySchemaDefaults', () => {
  it('fills absent properties at every nesting level', () => {
    const filled = applySchemaDefaults(SINGLE_SELECT_CONFIG_SCHEMA, {
      display: 'vertical',
      other: {},
    });
    expect(filled).toEqual({
      display: 'vertical',
      columns: 1,
      other: { enabled: false, optionRef: null, maxLen: 200, required: true },
      allowDeselect: false,
    });
  });

  it('never overwrites a value the author set', () => {
    const filled = applySchemaDefaults(SINGLE_SELECT_CONFIG_SCHEMA, {
      display: 'dropdown',
      columns: 4,
      other: { enabled: true, maxLen: 50 },
    }) as Record<string, unknown>;
    expect(filled['columns']).toBe(4);
    expect(filled['other']).toMatchObject({ enabled: true, maxLen: 50, required: true });
  });

  it('leaves a non-object value alone', () => {
    expect(applySchemaDefaults(SINGLE_SELECT_CONFIG_SCHEMA, 'not a config')).toBe('not a config');
    expect(applySchemaDefaults(SINGLE_SELECT_CONFIG_SCHEMA, [1, 2])).toEqual([1, 2]);
  });
});

describe('the cache', () => {
  it('compiles once per key and reuses the closure', () => {
    const cache = createSchemaCache();
    const first = cache.get('single_select@1.0.0', SINGLE_SELECT_CONFIG_SCHEMA);
    const second = cache.get('single_select@1.0.0', SINGLE_SELECT_CONFIG_SCHEMA);
    expect(second).toBe(first);
    expect(cache.size).toBe(1);
  });
});

describe('the shipped plugin schemas', () => {
  it('use only supported keywords', () => {
    // A plugin whose schema reaches beyond the supported surface would be believing it validated
    // something it did not — the registry refuses to register one, and this is the same check at
    // the source.
    expect(compileSchema(SINGLE_SELECT_CONFIG_SCHEMA).unsupported).toEqual([]);
  });

  it('reject a config with an unknown display mode', () => {
    expect(
      valid(SINGLE_SELECT_CONFIG_SCHEMA, {
        display: 'carousel',
        other: { enabled: false },
      }),
    ).toBe(false);
  });
});
