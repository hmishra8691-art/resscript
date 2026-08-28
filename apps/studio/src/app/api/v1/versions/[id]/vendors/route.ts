/**
 * `GET|PUT /api/v1/versions/:id/vendors` — API §2.16, the authoring path for `content.vendors`
 * (0024) and the write P2-04 was missing.
 *
 * Every piece of vendor handling was built and tested in P1 against `Survey.vendors`: signature
 * verification that creates no session on failure, inbound-parameter binding, and the `by_vendor`
 * redirect tier. None of it ran, because no table fed it and then no endpoint fed the table. 0024
 * added the columns; this is the only way to put a row in one without SQL.
 *
 * ## PUT is a whole-set replace, like redirects
 *
 * The resource is the SET. A vendor's meaning depends on which others exist — `?src=` matches one
 * ref out of the set, and a duplicate ref makes the match non-deterministic — so "add one vendor"
 * is not an operation an author performs; they edit the vendor console and save it. Replace also
 * makes deletion expressible without a fourth route.
 *
 * ## Both verbs at the PROGRAMMER floor, read included
 *
 * The one content resource whose READ bar sits above the review bar, and 0024 states why: a vendor
 * row is a commercial relationship plus a pointer into the secrets store, a list of `secret_ref`s
 * is a map of that store, and a review link is shared outside the programming team. The redirects
 * route makes the same call for a narrower version of the same reason.
 *
 * ## What this route does NOT accept
 *
 * A secret. Only `security.secret_ref`, a pointer. 0024 refuses a secret-shaped value at write
 * time and the compiler's `assertNoSecrets` throws at publish — but both of those sit DOWNSTREAM of
 * a paste into a vendor console, which is this endpoint. So the check is here too, and its 422 can
 * say why rather than surfacing a constraint name.
 *
 * ## No If-Match
 *
 * Same reasoning as redirects: a whole-set PUT has nothing to merge, last write wins is its
 * meaning, and the ETag issuer stays singular. The frozen check runs first regardless — ADR-002
 * makes a non-draft immutable, and a wave in field keeps the panels and the signing configuration
 * it was fielded with.
 */

import { AppError, frozenVersion } from '@resscript/observability';
import { requireRole } from '@/server/auth';
import { parseJsonBody, requireActiveOrg, route } from '@/server/http/handler';
import { json } from '@/server/http/respond';
import { replaceVendorsSchema } from '@/server/http/schemas';
import type { ErrorDetail } from '@resscript/observability';
import type { VendorRow } from '@/server/repo/types';

/** What a pasted HMAC key looks like — 0024's CHECK, restated so the 422 can explain itself. */
const LOOKS_LIKE_SECRET = /^[A-Za-z0-9+/=_-]{32,}$/;

/**
 * Cross-field and cross-row facts Zod cannot name cheaply per row.
 *
 * Validated to completion over the whole set BEFORE the store is touched, and each detail names the
 * offending row by index — the row is not stored, so the index into the submitted array is the only
 * address the client has. One PUT produces ONE 422 naming every problem rather than the first.
 */
function vendorSetDiagnostics(rows: readonly VendorRow[]): readonly ErrorDetail[] {
  // `code` carries the CONSTRAINT NAME 0024 would have raised, so a client that hits the 422 and a
  // reader who hits the constraint are looking at the same identifier.
  const details: ErrorDetail[] = [];
  const refs = new Map<string, number>();

  rows.forEach((row, i) => {
    const at = `vendors.${String(i)}`;

    const firstAt = refs.get(row.ref);
    if (firstAt !== undefined) {
      details.push({
        path: `${at}.ref`,
        code: 'vendors_ref_key',
        message:
          `duplicate vendor ref ${JSON.stringify(row.ref)} (also at index ${String(firstAt)}). ` +
          'The ref is what `?src=` matches, so a duplicate makes which vendor an entry link ' +
          'belongs to non-deterministic.',
      });
    } else {
      refs.set(row.ref, i);
    }

    if (row.security !== null && LOOKS_LIKE_SECRET.test(row.security.secret_ref)) {
      details.push({
        path: `${at}.security.secret_ref`,
        code: 'vendors_secret_ref_is_a_reference',
        message:
          'secret_ref looks like a secret VALUE rather than a reference. It must name a secret in ' +
          'the secrets store (for example "vendor/panel_a/hmac"); the secret itself must never be ' +
          'stored in a survey, because artifacts are served from a CDN.',
      });
    }

    const params = new Map<string, number>();
    row.inbound_params.forEach((p, j) => {
      const firstParamAt = params.get(p.param);
      if (firstParamAt !== undefined) {
        details.push({
          path: `${at}.inbound_params.${String(j)}.param`,
          code: 'vendor_params_pkey',
          message:
            `duplicate parameter ${JSON.stringify(p.param)} (also at index ` +
            `${String(firstParamAt)}). Two mappings for one query parameter would make which ` +
            'variable it writes depend on iteration order.',
        });
      } else {
        params.set(p.param, j);
      }
    });

    // A signed vendor must sign at least one of its own inbound params, or the signature covers
    // nothing the vendor actually sends. 0024 requires signed_params to be non-empty; this is the
    // stronger, cross-field version it cannot express.
    if (row.security !== null && row.inbound_params.length > 0) {
      const declared = new Set(row.inbound_params.map((p) => p.param));
      const unknown = row.security.signed_params.filter((p) => !declared.has(p));
      if (unknown.length === row.security.signed_params.length) {
        details.push({
          path: `${at}.security.signed_params`,
          code: 'vendors_signed_params_declared',
          message:
            'none of the signed params is an inbound parameter this vendor declares, so the ' +
            'signature would cover nothing the panel sends. Sign at least one declared param.',
        });
      }
    }
  });

  return details;
}

export const GET = route<{ id: string }>(async (ctx, _req, params) => {
  requireRole(ctx.role, 'programmer');
  requireActiveOrg(ctx);
  const version = await ctx.repos.surveys.getVersion(params.id);
  if (version === null) throw new AppError('not_found', 'version not found');
  const vendors = await ctx.repos.vendors.listVendors(params.id);
  return json({ survey_version_id: version.id, vendors }, { requestId: ctx.requestId });
});

export const PUT = route<{ id: string }>(async (ctx, req, params) => {
  requireRole(ctx.role, 'programmer');
  requireActiveOrg(ctx);
  const version = await ctx.repos.surveys.getVersion(params.id);
  if (version === null) throw new AppError('not_found', 'version not found');
  // Frozen first, as in the redirects route: a wave in field keeps the panels it was fielded with,
  // and the body is irrelevant to that answer.
  if (version.status !== 'draft') throw frozenVersion(version.id);

  const { value } = await parseJsonBody(req, replaceVendorsSchema);

  // `security: undefined` and `security: null` mean the same thing — an unsigned vendor — and the
  // repo wants one spelling. Materialized here, once, before validation reasons about the row.
  const rows: readonly VendorRow[] = value.vendors.map((row) => ({
    id: row.id,
    ref: row.ref,
    name: row.name,
    entry_url_template: row.entry_url_template,
    max_completes: row.max_completes,
    quota_plan_overrides: [...row.quota_plan_overrides],
    inbound_params: row.inbound_params.map((p) => ({
      param: p.param,
      variable_ref: p.variable_ref,
      required: p.required,
    })),
    // The three optional fields are spread CONDITIONALLY rather than copied: under
    // `exactOptionalPropertyTypes` a spread carries `| undefined` onto an optional property, which
    // is a different type from the property being absent — and the row shape says absent.
    security:
      row.security === null || row.security === undefined
        ? null
        : {
            hash_param: row.security.hash_param,
            algorithm: row.security.algorithm,
            secret_ref: row.security.secret_ref,
            signed_params: [...row.security.signed_params],
            ...(row.security.max_skew_s === undefined
              ? {}
              : { max_skew_s: row.security.max_skew_s }),
            ...(row.security.timestamp_param === undefined
              ? {}
              : { timestamp_param: row.security.timestamp_param }),
            ...(row.security.nonce_param === undefined
              ? {}
              : { nonce_param: row.security.nonce_param }),
          },
  }));

  const details = vendorSetDiagnostics(rows);
  if (details.length > 0) {
    throw new AppError(
      'validation_failed',
      `${details.length} vendor problem${details.length === 1 ? '' : 's'} failed validation`,
      { details },
    );
  }

  const stored = await ctx.repos.vendors.replaceVendors(params.id, rows);
  return json({ survey_version_id: version.id, vendors: stored }, { requestId: ctx.requestId });
});
