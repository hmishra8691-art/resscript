/**
 * The export job's two seams: the database (as the requesting user) and the file that the CSV
 * streams into.
 *
 * ## The database half follows `publish-store.ts` exactly, and for the same reason
 *
 * Migration 0012 restates 0009's calling convention for its own objects: the worker assumes
 * the ENQUEUING USER's identity (`request.jwt.claims` + `SET LOCAL ROLE authoring`) before
 * touching `app.exports` or calling `app.export_response_page`. The RLS policies then answer
 * "may this user read these responses" with the same predicates the studio would have used,
 * the analyst floor is re-checked inside the definer function on every page, and the PII
 * strip inside it keys off the impersonated user's LIVE capability — so a grant revoked
 * between request and job run stops the data, whatever `pii_included` says. A worker that ran
 * these reads as its own role would be an authorization check deleted by omission.
 *
 * Each method is one unit of work on one connection. Unlike the publish transaction, the
 * lifecycle writes and the page reads are SEPARATE units on purpose: a 100k-row export must
 * not hold one transaction open for its whole duration (vacuum horizon, idle-in-transaction
 * timeouts), and the keyset makes that safe — `(survey_version_id, session_id)` is the
 * primary key's own total order, so pages taken in different transactions still return every
 * row exactly once. What crossing transactions costs is snapshot unity: sessions that START
 * mid-export have ULIDs above the cursor and may appear in a late page. For an export that is
 * acceptable and honest (the file says "as of its finish time"); the alternative — one
 * repeatable-read transaction per export — is the P5-02 projection's problem to solve.
 *
 * ## The file half is a seam for the same reason `ArtifactStore` is
 *
 * There is no object storage in this deployment (artifact-store.ts's header: "THIS REPOSITORY
 * HAS NO STORAGE CLIENT"), so the shipped sink is a directory (`EXPORT_DIR`) and the row
 * records a RELATIVE `storage_key` — the honest Phase-1 stand-in that P5-02's bucket + signed
 * URLs replaces without touching the row shape. `ArtifactStore` itself is the wrong interface
 * here: its `put()` takes the whole byte string, and the one property this job is named for
 * ("a STREAMING CSV export") is that the file is written a batch at a time and never
 * materialized in memory.
 */

import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';

import { AppError } from '@resscript/observability';

import type { JsonObject, JsonValue } from './json.js';
import { PUBLISH_SQL, type JobIdentity, type SessionFactory, type SqlSession } from './publish-store.js';

/* -------------------------------------------------------------------------- */
/* Rows                                                                       */
/* -------------------------------------------------------------------------- */

/** `app.exports`, the columns the job reads. Snake_case = column names, as `JobRow` argues. */
export interface ExportRow {
  readonly id: string;
  readonly org_id: string;
  readonly survey_version_id: string;
  readonly requested_by: string;
  readonly status: string;
  readonly pii_included: boolean;
  readonly include_test: boolean;
}

/** One `app.export_response_page` row. `vars` is the document's variable_id → value map. */
export interface ResponseDocumentPage {
  readonly session_id: string;
  readonly is_test: boolean;
  readonly vars: JsonObject;
}

export interface ExportStore {
  /** `null` when the export row is invisible to the enqueuing user — a 404, never an error. */
  loadExport(identity: JobIdentity, exportId: string): Promise<ExportRow | null>;
  /**
   * The version's `artifact_hash`, read through `sv_select` as the user. `null` covers both
   * "no such version for you" and "never compiled" — the job names the second, because the
   * export row's own FK already proves the version exists in the requester's org.
   */
  artifactHashFor(identity: JobIdentity, surveyVersionId: string): Promise<string | null>;
  /** `status = 'running'`, `started_at`, and a cleared `error` — the claim the studio polls. */
  markRunning(identity: JobIdentity, exportId: string): Promise<void>;
  /** One keyset page. `afterSessionId = null` is the first page; fewer than `limit` rows = done. */
  fetchPage(
    identity: JobIdentity,
    surveyVersionId: string,
    afterSessionId: string | null,
    includeTest: boolean,
    limit: number,
  ): Promise<readonly ResponseDocumentPage[]>;
  /** The terminal success write: status, row_count, storage_key, finished_at. */
  markSucceeded(
    identity: JobIdentity,
    exportId: string,
    rowCount: number,
    storageKey: string,
  ): Promise<void>;
  /**
   * The terminal failure write. Best-effort by contract: it is called from the job's own
   * failure path, where a second throw would bury the original error, so implementations
   * swallow their own failures and the caller logs instead.
   */
  markFailed(identity: JobIdentity, exportId: string, error: JsonObject): Promise<void>;
}

/* -------------------------------------------------------------------------- */
/* SQL                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The statements, in one place, diffable against 0012. `PUBLISH_SQL.claims` is imported
 * rather than restated so the impersonation SHAPE cannot drift between the two stores that
 * use it — a divergence there is a security bug, not a style issue.
 */
export const EXPORT_SQL = {
  load:
    'SELECT id, org_id, survey_version_id, requested_by::text AS requested_by, ' +
    'status::text AS status, pii_included, include_test ' +
    'FROM app.exports WHERE id = $1::app.ulid',

  artifactHash:
    'SELECT artifact_hash FROM app.survey_versions WHERE id = $1::app.ulid',

  markRunning:
    "UPDATE app.exports SET status = 'running', started_at = now(), error = NULL " +
    'WHERE id = $1::app.ulid RETURNING id',

  page:
    'SELECT session_id, is_test, vars FROM app.export_response_page(' +
    'p_survey_version_id => $1::app.ulid, p_after_session_id => $2::app.ulid, ' +
    'p_include_test => $3::boolean, p_limit => $4::int)',

  markSucceeded:
    "UPDATE app.exports SET status = 'succeeded', row_count = $2::bigint, " +
    'storage_key = $3::text, finished_at = now() WHERE id = $1::app.ulid RETURNING id',

  markFailed:
    "UPDATE app.exports SET status = 'failed', error = $2::jsonb, finished_at = now() " +
    'WHERE id = $1::app.ulid RETURNING id',
} as const;

/* -------------------------------------------------------------------------- */
/* The Postgres implementation                                                */
/* -------------------------------------------------------------------------- */

export class PgExportStore implements ExportStore {
  constructor(private readonly sessions: SessionFactory) {}

  /** `PgPublishStore.asUser`, verbatim semantics — see that file for why the RESET is unconditional. */
  private async asUser<T>(
    identity: JobIdentity,
    fn: (session: SqlSession) => Promise<T>,
  ): Promise<T> {
    return this.sessions.run(async (session) => {
      await session.query(PUBLISH_SQL.claims, [identity.userId, identity.orgId]);
      await session.query('SET LOCAL ROLE authoring');
      try {
        return await fn(session);
      } finally {
        await session.query('RESET ROLE');
      }
    });
  }

  async loadExport(identity: JobIdentity, exportId: string): Promise<ExportRow | null> {
    return this.asUser(identity, async (session) => {
      const { rows } = await session.query<Record<string, unknown>>(EXPORT_SQL.load, [exportId]);
      const row = rows[0];
      if (row === undefined) return null;
      return {
        id: String(row['id']),
        org_id: String(row['org_id']),
        survey_version_id: String(row['survey_version_id']),
        requested_by: String(row['requested_by']),
        status: String(row['status']),
        pii_included: Boolean(row['pii_included']),
        include_test: Boolean(row['include_test']),
      };
    });
  }

  async artifactHashFor(identity: JobIdentity, surveyVersionId: string): Promise<string | null> {
    return this.asUser(identity, async (session) => {
      const { rows } = await session.query<{ artifact_hash: string | null }>(
        EXPORT_SQL.artifactHash,
        [surveyVersionId],
      );
      return rows[0]?.artifact_hash ?? null;
    });
  }

  async markRunning(identity: JobIdentity, exportId: string): Promise<void> {
    await this.asUser(identity, async (session) => {
      const { rows } = await session.query<{ id: string }>(EXPORT_SQL.markRunning, [exportId]);
      if (rows.length === 0) {
        // `exports_update` declined: the requester was demoted below analyst since pressing
        // Export, or the row vanished. Non-retryable — the next attempt reads the same policies.
        throw new AppError('forbidden', 'the export row could not be claimed', {
          retryable: false,
          context: { export_id: exportId, policy: 'exports_update' },
        });
      }
    });
  }

  async fetchPage(
    identity: JobIdentity,
    surveyVersionId: string,
    afterSessionId: string | null,
    includeTest: boolean,
    limit: number,
  ): Promise<readonly ResponseDocumentPage[]> {
    return this.asUser(identity, async (session) => {
      const { rows } = await session.query<Record<string, unknown>>(EXPORT_SQL.page, [
        surveyVersionId,
        afterSessionId,
        includeTest,
        limit,
      ]);
      return rows.map((row) => ({
        session_id: String(row['session_id']),
        is_test: Boolean(row['is_test']),
        vars: (row['vars'] ?? {}) as JsonObject,
      }));
    });
  }

  async markSucceeded(
    identity: JobIdentity,
    exportId: string,
    rowCount: number,
    storageKey: string,
  ): Promise<void> {
    await this.asUser(identity, async (session) => {
      const { rows } = await session.query<{ id: string }>(EXPORT_SQL.markSucceeded, [
        exportId,
        rowCount,
        storageKey,
      ]);
      if (rows.length === 0) {
        throw new AppError('forbidden', 'the export result could not be recorded', {
          retryable: false,
          context: { export_id: exportId, policy: 'exports_update' },
        });
      }
    });
  }

  async markFailed(identity: JobIdentity, exportId: string, error: JsonObject): Promise<void> {
    try {
      await this.asUser(identity, async (session) => {
        await session.query(EXPORT_SQL.markFailed, [exportId, JSON.stringify(error)]);
      });
    } catch {
      // Best-effort by contract (see the interface): the job is already failing, its error
      // envelope is already written to ops.jobs, and a throw here would replace the real
      // failure with this bookkeeping one. The row stays 'running' and reads as stalled,
      // which is true.
    }
  }
}

/* -------------------------------------------------------------------------- */
/* The sink                                                                   */
/* -------------------------------------------------------------------------- */

/** An open file being streamed into. `close()` resolves only when the bytes are flushed. */
export interface ExportSinkWriter {
  write(chunk: string): Promise<void>;
  close(): Promise<void>;
}

export interface ExportSink {
  /** Open `key` for writing, truncating what a previous (failed, retried) run left behind. */
  open(key: string): Promise<ExportSinkWriter>;
}

/** `exports/<export id>.csv` — namespaced so EXPORT_DIR can later hold more than one format. */
export function exportStorageKey(exportId: string): string {
  return `exports/${exportId}.csv`;
}

/**
 * The shipped sink: a directory tree, same posture as `FsArtifactStore` and the same honesty
 * about being wrong for a fleet. Keys are joined onto the root and checked to still be under
 * it, for the day the first caller passes a key that came from a request.
 */
export class FsExportSink implements ExportSink {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  async open(key: string): Promise<ExportSinkWriter> {
    const file = resolve(join(this.root, key));
    if (file !== this.root && !file.startsWith(this.root + sep)) {
      throw new AppError('malformed_request', 'export key escapes the sink root', {
        context: { key },
      });
    }
    await mkdir(dirname(file), { recursive: true });
    const stream = createWriteStream(file, { encoding: 'utf8', flags: 'w' });
    return {
      write: (chunk) =>
        new Promise<void>((resolveWrite, rejectWrite) => {
          // Respect backpressure: when write() returns false, wait for 'drain' rather than
          // buffering the whole export in the stream's queue — the streaming property again.
          const ok = stream.write(chunk, (err) => {
            if (err) rejectWrite(err);
          });
          if (ok) resolveWrite();
          else stream.once('drain', () => resolveWrite());
        }),
      close: () =>
        new Promise<void>((resolveClose, rejectClose) => {
          stream.end((err?: Error | null) => {
            if (err) rejectClose(err);
            else resolveClose();
          });
        }),
    };
  }
}

/**
 * The test double, which keeps what was written AND how it was written: `chunks` is the
 * evidence for the streaming claim (a 10,000-row export arrives in many writes, not one),
 * the same way `MemoryArtifactStore.puts` is the evidence for "no new object".
 */
export class MemoryExportSink implements ExportSink {
  readonly files = new Map<string, string>();
  readonly chunks = new Map<string, number>();

  async open(key: string): Promise<ExportSinkWriter> {
    this.files.set(key, '');
    this.chunks.set(key, 0);
    return {
      write: async (chunk: string): Promise<void> => {
        this.files.set(key, (this.files.get(key) ?? '') + chunk);
        this.chunks.set(key, (this.chunks.get(key) ?? 0) + 1);
      },
      close: async (): Promise<void> => undefined,
    };
  }
}
