/**
 * The `export` job.
 *
 * Two suites, the split `compile.test.ts` established:
 *
 *  1. **The job through the harness** — real `Consumer`, `MemoryJobStore`, memory doubles for
 *     the three seams — so the column contract, the PII gate, the value conventions and the
 *     failure classification are asserted in milliseconds, and progress/results land where the
 *     studio will read them.
 *  2. **The integration suite** (SKIPS without `DATABASE_URL`), which is where the roadmap's
 *     P1-12 test lives: 10,000 synthetic sessions in `runtime.response_documents`, the job run
 *     with `PgExportStore` over 0012's `app.export_response_page`, asserting column order
 *     matches manifest order, a `pii: true` open-end is NULL without `pii_included`, `is_test`
 *     rows are excluded by default, keyset paging returns every row exactly once, and a value
 *     containing `","` round-trips.
 *
 * Assertions are on parsed CSV cells, row counts and store calls — never on message prose.
 */

import { createCapturingLogger } from '@resscript/observability';
import type { ArtifactManifest, VariableManifestEntry } from '@resscript/schema';
import { describe, expect, it } from 'vitest';

import { artifactKey, MemoryArtifactStore } from '../artifact-store.js';
import { parseCsv } from '../csv.js';
import { Consumer } from '../consumer.js';
import {
  exportStorageKey,
  MemoryExportSink,
  PgExportStore,
  type ExportRow,
  type ExportStore,
  type ResponseDocumentPage,
} from '../export-store.js';
import type { JsonObject } from '../json.js';
import { MemoryJobStore } from '../memory-job-store.js';
import {
  PUBLISH_SQL,
  savepointSessions,
  type JobIdentity,
  type SqlSession,
} from '../publish-store.js';
import { buildRegistry } from './registry.js';
import { EXPORT_KIND, EXPORT_STAGES, type ExportEnvironment } from './export.js';

/* ========================================================================== */
/* Fixture                                                                     */
/* ========================================================================== */

/** `ops.test_ulid`'s shape (Crockford-safe tags only — no i/l/o/u). */
function tid(prefix: string, tag: string): string {
  return `${prefix}_0${tag.toUpperCase().padEnd(25, '0')}`;
}

const ORG = tid('org', 'a');
const USER = '11111111-1111-1111-1111-111111111111';
const VER = tid('ver', 'a1');
const EXP = tid('exp', 'a1');
const HASH = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

const V_SEQ = tid('var', 'sq');
const V_Q1 = tid('var', 'q1');
const V_SET = tid('var', 'st');
const V_OE = tid('var', 'x1');
const V_HIDDEN = tid('var', 'hd');
const V_BOOL = tid('var', 'b1');

function entry(
  id: string,
  column: string,
  type: VariableManifestEntry['type'],
  overrides: Partial<VariableManifestEntry> = {},
): VariableManifestEntry {
  return {
    id: id as VariableManifestEntry['id'],
    name: column,
    kind: 'response',
    type,
    export_column: column,
    export_include: true,
    pii: false,
    persist: true,
    ...overrides,
  };
}

/**
 * The manifest order IS the contract order (compiler emit/manifest.ts: document order,
 * unsorted). The fixture deliberately interleaves the excluded and pii entries so "filter,
 * do not reorder" is observable.
 */
function manifestEntries(): VariableManifestEntry[] {
  return [
    entry(V_SEQ, 'SEQ', 'number'),
    entry(V_Q1, 'Q1', 'enum'),
    entry(V_HIDDEN, 'HDN', 'text', { export_include: false }),
    entry(V_SET, 'Q2', 'set'),
    entry(V_OE, 'Q3_OE', 'text', { pii: true }),
    entry(V_BOOL, 'Q2r1', 'boolean'),
  ];
}

/** Included columns, in manifest order — what every header assertion compares against. */
const EXPECTED_HEADER = ['SEQ', 'Q1', 'Q2', 'Q3_OE', 'Q2r1'];

function manifestJson(entries: readonly VariableManifestEntry[]): string {
  const manifest: ArtifactManifest = {
    artifact_schema_version: 1,
    survey_id: tid('svy', 'a'),
    survey_version_id: VER,
    artifact_hash: HASH,
    compiled_at: '2026-01-01T00:00:00.000Z',
    base_language: 'en',
    languages: ['en'],
    script_hashes: {},
    csp_directives: {},
    variable_manifest: entries,
    entitlements: [],
    plugin_versions: {},
  };
  return JSON.stringify(manifest);
}

function doc(sessionTag: string, vars: JsonObject, isTest = false): ResponseDocumentPage {
  return { session_id: tid('ses', sessionTag), is_test: isTest, vars };
}

/* ========================================================================== */
/* Memory double for the store                                                */
/* ========================================================================== */

interface MutableExportRow {
  status: string;
  row_count: number | null;
  storage_key: string | null;
  error: JsonObject | null;
}

/**
 * Reimplements 0012's read semantics — keyset order, exclusive lower bound, is_test filter,
 * LIMIT — the way `MemoryJobStore` reimplements the queue: not a mock, so the paging
 * assertions here mean the same thing they mean against Postgres.
 */
class MemoryExportStore implements ExportStore {
  readonly lifecycle: string[] = [];
  readonly state: MutableExportRow = {
    status: 'pending',
    row_count: null,
    storage_key: null,
    error: null,
  };
  readonly pageSizes: number[] = [];

  constructor(
    private readonly row: ExportRow | null,
    private readonly hash: string | null,
    private readonly docs: readonly ResponseDocumentPage[],
  ) {}

  async loadExport(_identity: JobIdentity, exportId: string): Promise<ExportRow | null> {
    return this.row !== null && this.row.id === exportId ? this.row : null;
  }

  async artifactHashFor(): Promise<string | null> {
    return this.hash;
  }

  async markRunning(): Promise<void> {
    this.lifecycle.push('running');
    this.state.status = 'running';
  }

  async fetchPage(
    _identity: JobIdentity,
    _versionId: string,
    afterSessionId: string | null,
    includeTest: boolean,
    limit: number,
  ): Promise<readonly ResponseDocumentPage[]> {
    const page = [...this.docs]
      .filter((d) => includeTest || !d.is_test)
      .filter((d) => afterSessionId === null || d.session_id > afterSessionId)
      .sort((a, b) => (a.session_id < b.session_id ? -1 : 1))
      .slice(0, limit);
    this.pageSizes.push(page.length);
    return page;
  }

  async markSucceeded(
    _identity: JobIdentity,
    _exportId: string,
    rowCount: number,
    storageKey: string,
  ): Promise<void> {
    this.lifecycle.push('succeeded');
    this.state.status = 'succeeded';
    this.state.row_count = rowCount;
    this.state.storage_key = storageKey;
  }

  async markFailed(_identity: JobIdentity, _exportId: string, error: JsonObject): Promise<void> {
    this.lifecycle.push('failed');
    this.state.status = 'failed';
    this.state.error = error;
  }
}

/* ========================================================================== */
/* Harness                                                                     */
/* ========================================================================== */

function exportRow(overrides: Partial<ExportRow> = {}): ExportRow {
  return {
    id: EXP,
    org_id: ORG,
    survey_version_id: VER,
    requested_by: USER,
    status: 'pending',
    pii_included: false,
    include_test: false,
    ...overrides,
  };
}

interface Harness {
  readonly store: MemoryExportStore;
  readonly sink: MemoryExportSink;
  readonly jobs: MemoryJobStore;
  run(payload?: JsonObject): Promise<{
    status: string;
    result: JsonObject | null;
    error: JsonObject | null;
    progress: JsonObject;
    attempts: number;
  }>;
  csv(): string[][];
}

function harness(options: {
  readonly row?: ExportRow | null;
  readonly hash?: string | null;
  readonly docs?: readonly ResponseDocumentPage[];
  readonly entries?: readonly VariableManifestEntry[];
  readonly manifestMissing?: boolean;
  readonly batchSize?: number;
} = {}): Harness {
  const row = options.row === undefined ? exportRow() : options.row;
  const store = new MemoryExportStore(
    row,
    options.hash === undefined ? HASH : options.hash,
    options.docs ?? [],
  );
  const artifacts = new MemoryArtifactStore();
  if (options.manifestMissing !== true) {
    void artifacts.put(
      artifactKey(HASH, 'manifest.json'),
      manifestJson(options.entries ?? manifestEntries()),
    );
  }
  const sink = new MemoryExportSink();
  const env: ExportEnvironment = {
    store,
    artifacts,
    sink,
    ...(options.batchSize === undefined ? {} : { batchSize: options.batchSize }),
  };
  const jobs = new MemoryJobStore();
  const consumer = new Consumer({
    store: jobs,
    registry: buildRegistry({ export: env }),
    logger: createCapturingLogger({ service: 'worker', level: 'error' }).logger,
    concurrency: 1,
    pollIntervalMs: 2,
    heartbeatIntervalMs: 5,
    stalledAfterMs: 50_000,
    sweepIntervalMs: 0,
    drainTimeoutMs: 2_000,
    backoffMs: () => 0,
  });

  return {
    store,
    sink,
    jobs,
    run: async (payload = { export_id: EXP }) => {
      const { id } = await jobs.enqueue({
        kind: EXPORT_KIND,
        payload,
        orgId: ORG,
        createdBy: USER,
        surveyVersionId: VER,
        maxAttempts: 1,
      });
      await consumer.runUntilIdle();
      const job = await jobs.get(id);
      return {
        status: job?.status ?? 'missing',
        result: (job?.result ?? null) as JsonObject | null,
        error: job?.error ?? null,
        progress: job?.progress ?? {},
        attempts: job?.attempts ?? 0,
      };
    },
    csv: () => parseCsv(sink.files.get(exportStorageKey(EXP)) ?? ''),
  };
}

/** Cell lookup by header name, so tests read as facts about columns rather than indices. */
function cell(rows: string[][], rowIndex: number, column: string): string | undefined {
  const header = rows[0] ?? [];
  const at = header.indexOf(column);
  if (at === -1) return undefined;
  return (rows[rowIndex] ?? [])[at];
}

/* ========================================================================== */
/* 1. The contract                                                             */
/* ========================================================================== */

describe('the column contract', () => {
  it('writes export_column headers for export_include entries, in MANIFEST order', async () => {
    const h = harness({ docs: [doc('s1', { [V_SEQ]: 1 })] });
    const outcome = await h.run();
    expect(outcome.status).toBe('succeeded');
    const rows = h.csv();
    // The excluded HDN column is ABSENT and the others did not close ranks in a new order.
    expect(rows[0]).toEqual(EXPECTED_HEADER);
  });

  it('records the result on the export row: status, row_count, storage_key', async () => {
    const h = harness({ docs: [doc('s1', { [V_SEQ]: 1 }), doc('s2', { [V_SEQ]: 2 })] });
    const outcome = await h.run();
    expect(outcome.status).toBe('succeeded');
    expect(h.store.lifecycle).toEqual(['running', 'succeeded']);
    expect(h.store.state).toMatchObject({
      status: 'succeeded',
      row_count: 2,
      storage_key: exportStorageKey(EXP),
    });
    expect(outcome.result).toMatchObject({
      rows: 2,
      columns: EXPECTED_HEADER.length,
      artifact_hash: HASH,
      storage_key: exportStorageKey(EXP),
    });
  });

  it('reports progress through the named stages', async () => {
    const h = harness({ docs: [doc('s1', { [V_SEQ]: 1 })] });
    const outcome = await h.run();
    expect(outcome.progress).toMatchObject({
      step: EXPORT_STAGES.length,
      total: EXPORT_STAGES.length,
    });
  });
});

describe('the value conventions', () => {
  it('exports enum codes, 1/0 booleans, ;-joined sets, and JSON for object values', async () => {
    const h = harness({
      docs: [
        doc('s1', {
          [V_SEQ]: 7,
          [V_Q1]: 3,
          [V_SET]: [1, 3, 7],
          [V_OE]: 'unused',
          [V_BOOL]: true,
        }),
        doc('s2', { [V_SEQ]: { nested: 'x' }, [V_BOOL]: false }),
      ],
    });
    await h.run();
    const rows = h.csv();
    expect(cell(rows, 1, 'Q1')).toBe('3');
    expect(cell(rows, 1, 'Q2')).toBe('1;3;7');
    expect(cell(rows, 1, 'Q2r1')).toBe('1');
    expect(cell(rows, 2, 'Q2r1')).toBe('0');
    expect(cell(rows, 2, 'SEQ')).toBe('{"nested":"x"}');
  });

  it('renders NULL, absent and PII-suppressed values all as the empty cell', async () => {
    const h = harness({
      docs: [doc('s1', { [V_SEQ]: 1, [V_Q1]: null, [V_OE]: 'my email is x@y.test' })],
    });
    await h.run();
    const rows = h.csv();
    expect(cell(rows, 1, 'Q1')).toBe(''); // answered NULL
    expect(cell(rows, 1, 'Q2')).toBe(''); // never answered
    expect(cell(rows, 1, 'Q3_OE')).toBe(''); // pii: true, pii_included: false
  });

  it('carries the pii column when the row says pii_included', async () => {
    const h = harness({
      row: exportRow({ pii_included: true }),
      docs: [doc('s1', { [V_SEQ]: 1, [V_OE]: 'my email is x@y.test' })],
    });
    await h.run();
    expect(cell(h.csv(), 1, 'Q3_OE')).toBe('my email is x@y.test');
  });

  it('round-trips a hostile open-end — quotes, the literal `","`, a newline', async () => {
    const hostile = 'she said "no, thanks"\nthen typed ","';
    const h = harness({
      row: exportRow({ pii_included: true }),
      docs: [doc('s1', { [V_SEQ]: 1, [V_OE]: hostile })],
    });
    await h.run();
    expect(cell(h.csv(), 1, 'Q3_OE')).toBe(hostile);
  });
});

describe('paging and streaming', () => {
  it('pages by keyset until a short page, and writes one chunk per page', async () => {
    const docs = ['s1', 's2', 's3', 's4', 's5'].map((tag, index) =>
      doc(tag, { [V_SEQ]: index + 1 }),
    );
    const h = harness({ docs, batchSize: 2 });
    const outcome = await h.run();
    expect(outcome.status).toBe('succeeded');
    // 2 + 2 + 1: the short page terminates the loop — no extra empty-page probe after it.
    expect(h.store.pageSizes).toEqual([2, 2, 1]);
    // Header chunk + one chunk per non-empty page: the file was streamed, not materialized.
    expect(h.sink.chunks.get(exportStorageKey(EXP))).toBe(4);
    const seqs = h
      .csv()
      .slice(1)
      .map((row) => row[0]);
    expect(seqs).toEqual(['1', '2', '3', '4', '5']);
  });

  it('excludes is_test rows by default and includes them on the flag (E 14.1)', async () => {
    const docs = [
      doc('s1', { [V_SEQ]: 1 }),
      doc('s2', { [V_SEQ]: 2 }, true),
      doc('s3', { [V_SEQ]: 3 }),
    ];
    const h = harness({ docs });
    const outcome = await h.run();
    expect((outcome.result as JsonObject)['rows']).toBe(2);
    expect(h.csv().slice(1).map((row) => row[0])).toEqual(['1', '3']);

    const withTest = harness({ row: exportRow({ include_test: true }), docs });
    const second = await withTest.run();
    expect((second.result as JsonObject)['rows']).toBe(3);
  });
});

describe('failure classification', () => {
  it('fails not_found without retry when the export row is invisible', async () => {
    const h = harness({ row: null });
    const outcome = await h.run();
    expect(outcome.status).toBe('failed');
    expect(outcome.error?.['code']).toBe('not_found');
    expect(outcome.attempts).toBe(1);
    // Nothing was claimed, so nothing is marked failed on a row we could not see.
    expect(h.store.lifecycle).toEqual([]);
  });

  it('fails and RECORDS the failure on the row when the version has no artifact', async () => {
    const h = harness({ hash: null });
    const outcome = await h.run();
    expect(outcome.status).toBe('failed');
    expect(outcome.error?.['code']).toBe('not_found');
    expect(h.store.lifecycle).toEqual(['running', 'failed']);
    expect(h.store.state.error?.['code']).toBe('not_found');
  });

  it('fails when the manifest is missing from the artifact store', async () => {
    const h = harness({ manifestMissing: true });
    const outcome = await h.run();
    expect(outcome.status).toBe('failed');
    expect(outcome.error?.['code']).toBe('not_found');
    expect(h.store.state.status).toBe('failed');
  });

  it('fails validation_failed when the manifest exports zero columns', async () => {
    const entries = manifestEntries().map((e) => ({ ...e, export_include: false }));
    const h = harness({ entries });
    const outcome = await h.run();
    expect(outcome.status).toBe('failed');
    expect(outcome.error?.['code']).toBe('validation_failed');
  });
});

/* ========================================================================== */
/* 2. Integration — the roadmap's 10,000-session test                          */
/* ========================================================================== */

const DATABASE_URL = process.env['DATABASE_URL'];
const describeIntegration =
  DATABASE_URL === undefined || DATABASE_URL === '' ? describe.skip : describe;

if (DATABASE_URL === undefined || DATABASE_URL === '') {
  // eslint-disable-next-line no-console -- the whole point is that a human sees why these skipped
  console.info(
    '[export] integration tests SKIPPED: DATABASE_URL is unset. ' +
      'Run `pnpm db:up` and set DATABASE_URL to exercise app.exports, ' +
      'app.export_response_page and the keyset paging for real.',
  );
}

describeIntegration('the export against a real database (10,000 synthetic sessions)', () => {
  const ROWS = 10_000;
  const TEST_ROWS = 25;
  const HOSTILE_SEQ = 17;
  const HOSTILE = 'she typed "," and, worse,\na newline';
  // ver_a_frozen's artifact_hash from ops.test_seed_two_orgs (the sha256 of empty input).
  const K_HASH = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

  async function withRollback(
    body: (session: SqlSession, ids: Record<string, string>) => Promise<void>,
  ): Promise<void> {
    const pg = await import('pg');
    const client = new pg.default.Client({ connectionString: DATABASE_URL });
    await client.connect();
    const session: SqlSession = {
      query: (text, values) =>
        client.query(text, values === undefined ? undefined : [...values]) as never,
    };
    try {
      await session.query('BEGIN');
      const seeded = await session.query<{ ids: Record<string, string> }>(
        'SELECT ops.test_seed_two_orgs() AS ids',
      );
      await body(session, seeded.rows[0]?.ids ?? {});
    } finally {
      await session.query('ROLLBACK').catch(() => undefined);
      await client.end();
    }
  }

  /**
   * 10,000 real sessions + 25 test sessions, one INSERT ... SELECT. Session ids are
   * zero-padded decimals inside the ULID shape, so lexicographic (= keyset) order equals
   * numeric order and "every row exactly once" is checkable as a contiguous SEQ range.
   * The hostile open-end goes on one known row.
   */
  async function seedDocuments(
    session: SqlSession,
    versionId: string,
    orgId: string,
  ): Promise<void> {
    await session.query(
      `INSERT INTO runtime.response_documents
         (survey_version_id, session_id, org_id, is_test, status, disposition, vars, started_at)
       SELECT $1::app.ulid,
              ('ses_0' || lpad(n::text, 25, '0'))::app.ulid,
              $2::app.ulid,
              n > $3,
              'completed'::runtime.session_status,
              'COMPLETE'::runtime.disposition,
              jsonb_build_object(
                $4::text, n,
                $5::text, (n % 5) + 1,
                $6::text, jsonb_build_array(1, 3, 7),
                $7::text, CASE WHEN n = $8 THEN $9::text
                               ELSE 'open end for ' || n::text END,
                $10::text, (n % 2) = 0
              ),
              now()
         FROM generate_series(1, $11::int) AS n`,
      [versionId, orgId, ROWS, V_SEQ, V_Q1, V_SET, V_OE, HOSTILE_SEQ, HOSTILE, V_BOOL, ROWS + TEST_ROWS],
    );
  }

  interface JobOutcome {
    readonly status: string;
    readonly result: JsonObject | null;
    readonly error: JsonObject | null;
  }

  async function runExportJob(
    session: SqlSession,
    sink: MemoryExportSink,
    input: { readonly orgId: string; readonly userId: string; readonly exportId: string },
  ): Promise<JobOutcome> {
    const artifacts = new MemoryArtifactStore();
    await artifacts.put(artifactKey(K_HASH, 'manifest.json'), manifestJson(manifestEntries()));
    const env: ExportEnvironment = {
      store: new PgExportStore(savepointSessions(session)),
      artifacts,
      sink,
    };
    const jobs = new MemoryJobStore();
    const consumer = new Consumer({
      store: jobs,
      registry: buildRegistry({ export: env }),
      logger: createCapturingLogger({ service: 'worker', level: 'error' }).logger,
      concurrency: 1,
      pollIntervalMs: 2,
      heartbeatIntervalMs: 5,
      stalledAfterMs: 50_000,
      sweepIntervalMs: 0,
      drainTimeoutMs: 30_000,
      backoffMs: () => 0,
    });
    const { id } = await jobs.enqueue({
      kind: EXPORT_KIND,
      payload: { export_id: input.exportId },
      orgId: input.orgId,
      createdBy: input.userId,
      maxAttempts: 1,
    });
    await consumer.runUntilIdle();
    const job = await jobs.get(id);
    return {
      status: job?.status ?? 'missing',
      result: (job?.result ?? null) as JsonObject | null,
      error: job?.error ?? null,
    };
  }

  async function insertExportRow(
    session: SqlSession,
    input: {
      readonly exportId: string;
      readonly orgId: string;
      readonly versionId: string;
      readonly userId: string;
      readonly piiIncluded?: boolean;
      readonly includeTest?: boolean;
    },
  ): Promise<void> {
    await session.query(
      `INSERT INTO app.exports
         (id, org_id, survey_version_id, requested_by, pii_included, include_test)
       VALUES ($1::app.ulid, $2::app.ulid, $3::app.ulid, $4::uuid, $5, $6)`,
      [
        input.exportId,
        input.orgId,
        input.versionId,
        input.userId,
        input.piiIncluded ?? false,
        input.includeTest ?? false,
      ],
    );
  }

  it(
    'streams 10,000 sessions: manifest column order, NULL pii, no test rows, every row once, "," round-trip',
    { timeout: 120_000 },
    async () => {
      await withRollback(async (session, ids) => {
        const orgId = String(ids['org_a']);
        const userId = String(ids['user_a']);
        const versionId = String(ids['ver_a_frozen']);
        await seedDocuments(session, versionId, orgId);

        const exportId = tid('exp', 'x1');
        await insertExportRow(session, { exportId, orgId, versionId, userId });

        const sink = new MemoryExportSink();
        const outcome = await runExportJob(session, sink, { orgId, userId, exportId });
        expect(outcome.error).toBeNull();
        expect(outcome.status).toBe('succeeded');
        expect(outcome.result).toMatchObject({ rows: ROWS, columns: EXPECTED_HEADER.length });

        const rows = parseCsv(sink.files.get(exportStorageKey(exportId)) ?? '');

        // (a) column order matches the manifest's — the roadmap's sort_key order, since the
        // compiler emits the manifest in content.variables' sort_key order.
        expect(rows[0]).toEqual(EXPECTED_HEADER);

        // (d) keyset paging returned every row exactly once: 10,000 data rows whose SEQ
        // values are exactly the set 1..10000 — a duplicate or a dropped page cannot pass.
        const data = rows.slice(1);
        expect(data).toHaveLength(ROWS);
        const seqs = new Set(data.map((row) => row[0]));
        expect(seqs.size).toBe(ROWS);
        expect(seqs.has('1')).toBe(true);
        expect(seqs.has(String(ROWS))).toBe(true);

        // (c) is_test rows are EXCLUDED by default: their SEQ values are all above ROWS.
        expect(seqs.has(String(ROWS + 1))).toBe(false);

        // (b) the pii: true open-end is NULL (the empty cell) for an export without the PII
        // grant recorded — in EVERY row.
        const header = rows[0] ?? [];
        const oeAt = header.indexOf('Q3_OE');
        expect(oeAt).toBeGreaterThan(-1);
        expect(data.every((row) => row[oeAt] === '')).toBe(true);

        // Codes and conventions, spot-checked on a known row.
        const row17 = data.find((row) => row[0] === String(HOSTILE_SEQ));
        expect(row17?.[header.indexOf('Q1')]).toBe(String((HOSTILE_SEQ % 5) + 1));
        expect(row17?.[header.indexOf('Q2')]).toBe('1;3;7');
        expect(row17?.[header.indexOf('Q2r1')]).toBe(HOSTILE_SEQ % 2 === 0 ? '1' : '0');

        // The export row is the record: status, row_count, storage_key.
        const recorded = (
          await session.query<{ status: string; row_count: string; storage_key: string }>(
            'SELECT status::text AS status, row_count::text AS row_count, storage_key ' +
              'FROM app.exports WHERE id = $1::app.ulid',
            [exportId],
          )
        ).rows[0];
        expect(recorded).toMatchObject({
          status: 'succeeded',
          row_count: String(ROWS),
          storage_key: exportStorageKey(exportId),
        });
      });
    },
  );

  it(
    'a PII export carries the open-end — including the value containing ","',
    { timeout: 120_000 },
    async () => {
      await withRollback(async (session, ids) => {
        const orgId = String(ids['org_a']);
        const userId = String(ids['user_a']);
        const versionId = String(ids['ver_a_frozen']);
        await seedDocuments(session, versionId, orgId);

        // pii_included = true must clear 0012's capability trigger, so grant user_a
        // pii_access (as the seeding superuser — the P1-13 grant flow is not under test)
        // and set the claims the trigger reads before inserting.
        await session.query(
          `INSERT INTO app.capability_grants (org_id, user_id, capability, granted_by, justification)
           VALUES ($1::app.ulid, $2::uuid, 'pii_access', $2::uuid,
                   'export integration test grant, rolled back with the transaction')`,
          [orgId, userId],
        );
        await session.query(PUBLISH_SQL.claims, [userId, orgId]);
        const exportId = tid('exp', 'x2');
        await insertExportRow(session, {
          exportId,
          orgId,
          versionId,
          userId,
          piiIncluded: true,
        });

        const sink = new MemoryExportSink();
        const outcome = await runExportJob(session, sink, { orgId, userId, exportId });
        expect(outcome.error).toBeNull();
        expect(outcome.status).toBe('succeeded');

        const rows = parseCsv(sink.files.get(exportStorageKey(exportId)) ?? '');
        const header = rows[0] ?? [];
        const data = rows.slice(1);
        const oeAt = header.indexOf('Q3_OE');

        // (e) the hostile value — quotes, the literal ",", a newline — round-tripped exactly.
        const row17 = data.find((row) => row[0] === String(HOSTILE_SEQ));
        expect(row17?.[oeAt]).toBe(HOSTILE);
        // And an ordinary row carries its ordinary open-end.
        const row1 = data.find((row) => row[0] === '1');
        expect(row1?.[oeAt]).toBe('open end for 1');
      });
    },
  );

  it(
    'include_test = true brings the test sessions into the file',
    { timeout: 120_000 },
    async () => {
      await withRollback(async (session, ids) => {
        const orgId = String(ids['org_a']);
        const userId = String(ids['user_a']);
        const versionId = String(ids['ver_a_frozen']);
        await seedDocuments(session, versionId, orgId);

        const exportId = tid('exp', 'x3');
        await insertExportRow(session, {
          exportId,
          orgId,
          versionId,
          userId,
          includeTest: true,
        });

        const sink = new MemoryExportSink();
        const outcome = await runExportJob(session, sink, { orgId, userId, exportId });
        expect(outcome.status).toBe('succeeded');
        expect(outcome.result).toMatchObject({ rows: ROWS + TEST_ROWS });

        const rows = parseCsv(sink.files.get(exportStorageKey(exportId)) ?? '');
        const seqs = new Set(rows.slice(1).map((row) => row[0]));
        expect(seqs.has(String(ROWS + TEST_ROWS))).toBe(true);
      });
    },
  );

  it('fails not_found when the enqueuing user cannot see the export row', async () => {
    await withRollback(async (session, ids) => {
      const orgId = String(ids['org_a']);
      const userId = String(ids['user_a']);
      const versionId = String(ids['ver_a_frozen']);
      const exportId = tid('exp', 'x4');
      await insertExportRow(session, { exportId, orgId, versionId, userId });

      // Org B's owner enqueues a job naming org A's export: RLS answers "no such row".
      const sink = new MemoryExportSink();
      const outcome = await runExportJob(session, sink, {
        orgId: String(ids['org_b']),
        userId: String(ids['user_b']),
        exportId,
      });
      expect(outcome.status).toBe('failed');
      expect(outcome.error?.['code']).toBe('not_found');
      expect(sink.files.size).toBe(0);
    });
  });
});
