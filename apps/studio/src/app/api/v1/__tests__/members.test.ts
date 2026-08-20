/**
 * Member role management, including P1-01's audit acceptance criterion.
 */

import { describe, expect, it } from 'vitest';
import { GET as listMembers } from '@/app/api/v1/organizations/[id]/members/route';
import { DELETE as removeMember, PATCH as patchMember } from '@/app/api/v1/members/[id]/route';
import { POST as createSurvey } from '@/app/api/v1/surveys/route';
import { createHarness, params, readJson, req } from '@/test/harness';

describe('PATCH /api/v1/members/:id', () => {
  it('writes ONE audit row naming actor, target and old/new role', async () => {
    const h = createHarness();
    h.as({ userId: h.ids.ownerA, activeOrgId: h.ids.orgA });

    const response = await readJson(
      await patchMember(
        req('/api/v1/members/' + h.ids.programmerA, { method: 'PATCH', body: { role: 'viewer' } }),
        params({ id: h.ids.programmerA }),
      ),
    );
    expect(response.status).toBe(200);
    expect(response.body['role']).toBe('viewer');

    const rows = h.data.audit.filter((a) => a.action === 'member.role_changed');
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row?.actor_user_id).toBe(h.ids.ownerA);
    expect(row?.target_id).toBe(h.ids.programmerA);
    expect(row?.org_id).toBe(h.ids.orgA);
    expect(row?.request_id).toBe('req_test');
    expect(row?.diff).toMatchObject({ role: { from: 'programmer', to: 'viewer' } });
  });

  it('the demoted member next save fails with a permission error', async () => {
    const h = createHarness();

    // Before: the programmer can create a survey.
    h.as({ userId: h.ids.programmerA, activeOrgId: h.ids.orgA });
    const allowed = await createSurvey(
      req('/api/v1/surveys', {
        method: 'POST',
        body: { project_id: h.ids.projectA, ref: 'BEFORE', name: 'Before' },
      }),
    );
    expect(allowed.status).toBe(201);

    // The owner demotes them.
    h.as({ userId: h.ids.ownerA, activeOrgId: h.ids.orgA });
    await patchMember(
      req('/api/v1/members/' + h.ids.programmerA, { method: 'PATCH', body: { role: 'viewer' } }),
      params({ id: h.ids.programmerA }),
    );

    // After: the same call fails. The token is unchanged — the role is read from the membership
    // row, exactly as `app.has_role()` reads it, so a demotion takes effect on the next request
    // rather than at token expiry.
    h.as({ userId: h.ids.programmerA, activeOrgId: h.ids.orgA });
    const refused = await readJson(
      await createSurvey(
        req('/api/v1/surveys', {
          method: 'POST',
          body: { project_id: h.ids.projectA, ref: 'AFTER', name: 'After' },
        }),
      ),
    );
    expect(refused.status).toBe(403);
    expect((refused.body['error'] as { code: string }).code).toBe('forbidden');
    expect(h.data.surveys.some((s) => s.ref === 'AFTER')).toBe(false);
  });

  it('cannot promote anyone to owner', async () => {
    const h = createHarness();
    h.as({ userId: h.ids.ownerA, activeOrgId: h.ids.orgA });
    const response = await readJson(
      await patchMember(
        req('/api/v1/members/' + h.ids.programmerA, { method: 'PATCH', body: { role: 'owner' } }),
        params({ id: h.ids.programmerA }),
      ),
    );
    expect(response.status).toBe(422);
    const error = response.body['error'] as { code: string; details: { code: string }[] };
    expect(error.code).toBe('validation_failed');
    expect(error.details[0]?.code).toBe('role_not_assignable');
    expect(h.data.members.find((m) => m.user_id === h.ids.programmerA)?.role).toBe('programmer');
  });

  it('cannot demote an owner', async () => {
    const h = createHarness();
    h.as({ userId: h.ids.ownerA, activeOrgId: h.ids.orgA });
    const response = await readJson(
      await patchMember(
        req('/api/v1/members/' + h.ids.ownerA, { method: 'PATCH', body: { role: 'admin' } }),
        params({ id: h.ids.ownerA }),
      ),
    );
    expect(response.status).toBe(403);
    expect(h.data.members.find((m) => m.user_id === h.ids.ownerA)?.role).toBe('owner');
  });

  it('requires admin', async () => {
    const h = createHarness();
    h.as({ userId: h.ids.programmerA, activeOrgId: h.ids.orgA });
    const response = await readJson(
      await patchMember(
        req('/api/v1/members/' + h.ids.viewerA, { method: 'PATCH', body: { role: 'analyst' } }),
        params({ id: h.ids.viewerA }),
      ),
    );
    expect(response.status).toBe(403);
    expect(h.data.audit.filter((a) => a.action === 'member.role_changed')).toHaveLength(0);
  });

  it('a member of another org is not_found, not forbidden', async () => {
    const h = createHarness();
    h.as({ userId: h.ids.ownerA, activeOrgId: h.ids.orgA });
    const response = await readJson(
      await patchMember(
        req('/api/v1/members/' + h.ids.ownerB, { method: 'PATCH', body: { role: 'viewer' } }),
        params({ id: h.ids.ownerB }),
      ),
    );
    expect(response.status).toBe(404);
  });
});

describe('DELETE /api/v1/members/:id', () => {
  it('removes a non-owner and audits it', async () => {
    const h = createHarness();
    h.as({ userId: h.ids.ownerA, activeOrgId: h.ids.orgA });
    const response = await removeMember(
      req('/api/v1/members/' + h.ids.viewerA, { method: 'DELETE' }),
      params({ id: h.ids.viewerA }),
    );
    expect(response.status).toBe(204);
    expect(h.data.members.some((m) => m.user_id === h.ids.viewerA && m.org_id === h.ids.orgA)).toBe(false);
    expect(h.data.audit.filter((a) => a.action === 'member.removed')).toHaveLength(1);
  });

  it('refuses to remove the last owner', async () => {
    const h = createHarness();
    h.as({ userId: h.ids.ownerA, activeOrgId: h.ids.orgA });
    const response = await readJson(
      await removeMember(req('/api/v1/members/' + h.ids.ownerA, { method: 'DELETE' }), params({ id: h.ids.ownerA })),
    );
    expect(response.status).toBe(403);
    expect(h.data.members.some((m) => m.user_id === h.ids.ownerA)).toBe(true);
  });
});

describe('GET /api/v1/organizations/:id/members', () => {
  it('is admin-only, matching members_select', async () => {
    const h = createHarness();
    h.as({ userId: h.ids.programmerA, activeOrgId: h.ids.orgA });
    const refused = await listMembers(req('/api/v1/organizations/' + h.ids.orgA + '/members'), params({ id: h.ids.orgA }));
    expect(refused.status).toBe(403);

    h.as({ userId: h.ids.ownerA, activeOrgId: h.ids.orgA });
    const allowed = await readJson(
      await listMembers(req('/api/v1/organizations/' + h.ids.orgA + '/members'), params({ id: h.ids.orgA })),
    );
    expect(allowed.status).toBe(200);
    const rows = allowed.body['data'] as { user_id: string; role: string }[];
    expect(rows.map((r) => r.role).sort()).toEqual(['owner', 'programmer', 'reviewer', 'viewer']);
    // Org B's owner is never in org A's member list.
    expect(rows.some((r) => r.user_id === h.ids.ownerB)).toBe(false);
  });
});
