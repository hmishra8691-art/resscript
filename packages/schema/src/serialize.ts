/**
 * Canonical JSON serialization and parsing.
 *
 * ## Why canonical
 *
 * A survey is stored, exported, imported, diffed in code review, and hashed on the way to a
 * content-addressed artifact (ADR-002). All four of those want the same property: **the same
 * survey must produce the same bytes.** If key order depended on insertion order, two
 * semantically identical surveys would hash differently, `git diff` would show noise on every
 * save, and the round-trip property test could only ever assert "deep equal", never
 * "byte identical".
 *
 * The rule: object keys are emitted with a small set of identifying keys first (`id`, `ref`,
 * `type`, `kind`, `name`, `question_type`), then everything else in code-point order. The
 * identity prefix is not cosmetic — a diff hunk that starts with `"id": "qst_…"` tells a
 * reviewer *which* question changed without scrolling, which is the difference between a
 * readable version diff and an unreadable one.
 *
 * Arrays are never reordered: array order is semantic everywhere in this model (option
 * positions, flow branch precedence, export column order).
 */

import type { Diagnostic } from './diagnostics.js';
import { hasErrors, sortDiagnostics } from './diagnostics.js';
import { validateShape } from './json-schema.js';
import type { Survey } from './types/survey.js';
import { validateStructural } from './validate.js';

/**
 * Keys hoisted to the front of every object, in this order. Chosen because they answer "what
 * is this node?" — a reviewer reading a diff needs that before anything else.
 */
const KEY_PRIORITY: readonly string[] = ['id', 'ref', 'type', 'kind', 'name', 'question_type'];

function compareKeys(a: string, b: string): number {
  const ai = KEY_PRIORITY.indexOf(a);
  const bi = KEY_PRIORITY.indexOf(b);
  if (ai !== -1 || bi !== -1) {
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    if (ai !== bi) return ai - bi;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Deterministic pretty-printed JSON. Two-space indent and a trailing newline: the file is
 * meant to be reviewed by a human in a pull request, and a minified 400 KB line is not.
 */
export function stableStringify(value: unknown): string {
  return `${write(value, 0)}\n`;
}

function write(value: unknown, depth: number): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number': {
      if (!Number.isFinite(value)) {
        // NaN and Infinity have no JSON representation. Emitting `null` silently would turn a
        // broken number into a missing answer, so it fails loudly instead.
        throw new Error(`Cannot serialize non-finite number: ${String(value)}`);
      }
      // `JSON.stringify` already produces the shortest round-tripping form (ECMA-262
      // Number::toString), so -0 becomes 0 and 1e21 stays exponential. Both are stable.
      return JSON.stringify(value);
    }
    case 'object':
      break;
    default:
      throw new Error(`Cannot serialize a ${typeof value}.`);
  }

  const indent = '  '.repeat(depth + 1);
  const closeIndent = '  '.repeat(depth);

  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    const items = value.map((entry) => `${indent}${write(entry, depth + 1)}`);
    return `[\n${items.join(',\n')}\n${closeIndent}]`;
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort(compareKeys);
  if (keys.length === 0) return '{}';
  const entries = keys.map((key) => `${indent}${JSON.stringify(key)}: ${write(record[key], depth + 1)}`);
  return `{\n${entries.join(',\n')}\n${closeIndent}}`;
}

/** Serialize a survey to canonical JSON. */
export function serialize(survey: Survey): string {
  return stableStringify(survey);
}

export type ParseResult =
  | { readonly ok: true; readonly survey: Survey; readonly diagnostics: readonly Diagnostic[] }
  | { readonly ok: false; readonly survey?: undefined; readonly diagnostics: readonly Diagnostic[] };

export interface ParseOptions {
  /**
   * Run `validateStructural` as well as the shape check. On by default: an importer wants
   * everything wrong with the file at once. Turn it off when parsing a survey that is
   * deliberately mid-edit (the editor's autosave path).
   */
  readonly structural?: boolean;
}

/** Parse a JSON string. Never throws: malformed input is a diagnostic, not an exception. */
export function parse(text: string, options: ParseOptions = {}): ParseResult {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      diagnostics: [
        { code: 'SCH-0001', severity: 'error', message: `Document is not valid JSON: ${message}`, path: '' },
      ],
    };
  }
  return parseValue(value, options);
}

/** Parse an already-decoded value (an HTTP body, a database row, a fixture import). */
export function parseValue(value: unknown, options: ParseOptions = {}): ParseResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {
      ok: false,
      diagnostics: [
        { code: 'SCH-0002', severity: 'error', message: 'Document root must be a survey object.', path: '' },
      ],
    };
  }

  const shape = validateShape(value);
  if (hasErrors(shape)) return { ok: false, diagnostics: sortDiagnostics(shape) };

  // The boundary cast. `validateShape` has just proved every field of every node against the
  // descriptor, and the descriptor is compiler-checked against these very types, so this is
  // the one place where an assertion is the honest expression of "validated".
  const survey = value as unknown as Survey;

  const structural = options.structural === false ? [] : validateStructural(survey);
  const diagnostics = sortDiagnostics([...shape, ...structural]);
  if (hasErrors(diagnostics)) return { ok: false, diagnostics };
  return { ok: true, survey, diagnostics };
}
