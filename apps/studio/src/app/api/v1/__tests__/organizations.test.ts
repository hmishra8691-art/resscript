/**
 * Organizations: the switcher list, creation (the only path to `owner`), and the org-switch
 * re-mint.
 */

import { describe, expect, it } from 'vitest';
import { GET as listOrgs, POST as createOrg } from '@/app/api/v1/organizations/route';
import { GET as getOrg, PATCH as patchOrg } from '@/app/api/v1/organizations/[id]/route';
import { POST as switchOrg } from '@/app/api/v1/orgs/[id]/switch/route';
import { createHarness, params, readJson, req } from '@/test/harness';

describe('GET /api/v1/organizations', () => {
  it('lists memberships, naming only the org the token is scoped to', async () => {
    const h = createHarness();
    h.data.seedMember({ orgId: h.ids.orgB, userId: h.ids.ownerA, role: 'analyst' });
    h.as({ userId: h.ids.ownerA, activeOrgId: h.ids.orgA });

    const response = await readJson(await listOrgs(req('/api/v1/organizations')));
    const rows = response.body['data'] as { org_id: string; name: string | null; role: string; is_active: boolean }[];
    expect(rows).toHaveLength(2);
    const active = rows.find((r) => r.is_active);
    const other = rows.find((r) => !r.is_active);
    expect(active).toMatchObject({ org_id: h.ids.orgA, name: 'Org A', role: 'owner' });
    // Org B's NAME is not readable while the token is scoped to org A — that is
    // `organizations_select` doing its job, not a missing join.
    expect(other).toMatchObject({ org_id: h.ids.orgB, name: null, role: 'analyst' });
  });
});

describe('POST /api/v1/organizations', () => {
  it('creates the org, makes the caller its owner, and re-mints the token', async () => {
    const h = createHarness();
    h.as({ userId: h.ids.outsider, activeOrgId: null });
    const response = await readJson(
      await createOrg(req('/api/v1/organizations', { method: 'POST', body: { slug: 'org-c', name: 'Org C' } })),
    );
    expect(response.status).toBe(201);
    const orgId = response.body['id'] as string;
    expect(h.data.members.find((m) => m.org_id === orgId)?.role).toBe('owner');
    expect(h.mints).toContainEqual({ userId: h.ids.outsider, orgId, role: 'owner' });
    expect(response.body['token_refresh_required']).toBe(true);
  });

  it('rejects a taken slug with already_exists on the slug field', async () => {
    const h = createHarness();
    h.as({ userId: h.ids.outsider, activeOrgId: null });
    const response = await readJson(
      await createOrg(req('/api/v1/organizations', { method: 'POST', body: { slug: 'org-a', name: 'Copy' } })),
    );
    expect(response.status).toBe(409);
    const error = response.body['error'] as { code: string; details: { path: string }[] };
    expect(error.code).toBe('already_exists');
    expect(error.details[0]?.path).toBe('slug');
  });

  it('rejects a malformed slug before it reaches the CHECK', async () => {
    const h = createHarness();
    h.as({ userId: h.ids.outsider, activeOrgId: null });
    const response = await readJson(
      await createOrg(req('/api/v1/organizations', { method: 'POST', body: { slug: 'Org C!', name: 'Org C' } })),
    );
    expect(response.status).toBe(422);
    expect((response.body['error'] as { code: string }).code).toBe('validation_failed');
  });
});

describe('GET|PATCH /api/v1/organizations/:id', () => {
  it('reads the active org for any member', async () => {
    const h = createHarness();
    h.as({ userId: h.ids.viewerA, activeOrgId: h.ids.orgA });
    const response = await readJson(await getOrg(req('/x'), params({ id: h.ids.orgA })));
    expect(response.status).toBe(200);
    expect(response.body['slug']).toBe('org-a');
  });

  it('requires admin to update, and audits the change', async () => {
    const h = createHarness();
    h.as({ userId: h.ids.programmerA, activeOrgId: h.ids.orgA });
    const refused = await patchOrg(
      req('/x', { method: 'PATCH', body: { name: 'Renamed' } }),
      params({ id: h.ids.orgA }),
    );
    expect(refused.status).toBe(403);

    h.as({ userId: h.ids.ownerA, activeOrgId: h.ids.orgA });
    const allowed = await readJson(
      await patchOrg(req('/x', { method: 'PATCH', body: { name: 'Renamed' } }), params({ id: h.ids.orgA })),
    );
    expect(allowed.status).toBe(200);
    expect(allowed.body['name']).toBe('Renamed');
    expect(h.data.audit.filter((a) => a.action === 'organization.updated')).toHaveLength(1);
  });
});

describe('POST /api/v1/orgs/:id/switch', () => {
  it('re-mints the token for an org the caller is a member of', async () => {
    const h = createHarness();
    h.data.seedMember({ orgId: h.ids.orgB, userId: h.ids.ownerA, role: 'reviewer' });
    h.as({ userId: h.ids.ownerA, activeOrgId: h.ids.orgA });

    const response = await readJson(
      await switchOrg(req('/x', { method: 'POST' }), params({ id: h.ids.orgB })),
    );
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ org_id: h.ids.orgB, role: 'reviewer', token_refresh_required: true });
    expect(h.mints).toContainEqual({ userId: h.ids.ownerA, orgId: h.ids.orgB, role: 'reviewer' });
  });

  it('is 404 for an org the caller does not belong to', async () => {
    const h = createHarness();
    h.as({ userId: h.ids.ownerA, activeOrgId: h.ids.orgA });
    const response = await readJson(await switchOrg(req('/x', { method: 'POST' }), params({ id: h.ids.orgB })));
    expect(response.status).toBe(404);
    expect(h.mints).toHaveLength(0);
  });
});
