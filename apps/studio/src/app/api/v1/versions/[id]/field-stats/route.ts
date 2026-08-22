/**
 * `GET /api/v1/versions/:id/field-stats?include_test=` — the field dashboard's one read
 * (roadmap P1-12: "Response counter and a simple field dashboard (entries, completes,
 * screenouts, dispositions)").
 *
 * ## `is_test` is EXCLUDED by default — the P1-11 acceptance line, verbatim
 *
 * "A test session leaves is_test = true rows in the same tables as production rows and is
 * excluded from the default response count shown in studio." The exclusion lives in
 * `app.field_stats`' SQL (0013), not in a query parameter default a client could omit its way
 * past: an ABSENT `include_test` and `include_test=false` are the same request, and only the
 * literal string `true` turns test rows on. The response echoes the flag so the dashboard can
 * label the numbers it renders as the numbers it asked for.
 *
 * ## Derived fields are derived HERE, from one grouping
 *
 * `entries` (every session that started), `completes` and `screenouts` are sums over the same
 * `by_disposition` map the response carries — computed server-side so the counter widget and
 * the disposition table can never disagree, and so "entries" has exactly one definition (the
 * roadmap's "response counter" is this field). `IN_PROGRESS` is the function's spelling for a
 * session with no disposition yet (K §2's own name for that state); it counts toward
 * `entries` and toward nothing else.
 *
 * ## The floor is analyst, matching the function's own check
 *
 * Response counts are respondent data in aggregate — the same plane exports read from — and
 * `app.field_stats` re-checks analyst + org on every call (SECURITY DEFINER is the only
 * bridge into schema `runtime`, ADR-001). The route's copy exists for the 403 message; the
 * function's is the guarantee.
 */

import { AppError } from '@resscript/observability';
import { requireRole } from '@/server/auth';
import { requireActiveOrg, route } from '@/server/http/handler';
import { json } from '@/server/http/respond';

export const GET = route<{ id: string }>(async (ctx, req, params) => {
  requireRole(ctx.role, 'analyst');
  requireActiveOrg(ctx);
  const version = await ctx.repos.surveys.getVersion(params.id);
  if (version === null) throw new AppError('not_found', 'version not found');

  const includeTest = new URL(req.url).searchParams.get('include_test') === 'true';
  const counts = await ctx.repos.fieldStats.forVersion(params.id, includeTest);

  const byDisposition: Record<string, number> = {};
  let entries = 0;
  for (const { disposition, sessions } of counts) {
    byDisposition[disposition] = sessions;
    entries += sessions;
  }

  return json(
    {
      survey_version_id: version.id,
      include_test: includeTest,
      entries,
      completes: byDisposition['COMPLETE'] ?? 0,
      screenouts: byDisposition['SCREENOUT'] ?? 0,
      by_disposition: byDisposition,
    },
    { requestId: ctx.requestId },
  );
});
