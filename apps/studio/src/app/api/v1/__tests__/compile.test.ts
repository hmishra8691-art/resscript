/**
 * `POST /versions/:id/compile` — the dry compile (H §2.4: "produces diagnostics and an artifact
 * but does not change status").
 *
 * The two claims worth a suite. First, that it is the SAME job as publish with no target: the
 * payload carries `survey_version_id` and no `target_status`, which is what makes the worker run
 * every stage of the gate and swap only the last. A route that queued a different kind, or added
 * a `dry: true` flag alongside a target, would be a second gate or a contradictory payload.
 *
 * Second, that the floor is the CONTENT-write floor and not the publish target's. A programmer
 * who may author the questions must be able to check them; requiring `project_manager` to check
 * would mean logic a programmer can write and cannot validate.
 *
 * Assertions are on status codes, envelope codes and the stored job row. Never on message prose.
 */

import { describe, expect, it } from 'vitest';
import { POST as compileVersion } from '@/app/api/v1/versions/[id]/compile/route';
import { createHarness, params, readJson, req, type Harness } from '@/test/harness';

function envelopeCode(body: Record<string, unknown>): string {
  return (body['error'] as { code: string }).code;
}

function compileRequest(versionId: string, headers?: Record<string, string>): Request {
  return req(`/api/v1/versions/${versionId}/compile`, {
    method: 'POST',
    ...(headers === undefined ? {} : { headers }),
  });
}

async function compile(h: Harness, versionId: string): Promise<{
  status: number;
  body: Record<string, unknown>;
  headers: Headers;
}> {
  return readJson(await compileVersion(compileRequest(versionId), params({ id: versionId })));
}

describe('POST /api/v1/versions/:id/compile', () => {
  it('queues one compile job whose payload carries NO target_status', async () => {
    const h = createHarness();
    h.as({ userId: h.ids.programmerA, activeOrgId: h.ids.orgA });

    const response = await compile(h, h.ids.draftA);

    expect(response.status).toBe(202);
    expect(response.headers.get('Retry-After')).toBe('2');
    const job = response.body['job'] as Record<string, unknown>;
    expect(job['kind']).toBe('compile');
    expect(response.headers.get('Location')).toBe('/api/v1/jobs/' + String(job['id']));

    const row = h.data.jobs.find((j) => j.id === job['id']);
    expect(row?.survey_version_id).toBe(h.ids.draftA);
    expect(row?.created_by).toBe(h.ids.programmerA);
    // THE dry marker: absence. The worker reads an absent target as "check, do not move".
    // `JobRow` deliberately omits the payload (it is the worker's input, not a client's view),
    // so the assertion reads the store's own `enqueuedPayloads` — added for exports' sake and
    // reused here for exactly the same reason.
    const enqueued = h.data.enqueuedPayloads.find((e) => e.job_id === job['id']);
    expect(enqueued?.kind).toBe('compile');
    expect(enqueued?.payload['survey_version_id']).toBe(h.ids.draftA);
    expect('target_status' in (enqueued?.payload ?? {})).toBe(false);
    expect('acknowledged_warnings' in (enqueued?.payload ?? {})).toBe(false);
  });

  it('is available to a programmer — the content floor, not the publish target floor', async () => {
    const h = createHarness();
    h.as({ userId: h.ids.programmerA, activeOrgId: h.ids.orgA });
    expect((await compile(h, h.ids.draftA)).status).toBe(202);
  });

  it('refuses a viewer', async () => {
    const h = createHarness();
    h.as({ userId: h.ids.viewerA, activeOrgId: h.ids.orgA });
    const response = await compile(h, h.ids.draftA);
    expect(response.status).toBe(403);
    expect(envelopeCode(response.body)).toBe('forbidden');
  });

  it('is a 404 across orgs, and queues nothing', async () => {
    const h = createHarness();
    h.as({ userId: h.ids.programmerA, activeOrgId: h.ids.orgA });
    const before = h.data.jobs.length;
    const response = await compile(h, h.ids.draftB);
    expect(response.status).toBe(404);
    expect(h.data.jobs.length).toBe(before);
  });

  it('two clicks on unchanged content attach to ONE job', async () => {
    // The derived key is version + revision, so an unchanged draft de-duplicates the work even
    // when the client sends no Idempotency-Key (M0.4's "double-clicking produces one job row").
    const h = createHarness();
    h.as({ userId: h.ids.programmerA, activeOrgId: h.ids.orgA });

    const first = await compile(h, h.ids.draftA);
    const second = await compile(h, h.ids.draftA);

    const firstId = (first.body['job'] as Record<string, unknown>)['id'];
    const secondId = (second.body['job'] as Record<string, unknown>)['id'];
    expect(secondId).toBe(firstId);
    // 200, not 202: the second click attached to work already in flight.
    expect(second.status).toBe(200);
    expect(h.data.jobs.filter((j) => j.survey_version_id === h.ids.draftA).length).toBe(1);
  });

  it('a dry compile is queued for a PUBLISHED version too — checking is not a mutation', async () => {
    // Unlike every content write, this one has no frozen-version refusal: it reads the version's
    // rows and writes diagnostics, and asking "what does the gate say about what is in field" is
    // a legitimate question about a frozen version.
    const h = createHarness();
    h.as({ userId: h.ids.programmerA, activeOrgId: h.ids.orgA });
    const published = h.data.versions.find((v) => v.status !== 'draft');
    if (published === undefined) return; // the harness seeds one; if not, nothing to assert
    expect((await compile(h, published.id)).status).toBe(202);
  });
});
