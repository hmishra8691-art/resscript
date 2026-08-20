/**
 * ETag / `If-Match` over `app.survey_versions.revision` (API §1.7).
 *
 * ONE optimistic lock for every version-scoped resource, because renaming a `ref` touches
 * variables and the rules that print it, and a per-node lock would not protect that
 * cross-node invariant. `tg_version_guard()` increments `revision` on every update to the
 * version row, so the lock cannot be forgotten by a caller.
 *
 * The ETag carries a TIMESTAMP as well as the revision — `W/"41.1755680123456"` — and that is
 * load-bearing rather than decorative: on a `412`, the client needs `changed_since`, which is
 * an indexed read of `app.audit_log` by `survey_version_id AND created_at > <the ETag's
 * timestamp>`. The revision alone gives no range to query.
 *
 * Weak (`W/`) because the representation can differ byte-for-byte at the same revision — field
 * order, an added response field — while being semantically the same version. A strong ETag
 * would claim byte equality we do not provide.
 */

import { AppError, preconditionRequired } from '@resscript/observability';

export interface ParsedEtag {
  readonly revision: number;
  readonly issuedAtMs: number;
}

export function versionEtag(revision: number, issuedAt: Date): string {
  return `W/"${revision}.${issuedAt.getTime()}"`;
}

export function parseEtag(value: string): ParsedEtag | null {
  const match = /^W\/"(\d+)\.(\d+)"$/.exec(value.trim());
  if (match === null) return null;
  const revision = Number(match[1]);
  const issuedAtMs = Number(match[2]);
  if (!Number.isInteger(revision) || !Number.isInteger(issuedAtMs)) return null;
  return { revision, issuedAtMs };
}

/**
 * A mutation without `If-Match` is `428 precondition_required`, never a silent success.
 *
 * API §1.7 is explicit that this is not optional: "a client that does not participate in the
 * lock is a client that overwrites a colleague."
 */
export function requireIfMatch(req: Request): ParsedEtag {
  const header = req.headers.get('If-Match');
  if (header === null || header.trim() === '') throw preconditionRequired('If-Match');
  const parsed = parseEtag(header);
  if (parsed === null) {
    throw new AppError('malformed_request', 'If-Match must be an ETag issued by this API', {
      details: [{ path: null, code: 'invalid_etag', message: header }],
    });
  }
  return parsed;
}
