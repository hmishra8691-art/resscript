/**
 * The translation surface (roadmap P1-12, migration 0007 §8): the summary with its
 * completeness gauge, the add-language write, and the flat-file round trip.
 *
 * The centre of this suite is two rules the routes exist to hold:
 *
 *  1. **The gauge's denominator is the BASE language's key set**, computed server-side — a
 *     stray row under a key the base does not carry is drift, never progress.
 *  2. **An unknown key on import is a 422 NAMING EVERY OFFENDING KEY, and nothing is
 *     stored** — a translator's typo'd key must not silently become a row nothing reads.
 *     Every rejection test asserts both the details and that a subsequent GET is unchanged.
 *
 * Assertions are on status codes, envelope CODES and stored rows. Never on message prose.
 */

import { describe, expect, it } from 'vitest';
import {
  GET as getSummary,
  POST as postLanguage,
} from '@/app/api/v1/versions/[id]/translations/route';
import {
  GET as getFlat,
  PUT as putFlat,
} from '@/app/api/v1/versions/[id]/translations/[lang]/route';
import { createHarness, params, readJson, req, type Harness } from '@/test/harness';

function envelopeCode(body: Record<string, unknown>): string {
  return (body['error'] as { code: string }).code;
}

function details(body: Record<string, unknown>): { path: string; code: string }[] {
  return (body['error'] as { details: { path: string; code: string }[] }).details;
}

/** The base language plus two keys — the smallest fixture with a real denominator. */
function seedBase(h: Harness): void {
  h.data.seedLanguage({ versionId: h.ids.draftA, orgId: h.ids.orgA, lang: 'en', isBase: true });
  h.data.seedString({
    versionId: h.ids.draftA,
    orgId: h.ids.orgA,
    lang: 'en',
    key: 'q1.text',
    value: 'Hello',
  });
  h.data.seedString({
    versionId: h.ids.draftA,
    orgId: h.ids.orgA,
    lang: 'en',
    key: 'q2.text',
    value: 'Goodbye',
  });
}

async function addFrench(h: Harness): Promise<void> {
  const response = await postLanguage(
    req(`/api/v1/versions/${h.ids.draftA}/translations`, { method: 'POST', body: { lang: 'fr' } }),
    params({ id: h.ids.draftA }),
  );
  expect(response.status).toBe(201);
}

function putRequest(versionId: string, lang: string, body: unknown): Request {
  return req(`/api/v1/versions/${versionId}/translations/${lang}`, { method: 'PUT', body });
}

async function flatFile(h: Harness, lang: string): Promise<Record<string, unknown>> {
  const response = await readJson(
    await getFlat(
      req(`/api/v1/versions/${h.ids.draftA}/translations/${lang}`),
      params({ id: h.ids.draftA, lang }),
    ),
  );
  expect(response.status).toBe(200);
  return response.body;
}

/* ========================================================================== */
/* The summary: languages, gauge, per-string detail                            */
/* ========================================================================== */

describe('GET /api/v1/versions/:id/translations', () => {
  it('computes the completeness gauge server-side over the BASE key set', async () => {
    const h = createHarness();
    h.as({ userId: h.ids.programmerA, activeOrgId: h.ids.orgA });
    seedBase(h);
    await addFrench(h);
    await putFlat(putRequest(h.ids.draftA, 'fr', { 'q1.text': 'Bonjour' }), params({ id: h.ids.draftA, lang: 'fr' }));
    // Drift: a fr row under a key the base does not carry. It must count NOWHERE.
    h.data.seedString({ versionId: h.ids.draftA, orgId: h.ids.orgA, lang: 'fr', key: 'stray.key', value: 'x' });

    const response = await readJson(
      await getSummary(req(`/api/v1/versions/${h.ids.draftA}/translations`), params({ id: h.ids.draftA })),
    );
    expect(response.status).toBe(200);
    expect(response.body['base_lang']).toBe('en');
    expect(response.body['total_keys']).toBe(2);
    const languages = response.body['languages'] as Record<string, unknown>[];
    // Base first, then tag order.
    expect(languages.map((l) => l['lang'])).toEqual(['en', 'fr']);
    expect(languages[0]).toMatchObject({ is_base: true, translated: 2, missing: 0, complete_pct: 100 });
    expect(languages[1]).toMatchObject({
      is_base: false,
      total_keys: 2,
      translated: 1,
      missing: 1,
      complete_pct: 50,
    });
  });

  it('?lang= returns the per-string states with missing keys MATERIALIZED', async () => {
    const h = createHarness();
    h.as({ userId: h.ids.programmerA, activeOrgId: h.ids.orgA });
    seedBase(h);
    await addFrench(h);
    await putFlat(putRequest(h.ids.draftA, 'fr', { 'q1.text': 'Bonjour' }), params({ id: h.ids.draftA, lang: 'fr' }));

    const response = await readJson(
      await getSummary(
        req(`/api/v1/versions/${h.ids.draftA}/translations?lang=fr`),
        params({ id: h.ids.draftA }),
      ),
    );
    // Every BASE key appears — a key with no fr row is `missing`, not absent, because the
    // manager's table renders the worklist, not the finished part.
    expect(response.body['strings']).toEqual([
      { key: 'q1.text', value: 'Bonjour', state: 'translated' },
      { key: 'q2.text', value: null, state: 'missing' },
    ]);
  });

  it('is 403 for a viewer — the reviewer floor (0007: translation state is review material)', async () => {
    const h = createHarness();
    h.as({ userId: h.ids.viewerA, activeOrgId: h.ids.orgA });
    const response = await getSummary(
      req(`/api/v1/versions/${h.ids.draftA}/translations`),
      params({ id: h.ids.draftA }),
    );
    expect(response.status).toBe(403);
  });

  it("is not_found for another org's version", async () => {
    const h = createHarness();
    h.as({ userId: h.ids.programmerA, activeOrgId: h.ids.orgA });
    const response = await getSummary(
      req(`/api/v1/versions/${h.ids.draftB}/translations`),
      params({ id: h.ids.draftB }),
    );
    expect(response.status).toBe(404);
  });
});

/* ========================================================================== */
/* Adding a language                                                           */
/* ========================================================================== */

describe('POST /api/v1/versions/:id/translations', () => {
  it('is 403 for a reviewer: adding a fielding language is survey structure, not entry', async () => {
    const h = createHarness();
    h.as({ userId: h.ids.reviewerA, activeOrgId: h.ids.orgA });
    const response = await readJson(
      await postLanguage(
        req(`/api/v1/versions/${h.ids.draftA}/translations`, { method: 'POST', body: { lang: 'fr' } }),
        params({ id: h.ids.draftA }),
      ),
    );
    expect(response.status).toBe(403);
    expect(envelopeCode(response.body)).toBe('forbidden');
    expect(h.data.languages).toHaveLength(0);
  });

  it('rejects a malformed tag with 422 and a duplicate with 409', async () => {
    const h = createHarness();
    h.as({ userId: h.ids.programmerA, activeOrgId: h.ids.orgA });
    const bad = await readJson(
      await postLanguage(
        req(`/api/v1/versions/${h.ids.draftA}/translations`, { method: 'POST', body: { lang: 'FRANCE' } }),
        params({ id: h.ids.draftA }),
      ),
    );
    expect(bad.status).toBe(422);
    expect(envelopeCode(bad.body)).toBe('validation_failed');

    await addFrench(h);
    const dup = await readJson(
      await postLanguage(
        req(`/api/v1/versions/${h.ids.draftA}/translations`, { method: 'POST', body: { lang: 'fr' } }),
        params({ id: h.ids.draftA }),
      ),
    );
    expect(dup.status).toBe(409);
    expect(envelopeCode(dup.body)).toBe('already_exists');
  });

  it('is 409 frozen_version on a non-draft', async () => {
    const h = createHarness();
    h.as({ userId: h.ids.programmerA, activeOrgId: h.ids.orgA });
    const index = h.data.versions.findIndex((v) => v.id === h.ids.draftA);
    const current = h.data.versions[index];
    if (current === undefined) throw new Error('fixture missing');
    h.data.versions[index] = { ...current, status: 'production', frozen_at: new Date(h.nowMs).toISOString() };

    const response = await readJson(
      await postLanguage(
        req(`/api/v1/versions/${h.ids.draftA}/translations`, { method: 'POST', body: { lang: 'fr' } }),
        params({ id: h.ids.draftA }),
      ),
    );
    expect(response.status).toBe(409);
    expect(envelopeCode(response.body)).toBe('frozen_version');
  });
});

/* ========================================================================== */
/* The flat file: export, import, round trip                                   */
/* ========================================================================== */

describe('GET|PUT /api/v1/versions/:id/translations/:lang', () => {
  it("round-trips: PUT stores, GET returns every BASE key with '' where untranslated", async () => {
    const h = createHarness();
    h.as({ userId: h.ids.programmerA, activeOrgId: h.ids.orgA });
    seedBase(h);
    await addFrench(h);

    const put = await readJson(
      await putFlat(putRequest(h.ids.draftA, 'fr', { 'q1.text': 'Bonjour' }), params({ id: h.ids.draftA, lang: 'fr' })),
    );
    expect(put.status).toBe(200);
    expect(put.body).toMatchObject({ lang: 'fr', written: 1, translated: 1, cleared: 0 });

    // The whole worklist, not just the done part.
    expect(await flatFile(h, 'fr')).toEqual({ 'q1.text': 'Bonjour', 'q2.text': '' });
    // Re-importing the exported file verbatim is a semantic no-op: same file back out.
    await putFlat(
      putRequest(h.ids.draftA, 'fr', { 'q1.text': 'Bonjour', 'q2.text': '' }),
      params({ id: h.ids.draftA, lang: 'fr' }),
    );
    expect(await flatFile(h, 'fr')).toEqual({ 'q1.text': 'Bonjour', 'q2.text': '' });
  });

  it('rejects unknown keys with 422 NAMING EACH ONE, and stores nothing', async () => {
    const h = createHarness();
    h.as({ userId: h.ids.programmerA, activeOrgId: h.ids.orgA });
    seedBase(h);
    await addFrench(h);

    const response = await readJson(
      await putFlat(
        // 'q1.txt' is THE failure mode this route exists for: a typo in a text editor.
        putRequest(h.ids.draftA, 'fr', { 'q1.txt': 'Bonjour', 'q3.text': 'Salut', 'q2.text': 'Au revoir' }),
        params({ id: h.ids.draftA, lang: 'fr' }),
      ),
    );
    expect(response.status).toBe(422);
    expect(envelopeCode(response.body)).toBe('validation_failed');
    expect(details(response.body).map((d) => [d.path, d.code])).toEqual([
      ['q1.txt', 'unknown_key'],
      ['q3.text', 'unknown_key'],
    ]);
    // NOTHING stored — not even the valid q2.text (security §12.3's write rule).
    expect(h.data.strings.filter((s) => s.lang === 'fr')).toHaveLength(0);
  });

  it("'' clears a string back to missing, and the gauge drops with it", async () => {
    const h = createHarness();
    h.as({ userId: h.ids.programmerA, activeOrgId: h.ids.orgA });
    seedBase(h);
    await addFrench(h);
    await putFlat(putRequest(h.ids.draftA, 'fr', { 'q1.text': 'Bonjour' }), params({ id: h.ids.draftA, lang: 'fr' }));

    const cleared = await readJson(
      await putFlat(putRequest(h.ids.draftA, 'fr', { 'q1.text': '' }), params({ id: h.ids.draftA, lang: 'fr' })),
    );
    expect(cleared.body).toMatchObject({ written: 1, cleared: 1 });
    // The table's own encoding: state missing, value NULL (i18n_missing_has_no_value).
    const row = h.data.strings.find((s) => s.lang === 'fr' && s.key === 'q1.text');
    expect(row).toMatchObject({ state: 'missing', value: null });

    const summary = await readJson(
      await getSummary(req(`/api/v1/versions/${h.ids.draftA}/translations`), params({ id: h.ids.draftA })),
    );
    const fr = (summary.body['languages'] as Record<string, unknown>[]).find((l) => l['lang'] === 'fr');
    expect(fr).toMatchObject({ translated: 0, missing: 2, complete_pct: 0 });
  });

  it('a REVIEWER can import — 0007 puts translation entry below the programmer floor', async () => {
    const h = createHarness();
    h.as({ userId: h.ids.programmerA, activeOrgId: h.ids.orgA });
    seedBase(h);
    await addFrench(h);

    h.as({ userId: h.ids.reviewerA, activeOrgId: h.ids.orgA });
    const response = await putFlat(
      putRequest(h.ids.draftA, 'fr', { 'q1.text': 'Bonjour' }),
      params({ id: h.ids.draftA, lang: 'fr' }),
    );
    expect(response.status).toBe(200);
  });

  it('is 403 for a viewer, both directions', async () => {
    const h = createHarness();
    h.as({ userId: h.ids.programmerA, activeOrgId: h.ids.orgA });
    seedBase(h);
    await addFrench(h);

    h.as({ userId: h.ids.viewerA, activeOrgId: h.ids.orgA });
    const read = await getFlat(
      req(`/api/v1/versions/${h.ids.draftA}/translations/fr`),
      params({ id: h.ids.draftA, lang: 'fr' }),
    );
    expect(read.status).toBe(403);
    const write = await putFlat(
      putRequest(h.ids.draftA, 'fr', { 'q1.text': 'x' }),
      params({ id: h.ids.draftA, lang: 'fr' }),
    );
    expect(write.status).toBe(403);
    expect(h.data.strings.filter((s) => s.lang === 'fr')).toHaveLength(0);
  });

  it('is 404 for a language the version does not carry — before the body is even judged', async () => {
    const h = createHarness();
    h.as({ userId: h.ids.programmerA, activeOrgId: h.ids.orgA });
    seedBase(h);
    const response = await readJson(
      await putFlat(putRequest(h.ids.draftA, 'de', { 'q1.text': 'Hallo' }), params({ id: h.ids.draftA, lang: 'de' })),
    );
    expect(response.status).toBe(404);
    expect(h.data.strings.filter((s) => s.lang === 'de')).toHaveLength(0);
  });

  it('is 409 frozen_version on a non-draft: the strings are part of what it published', async () => {
    const h = createHarness();
    h.as({ userId: h.ids.programmerA, activeOrgId: h.ids.orgA });
    seedBase(h);
    await addFrench(h);
    const index = h.data.versions.findIndex((v) => v.id === h.ids.draftA);
    const current = h.data.versions[index];
    if (current === undefined) throw new Error('fixture missing');
    h.data.versions[index] = { ...current, status: 'production', frozen_at: new Date(h.nowMs).toISOString() };

    const response = await readJson(
      await putFlat(putRequest(h.ids.draftA, 'fr', { 'q1.text': 'Bonjour' }), params({ id: h.ids.draftA, lang: 'fr' })),
    );
    expect(response.status).toBe(409);
    expect(envelopeCode(response.body)).toBe('frozen_version');
    // Export still works on the frozen version: reading is not a write.
    expect(await flatFile(h, 'fr')).toEqual({ 'q1.text': '', 'q2.text': '' });
  });
});
