/**
 * Optimistic concurrency on `survey_versions.revision` (API §1.7).
 */

import { describe, expect, it } from 'vitest';
import { GET as getVersion, PATCH as patchVersion } from '@/app/api/v1/versions/[id]/route';
import { GET as listVersions, POST as createVersion } from '@/app/api/v1/surveys/[id]/versions/route';
import { parseEtag } from '@/server/http/etag';
import { createHarness, params, readJson, req } from '@/test/harness';

describe('GET /api/v1/versions/:id', () => {
  it('issues a weak ETag carrying revision AND a timestamp', async () => {
    const h = createHarness();
    h.as({ userId: h.ids.programmerA, activeOrgId: h.ids.orgA });
    const response = await getVersion(req('/api/v1/versions/' + h.ids.draftA), params({ id: h.ids.draftA }));
    const etag = response.headers.get('etag');
    expect(etag).toBe('W/"1.' + String(h.nowMs) + '"');
    // The timestamp is what gives `changed_since` a range to query; the revision alone gives none.
    expect(parseEtag(etag as string)).toEqual({ revision: 1, issuedAtMs: h.nowMs });
  });

  it("is not_found for another org's version", async () => {
    const h = createHarness();
    h.as({ userId: h.ids.programmerA, activeOrgId: h.ids.orgA });
    const response = await getVersion(req('/api/v1/versions/' + h.ids.draftB), params({ id: h.ids.draftB }));
    expect(response.status).toBe(404);
  });
});

describe('PATCH /api/v1/versions/:id', () => {
  it('is 428 precondition_required without If-Match', async () => {
    const h = createHarness();
    h.as({ userId: h.ids.programmerA, activeOrgId: h.ids.orgA });
    const response = await readJson(
      await patchVersion(
        req('/api/v1/versions/' + h.ids.draftA, { method: 'PATCH', body: { notes: 'no lock' } }),
        params({ id: h.ids.draftA }),
      ),
    );
    expect(response.status).toBe(428);
    expect((response.body['error'] as { code: string }).code).toBe('precondition_required');
    expect(h.data.versions.find((v) => v.id === h.ids.draftA)?.notes).toBeNull();
  });

  it('succeeds with a matching If-Match and BUMPS the revision', async () => {
    const h = createHarness();
    h.as({ userId: h.ids.programmerA, activeOrgId: h.ids.orgA });
    const response = await readJson(
      await patchVersion(
        req('/api/v1/versions/' + h.ids.draftA, {
          method: 'PATCH',
          body: { notes: 'screener rewritten' },
          headers: { 'If-Match': 'W/"1.' + String(h.nowMs) + '"' },
        }),
        params({ id: h.ids.draftA }),
      ),
    );
    expect(response.status).toBe(200);
    expect(response.body['revision']).toBe(2);
    expect(response.body['notes']).toBe('screener rewritten');
    expect(response.headers.get('etag')).toBe('W/"2.' + String(h.nowMs) + '"');
  });

  it('is 412 revision_conflict on a stale If-Match, with what the client needs to recover', async () => {
    const h = createHarness();
    h.as({ userId: h.ids.programmerA, activeOrgId: h.ids.orgA });
    const staleEtag = 'W/"1.' + String(h.nowMs) + '"';

    // A colleague saves first.
    await patchVersion(
      req('/api/v1/versions/' + h.ids.draftA, {
        method: 'PATCH',
        body: { notes: 'theirs' },
        headers: { 'If-Match': staleEtag },
      }),
      params({ id: h.ids.draftA }),
    );

    h.nowMs += 1000;
    const conflict = await readJson(
      await patchVersion(
        req('/api/v1/versions/' + h.ids.draftA, {
          method: 'PATCH',
          body: { notes: 'mine' },
          headers: { 'If-Match': staleEtag },
        }),
        params({ id: h.ids.draftA }),
      ),
    );
    expect(conflict.status).toBe(412);
    const error = conflict.body['error'] as {
      code: string;
      current_revision: number;
      changed_since: { action: string; actor: string }[];
    };
    expect(error.code).toBe('revision_conflict');
    expect(error.current_revision).toBe(2);
    // `changed_since` is what makes UI §5.3's auto-retry possible: the studio compares it
    // against its own touched-node set and only surfaces a true conflict.
    expect(error.changed_since.map((c) => c.action)).toContain('version.updated');
    // The losing write did NOT land.
    expect(h.data.versions.find((v) => v.id === h.ids.draftA)?.notes).toBe('theirs');
  });

  it('rejects an If-Match this API did not issue', async () => {
    const h = createHarness();
    h.as({ userId: h.ids.programmerA, activeOrgId: h.ids.orgA });
    const response = await readJson(
      await patchVersion(
        req('/api/v1/versions/' + h.ids.draftA, {
          method: 'PATCH',
          body: { notes: 'x' },
          headers: { 'If-Match': '"42"' },
        }),
        params({ id: h.ids.draftA }),
      ),
    );
    expect(response.status).toBe(400);
    expect((response.body['error'] as { code: string }).code).toBe('malformed_request');
  });

  it('is 409 frozen_version on a non-draft, checked BEFORE the lock', async () => {
    const h = createHarness();
    h.as({ userId: h.ids.programmerA, activeOrgId: h.ids.orgA });
    const index = h.data.versions.findIndex((v) => v.id === h.ids.draftA);
    const current = h.data.versions[index];
    if (current === undefined) throw new Error('fixture missing');
    h.data.versions[index] = { ...current, status: 'review', frozen_at: new Date(h.nowMs).toISOString() };

    const response = await readJson(
      await patchVersion(
        // No If-Match at all: the frozen answer must win, because "clone a new draft to edit" is
        // the actionable message and the revision is irrelevant to it.
        req('/api/v1/versions/' + h.ids.draftA, { method: 'PATCH', body: { notes: 'x' } }),
        params({ id: h.ids.draftA }),
      ),
    );
    expect(response.status).toBe(409);
    expect((response.body['error'] as { code: string }).code).toBe('frozen_version');
  });

  it('requires programmer', async () => {
    const h = createHarness();
    h.as({ userId: h.ids.reviewerA, activeOrgId: h.ids.orgA });
    const response = await patchVersion(
      req('/api/v1/versions/' + h.ids.draftA, {
        method: 'PATCH',
        body: { notes: 'x' },
        headers: { 'If-Match': 'W/"1.1"' },
      }),
      params({ id: h.ids.draftA }),
    );
    expect(response.status).toBe(403);
  });
});

describe('POST /api/v1/surveys/:id/versions', () => {
  it('refuses a second draft (sv_one_draft) with 409', async () => {
    const h = createHarness();
    h.as({ userId: h.ids.programmerA, activeOrgId: h.ids.orgA });
    const response = await readJson(
      await createVersion(
        req('/api/v1/surveys/' + h.ids.surveyA + '/versions', { method: 'POST', body: {} }),
        params({ id: h.ids.surveyA }),
      ),
    );
    expect(response.status).toBe(409);
    expect((response.body['error'] as { code: string }).code).toBe('already_exists');
  });

  it('lists a survey versions with both K §3 axes', async () => {
    const h = createHarness();
    h.as({ userId: h.ids.reviewerA, activeOrgId: h.ids.orgA });
    const response = await readJson(
      await listVersions(req('/api/v1/surveys/' + h.ids.surveyA + '/versions'), params({ id: h.ids.surveyA })),
    );
    const rows = response.body['data'] as { status: string; compile_state: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'draft', compile_state: 'none' });
  });
});
