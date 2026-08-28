/**
 * `GET|PUT /api/v1/versions/:id/vendors` — API §2.16, migration 0024.
 *
 * Every piece of P2-04's vendor handling was built and tested in P1 against `Survey.vendors`:
 * signature verification that creates no session on failure, inbound-parameter binding, and the
 * `by_vendor` redirect tier. None of it ran, because no table fed it and then no endpoint fed the
 * table. This is the only way to put a vendor row in without SQL, so the assertions worth making
 * are the refusals — a vendor stored in a broken state is a 403 a respondent sees for somebody
 * else's configuration mistake.
 */

import { describe, expect, it } from 'vitest';

import { GET as getVendors, PUT as putVendors } from '@/app/api/v1/versions/[id]/vendors/route';
import { createHarness, params, readJson, req, type Harness } from '@/test/harness';

const VND_A = 'vnd_0PANA0000000000000000000000'.slice(0, 30);
const VND_B = 'vnd_0PANB0000000000000000000000'.slice(0, 30);

function envelopeCode(body: Record<string, unknown>): string {
  return (body['error'] as { code: string }).code;
}

function details(body: Record<string, unknown>): { path: string; code: string }[] {
  return (body['error'] as { details: { path: string; code: string }[] }).details ?? [];
}

function putRequest(versionId: string, vendors: unknown[]): Request {
  return req(`/api/v1/versions/${versionId}/vendors`, { method: 'PUT', body: { vendors } });
}

/** A hidden variable for an inbound param to target — 0024's FK requires a real one. */
function seedVariable(h: Harness, versionId: string, name: string): void {
  h.data.variables.push({
    survey_version_id: versionId,
    id: `var_0${name.toUpperCase().padEnd(25, '0')}`,
    org_id: h.ids.orgA,
    name,
    kind: 'hidden',
    vtype: 'text',
    export_column: name,
    export_include: true,
    pii: false,
    persist: true,
    sort_key: '0100',
  } as never);
}

function vendor(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: VND_A,
    ref: 'PANEL_A',
    name: 'Panel A',
    entry_url_template: null,
    max_completes: 500,
    quota_plan_overrides: [],
    inbound_params: [{ param: 'pid', variable_ref: 'VENDORPID', required: true }],
    security: {
      hash_param: 'hash',
      algorithm: 'sha256',
      secret_ref: 'vendor/panel_a/hmac',
      signed_params: ['pid'],
    },
    ...over,
  };
}

/* ========================================================================== */
/* PUT then GET                                                                */
/* ========================================================================== */

describe('PUT /api/v1/versions/:id/vendors', () => {
  it('stores a vendor that GET then returns, with its inbound params', async () => {
    const h = createHarness();
    h.as({ userId: h.ids.programmerA, activeOrgId: h.ids.orgA });
    seedVariable(h, h.ids.draftA, 'VENDORPID');

    const put = await readJson(
      await putVendors(putRequest(h.ids.draftA, [vendor()]), params({ id: h.ids.draftA })),
    );
    expect(put.status).toBe(200);

    const got = await readJson(
      await getVendors(
        req(`/api/v1/versions/${h.ids.draftA}/vendors`),
        params({ id: h.ids.draftA }),
      ),
    );
    const stored = got.body['vendors'] as Record<string, unknown>[];
    expect(stored).toHaveLength(1);
    expect(stored[0]?.['ref']).toBe('PANEL_A');
    // The allowlist reaches storage — without it `bindInboundParams` binds nothing and a panel id
    // never becomes a variable, which is also the allowlist that stops a respondent setting any
    // hidden variable by appending to the query string.
    expect(stored[0]?.['inbound_params']).toEqual([
      { param: 'pid', variable_ref: 'VENDORPID', required: true },
    ]);
    // The secret REFERENCE round-trips; the secret was never here to round-trip.
    expect((stored[0]?.['security'] as Record<string, unknown>)['secret_ref']).toBe(
      'vendor/panel_a/hmac',
    );
  });

  it('stores an UNSIGNED vendor, which is a real configuration', async () => {
    // A QR code or a client's own mailing list has no panel to sign.
    const h = createHarness();
    h.as({ userId: h.ids.programmerA, activeOrgId: h.ids.orgA });
    const put = await readJson(
      await putVendors(
        putRequest(h.ids.draftA, [
          vendor({ ref: 'DIRECT', inbound_params: [], security: null }),
        ]),
        params({ id: h.ids.draftA }),
      ),
    );
    expect(put.status).toBe(200);
    expect((put.body['vendors'] as Record<string, unknown>[])[0]?.['security']).toBeNull();
  });

  it('is a whole-set REPLACE, so deletion is expressible', async () => {
    const h = createHarness();
    h.as({ userId: h.ids.programmerA, activeOrgId: h.ids.orgA });
    seedVariable(h, h.ids.draftA, 'VENDORPID');

    await putVendors(putRequest(h.ids.draftA, [vendor()]), params({ id: h.ids.draftA }));
    const cleared = await readJson(
      await putVendors(putRequest(h.ids.draftA, []), params({ id: h.ids.draftA })),
    );
    expect(cleared.status).toBe(200);
    expect(cleared.body['vendors']).toEqual([]);
  });
});

/* ========================================================================== */
/* The 422 path                                                                */
/* ========================================================================== */

describe('validation', () => {
  it('REFUSES a secret VALUE in secret_ref, naming why', async () => {
    // Every other layer that forbids a secret value — the schema type, the compiler's
    // assertNoSecrets, 0024's CHECK — sits DOWNSTREAM of a paste into a vendor console, which is
    // this endpoint. So the check is here too, and its 422 explains itself rather than surfacing a
    // constraint name.
    const h = createHarness();
    h.as({ userId: h.ids.programmerA, activeOrgId: h.ids.orgA });
    seedVariable(h, h.ids.draftA, 'VENDORPID');

    const r = await readJson(
      await putVendors(
        putRequest(h.ids.draftA, [
          vendor({
            security: {
              hash_param: 'hash',
              algorithm: 'sha256',
              secret_ref: 'k7Fq2mZp9xLtR4vNwYbS3jHcQ8eA6uDg',
              signed_params: ['pid'],
            },
          }),
        ]),
        params({ id: h.ids.draftA }),
      ),
    );

    expect(r.status).toBe(422);
    expect(envelopeCode(r.body)).toBe('validation_failed');
    const d = details(r.body);
    expect(d[0]?.path).toBe('vendors.0.security.secret_ref');
    expect(d[0]?.code).toBe('vendors_secret_ref_is_a_reference');
  });

  it('accepts a path-shaped reference — the heuristic targets opaque length', async () => {
    const h = createHarness();
    h.as({ userId: h.ids.programmerA, activeOrgId: h.ids.orgA });
    seedVariable(h, h.ids.draftA, 'VENDORPID');
    const r = await putVendors(putRequest(h.ids.draftA, [vendor()]), params({ id: h.ids.draftA }));
    expect(r.status).toBe(200);
  });

  it('refuses a duplicate vendor ref, naming both indices', async () => {
    // The ref is what `?src=` matches, so a duplicate makes which vendor an entry link belongs to
    // non-deterministic.
    const h = createHarness();
    h.as({ userId: h.ids.programmerA, activeOrgId: h.ids.orgA });
    seedVariable(h, h.ids.draftA, 'VENDORPID');

    const r = await readJson(
      await putVendors(
        putRequest(h.ids.draftA, [vendor(), vendor({ id: VND_B })]),
        params({ id: h.ids.draftA }),
      ),
    );
    expect(r.status).toBe(422);
    expect(details(r.body)[0]?.code).toBe('vendors_ref_key');
    expect(details(r.body)[0]?.path).toBe('vendors.1.ref');
  });

  it('refuses a duplicate inbound param within one vendor', async () => {
    const h = createHarness();
    h.as({ userId: h.ids.programmerA, activeOrgId: h.ids.orgA });
    seedVariable(h, h.ids.draftA, 'VENDORPID');

    const r = await readJson(
      await putVendors(
        putRequest(h.ids.draftA, [
          vendor({
            inbound_params: [
              { param: 'pid', variable_ref: 'VENDORPID', required: true },
              { param: 'pid', variable_ref: 'VENDORPID', required: false },
            ],
          }),
        ]),
        params({ id: h.ids.draftA }),
      ),
    );
    expect(r.status).toBe(422);
    expect(details(r.body)[0]?.code).toBe('vendor_params_pkey');
  });

  it('refuses signing only params the vendor never declares', async () => {
    // A signature over nothing the panel sends covers nothing. 0024 requires signed_params to be
    // non-empty; this is the cross-field version it cannot express.
    const h = createHarness();
    h.as({ userId: h.ids.programmerA, activeOrgId: h.ids.orgA });
    seedVariable(h, h.ids.draftA, 'VENDORPID');

    const r = await readJson(
      await putVendors(
        putRequest(h.ids.draftA, [
          vendor({
            security: {
              hash_param: 'hash',
              algorithm: 'sha256',
              secret_ref: 'vendor/a/hmac',
              signed_params: ['nothing_declared'],
            },
          }),
        ]),
        params({ id: h.ids.draftA }),
      ),
    );
    expect(r.status).toBe(422);
    expect(details(r.body)[0]?.code).toBe('vendors_signed_params_declared');
  });

  it('reports EVERY problem in one 422, not just the first', async () => {
    // The row is not stored, so the index into the submitted array is the only address the client
    // has — and an author fixing four problems one round trip at a time is an author who stops.
    const h = createHarness();
    h.as({ userId: h.ids.programmerA, activeOrgId: h.ids.orgA });
    seedVariable(h, h.ids.draftA, 'VENDORPID');

    const r = await readJson(
      await putVendors(
        putRequest(h.ids.draftA, [
          vendor(),
          vendor({
            id: VND_B,
            security: {
              hash_param: 'hash',
              algorithm: 'sha256',
              secret_ref: 'k7Fq2mZp9xLtR4vNwYbS3jHcQ8eA6uDg',
              signed_params: ['pid'],
            },
          }),
        ]),
        params({ id: h.ids.draftA }),
      ),
    );
    expect(r.status).toBe(422);
    const codes = details(r.body).map((x) => x.code);
    expect(codes).toContain('vendors_ref_key');
    expect(codes).toContain('vendors_secret_ref_is_a_reference');
  });

  it('refuses a param targeting an undeclared variable, from the store', async () => {
    // 0024's composite FK is the whole reason the params are a table rather than a jsonb column.
    // The memory store reproduces it by name, so a failing test names what a failing INSERT would.
    const h = createHarness();
    h.as({ userId: h.ids.programmerA, activeOrgId: h.ids.orgA });
    // No seedVariable — the ref resolves to nothing.
    const r = await readJson(
      await putVendors(putRequest(h.ids.draftA, [vendor()]), params({ id: h.ids.draftA })),
    );
    expect(r.status).toBeGreaterThanOrEqual(400);
  });
});

/* ========================================================================== */
/* Authorization and the draft boundary                                        */
/* ========================================================================== */

describe('authorization', () => {
  it('refuses a REVIEWER even for the read', async () => {
    // The one content resource whose READ bar sits above the review bar. 0024: a vendor row is a
    // commercial relationship plus a pointer into the secrets store, a list of secret_refs is a map
    // of that store, and a review link is shared outside the programming team.
    const h = createHarness();
    h.as({ userId: h.ids.reviewerA, activeOrgId: h.ids.orgA });
    const r = await getVendors(
      req(`/api/v1/versions/${h.ids.draftA}/vendors`),
      params({ id: h.ids.draftA }),
    );
    expect(r.status).toBe(403);
  });

  it('refuses a version in another org as NOT FOUND, not forbidden', async () => {
    // 0004's existence-oracle rule: a wrong-tenant id must be indistinguishable from one that never
    // existed.
    const h = createHarness();
    h.as({ userId: h.ids.programmerA, activeOrgId: h.ids.orgA });
    const r = await readJson(
      await getVendors(
        req(`/api/v1/versions/${h.ids.draftB}/vendors`),
        params({ id: h.ids.draftB }),
      ),
    );
    expect(r.status).toBe(404);
    expect(envelopeCode(r.body)).toBe('not_found');
  });

  it('refuses a write to a FROZEN version with 409, before reading the body', async () => {
    // A wave in field keeps the panels and the signing configuration it was fielded with, and the
    // body is irrelevant to that answer.
    // There is no pre-frozen version in the fixture, so the draft is frozen in place — the same
    // move the redirects suite makes for its own 409 case.
    const h = createHarness();
    h.as({ userId: h.ids.programmerA, activeOrgId: h.ids.orgA });
    const index = h.data.versions.findIndex((v) => v.id === h.ids.draftA);
    const current = h.data.versions[index];
    if (current === undefined) throw new Error('fixture missing');
    h.data.versions[index] = {
      ...current,
      status: 'production',
      frozen_at: new Date(h.nowMs).toISOString(),
    };

    const r = await readJson(
      await putVendors(putRequest(h.ids.draftA, [vendor()]), params({ id: h.ids.draftA })),
    );
    expect(r.status).toBe(409);
    expect(envelopeCode(r.body)).toBe('frozen_version');
  });
});
