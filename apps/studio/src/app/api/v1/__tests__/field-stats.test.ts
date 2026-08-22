/**
 * The field dashboard's counter (roadmap P1-12, migration 0013).
 *
 * The centre of this suite is ONE sentence, P1-11's acceptance: a test session "is excluded
 * from the default response count shown in studio". Every count below is asserted on both
 * axes — the derived totals AND the grouped row — so a filter that dropped the wrong axis
 * cannot pass. The SQL half of the same contract is 0013's pgTAP; this half proves the route
 * derives `entries`/`completes`/`screenouts` from the same grouping it returns.
 *
 * Assertions are on status codes, envelope CODES and numbers. Never on message prose.
 */

import { describe, expect, it } from 'vitest';
import { GET as getFieldStats } from '@/app/api/v1/versions/[id]/field-stats/route';
import { createHarness, params, readJson, req, type Harness } from '@/test/harness';

function envelopeCode(body: Record<string, unknown>): string {
  return (body['error'] as { code: string }).code;
}

/** Five sessions: 2 COMPLETE (one a TEST session), a SCREENOUT, a QUOTA_FULL, one in flight. */
function seedSessions(h: Harness): void {
  const base = { versionId: h.ids.draftA, orgId: h.ids.orgA };
  h.data.seedSession({ ...base, disposition: 'COMPLETE' });
  h.data.seedSession({ ...base, disposition: 'COMPLETE', isTest: true });
  h.data.seedSession({ ...base, disposition: 'SCREENOUT' });
  h.data.seedSession({ ...base, disposition: 'QUOTA_FULL' });
  h.data.seedSession({ ...base, disposition: null });
}

async function stats(h: Harness, query = ''): Promise<{ status: number; body: Record<string, unknown> }> {
  return readJson(
    await getFieldStats(
      req(`/api/v1/versions/${h.ids.draftA}/field-stats${query}`),
      params({ id: h.ids.draftA }),
    ),
  );
}

describe('GET /api/v1/versions/:id/field-stats', () => {
  it('EXCLUDES is_test by default — the P1-11 acceptance line, on totals AND the grouped row', async () => {
    const h = createHarness();
    h.as({ userId: h.ids.ownerA, activeOrgId: h.ids.orgA });
    seedSessions(h);

    const response = await stats(h);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      survey_version_id: h.ids.draftA,
      include_test: false,
      entries: 4,
      completes: 1,
      screenouts: 1,
    });
    // A session with no disposition yet is IN_PROGRESS (K §2's name), never "null".
    expect(response.body['by_disposition']).toEqual({
      COMPLETE: 1,
      IN_PROGRESS: 1,
      QUOTA_FULL: 1,
      SCREENOUT: 1,
    });
  });

  it('includes test sessions only for the literal include_test=true', async () => {
    const h = createHarness();
    h.as({ userId: h.ids.ownerA, activeOrgId: h.ids.orgA });
    seedSessions(h);

    const on = await stats(h, '?include_test=true');
    expect(on.body).toMatchObject({ include_test: true, entries: 5, completes: 2 });

    // Anything that is not the literal string 'true' means the default: excluded. An absent
    // flag and a mistyped one must never silently widen the count.
    for (const query of ['?include_test=false', '?include_test=1', '?include_test=yes']) {
      const off = await stats(h, query);
      expect(off.body).toMatchObject({ include_test: false, entries: 4, completes: 1 });
    }
  });

  it('answers a version with no sessions as zeros, not an error', async () => {
    const h = createHarness();
    h.as({ userId: h.ids.ownerA, activeOrgId: h.ids.orgA });
    const response = await stats(h);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ entries: 0, completes: 0, screenouts: 0 });
    expect(response.body['by_disposition']).toEqual({});
  });

  it('is 403 below the analyst floor: response counts are respondent data in aggregate', async () => {
    const h = createHarness();
    seedSessions(h);
    for (const userId of [h.ids.reviewerA, h.ids.viewerA]) {
      h.as({ userId, activeOrgId: h.ids.orgA });
      const response = await stats(h);
      expect(response.status).toBe(403);
      expect(envelopeCode(response.body)).toBe('forbidden');
    }
  });

  it("is not_found for another org's version — the count is an existence oracle otherwise", async () => {
    const h = createHarness();
    h.as({ userId: h.ids.ownerA, activeOrgId: h.ids.orgA });
    const response = await getFieldStats(
      req(`/api/v1/versions/${h.ids.draftB}/field-stats`),
      params({ id: h.ids.draftB }),
    );
    expect(response.status).toBe(404);
  });
});
