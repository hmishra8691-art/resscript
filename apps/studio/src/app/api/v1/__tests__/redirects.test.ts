/**
 * The redirect authoring path (API §2.9, migration 0010) — the last write the publish path was
 * missing: `content.redirects` existed, the worker assembled it, the runtime resolved it, and
 * nothing could put rows in it.
 *
 * The centre of this suite is security §12.3's write rule: "every template is validated on
 * write … failures are 422, never stored". Every rejection test therefore asserts TWO things —
 * the 422 with per-row details, and that a subsequent GET still returns the set the PUT tried to
 * replace (or nothing) — because a validator that rejects after a partial write is the bug the
 * rule exists to name.
 *
 * Assertions are on status codes, envelope CODES and stored rows. Never on message prose.
 */

import { describe, expect, it } from 'vitest';
import { GET as getRedirects, PUT as putRedirects } from '@/app/api/v1/versions/[id]/redirects/route';
import { GET as getCoverage } from '@/app/api/v1/versions/[id]/redirects/coverage/route';
import { createHarness, params, readJson, req, type Harness } from '@/test/harness';

function envelopeCode(body: Record<string, unknown>): string {
  return (body['error'] as { code: string }).code;
}

function details(body: Record<string, unknown>): { path: string; code: string }[] {
  return (body['error'] as { details: { path: string; code: string }[] }).details;
}

function putRequest(versionId: string, redirects: unknown[]): Request {
  return req(`/api/v1/versions/${versionId}/redirects`, { method: 'PUT', body: { redirects } });
}

async function storedRows(h: Harness, versionId: string): Promise<Record<string, unknown>[]> {
  const response = await readJson(
    await getRedirects(req(`/api/v1/versions/${versionId}/redirects`), params({ id: versionId })),
  );
  return response.body['redirects'] as Record<string, unknown>[];
}

/* ========================================================================== */
/* PUT then GET — the happy path, and the worker's shape                       */
/* ========================================================================== */

describe('PUT /api/v1/versions/:id/redirects', () => {
  it('stores a whole set that GET then returns, flattened', async () => {
    const h = createHarness();
    h.as({ userId: h.ids.programmerA, activeOrgId: h.ids.orgA });
    const response = await readJson(
      await putRedirects(
        putRequest(h.ids.draftA, [
          { scope: 'default', disposition: 'COMPLETE', url_template: 'https://cb.vendor.test/c?rid={{RID}}' },
          { scope: 'default', disposition: 'SCREENOUT', url_template: 'https://cb.vendor.test/s' },
          {
            scope: 'vendor',
            scope_key: 'v_panel',
            disposition: 'COMPLETE',
            url_template: 'https://panel.example.test/done?sig={{SIG}}',
          },
          {
            scope: 'language',
            scope_key: 'fr',
            disposition: 'CUSTOM',
            custom_key: 'over_quota_fr',
            url_template: 'https://cb.vendor.test/fr/q',
          },
        ]),
        params({ id: h.ids.draftA }),
      ),
    );

    expect(response.status).toBe(200);
    const stored = response.body['redirects'] as Record<string, unknown>[];
    expect(stored).toHaveLength(4);
    // The '' defaults are the TABLE's encoding (0010's biconditional CHECKs), and they must come
    // back materialized: a client that sent two fields reads back the row the worker will read.
    expect(stored).toContainEqual({
      scope: 'default',
      scope_key: '',
      disposition: 'COMPLETE',
      custom_key: '',
      url_template: 'https://cb.vendor.test/c?rid={{RID}}',
    });
    expect(await storedRows(h, h.ids.draftA)).toEqual(stored);
  });

  it('round-trips into exactly the shape the worker assembles from (AuthoringRedirectRow)', async () => {
    const h = createHarness();
    h.as({ userId: h.ids.programmerA, activeOrgId: h.ids.orgA });
    await putRedirects(
      putRequest(h.ids.draftA, [
        { scope: 'default', disposition: 'COMPLETE', url_template: 'https://cb.vendor.test/c' },
        {
          scope: 'vendor',
          scope_key: 'v_panel',
          disposition: 'CUSTOM',
          custom_key: 'special',
          url_template: 'https://cb.vendor.test/x',
        },
      ]),
      params({ id: h.ids.draftA }),
    );

    // `apps/worker`'s `AuthoringRedirectRow` cannot be imported here (app-to-app imports are
    // what `.dependency-cruiser.cjs` forbids — see JobProgressShape's comment in repo/types.ts),
    // so the contract is asserted structurally: five keys, all strings, scope in 0010's enum.
    // `redirectsOf` consumes rows of exactly this shape into `Survey.redirects`.
    for (const row of await storedRows(h, h.ids.draftA)) {
      expect(Object.keys(row).sort()).toEqual([
        'custom_key',
        'disposition',
        'scope',
        'scope_key',
        'url_template',
      ]);
      expect(['default', 'vendor', 'language']).toContain(row['scope']);
      for (const value of Object.values(row)) expect(typeof value).toBe('string');
      // The biconditional encodings the worker's reassembly relies on.
      expect(row['scope'] === 'default').toBe(row['scope_key'] === '');
      expect(row['disposition'] === 'CUSTOM').toBe(row['custom_key'] !== '');
    }
  });

  it('replaces the WHOLE set — PUT semantics, so an empty array is how a row is deleted', async () => {
    const h = createHarness();
    h.as({ userId: h.ids.programmerA, activeOrgId: h.ids.orgA });
    await putRedirects(
      putRequest(h.ids.draftA, [
        { scope: 'default', disposition: 'COMPLETE', url_template: 'https://cb.vendor.test/c' },
      ]),
      params({ id: h.ids.draftA }),
    );
    const response = await readJson(
      await putRedirects(putRequest(h.ids.draftA, []), params({ id: h.ids.draftA })),
    );
    expect(response.status).toBe(200);
    expect(response.body['redirects']).toEqual([]);
    expect(await storedRows(h, h.ids.draftA)).toEqual([]);
  });

  /* ------------------------------------------------------------------------ */
  /* The 422 path: failures name the row, and nothing is stored                */
  /* ------------------------------------------------------------------------ */

  it('rejects an http:// template with 422 and stores NOTHING — not even the valid rows', async () => {
    const h = createHarness();
    h.as({ userId: h.ids.programmerA, activeOrgId: h.ids.orgA });
    const response = await readJson(
      await putRedirects(
        putRequest(h.ids.draftA, [
          { scope: 'default', disposition: 'COMPLETE', url_template: 'https://cb.vendor.test/c' },
          { scope: 'default', disposition: 'SCREENOUT', url_template: 'http://cb.vendor.test/s' },
        ]),
        params({ id: h.ids.draftA }),
      ),
    );
    expect(response.status).toBe(422);
    expect(envelopeCode(response.body)).toBe('validation_failed');
    expect(details(response.body)).toEqual([
      { path: 'redirects.1.url_template', code: 'scheme_not_https', message: expect.any(String) },
    ]);
    expect(await storedRows(h, h.ids.draftA)).toEqual([]);
    expect(h.data.redirects).toHaveLength(0);
  });

  it('rejects userinfo, IP-literal hosts and interpolation in the authority, each named per row', async () => {
    const h = createHarness();
    h.as({ userId: h.ids.programmerA, activeOrgId: h.ids.orgA });
    const response = await readJson(
      await putRedirects(
        putRequest(h.ids.draftA, [
          { scope: 'default', disposition: 'COMPLETE', url_template: 'https://evil@cb.vendor.test/c' },
          { scope: 'default', disposition: 'SCREENOUT', url_template: 'https://203.0.113.7/s' },
          { scope: 'default', disposition: 'QUOTA_FULL', url_template: 'https://{{HOST}}/q' },
          { scope: 'default', disposition: 'QUALITY', url_template: '{{SCHEME}}://cb.vendor.test/x' },
          { scope: 'default', disposition: 'TERMINATE', url_template: 'https://[2001:db8::1]/t' },
        ]),
        params({ id: h.ids.draftA }),
      ),
    );
    expect(response.status).toBe(422);
    const failed = details(response.body);
    expect(failed).toHaveLength(5);
    expect(failed.map((d) => [d.path, d.code])).toEqual([
      ['redirects.0.url_template', 'has_userinfo'],
      ['redirects.1.url_template', 'ip_literal_host'],
      // A `{{…}}` before the end of the authority — host or scheme — is the open-redirect kit,
      // rejected BEFORE substitution because no benign token can stand in for "any host".
      ['redirects.2.url_template', 'interpolation_in_authority'],
      ['redirects.3.url_template', 'interpolation_in_authority'],
      ['redirects.4.url_template', 'ip_literal_host'],
    ]);
    expect(h.data.redirects).toHaveLength(0);
  });

  it("accepts interpolation where it belongs: path, query and fragment", async () => {
    const h = createHarness();
    h.as({ userId: h.ids.programmerA, activeOrgId: h.ids.orgA });
    const response = await putRedirects(
      putRequest(h.ids.draftA, [
        {
          scope: 'default',
          disposition: 'COMPLETE',
          url_template: 'https://cb.vendor.test/{{PATH}}/done?rid={{RID}}&sig={{SIG.hex}}#{{FRAG}}',
        },
      ]),
      params({ id: h.ids.draftA }),
    );
    expect(response.status).toBe(200);
  });

  it("rejects 0010's shape violations and duplicates with the row index in the path", async () => {
    const h = createHarness();
    h.as({ userId: h.ids.programmerA, activeOrgId: h.ids.orgA });
    const response = await readJson(
      await putRedirects(
        putRequest(h.ids.draftA, [
          // default scope with a scope_key: a row that would silently never match.
          { scope: 'default', scope_key: 'v_panel', disposition: 'COMPLETE', url_template: 'https://a.test/1' },
          // vendor scope with no key.
          { scope: 'vendor', disposition: 'COMPLETE', url_template: 'https://a.test/2' },
          // CUSTOM with no key: nothing could ever select it.
          { scope: 'default', disposition: 'CUSTOM', url_template: 'https://a.test/3' },
          // custom_key on a non-CUSTOM disposition.
          { scope: 'default', disposition: 'SCREENOUT', custom_key: 'k', url_template: 'https://a.test/4' },
          { scope: 'default', disposition: 'QUALITY', url_template: 'https://a.test/5' },
          // The primary key: a duplicate of row 4.
          { scope: 'default', disposition: 'QUALITY', url_template: 'https://a.test/6' },
        ]),
        params({ id: h.ids.draftA }),
      ),
    );
    expect(response.status).toBe(422);
    expect(details(response.body).map((d) => [d.path, d.code])).toEqual([
      ['redirects.0.scope_key', 'scope_key_shape'],
      ['redirects.1.scope_key', 'scope_key_shape'],
      ['redirects.2.custom_key', 'custom_key_shape'],
      ['redirects.3.custom_key', 'custom_key_shape'],
      ['redirects.5', 'duplicate_row'],
    ]);
    expect(h.data.redirects).toHaveLength(0);
  });

  it('rejects a disposition outside the redirect-required registry subset', async () => {
    const h = createHarness();
    h.as({ userId: h.ids.programmerA, activeOrgId: h.ids.orgA });
    const response = await readJson(
      await putRedirects(
        // ABANDONED is a real disposition, but K §2 says nobody is there to redirect — the same
        // exclusion 0010's CHECK and CMP-0300 make.
        putRequest(h.ids.draftA, [
          { scope: 'default', disposition: 'ABANDONED', url_template: 'https://a.test/x' },
        ]),
        params({ id: h.ids.draftA }),
      ),
    );
    expect(response.status).toBe(422);
    expect(envelopeCode(response.body)).toBe('validation_failed');
  });

  /* ------------------------------------------------------------------------ */
  /* Floors, freezes and tenancy                                               */
  /* ------------------------------------------------------------------------ */

  it('is 403 for a viewer — the programmer floor (API §2.9)', async () => {
    const h = createHarness();
    h.as({ userId: h.ids.viewerA, activeOrgId: h.ids.orgA });
    const response = await readJson(
      await putRedirects(
        putRequest(h.ids.draftA, [
          { scope: 'default', disposition: 'COMPLETE', url_template: 'https://cb.vendor.test/c' },
        ]),
        params({ id: h.ids.draftA }),
      ),
    );
    expect(response.status).toBe(403);
    expect(envelopeCode(response.body)).toBe('forbidden');
    expect(h.data.redirects).toHaveLength(0);
  });

  it('is 409 frozen_version on a non-draft: where a wave in field sends people is published', async () => {
    const h = createHarness();
    h.as({ userId: h.ids.programmerA, activeOrgId: h.ids.orgA });
    const index = h.data.versions.findIndex((v) => v.id === h.ids.draftA);
    const current = h.data.versions[index];
    if (current === undefined) throw new Error('fixture missing');
    h.data.versions[index] = { ...current, status: 'production', frozen_at: new Date(h.nowMs).toISOString() };

    const response = await readJson(
      await putRedirects(
        putRequest(h.ids.draftA, [
          { scope: 'default', disposition: 'COMPLETE', url_template: 'https://cb.vendor.test/c' },
        ]),
        params({ id: h.ids.draftA }),
      ),
    );
    expect(response.status).toBe(409);
    expect(envelopeCode(response.body)).toBe('frozen_version');
  });

  it("is not_found for another org's version", async () => {
    const h = createHarness();
    h.as({ userId: h.ids.programmerA, activeOrgId: h.ids.orgA });
    const response = await putRedirects(
      putRequest(h.ids.draftB, [
        { scope: 'default', disposition: 'COMPLETE', url_template: 'https://cb.vendor.test/c' },
      ]),
      params({ id: h.ids.draftB }),
    );
    expect(response.status).toBe(404);
  });
});

describe('GET /api/v1/versions/:id/redirects', () => {
  it('is 403 for a viewer: redirect rows are vendor relationships, not review material', async () => {
    const h = createHarness();
    h.as({ userId: h.ids.viewerA, activeOrgId: h.ids.orgA });
    const response = await getRedirects(
      req(`/api/v1/versions/${h.ids.draftA}/redirects`),
      params({ id: h.ids.draftA }),
    );
    expect(response.status).toBe(403);
  });
});

/* ========================================================================== */
/* Coverage                                                                    */
/* ========================================================================== */

describe('GET /api/v1/versions/:id/redirects/coverage', () => {
  it('reports every redirect-required disposition missing on a bare version, and clears as rows land', async () => {
    const h = createHarness();
    h.as({ userId: h.ids.programmerA, activeOrgId: h.ids.orgA });

    const before = await readJson(
      await getCoverage(req(`/api/v1/versions/${h.ids.draftA}/redirects/coverage`), params({ id: h.ids.draftA })),
    );
    expect(before.status).toBe(200);
    const missingBefore = before.body['missing'] as { disposition: string; vendor: string | null; language: string | null }[];
    // K §2's redirect-required subset, minus CUSTOM (a per-key question only CMP-0300 can pose):
    // never ABANDONED, TIMED_OUT or IN_PROGRESS — nobody to redirect.
    expect(missingBefore.map((m) => m.disposition)).toEqual([
      'COMPLETE',
      'SCREENOUT',
      'QUOTA_FULL',
      'QUALITY',
      'DUPLICATE',
      'FRAUD',
      'TERMINATE',
    ]);
    expect(missingBefore.every((m) => m.vendor === null && m.language === null)).toBe(true);

    await putRedirects(
      putRequest(h.ids.draftA, [
        { scope: 'default', disposition: 'COMPLETE', url_template: 'https://cb.vendor.test/c' },
      ]),
      params({ id: h.ids.draftA }),
    );

    const after = await readJson(
      await getCoverage(req(`/api/v1/versions/${h.ids.draftA}/redirects/coverage`), params({ id: h.ids.draftA })),
    );
    const missingAfter = after.body['missing'] as { disposition: string }[];
    expect(missingAfter.map((m) => m.disposition)).not.toContain('COMPLETE');
    expect(missingAfter).toHaveLength(6);
  });

  it('reports override maps that exist and do not fill a hole the default leaves — and only those', async () => {
    const h = createHarness();
    h.as({ userId: h.ids.programmerA, activeOrgId: h.ids.orgA });
    await putRedirects(
      putRequest(h.ids.draftA, [
        { scope: 'default', disposition: 'COMPLETE', url_template: 'https://cb.vendor.test/c' },
        { scope: 'default', disposition: 'QUALITY', url_template: 'https://cb.vendor.test/ql' },
        { scope: 'default', disposition: 'DUPLICATE', url_template: 'https://cb.vendor.test/d' },
        { scope: 'default', disposition: 'FRAUD', url_template: 'https://cb.vendor.test/f' },
        { scope: 'default', disposition: 'TERMINATE', url_template: 'https://cb.vendor.test/t' },
        // SCREENOUT covered for one vendor's population only; QUOTA_FULL nowhere.
        { scope: 'vendor', scope_key: 'v_panel', disposition: 'SCREENOUT', url_template: 'https://p.test/s' },
        { scope: 'language', scope_key: 'fr', disposition: 'QUOTA_FULL', url_template: 'https://p.test/fr/q' },
      ]),
      params({ id: h.ids.draftA }),
    );

    const response = await readJson(
      await getCoverage(req(`/api/v1/versions/${h.ids.draftA}/redirects/coverage`), params({ id: h.ids.draftA })),
    );
    // COMPLETE has a default template: covered for EVERY population, including v_panel's, by
    // the runtime's fallback — so it appears nowhere. SCREENOUT's default is missing: the
    // bare-link population is uncovered, fr's map exists and does not carry it, and v_panel's
    // does. QUOTA_FULL mirrors it the other way around.
    expect(response.body['missing']).toEqual([
      { disposition: 'SCREENOUT', vendor: null, language: null },
      { disposition: 'SCREENOUT', vendor: null, language: 'fr' },
      { disposition: 'QUOTA_FULL', vendor: null, language: null },
      { disposition: 'QUOTA_FULL', vendor: 'v_panel', language: null },
    ]);
  });

  it('is 403 for a viewer, like the rows it summarizes', async () => {
    const h = createHarness();
    h.as({ userId: h.ids.viewerA, activeOrgId: h.ids.orgA });
    const response = await getCoverage(
      req(`/api/v1/versions/${h.ids.draftA}/redirects/coverage`),
      params({ id: h.ids.draftA }),
    );
    expect(response.status).toBe(403);
  });

  it("is not_found for another org's version", async () => {
    const h = createHarness();
    h.as({ userId: h.ids.programmerA, activeOrgId: h.ids.orgA });
    const response = await getCoverage(
      req(`/api/v1/versions/${h.ids.draftB}/redirects/coverage`),
      params({ id: h.ids.draftB }),
    );
    expect(response.status).toBe(404);
  });
});
