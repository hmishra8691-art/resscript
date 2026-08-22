/**
 * `GET|POST /api/v1/versions/:id/exports` — the export dialog's two verbs (roadmap P1-12,
 * API §2.15, migration 0012).
 *
 * ## POST is a row PLUS a job, in that order
 *
 * The `app.exports` row is the durable record ("who exported the open-ends, with or without
 * PII" — one row answers it, security §7.2) and the `ops.jobs` row is the work. The row is
 * created FIRST because it is where the two guards live — `exports_insert`'s analyst floor and
 * `app.tg_exports_pii_guard`'s capability check — and a job enqueued before the row exists
 * would be work whose authorization had not happened yet. The job payload is JUST the row id
 * (`{export_id}`): everything else — version, PII, test rows — lives on the row, where the
 * policies already judged it, and a payload that restated `pii_included` would be a second,
 * unguarded copy of a security decision (kinds/export.ts's own words).
 *
 * ## What this route does NOT enforce
 *
 * `pii_included`. The gate is 0012's trigger, running as the invoking role on the INSERT,
 * checking `app.has_capability('pii_access')` — capability, never rank (K §1). The route's
 * job is honest defaults (both flags false) and translating the trigger's 42501 into a 403
 * naming the grant. A route-level `if` here would be the more permissive of two checks the
 * moment the capability rules move, which is exactly the drift K exists to prevent.
 *
 * ## Idempotency
 *
 * The `Idempotency-Key` header replays the RESPONSE (API §1.4) for a client that retried a
 * request it never saw the answer to. There is deliberately NO derived job key: unlike
 * publish (where two clicks on unchanged content mean one compile), two deliberate export
 * requests are two files with two audit rows — a second click IS new work. The per-request
 * job key `export:<row id>` exists only so a crash between insert and enqueue cannot double
 * the work on the enqueue retry.
 */

import { AppError } from '@resscript/observability';
import { requireRole } from '@/server/auth';
import { parseJsonBody, requireActiveOrg, route } from '@/server/http/handler';
import { idempotencyKeyOf, withIdempotency } from '@/server/http/idempotency';
import { json } from '@/server/http/respond';
import { createExportSchema } from '@/server/http/schemas';
import { EXPORT_JOB_KIND } from '@/server/jobs';

export const GET = route<{ id: string }>(async (ctx, _req, params) => {
  // Analyst floor — `exports_select`'s own (security §7.1: exports are an analyst-and-above
  // surface). The history is org-visible at that floor: "who exported PII" is not a secret
  // from the people entitled to export.
  requireRole(ctx.role, 'analyst');
  requireActiveOrg(ctx);
  const version = await ctx.repos.surveys.getVersion(params.id);
  if (version === null) throw new AppError('not_found', 'version not found');
  const exports = await ctx.repos.exports.listForVersion(params.id);
  return json({ survey_version_id: version.id, exports }, { requestId: ctx.requestId });
});

export const POST = route<{ id: string }>(async (ctx, req, params) => {
  const orgId = requireActiveOrg(ctx);
  requireRole(ctx.role, 'analyst');
  const version = await ctx.repos.surveys.getVersion(params.id);
  if (version === null) throw new AppError('not_found', 'version not found');
  // No frozen check, deliberately: exports read responses, not content, and the version an
  // analyst exports is normally frozen. Any status may be exported — a draft that fielded
  // test sessions included.

  const { value, raw } = await parseJsonBody(req, createExportSchema);

  return withIdempotency(
    {
      store: ctx.repos.idempotency,
      orgId,
      endpoint: 'POST /versions/:id/exports',
      key: idempotencyKeyOf(req),
      body: raw,
      requestId: ctx.requestId,
      now: ctx.now,
    },
    async () => {
      const exportRow = await ctx.repos.exports.create({
        survey_version_id: version.id,
        pii_included: value.pii_included ?? false,
        include_test: value.include_test ?? false,
      });

      const { id: jobId } = await ctx.repos.jobs.enqueue({
        kind: EXPORT_JOB_KIND,
        // Snake_case, because this object is `ops.jobs.payload` and `apps/worker`'s
        // `exportJob.parse` reads exactly `export_id` (p.requiredString(raw, 'export_id')).
        payload: { export_id: exportRow.id },
        idempotency_key: `export:${exportRow.id}`,
        survey_version_id: version.id,
      });

      await ctx.repos.audit.write({
        action: 'export.requested',
        target_kind: 'export',
        target_id: exportRow.id,
        survey_id: version.survey_id,
        survey_version_id: version.id,
        summary:
          `requested a response export of version ${String(version.version_no)}` +
          (exportRow.pii_included ? ' INCLUDING PII' : '') +
          (exportRow.include_test ? ' including test rows' : ''),
        diff: {
          export_id: exportRow.id,
          job_id: jobId,
          pii_included: exportRow.pii_included,
          include_test: exportRow.include_test,
        },
        request_id: ctx.requestId,
      });

      // 202: the row exists but the file does not — the dialog polls the list (the row's
      // status is the export's lifecycle; the job is retry mechanics, 0012's enum comment).
      return {
        status: 202,
        body: { export: exportRow, job: { id: jobId } },
        headers: { Location: `/api/v1/jobs/${jobId}`, 'Retry-After': '2' },
      };
    },
  );
});
