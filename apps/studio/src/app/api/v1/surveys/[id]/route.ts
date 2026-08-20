/**
 * `GET|PATCH|DELETE /api/v1/surveys/:id`
 *
 * PATCH covers rename (`name`), re-ref (`ref`, refused once a non-draft version exists — a ref
 * that has reached a client in an export file name is no longer free to change) and archive.
 */

import { AppError } from '@resscript/observability';
import { requireRole } from '@/server/auth';
import { parseJsonBody, requireActiveOrg, route } from '@/server/http/handler';
import { json, noContent } from '@/server/http/respond';
import { updateSurveySchema } from '@/server/http/schemas';

export const GET = route<{ id: string }>(async (ctx, _req, params) => {
  requireRole(ctx.role, 'client');
  requireActiveOrg(ctx);
  const survey = await ctx.repos.surveys.get(params.id);
  if (survey === null) throw new AppError('not_found', 'survey not found');
  const versions = await ctx.repos.surveys.listVersions(params.id, { limit: 50 });
  return json(
    {
      ...survey,
      // K §3: `status` and `compile_state` are separate axes and both are reported. A UI that
      // renders one of them as "the state" is a UI that shows a failed compile as live.
      versions: versions.rows.map((v) => ({
        id: v.id,
        version_no: v.version_no,
        status: v.status,
        compile_state: v.compile_state,
        revision: v.revision,
      })),
    },
    { requestId: ctx.requestId },
  );
});

export const PATCH = route<{ id: string }>(async (ctx, req, params) => {
  requireRole(ctx.role, 'programmer');
  requireActiveOrg(ctx);
  const { value } = await parseJsonBody(req, updateSurveySchema);
  const before = await ctx.repos.surveys.get(params.id);
  if (before === null) throw new AppError('not_found', 'survey not found');
  const archivedAt =
    value.archived === undefined ? undefined : value.archived ? ctx.now().toISOString() : null;
  const survey = await ctx.repos.surveys.update(params.id, {
    ...(value.name === undefined ? {} : { name: value.name }),
    ...(value.description === undefined ? {} : { description: value.description }),
    ...(value.ref === undefined ? {} : { ref: value.ref }),
    ...(archivedAt === undefined ? {} : { archived_at: archivedAt }),
  });
  await ctx.repos.audit.write({
    action: value.archived === true ? 'survey.archived' : 'survey.updated',
    target_kind: 'survey',
    target_id: survey.id,
    project_id: survey.project_id,
    survey_id: survey.id,
    summary: 'updated survey ' + survey.ref,
    diff: {
      name: { from: before.name, to: survey.name },
      ref: { from: before.ref, to: survey.ref },
      archived_at: { from: before.archived_at, to: survey.archived_at },
    },
    request_id: ctx.requestId,
  });
  return json(survey, { requestId: ctx.requestId });
});

export const DELETE = route<{ id: string }>(async (ctx, _req, params) => {
  requireRole(ctx.role, 'admin');
  requireActiveOrg(ctx);
  const before = await ctx.repos.surveys.get(params.id);
  if (before === null) throw new AppError('not_found', 'survey not found');
  if (before.archived_at === null) {
    throw new AppError('illegal_transition', 'archive the survey before deleting it', {
      details: [{ path: null, code: 'not_archived', message: 'PATCH {"archived": true} first' }],
    });
  }
  await ctx.repos.surveys.remove(params.id);
  await ctx.repos.audit.write({
    action: 'survey.deleted',
    target_kind: 'survey',
    target_id: params.id,
    survey_id: params.id,
    summary: 'deleted survey ' + before.ref,
    request_id: ctx.requestId,
  });
  return noContent(ctx.requestId);
});
