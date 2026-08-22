/**
 * `GET|PUT /api/v1/versions/:id/redirects` — API §2.9, the authoring path for
 * `content.redirects` (0010) and the last write the publish path was missing: the worker
 * assembles these rows into `Survey.redirects`, `CMP-0300` refuses a version without them, and
 * until this route existed no endpoint could put them there.
 *
 * ## Flattened rows, both directions
 *
 * The wire shape is the table's — one row per (scope, scope_key, disposition, custom_key) —
 * and NOT C §9's nested map, on purpose (API §2.9: "flattened, so 'is every disposition
 * covered' is a join, not a JSONB walk"). It is also field-for-field the worker's
 * `AuthoringRedirectRow`, so what PUT stores is literally what the publish read hands to
 * `redirectsOf`; a nested wire shape would mean this route owning a second copy of that
 * reassembly and disagreeing with it eventually.
 *
 * ## PUT is a whole-set replace
 *
 * PUT semantics because the resource is the SET: the runtime's resolution order
 * (`by_vendor → by_language → default`) makes the meaning of any one row depend on which other
 * rows exist, so "add one row" is not an operation an author performs — they edit the map in the
 * redirect editor and save it. Replace also makes deletion expressible without a fourth route.
 *
 * ## The 422 path (security §12.3)
 *
 * "Every template is validated on write … failures are 422, never stored." Validation runs to
 * completion over the whole set BEFORE the store is touched, and the details name each offending
 * row by index — see `src/server/redirects.ts` for the checks and for what is deliberately not
 * checked yet (the org host allowlist is security §12.3 check 7, control-plane, not built).
 *
 * ## No If-Match
 *
 * `PATCH /versions/:id` carries the optimistic lock because two authors merge FIELD edits; a
 * whole-set PUT has nothing to merge — last write wins is its meaning — and the ETag issuer must
 * stay singular (see the diagnostics route: a second `W/"…"` issuer invites a client to send it
 * back for a mutation it never read). The frozen check still applies, before everything:
 * ADR-002 makes a non-draft immutable, and "clone a new draft" is the actionable answer.
 */

import { AppError, frozenVersion } from '@resscript/observability';
import { requireRole } from '@/server/auth';
import { parseJsonBody, requireActiveOrg, route } from '@/server/http/handler';
import { json } from '@/server/http/respond';
import { replaceRedirectsSchema } from '@/server/http/schemas';
import { redirectSetDiagnostics } from '@/server/redirects';

export const GET = route<{ id: string }>(async (ctx, _req, params) => {
  // API §2.9 puts the READ at the programmer floor too, unlike diagnostics' client floor: a
  // redirect row is a vendor relationship (which panel, which callback host), which is not part
  // of what a review link is for.
  requireRole(ctx.role, 'programmer');
  requireActiveOrg(ctx);
  const version = await ctx.repos.surveys.getVersion(params.id);
  if (version === null) throw new AppError('not_found', 'version not found');
  const redirects = await ctx.repos.redirects.listRedirects(params.id);
  return json(
    {
      survey_version_id: version.id,
      redirects,
      links: { coverage: `/api/v1/versions/${version.id}/redirects/coverage` },
    },
    { requestId: ctx.requestId },
  );
});

export const PUT = route<{ id: string }>(async (ctx, req, params) => {
  requireRole(ctx.role, 'programmer');
  requireActiveOrg(ctx);
  const version = await ctx.repos.surveys.getVersion(params.id);
  if (version === null) throw new AppError('not_found', 'version not found');
  // Frozen check first, as in `PATCH /versions/:id`: where a respondent already in field is
  // sent is part of what the version published (0010's table comment), and the body is
  // irrelevant to that answer.
  if (version.status !== 'draft') throw frozenVersion(version.id);

  const { value } = await parseJsonBody(req, replaceRedirectsSchema);

  // `''` is the TABLE's encoding of "not applicable" (0010's biconditional CHECKs), so an
  // omitted key is materialized here, once, before validation reasons about the row — the shape
  // checks and the store must see the same row the client reads back.
  const rows = value.redirects.map((row) => ({
    scope: row.scope,
    scope_key: row.scope_key ?? '',
    disposition: row.disposition,
    custom_key: row.custom_key ?? '',
    url_template: row.url_template,
  }));

  // The whole set, validated to completion, before ANY write. `validation_failed` is 422 and
  // the details carry `redirects.<index>.<field>` paths — the row is not stored, so the index
  // into the submitted array is the only address the client has.
  const details = redirectSetDiagnostics(rows);
  if (details.length > 0) {
    throw new AppError(
      'validation_failed',
      `${details.length} redirect row${details.length === 1 ? '' : 's'} failed validation`,
      { details },
    );
  }

  const stored = await ctx.repos.redirects.replaceRedirects(params.id, rows);

  await ctx.repos.audit.write({
    action: 'version.redirects_replaced',
    target_kind: 'survey_version',
    target_id: version.id,
    survey_id: version.survey_id,
    survey_version_id: version.id,
    summary: `replaced the redirect map with ${stored.length} row${stored.length === 1 ? '' : 's'}`,
    // Counts, not templates: a callback URL can carry a vendor's signing parameters, and the
    // audit row outlives the row-level answer `GET` gives anyone entitled to the URLs.
    diff: { row_count: stored.length },
    request_id: ctx.requestId,
  });

  return json(
    {
      survey_version_id: version.id,
      redirects: stored,
      links: { coverage: `/api/v1/versions/${version.id}/redirects/coverage` },
    },
    { requestId: ctx.requestId },
  );
});
