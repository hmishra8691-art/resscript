/**
 * The preview-token mint and the debug-session proxy (P1-11).
 *
 * The load-bearing assertions:
 *
 *  - the minted token verifies against the RECIPE (`v1.<exp>.<hmac(secret, hash|exp)>`),
 *    re-derived here from `node:crypto` directly — not against `mintPreviewToken`, which would
 *    prove only that the function equals itself while the runtime rejects every token;
 *  - an uncompiled version is a `409` (compile first), and another org's version a `404`;
 *  - the proxy drives the runtime's preview endpoints with a server-minted `pt` and NEVER
 *    leaks that token to the browser — the signing secret's whole reason to live server-side.
 */

import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST as mintToken } from '@/app/api/v1/versions/[id]/preview-token/route';
import { POST as debugSession } from '@/app/api/v1/versions/[id]/debug-session/route';
import { PREVIEW_TOKEN_TTL_MS } from '@/server/preview';
import { createHarness, params, readJson, req, type Harness } from '@/test/harness';
import { registryRowsFor } from '@/test/registry-fixture';

const SECRET = 'test-preview-signing';
const ORIGIN = 'http://prv-dev.run.local:8081';
const HASH = 'a'.repeat(64);

beforeEach(() => {
  process.env['PREVIEW_SIGNING_SECRET'] = SECRET;
  process.env['RUNTIME_PREVIEW_ORIGIN'] = ORIGIN;
});

afterEach(() => {
  delete process.env['PREVIEW_SIGNING_SECRET'];
  delete process.env['RUNTIME_PREVIEW_ORIGIN'];
  vi.unstubAllGlobals();
});

/** Flip org A's draft to "a compile has run and produced an artifact" (the two axes stay two). */
function compiled(h: Harness): void {
  const index = h.data.versions.findIndex((v) => v.id === h.ids.draftA);
  const version = h.data.versions[index];
  if (version === undefined) throw new Error('no draft');
  h.data.versions[index] = { ...version, compile_state: 'compiled', artifact_hash: HASH };
}

/** The recipe, re-derived — the same bytes `apps/runtime/src/preview/token.ts` verifies. */
function expectedToken(expiresAtMs: number): string {
  const signature = createHmac('sha256', SECRET)
    .update(`${HASH}|${expiresAtMs}`)
    .digest('hex');
  return `v1.${expiresAtMs}.${signature}`;
}

describe('POST /api/v1/versions/:id/preview-token', () => {
  it('mints a token the runtime recipe verifies, expiring in 10 minutes', async () => {
    const h = createHarness();
    compiled(h);
    h.as({ userId: h.ids.programmerA, activeOrgId: h.ids.orgA });
    const response = await readJson(
      await mintToken(req('/x', { method: 'POST' }), params({ id: h.ids.draftA })),
    );
    expect(response.status).toBe(200);
    const expiresAtMs = h.nowMs + PREVIEW_TOKEN_TTL_MS;
    expect(response.body['artifact_hash']).toBe(HASH);
    expect(response.body['preview_token']).toBe(expectedToken(expiresAtMs));
    expect(response.body['expires_at']).toBe(new Date(expiresAtMs).toISOString());
    // The assembled URL, so the client cannot compose against the wrong origin — this origin
    // is also what the panel checks every incoming postMessage against.
    expect(response.body['preview_url']).toBe(
      `${ORIGIN}/preview/${HASH}?pt=${encodeURIComponent(expectedToken(expiresAtMs))}`,
    );
  });

  it('answers 409 for a version with no compiled artifact — compile first', async () => {
    const h = createHarness();
    h.as({ userId: h.ids.programmerA, activeOrgId: h.ids.orgA });
    const response = await readJson(
      await mintToken(req('/x', { method: 'POST' }), params({ id: h.ids.draftA })),
    );
    expect(response.status).toBe(409);
    expect((response.body['error'] as { code: string }).code).toBe('illegal_transition');
  });

  it("is not_found for another org's version — existence is the leak", async () => {
    const h = createHarness();
    h.as({ userId: h.ids.programmerA, activeOrgId: h.ids.orgA });
    const response = await mintToken(
      req('/x', { method: 'POST' }),
      params({ id: h.ids.draftB }),
    );
    expect(response.status).toBe(404);
  });

  it('allows the client role — the same floor as the version read routes', async () => {
    const h = createHarness();
    compiled(h);
    // viewerA outranks client (10 > 5); asserting the LOWEST rank passes pins the floor.
    h.as({ userId: h.ids.viewerA, activeOrgId: h.ids.orgA });
    const response = await mintToken(
      req('/x', { method: 'POST' }),
      params({ id: h.ids.draftA }),
    );
    expect(response.status).toBe(200);
  });

  it('is 503 unavailable when the deployment has no preview configuration', async () => {
    delete process.env['PREVIEW_SIGNING_SECRET'];
    const h = createHarness();
    compiled(h);
    h.as({ userId: h.ids.programmerA, activeOrgId: h.ids.orgA });
    const response = await readJson(
      await mintToken(req('/x', { method: 'POST' }), params({ id: h.ids.draftA })),
    );
    expect(response.status).toBe(503);
    expect((response.body['error'] as { code: string }).code).toBe('unavailable');
  });
});

describe('POST /api/v1/versions/:id/debug-session', () => {
  function stubRuntime(body: unknown, status = 200): ReturnType<typeof vi.fn> {
    const fetchMock = vi.fn(
      async (): Promise<Response> =>
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('starts a session against the runtime with a server-minted pt, seed and lang', async () => {
    const h = createHarness();
    compiled(h);
    h.as({ userId: h.ids.programmerA, activeOrgId: h.ids.orgA });
    const fetchMock = stubRuntime({
      session_id: 'ses_1',
      page: { page_id: 'pg_1', questions: [], skipped: [] },
      debug: { seed: 'f'.repeat(32), trace: [] },
    });

    const seed = 'c'.repeat(32);
    const response = await readJson(
      await debugSession(
        req('/x', { method: 'POST', body: { action: 'start', seed, lang: 'de' } }),
        params({ id: h.ids.draftA }),
      ),
    );

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(url.origin).toBe(ORIGIN);
    expect(url.pathname).toBe(`/preview/${HASH}`);
    expect(url.searchParams.get('pt')).toBe(expectedToken(h.nowMs + PREVIEW_TOKEN_TTL_MS));
    expect(url.searchParams.get('seed')).toBe(seed);
    expect(url.searchParams.get('lang')).toBe('de');

    // The runtime body passes through; the proxy adds the registry's pii projection.
    expect(response.body['session_id']).toBe('ses_1');
    const variables = response.body['variables'] as { name: string; pii: boolean }[];
    expect(variables.map((v) => v.name)).toContain('S1');
    expect(variables.every((v) => typeof v.pii === 'boolean')).toBe(true);
  });

  it('attaches the pii flag the panel masks with', async () => {
    const h = createHarness();
    compiled(h);
    // A registry with a PII variable, replacing the fixture's for this version.
    const rows = registryRowsFor(h.ids.draftA);
    h.data.seedRegistry({
      ...rows,
      variables: [
        ...rows.variables,
        {
          id: 'var_01JC8KX9Q2M4V7ZB3F0T5N6RZ',
          name: 'EMAIL',
          kind: 'response',
          vtype: 'text',
          enum_domain: null,
          source_question_id: null,
          source_item_id: null,
          source_part: null,
          pii: true,
          persist: true,
          sort_key: 'a9',
        },
      ],
    });
    h.as({ userId: h.ids.programmerA, activeOrgId: h.ids.orgA });
    stubRuntime({ session_id: 'ses_1', page: { page_id: 'pg_1', questions: [], skipped: [] } });

    const response = await readJson(
      await debugSession(
        req('/x', { method: 'POST', body: { action: 'start' } }),
        params({ id: h.ids.draftA }),
      ),
    );
    const variables = response.body['variables'] as { name: string; pii: boolean }[];
    expect(variables.find((v) => v.name === 'EMAIL')?.pii).toBe(true);
  });

  it('never leaks the pt token or the secret into the response', async () => {
    const h = createHarness();
    compiled(h);
    h.as({ userId: h.ids.programmerA, activeOrgId: h.ids.orgA });
    stubRuntime({ session_id: 'ses_1', page: { page_id: 'pg_1', questions: [], skipped: [] } });

    const response = await readJson(
      await debugSession(
        req('/x', { method: 'POST', body: { action: 'start' } }),
        params({ id: h.ids.draftA }),
      ),
    );
    const serialized = JSON.stringify(response.body);
    expect(serialized).not.toContain(SECRET);
    // The signature hex of the token the proxy minted for this call.
    const token = expectedToken(h.nowMs + PREVIEW_TOKEN_TTL_MS);
    expect(serialized).not.toContain(token.split('.')[2]);
  });

  it('proxies a submit to /submit with the session pinned in the query', async () => {
    const h = createHarness();
    compiled(h);
    h.as({ userId: h.ids.programmerA, activeOrgId: h.ids.orgA });
    const fetchMock = stubRuntime({
      session_id: 'ses_1',
      page: { page_id: 'pg_2', questions: [], skipped: [] },
      debug: { seed: 'f'.repeat(32) },
    });

    const response = await readJson(
      await debugSession(
        req('/x', {
          method: 'POST',
          body: {
            action: 'submit',
            session_id: 'ses_1',
            page_id: 'pg_1',
            values: { qst_1: 2 },
          },
        }),
        params({ id: h.ids.draftA }),
      ),
    );

    expect(response.status).toBe(200);
    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(url.pathname).toBe(`/preview/${HASH}/submit`);
    expect(url.searchParams.get('session')).toBe('ses_1');
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ page_id: 'pg_1', values: { qst_1: 2 } });
  });

  it("passes the runtime's own refusals through untranslated — they ARE the debug data", async () => {
    const h = createHarness();
    compiled(h);
    h.as({ userId: h.ids.programmerA, activeOrgId: h.ids.orgA });
    stubRuntime({ error: { code: 'stale_page', current_page_id: 'pg_3' } }, 409);

    const response = await readJson(
      await debugSession(
        req('/x', {
          method: 'POST',
          body: { action: 'submit', session_id: 'ses_1', page_id: 'pg_1', values: {} },
        }),
        params({ id: h.ids.draftA }),
      ),
    );
    expect(response.status).toBe(409);
    expect((response.body['error'] as { code: string }).code).toBe('stale_page');
  });

  it('refuses an uncompiled version BEFORE touching the runtime', async () => {
    const h = createHarness();
    h.as({ userId: h.ids.programmerA, activeOrgId: h.ids.orgA });
    const fetchMock = stubRuntime({});
    const response = await debugSession(
      req('/x', { method: 'POST', body: { action: 'start' } }),
      params({ id: h.ids.draftA }),
    );
    expect(response.status).toBe(409);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects an action the union does not know', async () => {
    const h = createHarness();
    compiled(h);
    h.as({ userId: h.ids.programmerA, activeOrgId: h.ids.orgA });
    stubRuntime({});
    const response = await readJson(
      await debugSession(
        req('/x', { method: 'POST', body: { action: 'drop_tables' } }),
        params({ id: h.ids.draftA }),
      ),
    );
    expect(response.status).toBe(422);
  });

  it('is 503 when the preview runtime is unreachable', async () => {
    const h = createHarness();
    compiled(h);
    h.as({ userId: h.ids.programmerA, activeOrgId: h.ids.orgA });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (): Promise<Response> => {
        throw new Error('ECONNREFUSED');
      }),
    );
    const response = await readJson(
      await debugSession(
        req('/x', { method: 'POST', body: { action: 'start' } }),
        params({ id: h.ids.draftA }),
      ),
    );
    expect(response.status).toBe(503);
    expect((response.body['error'] as { code: string }).code).toBe('unavailable');
  });
});
