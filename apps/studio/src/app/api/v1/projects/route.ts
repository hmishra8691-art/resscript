/**
 * `GET|POST /api/v1/projects`
 *
 * Sorted `created_at DESC, id DESC` and paginated by keyset (API §1.3). No `org_id` filter is
 * applied in TypeScript: `projects_select` already scopes to `app.current_org()` and narrows
 * per-project for freelancers and clients via `app.can_see_project()`.
 */

import { requireRole } from '@/server/auth';
import { parseJsonBody, requireActiveOrg, route } from '@/server/http/handler';
import { idempotencyKeyOf, withIdempotency } from '@/server/http/idempotency';
import { idPosition, pageEnvelope, pageQueryFrom } from '@/server/http/pagination';
import { json } from '@/server/http/respond';
import { createProjectSchema } from '@/server/http/schemas';

export const GET = route(async (ctx, req) => {
  // `client` is the floor, matching the policy: K §1 gives clients legitimate scoped access,
  // and `can_see_project()` is what actually narrows them.
  requireRole(ctx.role, 'client');
  requireActiveOrg(ctx);
  const url = new URL(req.url);
  const page = pageQueryFrom(url);
  const q = url.searchParams.get('q');
  const { rows, hasMore } = await ctx.repos.projects.list({
    ...page,
    ...(q === null ? {} : { q }),
    include_archived: url.searchParams.get('archived') === 'true',
  });
  return json(pageEnvelope(rows, hasMore, page.limit, idPosition), { requestId: ctx.requestId });
});

export const POST = route(async (ctx, req) => {
  // K §1 puts "create/archive projects" on project_manager, matching `projects_insert`.
  requireRole(ctx.role, 'project_manager');
  const orgId = requireActiveOrg(ctx);
  const { value, raw } = await parseJsonBody(req, createProjectSchema);
  return withIdempotency(
    {
      store: ctx.repos.idempotency,
      orgId,
      endpoint: 'POST /projects',
      key: idempotencyKeyOf(req),
      body: raw,
      requestId: ctx.requestId,
      now: ctx.now,
    },
    async () => {
      const project = await ctx.repos.projects.create({
        ref: value.ref,
        name: value.name,
        ...(value.client_name === undefined ? {} : { client_name: value.client_name }),
        ...(value.tags === undefined ? {} : { tags: value.tags }),
        ...(value.field_start === undefined ? {} : { field_start: value.field_start }),
        ...(value.field_end === undefined ? {} : { field_end: value.field_end }),
      });
      await ctx.repos.audit.write({
        action: 'project.created',
        target_kind: 'project',
        target_id: project.id,
        project_id: project.id,
        summary: 'created project ' + project.ref,
        request_id: ctx.requestId,
      });
      return { status: 201, body: project };
    },
  );
});
