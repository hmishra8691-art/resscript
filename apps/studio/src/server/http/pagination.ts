/**
 * Keyset cursor pagination (API §1.3).
 *
 * Offset is not an option here and the reason is not aesthetic: these collections are appended
 * to while being read, so with `OFFSET` a new row at the head shifts every later page and a
 * warehouse sync silently skips completes. The cursor is an opaque base64url of the sort tuple
 * `{c: created_at, i: id}` — opaque so the sort tuple can change without breaking clients, and
 * never a page number because "page 3" is not a stable concept over a growing collection.
 */

import { AppError } from '@resscript/observability';
import type { KeysetPosition, PageQuery } from '../repo/types.js';

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;

export interface PageEnvelope<T> {
  readonly data: readonly T[];
  readonly page: {
    readonly next_cursor: string | null;
    readonly has_more: boolean;
    readonly limit: number;
  };
}

function base64UrlEncode(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function base64UrlDecode(value: string): string {
  return Buffer.from(value, 'base64url').toString('utf8');
}

export function encodeCursor(position: KeysetPosition): string {
  return base64UrlEncode(JSON.stringify({ c: position.created_at, i: position.id }));
}

/** A cursor we did not mint (or one that has been edited) is `400 invalid_cursor`. */
export function decodeCursor(cursor: string): KeysetPosition {
  let parsed: unknown;
  try {
    parsed = JSON.parse(base64UrlDecode(cursor));
  } catch {
    throw new AppError('invalid_cursor', 'the cursor could not be decoded');
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new AppError('invalid_cursor', 'the cursor could not be decoded');
  }
  const record = parsed as Record<string, unknown>;
  const createdAt = record['c'];
  const id = record['i'];
  if (typeof createdAt !== 'string' || typeof id !== 'string') {
    throw new AppError('invalid_cursor', 'the cursor is missing its sort tuple');
  }
  return { created_at: createdAt, id };
}

/**
 * `limit` over the maximum is CLAMPED, not rejected, and the applied value is echoed in
 * `page.limit` (API §1.3). A non-numeric limit is a client bug worth reporting, so that one is
 * a 400.
 */
export function pageQueryFrom(url: URL): PageQuery {
  const rawLimit = url.searchParams.get('limit');
  let limit = DEFAULT_LIMIT;
  if (rawLimit !== null) {
    const parsed = Number(rawLimit);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new AppError('malformed_request', 'limit must be a positive integer', {
        details: [{ path: 'limit', code: 'invalid_value', message: rawLimit }],
      });
    }
    limit = Math.min(parsed, MAX_LIMIT);
  }
  const cursor = url.searchParams.get('cursor');
  return cursor === null ? { limit } : { limit, after: decodeCursor(cursor) };
}

/**
 * Build the response envelope. `keyOf` extracts the sort tuple from the LAST returned row,
 * which is what the next request resumes strictly after.
 */
export function pageEnvelope<T>(
  rows: readonly T[],
  hasMore: boolean,
  limit: number,
  keyOf: (row: T) => KeysetPosition,
): PageEnvelope<T> {
  const last = rows.length === 0 ? undefined : rows[rows.length - 1];
  return {
    data: rows,
    page: {
      // `null` when exhausted, so a client loop terminates on the cursor rather than on a
      // count it would have to compute.
      next_cursor: hasMore && last !== undefined ? encodeCursor(keyOf(last)) : null,
      has_more: hasMore,
      limit,
    },
  };
}

/** The sort tuple for every collection whose primary key is `id`. */
export function idPosition(row: { readonly created_at: string; readonly id: string }): KeysetPosition {
  return { created_at: row.created_at, id: row.id };
}
