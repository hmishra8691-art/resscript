/**
 * `POST /api/v1/versions/:id/compile` — the DRY compile.
 *
 * H §2.4: "Dry compile: produces diagnostics and an artifact but does not change `status`." It
 * exists so that seeing a diagnostic does not require attempting a publish. Without it the only
 * way an author learns their Q12 reads Q20 is a refused publish, which teaches them to treat a
 * refusal as the normal way to check their work — and a team that publishes to find out is a team
 * that will eventually publish something it did not mean to.
 *
 * The same job as publish, with no target. `apps/worker`'s `compileJob` reads an absent
 * `target_status` as the dry run and swaps its last stage — the `app.publish_version` transaction
 * — for a diagnostics-and-artifact write under `sv_update`. Everything before that stage is
 * byte-identical, which is the point: a dry compile that ran a DIFFERENT pipeline would be a
 * second gate, and the two would eventually disagree about whether a survey is publishable.
 *
 * WHY THE FLOOR IS `programmer` AND NOT THE TARGET'S. `PUBLISH_FLOORS` splits staging from
 * production because a publish moves a version into field (K §1). A dry compile moves nothing, so
 * the floor is the ordinary content-write floor — the same one that let the author create the
 * questions being checked. Requiring `project_manager` to CHECK a survey would mean a programmer
 * can write logic they are not allowed to validate.
 *
 * The idempotency key is derived the same way publish derives its own — version + revision, with
 * the target's slot spelled `dry` — so two clicks on unchanged content attach to one job while an
 * edit between them correctly produces a second.
 */

import { AppError } from '@resscript/observability';
import { requireRole } from '@/server/auth';
import { requireActiveOrg, route } from '@/server/http/handler';
import { idempotencyKeyOf, withIdempotency } from '@/server/http/idempotency';
import { COMPILE_JOB_KIND, jobEnvelope } from '@/server/jobs';

export const POST = route<{ id: string }>(async (ctx, req, params) => {
  const orgId = requireActiveOrg(ctx);
  requireRole(ctx.role, 'programmer');

  // Read before anything else: a version in another org is `null` here and therefore a 404, so a
  // cross-tenant probe never reaches the queue.
  const version = await ctx.repos.surveys.getVersion(params.id);
  if (version === null) throw new AppError('not_found', 'version not found');

  return withIdempotency(
    {
      store: ctx.repos.idempotency,
      orgId,
      endpoint: 'POST /versions/:id/compile',
      key: idempotencyKeyOf(req),
      body: null,
      requestId: ctx.requestId,
      now: ctx.now,
    },
    async () => {
      const { id, created } = await ctx.repos.jobs.enqueue({
        kind: COMPILE_JOB_KIND,
        // No `target_status`: that absence IS the dry run (see the worker's `parse`). No
        // acknowledgements either — a signature belongs to the publish a human pressed, and a
        // dry run reports unacknowledged warnings rather than blocking on them.
        payload: { survey_version_id: version.id },
        idempotency_key: `compile:${version.id}:dry:r${String(version.revision)}`,
        survey_version_id: version.id,
      });

      const job = await ctx.repos.jobs.get(id);
      return {
        // 200 when an in-flight job under the same key was returned, 202 when this click started
        // one — the same distinction the publish route makes.
        status: created ? 202 : 200,
        body: { job: job === null ? { id } : jobEnvelope(job) },
        headers: { Location: `/api/v1/jobs/${id}`, 'Retry-After': '2' },
      };
    },
  );
});
