/**
 * `Idempotency-Key` handling (API §1.4).
 *
 * Scope is `(org, endpoint)` and keys expire after 24 h. A replay with the SAME body returns
 * the first response; a replay with a DIFFERENT body is `422 idempotency_key_reuse`, because
 * silently returning the first response would be worse than failing — the client asked for
 * something else and would believe it happened.
 *
 * The hash is over the canonicalized body so that key ordering in JSON does not make an
 * identical request look different. Canonicalization is `@resscript/schema`'s
 * `stableStringify`, the same function the compiler uses for content addressing, rather than a
 * local sort — there is no reason for this codebase to have two definitions of "the same JSON".
 */

import { createHash } from 'node:crypto';
import { AppError, idempotencyKeyReuse } from '@resscript/observability';
import { stableStringify } from '@resscript/schema';
import type { JsonValue } from '@resscript/schema';
import type { IdempotencyStore, ResponseBody } from '../repo/types.js';
import { json } from './respond.js';

export const IDEMPOTENCY_HEADER = 'Idempotency-Key';

/** Result of running an idempotent handler: what to store and what to send. */
export interface IdempotentResult {
  readonly status: number;
  readonly body: ResponseBody;
  readonly headers?: Readonly<Record<string, string>>;
}

export function hashRequestBody(body: JsonValue): string {
  return createHash('sha256').update(stableStringify(body)).digest('hex');
}

export interface IdempotencyOptions {
  readonly store: IdempotencyStore;
  readonly orgId: string;
  readonly endpoint: string;
  readonly key: string | null;
  readonly body: JsonValue;
  readonly requestId: string;
  readonly now: () => Date;
}

/**
 * Run `handler` at most once per key.
 *
 * WHY a wrapper rather than a middleware: the stored value is the RESPONSE, and only the
 * handler knows it. A middleware that intercepted the request could deduplicate but could not
 * replay, and a replay that re-runs the work is not idempotency, it is a race with a smaller
 * window.
 */
export async function withIdempotency(
  options: IdempotencyOptions,
  handler: () => Promise<IdempotentResult>,
): Promise<Response> {
  const { key, store, orgId, endpoint, requestId } = options;
  if (key === null) {
    const result = await handler();
    return json(result.body, {
      status: result.status,
      requestId,
      ...(result.headers === undefined ? {} : { headers: result.headers }),
    });
  }
  if (key.length > 255) {
    throw new AppError('malformed_request', 'Idempotency-Key is too long', {
      details: [{ path: null, code: 'header_too_long', message: IDEMPOTENCY_HEADER }],
    });
  }
  const requestHash = hashRequestBody(options.body);
  const existing = await store.get(orgId, endpoint, key);
  if (existing !== null) {
    if (existing.request_hash !== requestHash) throw idempotencyKeyReuse(key);
    // Same key, same body: the first response, verbatim. `Idempotent-Replay` is informational
    // so a client (and a test) can tell a replay from the original without diffing bodies.
    return json(existing.body, {
      status: existing.status,
      requestId,
      headers: { 'Idempotent-Replay': 'true' },
    });
  }
  const result = await handler();
  await store.put({
    key,
    endpoint,
    org_id: orgId,
    request_hash: requestHash,
    status: result.status,
    body: result.body,
    created_at: options.now().toISOString(),
  });
  return json(result.body, {
    status: result.status,
    requestId,
    ...(result.headers === undefined ? {} : { headers: result.headers }),
  });
}

export function idempotencyKeyOf(req: Request): string | null {
  const value = req.headers.get(IDEMPOTENCY_HEADER);
  return value === null || value.trim() === '' ? null : value.trim();
}
