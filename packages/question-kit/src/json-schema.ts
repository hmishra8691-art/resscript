/**
 * A dependency-free JSON Schema (draft 2020-12) subset validator for plugin config.
 *
 * ## Why not Ajv
 *
 * The roadmap's P1-04 row says "validated against `configSchema` (Ajv)". Ajv is a fine library
 * and this is a deliberate departure, for three reasons that all point the same way:
 *
 *  1. `packages/schema` hand-wrote its validator specifically to stay dependency-free, and the
 *     two validators sit either side of the same API boundary. One of them pulling a 120 KB
 *     dependency (plus a code generator that `eval`s at runtime) undoes that choice by
 *     proximity.
 *  2. `Function`-constructing validators are exactly what F §6 forbids inside the QuickJS
 *     budget third-party plugin functions run under (`hostApi: ['console.warn']`, no dynamic
 *     code construction). Validating a third-party plugin's config with a tool that compiles
 *     JavaScript at runtime is an awkward place to be.
 *  3. The keyword surface a config schema actually needs is small and closed — see
 *     `SUPPORTED_KEYWORDS`. Anything outside it is *rejected at compile time* rather than
 *     silently ignored, which is strictly safer than Ajv's default of ignoring unknown
 *     keywords: a plugin author who writes `format: 'email'` learns that it does nothing here,
 *     instead of believing they validated something.
 *
 * The interface deliberately mirrors Ajv's shape (compile once, cache per plugin version,
 * validate many) so swapping it in later — if a plugin genuinely needs `$dynamicRef` — is a
 * one-file change at the boundary rather than a rewrite of every call site.
 */

import { stableStringify, type JsonValue } from '@resscript/schema';

export type JsonSchemaType = 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null';

export interface JsonSchemaObject {
  readonly $schema?: string;
  readonly $ref?: string;
  readonly $defs?: Readonly<Record<string, JsonSchema>>;
  readonly title?: string;
  readonly description?: string;
  readonly type?: JsonSchemaType | readonly JsonSchemaType[];
  readonly enum?: readonly JsonValue[];
  readonly const?: JsonValue;
  readonly default?: JsonValue;
  readonly properties?: Readonly<Record<string, JsonSchema>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: JsonSchema;
  readonly items?: JsonSchema;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly uniqueItems?: boolean;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly exclusiveMinimum?: number;
  readonly exclusiveMaximum?: number;
  readonly multipleOf?: number;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly pattern?: string;
  readonly anyOf?: readonly JsonSchema[];
  readonly oneOf?: readonly JsonSchema[];
  readonly allOf?: readonly JsonSchema[];
  readonly not?: JsonSchema;
}

/** `true` accepts anything, `false` rejects everything — draft 2020-12's boolean schemas. */
export type JsonSchema = boolean | JsonSchemaObject;

const SUPPORTED_KEYWORDS: readonly string[] = [
  '$schema',
  '$ref',
  '$defs',
  'title',
  'description',
  'type',
  'enum',
  'const',
  'default',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'minItems',
  'maxItems',
  'uniqueItems',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'pattern',
  'anyOf',
  'oneOf',
  'allOf',
  'not',
];

export interface ConfigIssue {
  /** RFC 6901 pointer into the *config value*, so the editor can focus the field. */
  readonly path: string;
  /** The keyword that rejected it. A metric label and a UI copy key, so it is closed-ish. */
  readonly keyword: string;
  readonly message: string;
}

export interface ConfigValidationResult {
  readonly valid: boolean;
  readonly issues: readonly ConfigIssue[];
}

/**
 * Externally referenced schemas.
 *
 * F §2's `single_select` config schema references `resscript://schema/randomization-spec`, so
 * the kit has to be able to resolve it. The definition mirrors `@resscript/schema`'s
 * `RandomizationSpec`, and it imports `RANDOMIZATION_MODES` from there rather than restating
 * the list, so the one part most likely to drift cannot.
 */
export const SCHEMA_REF_PREFIX = 'resscript://schema/';

export interface CompileOptions {
  /** Extra `$ref` targets, keyed by URI. Merged over the built-in registry. */
  readonly refs?: Readonly<Record<string, JsonSchema>>;
}

export interface CompiledSchema {
  /** Keywords present in the schema that this validator does not implement. Non-empty = bug. */
  readonly unsupported: readonly string[];
  validate(value: unknown): ConfigValidationResult;
}

function isSchemaObject(schema: JsonSchema): schema is JsonSchemaObject {
  return typeof schema === 'object';
}

function typeOf(value: unknown): JsonSchemaType | 'undefined' {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  switch (typeof value) {
    case 'string':
      return 'string';
    case 'number':
      return Number.isInteger(value) ? 'integer' : 'number';
    case 'boolean':
      return 'boolean';
    case 'object':
      return 'object';
    default:
      return 'undefined';
  }
}

function jsonEqual(a: unknown, b: unknown): boolean {
  try {
    return stableStringify(a) === stableStringify(b);
  } catch {
    // stableStringify throws on non-finite numbers and functions. Neither is JSON, so
    // "not equal to any JSON value" is the right answer rather than an exception escaping
    // a validator that must be total.
    return false;
  }
}

function pointerAppend(path: string, segment: string | number): string {
  return `${path}/${String(segment).replaceAll('~', '~0').replaceAll('/', '~1')}`;
}

/**
 * Compile a schema.
 *
 * "Compile" here means: walk it once, collect unsupported keywords and resolve `$ref`s, and
 * return a closure. There is no code generation, so the cost is a tree walk and the win is
 * that the unsupported-keyword scan happens once per plugin version rather than once per
 * request.
 */
export function compileSchema(root: JsonSchema, options: CompileOptions = {}): CompiledSchema {
  const refs: Record<string, JsonSchema> = { ...BUILTIN_REFS, ...(options.refs ?? {}) };
  const unsupported = new Set<string>();

  /**
   * Resolve a `$ref`, recording it as unsupported when it cannot be resolved.
   *
   * An unresolvable `$ref` is recorded, not thrown: a request in production degrades to "this
   * subtree is unconstrained" rather than a 500, and registration refuses the plugin outright.
   */
  const resolve = (schema: JsonSchema): JsonSchema => {
    if (!isSchemaObject(schema)) return schema;
    const ref = schema.$ref;
    if (ref === undefined) return schema;
    if (ref.startsWith('#/$defs/')) {
      const name = ref.slice('#/$defs/'.length);
      const defs = isSchemaObject(root) ? root.$defs : undefined;
      const target = defs?.[name];
      if (target === undefined) {
        unsupported.add(`$ref:${ref}`);
        return true;
      }
      return target;
    }
    const external = refs[ref];
    if (external === undefined) {
      unsupported.add(`$ref:${ref}`);
      return true;
    }
    return external;
  };

  /**
   * Walk the schema once, collecting unsupported keywords **and unresolvable refs**.
   *
   * The refs are resolved here rather than only on the validation path, and that is a fix rather
   * than an optimisation: `unsupported` is read at *registration* (`registry.register` refuses a
   * plugin whose schema reaches beyond this validator), so a broken `$ref` that was only noticed
   * during a later `validate()` call would sail through the gate that exists to catch it. The
   * `seen` set is what keeps a self-referential `$defs` from recursing forever.
   */
  const seen = new Set<JsonSchema>();
  const scan = (schema: JsonSchema): void => {
    if (!isSchemaObject(schema) || seen.has(schema)) return;
    seen.add(schema);
    for (const key of Object.keys(schema)) {
      if (!SUPPORTED_KEYWORDS.includes(key)) unsupported.add(key);
    }
    if (schema.$ref !== undefined) scan(resolve(schema));
    for (const child of Object.values(schema.properties ?? {})) scan(child);
    for (const child of Object.values(schema.$defs ?? {})) scan(child);
    if (schema.items !== undefined) scan(schema.items);
    if (schema.additionalProperties !== undefined) scan(schema.additionalProperties);
    if (schema.not !== undefined) scan(schema.not);
    for (const child of schema.anyOf ?? []) scan(child);
    for (const child of schema.oneOf ?? []) scan(child);
    for (const child of schema.allOf ?? []) scan(child);
  };
  scan(root);

  const check = (schema: JsonSchema, value: unknown, path: string, issues: ConfigIssue[]): void => {
    const resolved = resolve(schema);
    if (resolved === true) return;
    if (resolved === false) {
      issues.push({ path, keyword: 'false', message: 'no value is allowed here' });
      return;
    }
    if (!isSchemaObject(resolved)) return;
    const s = resolved;
    const actual = typeOf(value);

    if (s.type !== undefined) {
      const allowed = Array.isArray(s.type) ? s.type : [s.type];
      // `integer` satisfies `number`; the reverse does not. Draft 2020-12's rule, and the one
      // most often got wrong by hand-rolled validators.
      const typeOk = allowed.some(
        (t) => t === actual || (t === 'number' && actual === 'integer'),
      );
      if (!typeOk) {
        issues.push({
          path,
          keyword: 'type',
          message: `expected ${allowed.join(' | ')}, got ${actual}`,
        });
        return; // Every keyword below assumes the type; piling on is noise for the editor.
      }
    }

    if (s.enum !== undefined && !s.enum.some((candidate) => jsonEqual(candidate, value))) {
      issues.push({
        path,
        keyword: 'enum',
        message: `expected one of ${s.enum.map((v) => JSON.stringify(v)).join(', ')}`,
      });
    }
    if (s.const !== undefined && !jsonEqual(s.const, value)) {
      issues.push({ path, keyword: 'const', message: `expected ${JSON.stringify(s.const)}` });
    }

    if (typeof value === 'number') {
      if (s.minimum !== undefined && value < s.minimum) {
        issues.push({ path, keyword: 'minimum', message: `must be >= ${s.minimum}` });
      }
      if (s.maximum !== undefined && value > s.maximum) {
        issues.push({ path, keyword: 'maximum', message: `must be <= ${s.maximum}` });
      }
      if (s.exclusiveMinimum !== undefined && value <= s.exclusiveMinimum) {
        issues.push({ path, keyword: 'exclusiveMinimum', message: `must be > ${s.exclusiveMinimum}` });
      }
      if (s.exclusiveMaximum !== undefined && value >= s.exclusiveMaximum) {
        issues.push({ path, keyword: 'exclusiveMaximum', message: `must be < ${s.exclusiveMaximum}` });
      }
      if (s.multipleOf !== undefined && s.multipleOf > 0) {
        const quotient = value / s.multipleOf;
        if (!Number.isInteger(quotient)) {
          issues.push({ path, keyword: 'multipleOf', message: `must be a multiple of ${s.multipleOf}` });
        }
      }
    }

    if (typeof value === 'string') {
      // Code points, not UTF-16 units: a `maxLength` that counts surrogate halves rejects a
      // perfectly good emoji at 199 characters and is the kind of bug nobody finds until a
      // respondent in field hits it.
      const length = [...value].length;
      if (s.minLength !== undefined && length < s.minLength) {
        issues.push({ path, keyword: 'minLength', message: `must be at least ${s.minLength} characters` });
      }
      if (s.maxLength !== undefined && length > s.maxLength) {
        issues.push({ path, keyword: 'maxLength', message: `must be at most ${s.maxLength} characters` });
      }
      if (s.pattern !== undefined && !new RegExp(s.pattern, 'u').test(value)) {
        issues.push({ path, keyword: 'pattern', message: `must match ${s.pattern}` });
      }
    }

    if (Array.isArray(value)) {
      if (s.minItems !== undefined && value.length < s.minItems) {
        issues.push({ path, keyword: 'minItems', message: `must have at least ${s.minItems} items` });
      }
      if (s.maxItems !== undefined && value.length > s.maxItems) {
        issues.push({ path, keyword: 'maxItems', message: `must have at most ${s.maxItems} items` });
      }
      if (s.uniqueItems === true) {
        const seen = new Set<string>();
        for (const entry of value) {
          const key = stableStringify(entry);
          if (seen.has(key)) {
            issues.push({ path, keyword: 'uniqueItems', message: 'items must be unique' });
            break;
          }
          seen.add(key);
        }
      }
      if (s.items !== undefined) {
        value.forEach((entry, index) => {
          check(s.items as JsonSchema, entry, pointerAppend(path, index), issues);
        });
      }
    }

    if (actual === 'object') {
      const record = value as Record<string, unknown>;
      for (const key of s.required ?? []) {
        if (!Object.prototype.hasOwnProperty.call(record, key)) {
          issues.push({ path: pointerAppend(path, key), keyword: 'required', message: 'is required' });
        }
      }
      const properties = s.properties ?? {};
      for (const [key, child] of Object.entries(properties)) {
        if (Object.prototype.hasOwnProperty.call(record, key)) {
          check(child, record[key], pointerAppend(path, key), issues);
        }
      }
      const extra = s.additionalProperties;
      if (extra !== undefined) {
        for (const key of Object.keys(record)) {
          if (Object.prototype.hasOwnProperty.call(properties, key)) continue;
          if (extra === false) {
            issues.push({
              path: pointerAppend(path, key),
              keyword: 'additionalProperties',
              message: 'is not a known property',
            });
          } else {
            check(extra, record[key], pointerAppend(path, key), issues);
          }
        }
      }
    }

    for (const child of s.allOf ?? []) check(child, value, path, issues);
    if (s.anyOf !== undefined) {
      const matched = s.anyOf.some((child) => {
        const local: ConfigIssue[] = [];
        check(child, value, path, local);
        return local.length === 0;
      });
      if (!matched) issues.push({ path, keyword: 'anyOf', message: 'matches no allowed variant' });
    }
    if (s.oneOf !== undefined) {
      const matches = s.oneOf.filter((child) => {
        const local: ConfigIssue[] = [];
        check(child, value, path, local);
        return local.length === 0;
      }).length;
      if (matches !== 1) {
        issues.push({ path, keyword: 'oneOf', message: `must match exactly one variant, matched ${matches}` });
      }
    }
    if (s.not !== undefined) {
      const local: ConfigIssue[] = [];
      check(s.not, value, path, local);
      if (local.length === 0) issues.push({ path, keyword: 'not', message: 'is explicitly disallowed' });
    }
  };

  return {
    unsupported: [...unsupported].sort(),
    validate(value: unknown): ConfigValidationResult {
      const issues: ConfigIssue[] = [];
      check(root, value, '', issues);
      return { valid: issues.length === 0, issues };
    },
  };
}

/**
 * Fill in `default`s for absent object properties, one level per nesting level.
 *
 * F §5's compatibility table allows "new optional config field with a default" inside a major,
 * and that promise is only real if old configs are topped up on load. Applied to the authoring
 * model, never to a published artifact.
 */
export function applySchemaDefaults(schema: JsonSchema, value: JsonValue): JsonValue {
  if (!isSchemaObject(schema)) return value;
  const properties = schema.properties;
  if (properties === undefined) return value;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
  // `Array.isArray` does not narrow `readonly JsonValue[]` out of the union, so the object case
  // has to be re-stated. Asserting it here rather than at every read keeps the cast to one line
  // in the one function that needs it.
  const out: Record<string, JsonValue> = { ...(value as { readonly [key: string]: JsonValue }) };
  for (const [key, child] of Object.entries(properties)) {
    if (!isSchemaObject(child)) continue;
    if (Object.prototype.hasOwnProperty.call(out, key)) {
      const current = out[key];
      if (current !== undefined) out[key] = applySchemaDefaults(child, current);
      continue;
    }
    if (child.default !== undefined) out[key] = applySchemaDefaults(child, child.default);
  }
  return out;
}

/**
 * Compiled-schema cache, keyed by `${id}@${version}` — the *exact* version, not the major.
 *
 * Two plugins in the same major legitimately differ in their config schema (a new optional
 * field with a default is allowed within a major, F §5), so caching on the major would serve a
 * 1.4.0 config against a 1.5.0 schema and either reject a valid field or accept an unknown one.
 */
export interface SchemaCache {
  get(key: string, schema: JsonSchema, options?: CompileOptions): CompiledSchema;
  readonly size: number;
}

export function createSchemaCache(): SchemaCache {
  const cache = new Map<string, CompiledSchema>();
  return {
    get(key, schema, options) {
      const hit = cache.get(key);
      if (hit !== undefined) return hit;
      const compiled = compileSchema(schema, options ?? {});
      cache.set(key, compiled);
      return compiled;
    },
    get size() {
      return cache.size;
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Built-in `$ref` targets                                                    */
/* -------------------------------------------------------------------------- */

import { RANDOMIZATION_MODES } from '@resscript/schema';

/**
 * `resscript://schema/randomization-spec` — schema §12's `RandomizationSpec`.
 *
 * Hand-written here (rather than derived from schema's descriptor) because schema's
 * `toJsonSchema()` emits the whole survey document, and a plugin config schema needs one
 * definition, not a 200 KB envelope. The modes come from schema's own constant, so the field
 * most likely to drift cannot: adding a mode there without updating this is impossible.
 */
const RANDOMIZATION_SPEC_SCHEMA: JsonSchemaObject = {
  type: ['object', 'null'],
  required: ['mode'],
  properties: {
    mode: { enum: [...RANDOMIZATION_MODES] },
    n: { type: ['integer', 'null'], minimum: 1 },
    group_ref: { type: ['string', 'null'] },
    respect_anchors: { type: 'boolean' },
    seed_salt: { type: ['string', 'null'] },
    even_distribution: { type: 'boolean' },
    sub_blocks: {
      type: 'array',
      items: {
        type: 'object',
        required: ['refs'],
        properties: { refs: { type: 'array', items: { type: 'string' } } },
        additionalProperties: false,
      },
    },
    fixed_orders: { type: 'array', items: { type: 'array', items: { type: 'string' } } },
  },
  additionalProperties: false,
};

const BUILTIN_REFS: Readonly<Record<string, JsonSchema>> = {
  [`${SCHEMA_REF_PREFIX}randomization-spec`]: RANDOMIZATION_SPEC_SCHEMA,
};

export { RANDOMIZATION_SPEC_SCHEMA };
