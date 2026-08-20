/**
 * Invitations, and the acceptance criterion that an `owner` cannot be created by invitation.
 *
 * That one is tested at BOTH levels the design places it: the route refuses it with a
 * field-level message, and the store refuses it with the constraint's own name
 * (`invitations_role_not_owner` / `members_insert`) even when the route is bypassed. Two
 * independent guards, because takeover-by-invite is the class of bug that ends an enterprise
 * deal.
 */

import { describe, expect, it } from 'vitest';
import { GET as listInvitations, POST as createInvitation } from '@/app/api/v1/invitations/route';
import { POST as acceptInvitation } from '@/app/api/v1/invitations/accept/route';
import { hashInvitationToken } from '@/server/invitation-token';
import { StoreConstraintError } from '@/server/repo/memory';
import { createHarness, readJson, req } from '@/test/harness';

const NEWCOMER = '88888888-8888-8888-8888-888888888888';

describe('POST /api/v1/invitations', () => {
  it('issues an invitation, returns the token once, and stores only its hash', async () => {
    const h = createHarness();
    h.as({ userId: h.ids.ownerA, activeOrgId: h.ids.orgA });
    const response = await readJson(
      await createInvitation(
        req('/api/v1/invitations', { method: 'POST', body: { email: 'new@a.test', role: 'analyst' } }),
      ),
    );
    expect(response.status).toBe(201);
    const token = response.body['token'] as string;
    expect(token.length).toBeGreaterThan(20);
    expect(response.body['token_shown_once']).toBe(true);

    const stored = h.data.invitations.find((i) => i.email === 'new@a.test');
    expect(stored?.token_hash).toBe(hashInvitationToken(token));
    // The plaintext is nowhere in the row.
    expect(JSON.stringify(stored)).not.toContain(token);
  });

  it('REFUSES role=owner at the route with a field-level message', async () => {
    const h = createHarness();
    h.as({ userId: h.ids.ownerA, activeOrgId: h.ids.orgA });
    const response = await readJson(
      await createInvitation(
        req('/api/v1/invitations', { method: 'POST', body: { email: 'takeover@a.test', role: 'owner' } }),
      ),
    );
    expect(response.status).toBe(422);
    const error = response.body['error'] as { code: string; details: { path: string; code: string }[] };
    expect(error.code).toBe('validation_failed');
    expect(error.details[0]).toMatchObject({ path: 'role', code: 'role_not_invitable' });
    expect(h.data.invitations.some((i) => i.role === 'owner')).toBe(false);
  });

  it('REFUSES role=owner at the store too, by the constraint name', async () => {
    const h = createHarness();
    const repos = h.reposFor({ userId: h.ids.ownerA, activeOrgId: h.ids.orgA });
    // Bypassing the route entirely — this is what `invitations_role_not_owner` is for.
    await expect(
      repos.invitations.create({
        email: 'takeover2@a.test',
        role: 'owner',
        token_hash: 'x'.repeat(64),
        expires_at: new Date(h.nowMs + 1000).toISOString(),
      }),
    ).rejects.toThrowError(
      expect.objectContaining({ constraint: 'invitations_role_not_owner' }) as unknown as Error,
    );
  });

  it('REFUSES an owner membership insert, so even a forged invitation row cannot escalate', async () => {
    const h = createHarness();
    const repos = h.reposFor({ userId: h.ids.ownerA, activeOrgId: h.ids.orgA });
    await expect(
      repos.members.insert({
        org_id: h.ids.orgA,
        user_id: NEWCOMER,
        role: 'owner',
        project_ids: [],
        invited_by: h.ids.ownerA,
      }),
    ).rejects.toBeInstanceOf(StoreConstraintError);
  });

  it('is idempotent under a repeated Idempotency-Key: one invitation, one token', async () => {
    const h = createHarness();
    h.as({ userId: h.ids.ownerA, activeOrgId: h.ids.orgA });
    const spec = {
      method: 'POST',
      body: { email: 'once@a.test', role: 'reviewer' },
      headers: { 'Idempotency-Key': 'invite-key-1' },
    } as const;
    const first = await readJson(await createInvitation(req('/api/v1/invitations', spec)));
    const second = await readJson(await createInvitation(req('/api/v1/invitations', spec)));
    expect(first.body['id']).toBe(second.body['id']);
    // The same token comes back rather than a second live credential for one mailbox.
    expect(first.body['token']).toBe(second.body['token']);
    expect(h.data.invitations.filter((i) => i.email === 'once@a.test')).toHaveLength(1);
  });

  it('requires admin', async () => {
    const h = createHarness();
    h.as({ userId: h.ids.programmerA, activeOrgId: h.ids.orgA });
    const response = await createInvitation(
      req('/api/v1/invitations', { method: 'POST', body: { email: 'x@a.test', role: 'viewer' } }),
    );
    expect(response.status).toBe(403);
  });

  it('lists only the active org invitations', async () => {
    const h = createHarness();
    h.as({ userId: h.ids.ownerA, activeOrgId: h.ids.orgA });
    await createInvitation(req('/api/v1/invitations', { method: 'POST', body: { email: 'a@a.test', role: 'viewer' } }));
    h.as({ userId: h.ids.ownerB, activeOrgId: h.ids.orgB });
    await createInvitation(req('/api/v1/invitations', { method: 'POST', body: { email: 'b@b.test', role: 'viewer' } }));

    h.as({ userId: h.ids.ownerA, activeOrgId: h.ids.orgA });
    const response = await readJson(await listInvitations(req('/api/v1/invitations')));
    const emails = (response.body['data'] as { email: string }[]).map((i) => i.email);
    expect(emails).toEqual(['a@a.test']);
  });
});

describe('POST /api/v1/invitations/accept', () => {
  async function issue(h: ReturnType<typeof createHarness>, email: string, role: string): Promise<string> {
    h.as({ userId: h.ids.ownerA, activeOrgId: h.ids.orgA });
    const created = await readJson(
      await createInvitation(req('/api/v1/invitations', { method: 'POST', body: { email, role } })),
    );
    return created.body['token'] as string;
  }

  it('joins the invitation org — which is NOT the caller active_org_id', async () => {
    const h = createHarness();
    const token = await issue(h, 'joiner@a.test', 'analyst');

    // The newcomer has no org at all: `active_org_id` is null, which is exactly why this is the
    // one endpoint where the org comes from the (hashed) token.
    h.as({ userId: NEWCOMER, activeOrgId: null, email: 'joiner@a.test' });
    const response = await readJson(
      await acceptInvitation(req('/api/v1/invitations/accept', { method: 'POST', body: { token } })),
    );
    expect(response.status).toBe(200);
    expect(response.body['org_id']).toBe(h.ids.orgA);
    expect(response.body['role']).toBe('analyst');
    expect(h.data.members.some((m) => m.user_id === NEWCOMER && m.org_id === h.ids.orgA)).toBe(true);
    // Accepting re-mints the token, so the new membership is immediately usable.
    expect(h.mints).toContainEqual({ userId: NEWCOMER, orgId: h.ids.orgA, role: 'analyst' });
    expect(h.data.invitations.find((i) => i.email === 'joiner@a.test')?.status).toBe('accepted');
  });

  it('a used token cannot be replayed', async () => {
    const h = createHarness();
    const token = await issue(h, 'once2@a.test', 'viewer');
    h.as({ userId: NEWCOMER, activeOrgId: null, email: 'once2@a.test' });
    await acceptInvitation(req('/api/v1/invitations/accept', { method: 'POST', body: { token } }));
    const replay = await readJson(
      await acceptInvitation(req('/api/v1/invitations/accept', { method: 'POST', body: { token } })),
    );
    expect(replay.status).toBe(404);
  });

  it('an expired token is not_found — never a distinguishable "expired"', async () => {
    const h = createHarness();
    const token = await issue(h, 'late@a.test', 'viewer');
    h.nowMs += 73 * 60 * 60 * 1000; // past the 72 h TTL
    h.as({ userId: NEWCOMER, activeOrgId: null, email: 'late@a.test' });
    const response = await readJson(
      await acceptInvitation(req('/api/v1/invitations/accept', { method: 'POST', body: { token } })),
    );
    expect(response.status).toBe(404);
    expect((response.body['error'] as { code: string }).code).toBe('not_found');
  });

  it('a token held by the wrong addressee is refused', async () => {
    const h = createHarness();
    const token = await issue(h, 'intended@a.test', 'analyst');
    h.as({ userId: NEWCOMER, activeOrgId: null, email: 'someone.else@a.test' });
    const response = await readJson(
      await acceptInvitation(req('/api/v1/invitations/accept', { method: 'POST', body: { token } })),
    );
    expect(response.status).toBe(404);
    expect(h.data.members.some((m) => m.user_id === NEWCOMER)).toBe(false);
  });

  it('an unknown token is refused without revealing anything', async () => {
    const h = createHarness();
    h.as({ userId: NEWCOMER, activeOrgId: null, email: 'nobody@a.test' });
    const response = await readJson(
      await acceptInvitation(
        req('/api/v1/invitations/accept', { method: 'POST', body: { token: 'x'.repeat(43) } }),
      ),
    );
    expect(response.status).toBe(404);
  });
});
