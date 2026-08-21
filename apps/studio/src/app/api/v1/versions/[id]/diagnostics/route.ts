/**
 * `GET /api/v1/versions/:id/diagnostics` — H §2.4's `?severity` → `[CompileDiagnostic]`, plus the
 * compile state the list belongs to.
 *
 * ## Why the state ships with the list
 *
 * K §3 makes `status` and `compile_state` two orthogonal columns, and the publish dialog is the one
 * screen where the difference is load-bearing: an empty diagnostic list means "nothing to fix" when
 * `compile_state` is `compiled` and "nothing has been compiled yet" when it is `none`, and those
 * render as opposite things. Returning the array alone would make the client infer the state from
 * its length, which is the inference that shows a green tick on a version nobody has compiled.
 *
 * `summary` is counted server-side for the same reason `packages/compiler` exports
 * `compileErrors`/`compileWarnings` rather than letting a UI filter by severity itself: a client
 * that decided severity for itself would eventually disagree with the gate that blocked the
 * publish. Here the count is over the stored array, whose severities were written by the gate.
 *
 * ## What this route does not do
 *
 *  - **No ETag.** `GET /versions/:id` issues the optimistic-lock ETag and there must be exactly one
 *    issuer: a second `W/"<revision>.<ms>"` from a read-only projection invites a client to send it
 *    back as `If-Match` for a mutation it never read.
 *  - **No recompute.** The diagnostics are the LAST compile's, read from
 *    `survey_versions.compile_diagnostics`, and 0009's column comment says why they live there
 *    rather than on the job row: "the job is retained for a while and the version is retained
 *    forever, and 'why can I not publish this' outlives any queue".
 *  - **No `?code=` filter.** `severity` is what the dialog's two tabs need; a code filter would be
 *    a query language over a list the client already holds in full.
 */

import { AppError } from '@resscript/observability';
import type { JsonValue } from '@resscript/schema';
import { requireRole } from '@/server/auth';
import { requireActiveOrg, route } from '@/server/http/handler';
import { json } from '@/server/http/respond';

const SEVERITIES = ['error', 'warning', 'info'] as const;
type Severity = (typeof SEVERITIES)[number];

function severityOf(entry: JsonValue): string | null {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return null;
  const value = (entry as { readonly [key: string]: JsonValue })['severity'];
  return typeof value === 'string' ? value : null;
}

export const GET = route<{ id: string }>(async (ctx, req, params) => {
  // Same floor as `GET /versions/:id`: a reviewer or a client following a review link has to be
  // able to see why a version will not publish, and the diagnostics name questions they can
  // already read.
  requireRole(ctx.role, 'client');
  requireActiveOrg(ctx);
  const version = await ctx.repos.surveys.getVersion(params.id);
  if (version === null) throw new AppError('not_found', 'version not found');

  const requested = new URL(req.url).searchParams.get('severity');
  if (requested !== null && !(SEVERITIES as readonly string[]).includes(requested)) {
    throw new AppError('validation_failed', '1 field failed validation', {
      details: [
        {
          path: 'severity',
          code: 'invalid_enum',
          message: SEVERITIES.join(', '),
        },
      ],
    });
  }
  const filter = requested as Severity | null;

  const all = version.compile_diagnostics;
  const diagnostics = filter === null ? all : all.filter((d) => severityOf(d) === filter);

  return json(
    {
      survey_version_id: version.id,
      status: version.status,
      compile_state: version.compile_state,
      artifact_hash: version.artifact_hash,
      artifact_bytes: version.artifact_bytes,
      revision: version.revision,
      // The acknowledgement record, which the dialog needs in order NOT to ask a second time for a
      // warning already signed off. Sealed on a frozen version by `app.tg_version_guard`, which is
      // what makes it evidence rather than state.
      acknowledged_warnings: version.acknowledged_warnings,
      diagnostics,
      summary: {
        total: all.length,
        errors: all.filter((d) => severityOf(d) === 'error').length,
        warnings: all.filter((d) => severityOf(d) === 'warning').length,
      },
      links: { version: '/api/v1/versions/' + version.id },
    },
    { requestId: ctx.requestId },
  );
});
