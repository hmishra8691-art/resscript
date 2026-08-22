/**
 * The export request path (roadmap P1-12, migration 0012): `POST /versions/:id/exports`
 * creates the `app.exports` row AND enqueues the worker's job; GET is the dialog's history.
 *
 * The centre of this suite is K §1's non-nesting capability: `pii_included` is granted by
 * `app.capability_grants` + the org setting, NEVER by rank — an org OWNER without the grant is
 * refused, and the refusal stores nothing and enqueues nothing. The trigger is the guarantee
 * (0012's pgTAP proves the SQL); these tests prove the API translates it and that the
 * in-memory store refuses for the same two independent reasons.
 *
 * Assertions are on status codes, envelope CODES and stored rows. Never on message prose.
 */

import { describe, expect, it } from 'vitest';
import { GET as getExports, POST as postExport } from '@/app/api/v1/versions/[id]/exports/route';
import { createHarness, params, readJson, req, type Harness } from '@/test/harness';

function envelopeCode(body: Record<string, unknown>): string {
  return (body['error'] as { code: string }).code;
}

function postRequest(versionId: string, body: unknown, key?: string): Request {
  return req(`/api/v1/versions/${versionId}/exports`, {
    method: 'POST',
    body,
    ...(key === undefined ? {} : { headers: { 'Idempotency-Key': key } }),
  });
}

/** The PII preconditions, both halves: the grant AND the org setting (has_capability's own AND). */
function grantPii(h: Harness, userId: string): void {
  const index = h.data.organizations.findIndex((o) => o.id === h.ids.orgA);
  const org = h.data.organizations[index];
  if (org === undefined) throw new Error('fixture missing');
  h.data.organizations[index] = { ...org, settings: { pii_exports_enabled: true } };
  h.data.seedCapability({ org_id: h.ids.orgA, user_id: userId, capability: 'pii_access' });
}

describe('POST /api/v1/versions/:id/exports', () => {
  it('creates a born-pending row AND enqueues the export job, payload = just the row id', async () => {
    const h = createHarness();
    h.as({ userId: h.ids.ownerA, activeOrgId: h.ids.orgA });
    const response = await readJson(
      await postExport(postRequest(h.ids.draftA, {}), params({ id: h.ids.draftA })),
    );

    expect(response.status).toBe(202);
    const exportBody = response.body['export'] as Record<string, unknown>;
    // Honest defaults, stored: PII off (security §7.2), test rows out (E §14.1).
    expect(exportBody).toMatchObject({
      status: 'pending',
      pii_included: false,
      include_test: false,
      requested_by: h.ids.ownerA,
      survey_version_id: h.ids.draftA,
    });
    expect(h.data.exports).toHaveLength(1);

    const job = h.data.jobs.find((j) => j.kind === 'export');
    expect(job).toBeDefined();
    expect(job?.status).toBe('queued');
    expect(job?.survey_version_id).toBe(h.ids.draftA);
    // The payload is JUST the row id, in the exact snake_case key `apps/worker`'s
    // `exportJob.parse` reads: everything else — version, PII, test rows — lives ON the row,
    // where the policies and the pii trigger already judged it.
    expect(h.data.enqueuedPayloads).toEqual([
      { job_id: job?.id, kind: 'export', payload: { export_id: exportBody['id'] } },
    ]);
    expect((response.body['job'] as { id: string }).id).toBe(job?.id);
    expect(response.headers.get('Location')).toBe(`/api/v1/jobs/${job?.id ?? ''}`);
  });

  it('persists include_test when asked — the flag is ON the row, never in the job payload', async () => {
    const h = createHarness();
    h.as({ userId: h.ids.ownerA, activeOrgId: h.ids.orgA });
    const response = await readJson(
      await postExport(postRequest(h.ids.draftA, { include_test: true }), params({ id: h.ids.draftA })),
    );
    expect(response.status).toBe(202);
    expect((response.body['export'] as Record<string, unknown>)['include_test']).toBe(true);
    expect(h.data.exports[0]?.include_test).toBe(true);
    expect(h.data.exports[0]?.pii_included).toBe(false);
  });

  it('refuses pii_included for an OWNER without a grant — capability, never rank (K §1)', async () => {
    const h = createHarness();
    h.as({ userId: h.ids.ownerA, activeOrgId: h.ids.orgA });
    const response = await readJson(
      await postExport(postRequest(h.ids.draftA, { pii_included: true }), params({ id: h.ids.draftA })),
    );
    expect(response.status).toBe(403);
    expect(envelopeCode(response.body)).toBe('forbidden');
    // The refusal stores NOTHING and enqueues NOTHING: no row, no work, no half-audit.
    expect(h.data.exports).toHaveLength(0);
    expect(h.data.jobs.filter((j) => j.kind === 'export')).toHaveLength(0);
  });

  it('refuses pii_included when the grant exists but the org setting is off — both halves, independently', async () => {
    const h = createHarness();
    h.as({ userId: h.ids.ownerA, activeOrgId: h.ids.orgA });
    // The grant WITHOUT the setting: has_capability's conjunction must still refuse.
    h.data.seedCapability({ org_id: h.ids.orgA, user_id: h.ids.ownerA, capability: 'pii_access' });
    const response = await readJson(
      await postExport(postRequest(h.ids.draftA, { pii_included: true }), params({ id: h.ids.draftA })),
    );
    expect(response.status).toBe(403);
    expect(h.data.exports).toHaveLength(0);
  });

  it('accepts pii_included with a live grant AND the org setting, and STORES the fact', async () => {
    const h = createHarness();
    h.as({ userId: h.ids.ownerA, activeOrgId: h.ids.orgA });
    grantPii(h, h.ids.ownerA);
    const response = await readJson(
      await postExport(postRequest(h.ids.draftA, { pii_included: true }), params({ id: h.ids.draftA })),
    );
    expect(response.status).toBe(202);
    // Stored at request time, not recomputed (0012): the audit answer must not move when the
    // grant is later revoked.
    expect(h.data.exports[0]?.pii_included).toBe(true);
  });

  it('is 403 below the analyst floor — a reviewer cannot request an export at all', async () => {
    const h = createHarness();
    h.as({ userId: h.ids.reviewerA, activeOrgId: h.ids.orgA });
    const response = await readJson(
      await postExport(postRequest(h.ids.draftA, {}), params({ id: h.ids.draftA })),
    );
    expect(response.status).toBe(403);
    expect(envelopeCode(response.body)).toBe('forbidden');
    expect(h.data.exports).toHaveLength(0);
  });

  it("is not_found for another org's version, with nothing created", async () => {
    const h = createHarness();
    h.as({ userId: h.ids.ownerA, activeOrgId: h.ids.orgA });
    const response = await postExport(postRequest(h.ids.draftB, {}), params({ id: h.ids.draftB }));
    expect(response.status).toBe(404);
    expect(h.data.exports).toHaveLength(0);
  });

  it('replays under one Idempotency-Key: a client retry is ONE file, one audit row', async () => {
    const h = createHarness();
    h.as({ userId: h.ids.ownerA, activeOrgId: h.ids.orgA });
    const first = await readJson(
      await postExport(postRequest(h.ids.draftA, {}, 'retry-1'), params({ id: h.ids.draftA })),
    );
    const second = await readJson(
      await postExport(postRequest(h.ids.draftA, {}, 'retry-1'), params({ id: h.ids.draftA })),
    );
    expect(first.status).toBe(202);
    expect(second.headers.get('Idempotent-Replay')).toBe('true');
    expect(h.data.exports).toHaveLength(1);
    // A DELIBERATE second request (no key) is new work — two files, two audit rows.
    await postExport(postRequest(h.ids.draftA, {}), params({ id: h.ids.draftA }));
    expect(h.data.exports).toHaveLength(2);
  });
});

describe('GET /api/v1/versions/:id/exports', () => {
  it('lists the history newest first, with status and row_count', async () => {
    const h = createHarness();
    h.as({ userId: h.ids.ownerA, activeOrgId: h.ids.orgA });
    await postExport(postRequest(h.ids.draftA, {}), params({ id: h.ids.draftA }));
    await postExport(postRequest(h.ids.draftA, { include_test: true }), params({ id: h.ids.draftA }));
    // The worker's outcome write, as the requester: the history renders it verbatim.
    const done = h.data.exports[0];
    if (done === undefined) throw new Error('fixture missing');
    (done as { status: string }).status = 'succeeded';
    (done as { row_count: number | null }).row_count = 128;

    const response = await readJson(
      await getExports(req(`/api/v1/versions/${h.ids.draftA}/exports`), params({ id: h.ids.draftA })),
    );
    expect(response.status).toBe(200);
    const exports = response.body['exports'] as Record<string, unknown>[];
    expect(exports).toHaveLength(2);
    expect(exports[0]).toMatchObject({ include_test: true, status: 'pending' });
    expect(exports[1]).toMatchObject({ status: 'succeeded', row_count: 128 });
  });

  it('is 403 for a reviewer: the history is analyst-and-above, like the rows (security §7.1)', async () => {
    const h = createHarness();
    h.as({ userId: h.ids.reviewerA, activeOrgId: h.ids.orgA });
    const response = await getExports(
      req(`/api/v1/versions/${h.ids.draftA}/exports`),
      params({ id: h.ids.draftA }),
    );
    expect(response.status).toBe(403);
  });

  it("is not_found for another org's version", async () => {
    const h = createHarness();
    h.as({ userId: h.ids.ownerA, activeOrgId: h.ids.orgA });
    const response = await getExports(
      req(`/api/v1/versions/${h.ids.draftB}/exports`),
      params({ id: h.ids.draftB }),
    );
    expect(response.status).toBe(404);
  });
});
