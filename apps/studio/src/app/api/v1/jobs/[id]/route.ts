/**
 * `GET /api/v1/jobs/:id`
 *
 * Projects one `ops.jobs` row. `progress` is passed through with the worker's exact keys
 * (`{step, total, message, updated_at}`) because the studio's `JobStatus` component renders
 * "step N of M" off them; a handler that renamed them to `{done, outOf}` would be a component
 * that renders nothing.
 *
 * `Retry-After: 2` on a non-terminal job, per API §4's polling guidance (2 s backing off to
 * 15 s). Polling is the third-preference mechanism behind webhooks and the realtime broadcast,
 * and it is cheap: one indexed row read.
 */

import { AppError } from '@resscript/observability';
import { requireRole } from '@/server/auth';
import { requireActiveOrg, route } from '@/server/http/handler';
import { json } from '@/server/http/respond';

export const GET = route<{ id: string }>(async (ctx, _req, params) => {
  requireRole(ctx.role, 'client');
  requireActiveOrg(ctx);
  const job = await ctx.repos.jobs.get(params.id);
  // A job in another org is `not_found`, indistinguishable from one that never existed.
  if (job === null) throw new AppError('not_found', 'job not found');
  const terminal = job.status === 'succeeded' || job.status === 'failed' || job.status === 'cancelled';
  return json(
    {
      id: job.id,
      kind: job.kind,
      status: job.status,
      progress: job.progress,
      result: job.result,
      error: job.error,
      attempts: job.attempts,
      max_attempts: job.max_attempts,
      org_id: job.org_id,
      project_id: job.project_id,
      survey_version_id: job.survey_version_id,
      created_by: job.created_by,
      created_at: job.created_at,
      started_at: job.started_at,
      finished_at: job.finished_at,
      heartbeat_at: job.heartbeat_at,
      links: { self: '/api/v1/jobs/' + job.id },
    },
    {
      requestId: ctx.requestId,
      ...(terminal ? {} : { headers: { 'Retry-After': '2' } }),
    },
  );
});
