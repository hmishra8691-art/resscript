/**
 * The JSON value domain.
 *
 * `ops.jobs.payload`, `.progress`, `.result` and `.error` are all `jsonb` (DB §10.1), so the
 * TypeScript types that cross that boundary must be exactly what `jsonb` can hold — no `Date`,
 * no `undefined`, no `Map`. Typing them as `unknown` or `any` instead is how a `Date` ends up
 * silently stringified in one direction and read back as a string in the other.
 */

export type JsonPrimitive = string | number | boolean | null;

export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

/**
 * A runtime guard, needed because a `jsonb` column read back through `pg` is typed `any` by
 * `@types/pg`. Every value entering the worker from the database passes through here rather
 * than being asserted with a cast.
 */
export function isJsonObject(v: unknown): v is JsonObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Coerce a `jsonb` read to a JSON object, defaulting to `{}` for SQL NULL. */
export function asJsonObject(v: unknown): JsonObject {
  return isJsonObject(v) ? v : {};
}

/** Structural equality for JSON values, used by the idempotency-key body check. */
export function jsonEquals(a: JsonValue, b: JsonValue): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => jsonEquals(v, b[i] ?? null));
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a).sort();
    const kb = Object.keys(b).sort();
    if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) return false;
    return ka.every((k) => jsonEquals(a[k] ?? null, b[k] ?? null));
  }
  return false;
}
