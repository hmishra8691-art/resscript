/**
 * `GET|PATCH|DELETE /api/v1/projects/:id`
 *
 * DELETE is a HARD delete and requires the project to be archived first (`projects_delete`
 * carries `archived_at IS NOT NULL`), so destroying a project is always a second, deliberate
 * act. Archiving is `PATCH {archived: true}` — a soft delete, per B §0 ground rule 5.
 */

import { AppError } from '@resscript/observability';
import { requireRole } from '@/server/auth';
import { parseJsonBody, requireActiveOrg, route } from '@/server/http/handler';
import { json, noContent } from '@/server/http/respond';
import { updateProjectSchema } from '@/server/http/schemas';

export const GET = route<{ id: string }>(async (ctx, _req, params) => {
  requireRole(ctx.role, 'client');
  requireActiveOrg(ctx);
  const project = await ctx.repos.projects.get(params.id);
  if (project === null) throw new AppError('not_found', 'project not found');
  return json(project, { requestId: ctx.requestId });
});

export const PATCH = route<{ id: string }>(async (ctx, req, params) => {
  requireRole(ctx.role, 'project_manager');
  requireActiveOrg(ctx);
  const { value } = await parseJsonBody(req, updateProjectSchema);
  const before = await ctx.repos.projects.get(params.id);
  if (before === null) throw new AppError('not_found', 'project not found');
  const archivedAt =
    value.archived === undefined ? undefined : value.archived ? ctx.now().toISOString() : null;
  const project = await ctx.repos.projects.update(params.id, {
    ...(value.name === undefined ? {} : { name: value.name }),
    ...(value.client_name === undefined ? {} : { client_name: value.client_name }),
    ...(value.tags === undefined ? {} : { tags: value.tags }),
    ...(value.field_start === undefined ? {} : { field_start: value.field_start }),
    ...(value.field_end === undefined ? {} : { field_end: value.field_end }),
    ...(archivedAt === undefined ? {} : { archived_at: archivedAt }),
  });
  await ctx.repos.audit.write({
    action: value.archived === true ? 'project.archived' : 'project.updated',
    target_kind: 'project',
    target_id: project.id,
    project_id: project.id,
    summary: 'updated project ' + project.ref,
    diff: {
      name: { from: before.name, to: project.name },
      archived_at: { from: before.archived_at, to: project.archived_at },
    },
    request_id: ctx.requestId,
  });
  return json(project, { requestId: ctx.requestId });
});

export const DELETE = route<{ id: string }>(async (ctx, _req, params) => {
  // Hard delete is admin-only. In the full design this is a `202` job because it touches
  // partitioned tables (API §2.3); P1-01 has nothing partitioned under a project yet, so it is
  // synchronous and the job shape lands with the purge worker.
  requireRole(ctx.role, 'admin');
  requireActiveOrg(ctx);
  const before = await ctx.repos.projects.get(params.id);
  if (before === null) throw new AppError('not_found', 'project not found');
  if (before.archived_at === null) {
    throw new AppError('illegal_transition', 'archive the project before deleting it', {
      details: [{ path: null, code: 'not_archived', message: 'PATCH {"archived": true} first' }],
    });
  }
  await ctx.repos.projects.remove(params.id);
  await ctx.repos.audit.write({
    action: 'project.deleted',
    target_kind: 'project',
    target_id: params.id,
    summary: 'deleted project ' + before.ref,
    request_id: ctx.requestId,
  });
  return noContent(ctx.requestId);
});
