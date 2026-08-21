/**
 * `POST /api/v1/versions/:id/publish`
 *
 * Queues one `compile` job and answers `202` with it (API §4: "any operation that can exceed a few
 * seconds returns 202 and a job"). Publishing is not a field update — it runs a compiler, writes
 * an artifact to object storage, mints or repoints a survey token and moves the version's status —
 * which is why `PATCH /versions/:id` refuses `status` and this endpoint exists.
 *
 * What this route decides, and what it deliberately leaves to somebody else:
 *
 *  - **The floor.** K §1: `project_manager` for production, `programmer` for staging. Enforced
 *    here AND by `app.publish_version`, which is the guarantee; `src/server/publish.ts` explains
 *    why the API must not be the more permissive of the two, and audits the refusal.
 *  - **The transition.** `409 illegal_transition` BEFORE the job is queued (H §2.4), because
 *    `draft → production` is a real mistake — the review step was skipped — and a queued job whose
 *    only outcome is `app.tg_version_guard`'s `check_violation` tells the author nothing.
 *  - **Nothing about the survey's contents.** No diagnostics, no artifact, no decision about
 *    warnings. The gate is `packages/compiler`'s and it runs in the worker; a route that
 *    pre-validated would be a second implementation of the gate, and the two would eventually
 *    disagree about whether a publish may proceed.
 *
 * ## Two layers of idempotency, and why both
 *
 * `Idempotency-Key` (API §1.4) replays the RESPONSE, and `ops.jobs.idempotency_key` +
 * `jobs_idem_key` de-duplicate the WORK. They answer different questions: the header protects a
 * client that retried a request it never saw the answer to, and the job key is what makes M0.4's
 * "double-clicking Publish produces exactly one job row" true for two requests that both arrived.
 * A client that sends no header still gets the second, because the job key is DERIVED — from the
 * version, the target and the version's `revision`, so an edit between two clicks correctly
 * produces a second job while two clicks on unchanged content produce one.
 *
 * ## The acknowledgement record
 *
 * The audit row written here carries the keys and the author's notes as SUBMITTED. The worker
 * writes a second row at publish time carrying the warnings the compile actually raised. Both
 * exist on purpose: this one answers "what did the human sign", that one answers "what did they
 * sign it for", and a stale key for a warning that no longer fires must not read as a sign-off.
 */

import { AppError } from '@resscript/observability';
import type { JsonValue } from '@resscript/schema';
import { requireActiveOrg, parseJsonBody, route } from '@/server/http/handler';
import { idempotencyKeyOf, withIdempotency } from '@/server/http/idempotency';
import { json } from '@/server/http/respond';
import { publishVersionSchema } from '@/server/http/schemas';
import { COMPILE_JOB_KIND, jobEnvelope } from '@/server/jobs';
import { PUBLISH_FLOORS, assertLegalTransition, requireCapabilityAudited } from '@/server/publish';

export const POST = route<{ id: string }>(async (ctx, req, params) => {
  const orgId = requireActiveOrg(ctx);
  // Read BEFORE the capability check, so the floor can be chosen from the target and the audit row
  // can name the survey. A version in another org is `null` here and therefore a 404 — the refusal
  // audit is never reached, so a cross-tenant probe leaves no row naming a survey it cannot see.
  const version = await ctx.repos.surveys.getVersion(params.id);
  if (version === null) throw new AppError('not_found', 'version not found');

  const { value, raw } = await parseJsonBody(req, publishVersionSchema);
  const target = value.target;

  await requireCapabilityAudited(
    ctx,
    PUBLISH_FLOORS[target],
    'version.publish_refused',
    { surveyId: version.survey_id, surveyVersionId: version.id },
    { target_status: target, from_status: version.status },
  );

  assertLegalTransition(version.status, target);

  const acknowledged = value.acknowledge_warnings ?? [];

  return withIdempotency(
    {
      store: ctx.repos.idempotency,
      orgId,
      endpoint: 'POST /versions/:id/publish',
      key: idempotencyKeyOf(req),
      body: raw,
      requestId: ctx.requestId,
      now: ctx.now,
    },
    async () => {
      const { id, created } = await ctx.repos.jobs.enqueue({
        kind: COMPILE_JOB_KIND,
        // Snake_case keys, because this object is `ops.jobs.payload` and `apps/worker`'s
        // `compileJob.parse` reads it verbatim. The payload carries KEYS and not the submitted
        // objects: the worker compares them with `acknowledgementKey()` and has no use for a note.
        payload: {
          survey_version_id: version.id,
          target_status: target,
          acknowledged_warnings: acknowledged.map((w) => w.key),
        },
        idempotency_key: `publish:${version.id}:${target}:r${String(version.revision)}`,
        survey_version_id: version.id,
      });

      await ctx.repos.audit.write({
        action: 'version.publish_requested',
        target_kind: 'survey_version',
        target_id: version.id,
        survey_id: version.survey_id,
        survey_version_id: version.id,
        summary:
          `queued a publish of version ${String(version.version_no)} to ${target}` +
          (acknowledged.length === 0
            ? ''
            : ` with ${String(acknowledged.length)} acknowledged warning(s)`),
        diff: {
          target_status: target,
          from_status: version.status,
          job_id: id,
          // 03 §17's recorded note, verbatim as submitted. Recorded here rather than only in the
          // worker's row because this is the moment a human decided, and the compile that follows
          // may not even reach the warning they were signing for.
          acknowledged_warnings: acknowledged.map(
            (w): JsonValue => ({ key: w.key, reason: w.reason ?? null }),
          ),
        },
        request_id: ctx.requestId,
      });

      const job = await ctx.repos.jobs.get(id);
      return {
        // `created === false` means an existing job under the same key was returned, which API §4
        // maps to 200 rather than 201/202: telling a user their click started work when it
        // attached to an in-flight job is the distinction migration 0005 re-signed the function to
        // make possible.
        status: created ? 202 : 200,
        body: { job: job === null ? { id } : jobEnvelope(job) },
        headers: { Location: `/api/v1/jobs/${id}`, 'Retry-After': '2' },
      };
    },
  );
});
