/**
 * `GET /api/v1/jobs/:id` — the shape the `JobStatus` component reads.
 */

import { describe, expect, it } from 'vitest';
import { GET as getJob } from '@/app/api/v1/jobs/[id]/route';
import { createHarness, params, readJson, req } from '@/test/harness';

describe('GET /api/v1/jobs/:id', () => {
  it('passes the worker progress keys through verbatim', async () => {
    const h = createHarness();
    h.as({ userId: h.ids.programmerA, activeOrgId: h.ids.orgA });
    const response = await readJson(await getJob(req('/x'), params({ id: h.ids.jobA })));
    expect(response.status).toBe(200);
    // `{step, total, message, updated_at}` — apps/worker's JobProgress, unrenamed. A component
    // that renders "step 4 of 7" depends on these exact keys.
    expect(response.body['progress']).toEqual({
      step: 4,
      total: 7,
      message: 'compiling theme',
      updated_at: '2026-08-20T10:12:51Z',
    });
    // Non-terminal jobs carry API §4's polling hint.
    expect(response.headers.get('Retry-After')).toBe('2');
  });

  it('omits Retry-After once the job is terminal', async () => {
    const h = createHarness();
    h.data.seedJob({ id: 'job_done', org_id: h.ids.orgA, kind: 'export', status: 'succeeded', finished_at: 'now' });
    h.as({ userId: h.ids.programmerA, activeOrgId: h.ids.orgA });
    const response = await getJob(req('/x'), params({ id: 'job_done' }));
    expect(response.headers.get('Retry-After')).toBeNull();
  });

  it("is not_found for another org's job", async () => {
    const h = createHarness();
    h.data.seedJob({ id: 'job_orgb', org_id: h.ids.orgB, kind: 'compile' });
    h.as({ userId: h.ids.programmerA, activeOrgId: h.ids.orgA });
    const response = await getJob(req('/x'), params({ id: 'job_orgb' }));
    expect(response.status).toBe(404);
  });
});
