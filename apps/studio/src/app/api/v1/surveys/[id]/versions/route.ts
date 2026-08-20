/**
 * `GET|POST /api/v1/surveys/:id/versions`
 *
 * Nested for listing and creation, flat by id for read/update (API §1.2). A new version is
 * always born a `draft` — `sv_insert`'s WITH CHECK pins `status = 'draft'` — so publishing is
 * an UPDATE that `tg_version_guard` validates rather than an INSERT that skips every gate.
 * A second draft is `409 already_exists` via `sv_one_draft`.
 */

import { AppError } from '@resscript/observability';
import { requireRole } from '@/server/auth';
import { parseJsonBody, requireActiveOrg, route } from '@/server/http/handler';
import { idempotencyKeyOf, withIdempotency } from '@/server/http/idempotency';
import { idPosition, pageEnvelope, pageQueryFrom } from '@/server/http/pagination';
import { json } from '@/server/http/respond';
import { createVersionSchema } from '@/server/http/schemas';
import { versionEtag } from '@/server/http/etag';

export const GET = route<{ id: string }>(async (ctx, req, params) => {
  requireRole(ctx.role, 'client');
  requireActiveOrg(ctx);
  const survey = await ctx.repos.surveys.get(params.id);
  if (survey === null) throw new AppError('not_found', 'survey not found');
  const page = pageQueryFrom(new URL(req.url));
  const { rows, hasMore } = await ctx.repos.surveys.listVersions(params.id, page);
  return json(pageEnvelope(rows, hasMore, page.limit, idPosition), { requestId: ctx.requestId });
});

export const POST = route<{ id: string }>(async (ctx, req, params) => {
  requireRole(ctx.role, 'programmer');
  const orgId = requireActiveOrg(ctx);
  const { value, raw } = await parseJsonBody(req, createVersionSchema);
  return withIdempotency(
    {
      store: ctx.repos.idempotency,
      orgId,
      endpoint: 'POST /surveys/:id/versions',
      key: idempotencyKeyOf(req),
      body: raw,
      requestId: ctx.requestId,
      now: ctx.now,
    },
    async () => {
      const version = await ctx.repos.surveys.createVersion({
        survey_id: params.id,
        // The SURVEY DOCUMENT's schema version (03 §18), not the SQL migration number — B §14.1
        // is emphatic that conflating the two is a specific and expensive confusion.
        schema_version: 1,
        ...(value.from_version_id === undefined ? {} : { from_version_id: value.from_version_id }),
        ...(value.notes === undefined ? {} : { notes: value.notes }),
      });
      await ctx.repos.audit.write({
        action: 'version.created',
        target_kind: 'survey_version',
        target_id: version.id,
        survey_id: params.id,
        survey_version_id: version.id,
        summary: 'created version ' + String(version.version_no),
        request_id: ctx.requestId,
      });
      return {
        status: 201,
        body: version,
        // The ETag of a freshly created version, so a client can mutate it without a GET first.
        headers: { ETag: versionEtag(version.revision, ctx.now()) },
      };
    },
  );
});
