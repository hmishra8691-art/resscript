/**
 * `GET /api/v1/jobs/:id`
 *
 * Projects one `ops.jobs` row through `jobEnvelope`, which is the same projection every job
 * -creating endpoint's `202` body uses — `progress` passes through with the worker's exact keys
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
import { isTerminal, jobEnvelope } from '@/server/jobs';

export const GET = route<{ id: string }>(async (ctx, _req, params) => {
  requireRole(ctx.role, 'client');
  requireActiveOrg(ctx);
  const job = await ctx.repos.jobs.get(params.id);
  // A job in another org is `not_found`, indistinguishable from one that never existed.
  if (job === null) throw new AppError('not_found', 'job not found');
  return json(jobEnvelope(job), {
    requestId: ctx.requestId,
    ...(isTerminal(job) ? {} : { headers: { 'Retry-After': '2' } }),
  });
});
