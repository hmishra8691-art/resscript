/**
 * The editor's write path: one optimistic lock, one conflict story.
 *
 * Every content mutation in a version — nodes, items, everything §2.5 lists — shares ONE lock:
 * `app.survey_versions.revision`, carried as the ETag `W/"<revision>.<ms>"` (API §1.7). So the
 * ETag is held here, once per version, rather than per component: three components holding three
 * copies of the same ETag is three chances to send a stale one.
 *
 * ═══ THE TWO REFUSALS, AND WHY NEITHER IS RETRIED ═══
 *
 * `409 frozen_version` — the version is published. The editor goes READ-ONLY and says "clone a
 * new draft to edit", which is the roadmap's own wording and `packages/observability`'s message
 * for the code. Nothing is retried and nothing is queued: a frozen version does not become
 * writable by waiting.
 *
 * `412 revision_conflict` — someone else wrote to this version since our ETag was issued. This
 * opens the conflict dialog, and it does **not** auto-retry. UI §5.3 describes an auto-retry for
 * the case where `changed_since` is disjoint from our touched-node set, and that optimization is
 * deliberately NOT built here, for two reasons worth stating:
 *
 *  - `errors.ts` already records the house position for this code — "retryable by a HUMAN after a
 *    merge, not by a machine — auto-retrying an optimistic-lock failure is how you get a silent
 *    overwrite, the exact failure P1-03's conflict dialog exists to prevent" — and P1-03's
 *    acceptance line is a conflict dialog, not a silent recovery;
 *  - the disjointness test needs `changed_since` and a per-entity touched-node set. `ApiError`
 *    flattens the error envelope to `{code, message, details}`, so `changed_since` does not reach
 *    a caller today, and a "disjoint" decision made without it would be a guess. Widening the
 *    shared error class and adding the mutation queue is UI §5.2/§5.3 work; until then the honest
 *    behaviour is to ask the human.
 *
 * The dialog therefore offers Reload (take theirs) and Discard-mine (dismiss, keep editing) and
 * no "keep mine" — re-issuing the same write against their revision is precisely the overwrite
 * this machinery exists to prevent, and a field-by-field merge needs the payload above.
 */

'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, apiFetch } from '@/lib/api-client';

/** The message the acceptance criterion quotes. One string, used by every read-only surface. */
export const FROZEN_MESSAGE = 'This version is frozen — clone a new draft to edit.';

export interface ConflictInfo {
  /** What I was doing, in the words the tree announced it with. */
  readonly mine: string;
  /** The revision my ETag claimed. */
  readonly myRevision: number | null;
  /** The revision the server is at now. */
  readonly currentRevision: number | null;
}

export interface WriteOptions {
  readonly method: 'POST' | 'PATCH' | 'DELETE';
  readonly body?: unknown;
  /** Human-readable, for the announcement and for the conflict dialog's "mine" side. */
  readonly description: string;
}

export interface VersionWriter {
  readonly readOnly: boolean;
  readonly conflict: ConflictInfo | null;
  readonly error: string | null;
  readonly busy: boolean;
  /**
   * Run one mutation. Resolves with the response body, or `null` when the write was refused —
   * the caller rolls its optimistic update back on `null` and does not need to know which
   * refusal it was.
   */
  write<T>(path: string, options: WriteOptions): Promise<T | null>;
  dismissConflict(): void;
  clearError(): void;
}

interface VersionShape {
  readonly status?: string;
  readonly revision?: number;
}

function revisionFromDetails(error: ApiError, code: string): number | null {
  const detail = error.details.find((entry) => entry.code === code);
  if (detail === undefined) return null;
  const value = Number(detail.message);
  return Number.isInteger(value) ? value : null;
}

export function useVersionWriter(
  versionId: string,
  options: { readonly frozen: boolean },
): VersionWriter {
  const [readOnly, setReadOnly] = useState(options.frozen);
  const [conflict, setConflict] = useState<ConflictInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(0);
  // Refs, not state: `write` must read the CURRENT ETag, and a state read closed over by an
  // in-flight callback is one drag behind — which is a self-inflicted revision conflict.
  const etag = useRef<string | null>(null);
  const stale = useRef(true);

  useEffect(() => {
    etag.current = null;
    stale.current = true;
    setConflict(null);
    setError(null);
    setReadOnly(options.frozen);
  }, [versionId, options.frozen]);

  const ensureEtag = useCallback(async (): Promise<string | null> => {
    if (etag.current !== null && !stale.current) return etag.current;
    // `GET /versions/{id}` is the ETag's issuer (API §1.7). In practice this runs once per
    // editing session: every write response carries the next ETag, so the refresh below is the
    // cold-start path and the fallback for a route that answers without the header.
    const response = await apiFetch<VersionShape>('/versions/' + versionId);
    if (response.etag !== null) {
      etag.current = response.etag;
      stale.current = false;
    }
    if (response.data.status !== undefined && response.data.status !== 'draft') setReadOnly(true);
    return etag.current;
  }, [versionId]);

  const write = useCallback(
    async <T,>(path: string, writeOptions: WriteOptions): Promise<T | null> => {
      if (readOnly) {
        setError(FROZEN_MESSAGE);
        return null;
      }
      setBusy((count) => count + 1);
      try {
        const ifMatch = await ensureEtag();
        if (ifMatch === null) {
          // Sending no `If-Match` is `428 precondition_required` by design; saying so here is
          // more useful than provoking it.
          setError('the editor could not read this version’s revision — reload and try again');
          return null;
        }
        const response = await apiFetch<T>(path, {
          method: writeOptions.method,
          ifMatch,
          ...(writeOptions.body === undefined ? {} : { body: writeOptions.body }),
        });
        if (response.etag === null) stale.current = true;
        else {
          etag.current = response.etag;
          stale.current = false;
        }
        return response.data;
      } catch (err: unknown) {
        stale.current = true;
        if (err instanceof ApiError && err.code === 'frozen_version') {
          setReadOnly(true);
          setError(FROZEN_MESSAGE);
          return null;
        }
        if (err instanceof ApiError && err.code === 'revision_conflict') {
          setConflict({
            mine: writeOptions.description,
            myRevision: revisionFromDetails(err, 'expected_revision'),
            currentRevision: revisionFromDetails(err, 'current_revision'),
          });
          return null;
        }
        setError(err instanceof ApiError ? `${err.code}: ${err.message}` : String(err));
        return null;
      } finally {
        setBusy((count) => count - 1);
      }
    },
    [ensureEtag, readOnly],
  );

  const dismissConflict = useCallback((): void => {
    setConflict(null);
  }, []);

  const clearError = useCallback((): void => {
    setError(null);
  }, []);

  return { readOnly, conflict, error, busy: busy > 0, write, dismissConflict, clearError };
}
