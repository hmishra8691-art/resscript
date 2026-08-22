/**
 * The `export` job: `app.exports` row → artifact manifest → streamed CSV (roadmap P1-12).
 *
 * The roadmap's backend sentence, clause by clause, and where each lands:
 *
 *   "a streaming CSV export worker            → pages are written to the sink as they arrive;
 *                                               nothing holds more than one 500-row batch
 *    reading the artifact's variable manifest → the COLUMN CONTRACT comes from the compiled
 *                                               artifact, never from live `content.variables`:
 *                                               the manifest is versioned with the artifact
 *                                               (C §17 "one column of the export contract,
 *                                               versioned with the artifact so it cannot
 *                                               shift"), so a survey edited after fielding
 *                                               still exports the columns respondents answered
 *    and paging response_documents by keyset,  → `app.export_response_page` (0012): session_id
 *                                               order under a fixed version, exclusive lower
 *                                               bound, 0011's respdoc_export_idx
 *    applying the PII policy for the           → twice. The database strips PII values for a
 *    requester's role"                           caller without a LIVE pii_access grant; this
 *                                               job additionally NULLs every `pii: true`
 *                                               column when the row says `pii_included =
 *                                               false`, so a capable user's coded export is
 *                                               still clean."
 *
 * ## The export contract, stated once
 *
 *  * **Columns** = manifest entries with `export_include`, in MANIFEST ARRAY ORDER. The
 *    compiler emits `variable_manifest` in document order — `content.variables` read
 *    `ORDER BY sort_key` — so the array order IS the roadmap's "sort_key order" and this job
 *    never re-sorts. Header cells are `export_column`.
 *  * **Row identity**: one row per response DOCUMENT (= per session), in session_id (= start)
 *    order. No synthetic id column is prepended: the manifest is the whole contract, and the
 *    respondent-id / disposition columns arrive as compiler-emitted system variables, not as
 *    exporter inventions.
 *  * **Values are CODES.** An enum exports its numeric code; labels are the P5-02 SPSS work
 *    (`values: 'codes' | 'labels' | 'both'` in API §2.15) and need the i18n bundle this job
 *    deliberately does not load.
 *  * **A set** (a multi-select's set view) exports as its codes joined with `;` — `"1;3;7"` —
 *    the flat-file convention SPSS/Excel users expect for multi-punch in a single column; the
 *    per-option boolean fan-out columns are separately present as their own variables, so no
 *    information rides on the packed form. Semicolon and not comma so the cell rarely needs
 *    quoting and never reads as a column split when hand-opened.
 *  * **Booleans** export as `1`/`0` — the fan-out members are SPSS-bound dummies, and the
 *    literal `true` would type the column as text in every stats package.
 *  * **NULL is the empty cell.** CSV has no other spelling. Three sources collapse into it —
 *    never answered, PII-suppressed, and value absent from the document — which is exactly
 *    what security §7.2 wants for the middle one: a PII-redacted file is indistinguishable
 *    from one where nobody answered.
 *  * **RFC 4180 bytes**: see `csv.ts` (CRLF, minimal quoting, UTF-8 without BOM).
 *
 * ## What lands where
 *
 * The file goes to the `ExportSink` under `exports/<export id>.csv` — a LOCAL DIRECTORY in
 * this deployment, because there is no object storage stood up (artifact-store.ts's header);
 * the row records the relative `storage_key` so P5-02's bucket move changes the sink, not the
 * row. Success and failure are both written back to `app.exports` AS THE REQUESTER, so the
 * export history answers "who exported the open-ends, and did it finish" without touching
 * `ops.jobs`.
 */

import { AppError } from '@resscript/observability';
import type { ArtifactManifest, VariableManifestEntry } from '@resscript/schema';

import { artifactKey, type ArtifactStore } from '../artifact-store.js';
import { encodeCsvRow } from '../csv.js';
import {
  exportStorageKey,
  type ExportSink,
  type ExportStore,
  type ResponseDocumentPage,
} from '../export-store.js';
import type { JsonObject, JsonValue } from '../json.js';
import { defineJob, payload as p, type JobContext, type JobDefinition } from '../registry.js';
import type { JobIdentity } from '../publish-store.js';

export const EXPORT_KIND = 'export';

/**
 * The keyset page size. 500 documents × a few KB of vars is a comfortably small unit between
 * abort checks, and small enough that a page never strains the definer function's timeout.
 */
export const EXPORT_BATCH_SIZE = 500;

/* -------------------------------------------------------------------------- */
/* Payload and result                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Just the row id. Everything else — version, PII, test rows — lives ON `app.exports`, where
 * the INSERT policies and the pii trigger already judged it; a payload that restated
 * `pii_included` would be a second, unguarded copy of a security decision.
 */
export interface ExportPayload {
  readonly exportId: string;
}

export interface ExportJobResult extends JsonObject {
  export_id: string;
  survey_version_id: string;
  artifact_hash: string;
  storage_key: string;
  /** Response rows written — the row_count recorded on the export row. */
  rows: number;
  /** Columns in the file = manifest entries with `export_include`. */
  columns: number;
  pages: number;
  pii_included: boolean;
  include_test: boolean;
}

/* -------------------------------------------------------------------------- */
/* Environment                                                                */
/* -------------------------------------------------------------------------- */

export interface ExportEnvironment {
  readonly store: ExportStore;
  /** Where the compiled artifact lives — the SAME store the publish job wrote (ADR-002). */
  readonly artifacts: ArtifactStore;
  readonly sink: ExportSink;
  /** Test override for the page size; production uses EXPORT_BATCH_SIZE. */
  readonly batchSize?: number | undefined;
}

/**
 * The environment a worker with no `DATABASE_URL` gets — same posture as
 * `unconfiguredCompileEnvironment` and for the same reason (see kinds/registry.ts): the kind
 * is registered unconditionally so export jobs fail loudly instead of queueing forever.
 */
export function unconfiguredExportEnvironment(): ExportEnvironment {
  const refuse = (): never => {
    throw new AppError('unavailable', 'this worker cannot export: DATABASE_URL is unset', {
      retryable: false,
      context: { kind: EXPORT_KIND },
    });
  };
  return {
    store: {
      loadExport: async () => refuse(),
      artifactHashFor: async () => refuse(),
      markRunning: async () => refuse(),
      fetchPage: async () => refuse(),
      markSucceeded: async () => refuse(),
      markFailed: async () => undefined,
    },
    artifacts: { has: async () => refuse(), put: async () => refuse(), get: async () => refuse() },
    sink: { open: async () => refuse() },
  };
}

/* -------------------------------------------------------------------------- */
/* The job                                                                    */
/* -------------------------------------------------------------------------- */

export const EXPORT_STAGES: readonly string[] = [
  'reading the export request',
  'loading the artifact manifest',
  'streaming response documents',
  'recording the result',
];

export function exportJob(env: ExportEnvironment): JobDefinition<ExportPayload, ExportJobResult> {
  return defineJob({
    parse: (raw): ExportPayload => ({ exportId: p.requiredString(raw, 'export_id') }),
    handle: (ctx) => runExport(ctx, env),
  });
}

async function runExport(
  ctx: JobContext<ExportPayload>,
  env: ExportEnvironment,
): Promise<ExportJobResult> {
  const total = EXPORT_STAGES.length;
  const { exportId } = ctx.payload;
  const identity = identityOf(ctx);
  const batch = env.batchSize ?? EXPORT_BATCH_SIZE;

  /* ---- 1. the export row -------------------------------------------------- */

  await stage(ctx, 1, total);
  const row = await env.store.loadExport(identity, exportId);
  if (row === null) {
    // Zero rows from a policy-filtered read = "no such export", including "another org's
    // export" — the same indistinguishability every load in this codebase preserves.
    throw new AppError('not_found', 'the export is not visible to the enqueuing user', {
      retryable: false,
      context: { export_id: exportId, org_id: identity.orgId },
    });
  }
  await env.store.markRunning(identity, exportId);

  // Everything past the claim reports its failure ON THE ROW: the export history is the
  // record an analyst watches, and a failure visible only in ops.jobs is a spinner to them.
  try {
    /* ---- 2. the manifest --------------------------------------------------- */

    await stage(ctx, 2, total);
    const hash = await env.store.artifactHashFor(identity, row.survey_version_id);
    if (hash === null) {
      throw new AppError('not_found', 'the survey version has no compiled artifact to export against', {
        retryable: false,
        context: { export_id: exportId, survey_version_id: row.survey_version_id },
      });
    }
    const manifest = await loadManifest(env.artifacts, hash);
    const columns = manifest.variable_manifest.filter((entry) => entry.export_include);
    if (columns.length === 0) {
      throw new AppError('validation_failed', 'the variable manifest exports no columns', {
        retryable: false,
        context: { export_id: exportId, artifact_hash: hash },
      });
    }

    /* ---- 3. the stream ------------------------------------------------------ */

    await stage(ctx, 3, total);
    const storageKey = exportStorageKey(exportId);
    const writer = await env.sink.open(storageKey);
    let rows = 0;
    let pages = 0;
    try {
      await writer.write(encodeCsvRow(columns.map((entry) => entry.export_column)));
      let after: string | null = null;
      for (;;) {
        // Between pages, the same way compile checks between files: a drain must not wait
        // out a 200k-row export, and an aborted run is safely re-runnable from scratch.
        abortIfDraining(ctx, { export_id: exportId, page: pages });
        const page: readonly ResponseDocumentPage[] = await env.store.fetchPage(
          identity,
          row.survey_version_id,
          after,
          row.include_test,
          batch,
        );
        if (page.length > 0) {
          // One write per page, not per row: the sink sees a batch-sized chunk, the memory
          // high-water mark stays one page, and 10,000 rows are ~20 writes.
          let chunk = '';
          for (const doc of page) {
            chunk += csvLine(columns, doc, row.pii_included);
          }
          await writer.write(chunk);
          rows += page.length;
          pages += 1;
          await ctx.progress(3, total, `streamed ${String(rows)} rows`);
          const last = page[page.length - 1];
          after = last === undefined ? after : last.session_id;
        }
        // Fewer rows than asked for = the keyset is exhausted. `===` and not `>=`: the
        // function LIMITs at the batch size, so overshoot is impossible.
        if (page.length < batch) break;
      }
    } finally {
      await writer.close();
    }

    /* ---- 4. the record ------------------------------------------------------ */

    await stage(ctx, 4, total);
    await env.store.markSucceeded(identity, exportId, rows, storageKey);

    ctx.log.info('export_completed', {
      export_id: exportId,
      survey_version_id: row.survey_version_id,
      rows,
      columns: columns.length,
      pii_included: row.pii_included,
      include_test: row.include_test,
    });

    return {
      export_id: exportId,
      survey_version_id: row.survey_version_id,
      artifact_hash: hash,
      storage_key: storageKey,
      rows,
      columns: columns.length,
      pages,
      pii_included: row.pii_included,
      include_test: row.include_test,
    };
  } catch (err: unknown) {
    const appErr = AppError.from(err);
    // A drain abort is retryable and the retry will overwrite the file and re-mark the row —
    // recording 'failed' for it would flash a false failure at the analyst mid-deploy.
    if (!appErr.retryable) {
      await env.store.markFailed(identity, exportId, {
        code: appErr.code,
        message: appErr.message,
      });
    }
    throw appErr;
  }
}

/* -------------------------------------------------------------------------- */
/* Values → cells                                                             */
/* -------------------------------------------------------------------------- */

/** One document → one CSV line. Exported for the unit tests; pure. */
export function csvLine(
  columns: readonly VariableManifestEntry[],
  doc: ResponseDocumentPage,
  piiIncluded: boolean,
): string {
  return encodeCsvRow(columns.map((entry) => cellOf(entry, doc.vars[entry.id], piiIncluded)));
}

/**
 * The value mapping of the header's contract. NOTE the PII gate is per-COLUMN and absolute:
 * `pii: true` + `pii_included: false` is the empty cell even when the database handed the
 * value over (a requester WITH the capability who asked for a coded export). The database's
 * own strip (0012) covers the inverse case — a requester WITHOUT the capability never
 * receives the value at all, whatever this flag says.
 */
function cellOf(entry: VariableManifestEntry, value: JsonValue | undefined, piiIncluded: boolean): string {
  if (entry.pii && !piiIncluded) return '';
  if (value === undefined || value === null) return '';
  if (Array.isArray(value)) {
    // The set view: codes joined with ';' (see the header's decisions of record).
    return value.map((item) => scalarCell(item)).join(';');
  }
  return scalarCell(value);
}

function scalarCell(value: JsonValue): string {
  if (value === null) return '';
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return value;
  // An 'object'-typed variable (a plugin's structured value): serialized JSON, quoted by the
  // CSV layer. Rare, honest, and better than silently dropping a column the manifest promises.
  return JSON.stringify(value);
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

async function loadManifest(artifacts: ArtifactStore, hash: string): Promise<ArtifactManifest> {
  const raw = await artifacts.get(artifactKey(hash, 'manifest.json'));
  if (raw === null) {
    // Deterministic on this worker: the store either has the content-addressed bytes or it
    // does not, and retrying asks the same store the same question. On a fleet with a shared
    // bucket this is a real 404 — the artifact a version names must exist (0009's ordering).
    throw new AppError('not_found', 'the artifact manifest is missing from the store', {
      retryable: false,
      context: { artifact_hash: hash },
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause: unknown) {
    throw new AppError('internal_error', 'the artifact manifest is not valid JSON', {
      retryable: false,
      cause,
      context: { artifact_hash: hash },
    });
  }
  const manifest = parsed as ArtifactManifest;
  if (!Array.isArray(manifest.variable_manifest)) {
    throw new AppError('internal_error', 'the artifact manifest has no variable_manifest', {
      retryable: false,
      context: { artifact_hash: hash },
    });
  }
  return manifest;
}

async function stage(ctx: JobContext<ExportPayload>, step: number, total: number): Promise<void> {
  abortIfDraining(ctx, { step });
  await ctx.progress(step, total, EXPORT_STAGES[step - 1] ?? '');
}

function abortIfDraining(ctx: JobContext<ExportPayload>, context: JsonObject): void {
  if (!ctx.signal.aborted) return;
  throw new AppError('unavailable', 'export aborted during drain', {
    retryable: true,
    context: { export_id: ctx.payload.exportId, ...context },
  });
}

/** `compile.ts`'s identityOf, same argument: identity comes from `ops.jobs`, never the payload. */
function identityOf(ctx: JobContext<ExportPayload>): JobIdentity {
  const orgId = ctx.job.org_id;
  const userId = ctx.job.created_by;
  if (orgId === null || userId === null) {
    throw new AppError('forbidden', 'an export job must carry an org and a creating user', {
      retryable: false,
      context: { job_id: ctx.job.id, has_org: orgId !== null, has_user: userId !== null },
    });
  }
  return { orgId, userId };
}
