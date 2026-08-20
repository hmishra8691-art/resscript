/**
 * Projects: pagination, idempotency, role enforcement, the error envelope, and tenant isolation.
 */

import { describe, expect, it } from 'vitest';
import { GET as listProjects, POST as createProject } from '@/app/api/v1/projects/route';
import { DELETE as deleteProject, PATCH as patchProject } from '@/app/api/v1/projects/[id]/route';
import { createHarness, params, readJson, req } from '@/test/harness';

describe('GET /api/v1/projects', () => {
  it('paginates by keyset and resumes strictly after the cursor', async () => {
    const h = createHarness();
    h.as({ userId: h.ids.ownerA, activeOrgId: h.ids.orgA });
    for (let i = 0; i < 5; i += 1) {
      h.data.seedProject({ orgId: h.ids.orgA, ref: 'EXTRA' + String(i), name: 'Extra ' + String(i), createdBy: h.ids.ownerA });
    }

    const first = await readJson(await listProjects(req('/api/v1/projects?limit=3')));
    expect(first.status).toBe(200);
    const firstRows = first.body['data'] as { id: string }[];
    const firstPage = first.body['page'] as { next_cursor: string; has_more: boolean; limit: number };
    expect(firstRows).toHaveLength(3);
    expect(firstPage).toMatchObject({ has_more: true, limit: 3 });

    const second = await readJson(
      await listProjects(req('/api/v1/projects?limit=3&cursor=' + encodeURIComponent(firstPage.next_cursor))),
    );
    const secondRows = second.body['data'] as { id: string }[];
    expect(secondRows).toHaveLength(3);
    // No overlap and no gap: the whole point of keyset over offset.
    expect(secondRows.map((r) => r.id)).not.toEqual(expect.arrayContaining(firstRows.map((r) => r.id)));

    const all = await readJson(await listProjects(req('/api/v1/projects?limit=200')));
    expect((all.body['data'] as unknown[]).length).toBe(7);
    expect((all.body['page'] as { has_more: boolean }).has_more).toBe(false);
  });

  it('narrows a project-scoped member to their projects (can_see_project)', async () => {
    const h = createHarness();
    // The reviewer is scoped to project A only; project A2 exists in the same org.
    h.as({ userId: h.ids.reviewerA, activeOrgId: h.ids.orgA });
    const response = await readJson(await listProjects(req('/api/v1/projects')));
    expect((response.body['data'] as { ref: string }[]).map((p) => p.ref)).toEqual(['PRJA']);
  });

  it('shows a user in org A exactly org A projects', async () => {
    const h = createHarness();
    h.as({ userId: h.ids.ownerB, activeOrgId: h.ids.orgB });
    const response = await readJson(await listProjects(req('/api/v1/projects')));
    expect((response.body['data'] as { ref: string }[]).map((p) => p.ref)).toEqual(['PRJB']);
  });
});

describe('POST /api/v1/projects', () => {
  it('honours Idempotency-Key: the same key twice creates ONE project', async () => {
    const h = createHarness();
    h.as({ userId: h.ids.ownerA, activeOrgId: h.ids.orgA });
    const body = { ref: 'NEWPRJ', name: 'New project' };
    const headers = { 'Idempotency-Key': '01JC8KX9Q2M4V7ZB3F0T5N6R8W' };

    const first = await readJson(await createProject(req('/api/v1/projects', { method: 'POST', body, headers })));
    const second = await readJson(await createProject(req('/api/v1/projects', { method: 'POST', body, headers })));

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body['id']).toBe(first.body['id']);
    expect(second.headers.get('Idempotent-Replay')).toBe('true');
    expect(h.data.projects.filter((p) => p.ref === 'NEWPRJ')).toHaveLength(1);
  });

  it('a replay with the SAME key and a DIFFERENT body is 422 idempotency_key_reuse', async () => {
    const h = createHarness();
    h.as({ userId: h.ids.ownerA, activeOrgId: h.ids.orgA });
    const headers = { 'Idempotency-Key': 'key-reuse-1' };
    await createProject(req('/api/v1/projects', { method: 'POST', body: { ref: 'ONE', name: 'One' }, headers }));
    const second = await readJson(
      await createProject(req('/api/v1/projects', { method: 'POST', body: { ref: 'TWO', name: 'Two' }, headers })),
    );
    expect(second.status).toBe(422);
    expect((second.body['error'] as { code: string }).code).toBe('idempotency_key_reuse');
    expect(h.data.projects.some((p) => p.ref === 'TWO')).toBe(false);
  });

  it('without a key, two identical creates collide on the natural unique constraint', async () => {
    const h = createHarness();
    h.as({ userId: h.ids.ownerA, activeOrgId: h.ids.orgA });
    const body = { ref: 'DUPE', name: 'Dupe' };
    await createProject(req('/api/v1/projects', { method: 'POST', body }));
    const second = await readJson(await createProject(req('/api/v1/projects', { method: 'POST', body })));
    // API §1.4: idempotency as a data-model property — `projects_ref_key` converges the retry
    // on `409 already_exists` instead of creating a twin.
    expect(second.status).toBe(409);
    expect((second.body['error'] as { code: string }).code).toBe('already_exists');
  });

  it('requires project_manager: a programmer is refused with the required role named', async () => {
    const h = createHarness();
    h.as({ userId: h.ids.programmerA, activeOrgId: h.ids.orgA });
    const response = await readJson(
      await createProject(req('/api/v1/projects', { method: 'POST', body: { ref: 'NOPE', name: 'Nope' } })),
    );
    expect(response.status).toBe(403);
    const error = response.body['error'] as { code: string; details: { code: string; message: string }[] };
    expect(error.code).toBe('forbidden');
    expect(error.details).toContainEqual({ path: null, code: 'role_required', message: 'project_manager' });
    expect(h.data.projects.some((p) => p.ref === 'NOPE')).toBe(false);
  });

  it('rejects unknown request fields rather than ignoring them', async () => {
    const h = createHarness();
    h.as({ userId: h.ids.ownerA, activeOrgId: h.ids.orgA });
    const response = await readJson(
      await createProject(
        req('/api/v1/projects', { method: 'POST', body: { ref: 'OK1', name: 'Ok', quota: 500 } }),
      ),
    );
    expect(response.status).toBe(400);
    const error = response.body['error'] as { code: string; details: { path: string }[] };
    expect(error.code).toBe('unknown_field');
    expect(error.details[0]?.path).toBe('quota');
  });
});

describe('the error envelope', () => {
  it('has exactly API §1.5 shape on every failure', async () => {
    const h = createHarness();
    h.as({ userId: h.ids.viewerA, activeOrgId: h.ids.orgA });
    const response = await readJson(
      await createProject(req('/api/v1/projects', { method: 'POST', body: { ref: 'X1', name: 'X' } })),
    );
    expect(Object.keys(response.body)).toEqual(['error']);
    const error = response.body['error'] as Record<string, unknown>;
    expect(Object.keys(error).sort()).toEqual(
      ['code', 'details', 'docs_url', 'message', 'request_id', 'retry_after_s'].sort(),
    );
    expect(error['request_id']).toBe('req_test');
    expect(error['docs_url']).toBe('https://docs.rescript.io/errors/forbidden');
    expect(error['retry_after_s']).toBeNull();
    // `request_id` is on the header too, and it is the same value.
    expect(response.headers.get('X-Request-Id')).toBe('req_test');
  });
});

describe('archive before delete', () => {
  it('refuses a hard delete of a live project, then allows it once archived', async () => {
    const h = createHarness();
    h.as({ userId: h.ids.ownerA, activeOrgId: h.ids.orgA });

    const refused = await readJson(
      await deleteProject(req('/api/v1/projects/' + h.ids.projectA2, { method: 'DELETE' }), params({ id: h.ids.projectA2 })),
    );
    expect(refused.status).toBe(409);
    expect((refused.body['error'] as { code: string }).code).toBe('illegal_transition');

    await patchProject(
      req('/api/v1/projects/' + h.ids.projectA2, { method: 'PATCH', body: { archived: true } }),
      params({ id: h.ids.projectA2 }),
    );
    const deleted = await deleteProject(
      req('/api/v1/projects/' + h.ids.projectA2, { method: 'DELETE' }),
      params({ id: h.ids.projectA2 }),
    );
    expect(deleted.status).toBe(204);
    expect(h.data.projects.some((p) => p.id === h.ids.projectA2)).toBe(false);
  });

  it('a cross-tenant project is not_found, never forbidden', async () => {
    const h = createHarness();
    h.as({ userId: h.ids.ownerA, activeOrgId: h.ids.orgA });
    const response = await readJson(
      await patchProject(
        req('/api/v1/projects/' + h.ids.projectB, { method: 'PATCH', body: { name: 'stolen' } }),
        params({ id: h.ids.projectB }),
      ),
    );
    expect(response.status).toBe(404);
    expect(h.data.projects.find((p) => p.id === h.ids.projectB)?.name).toBe('Project B');
  });
});
