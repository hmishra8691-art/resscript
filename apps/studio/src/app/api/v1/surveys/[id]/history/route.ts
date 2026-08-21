/**
 * `GET /api/v1/surveys/:id/history` — the version-history panel's read (roadmap P1-08 Frontend:
 * "version history with rollback").
 *
 * ## Why this is not `GET /surveys/:id/versions`
 *
 * That endpoint is the collection: keyset-paginated (API §1.3), full rows, ordered
 * `created_at DESC, id DESC`. This one answers a different question — "what has this survey
 * shipped, and what can I roll back to" — and the two differ in three ways that matter:
 *
 *  1. **Version order, not creation order.** A history panel reads newest-version-first, and
 *     `version_no` is the number a user recognises; `sv_survey_idx` is `(survey_id, version_no
 *     DESC)` for exactly this read. Creation order and version order coincide today and will not
 *     once a tracker wave clones out of order.
 *  2. **`can_roll_back` is computed HERE.** `app.rollback_version` refuses a target that is not
 *     `archived`, one whose `compile_state` is not `compiled` or whose `artifact_hash` is NULL,
 *     and a survey with nothing live to replace. A client that re-derived that rule would
 *     eventually offer a button the database refuses, which is the worst kind of UI bug: the user
 *     did the right thing and got an error. Computing it once server-side is the same argument
 *     `GET /versions/{id}/translations/completeness` makes for the publish gate — "the studio and
 *     CI read the same number".
 *  3. **No pagination.** A survey has tens of versions, not thousands, and a history panel that
 *     paginated would hide the archived version a user is trying to roll back to. The page size is
 *     capped at the collection endpoint's maximum so the response cannot grow unbounded; a survey
 *     past that cap is pathological and the collection endpoint is the honest way to read it.
 *
 * The projection is narrow on purpose: no `notes`, no `compile_diagnostics`. A history row that
 * carried every version's diagnostics would be a response whose size is quadratic in the survey's
 * age, and `GET /versions/:id/diagnostics` is one request away.
 */

import { AppError } from '@resscript/observability';
import { requireRole } from '@/server/auth';
import { requireActiveOrg, route } from '@/server/http/handler';
import { json } from '@/server/http/respond';
import { MAX_LIMIT } from '@/server/http/pagination';
import type { SurveyVersionRow } from '@/server/repo/types';

/** Exactly `app.rollback_version`'s three refusals, minus the one about the survey. */
function isRollbackTarget(version: SurveyVersionRow): boolean {
  return (
    version.status === 'archived' &&
    version.compile_state === 'compiled' &&
    version.artifact_hash !== null
  );
}

export const GET = route<{ id: string }>(async (ctx, _req, params) => {
  requireRole(ctx.role, 'client');
  requireActiveOrg(ctx);
  const survey = await ctx.repos.surveys.get(params.id);
  if (survey === null) throw new AppError('not_found', 'survey not found');

  const { rows, hasMore } = await ctx.repos.surveys.listVersions(params.id, {
    limit: MAX_LIMIT,
  });
  const ordered = [...rows].sort((a, b) => b.version_no - a.version_no);
  const live = ordered.find((v) => v.status === 'production') ?? null;
  // No production version means there is nothing to roll back FROM, which is a property of the
  // survey and not of any candidate — `app.rollback_version` raises "no production version to roll
  // back from" and points at publish instead. Reflected here so the panel disables every button
  // for the right reason rather than for a per-version one.
  const rollbackPossible = live !== null;

  return json(
    {
      survey_id: survey.id,
      survey_ref: survey.ref,
      live_version_id: live?.id ?? null,
      versions: ordered.map((version) => ({
        id: version.id,
        version_no: version.version_no,
        status: version.status,
        compile_state: version.compile_state,
        artifact_hash: version.artifact_hash,
        artifact_bytes: version.artifact_bytes,
        revision: version.revision,
        created_at: version.created_at,
        frozen_at: version.frozen_at,
        published_at: version.published_at,
        can_roll_back: rollbackPossible && isRollbackTarget(version),
        links: {
          self: '/api/v1/versions/' + version.id,
          diagnostics: '/api/v1/versions/' + version.id + '/diagnostics',
        },
      })),
      // True only for a survey with more versions than one response should carry. The collection
      // endpoint is the paginated read; this flag exists so the panel can say so rather than
      // silently showing a prefix.
      truncated: hasMore,
    },
    { requestId: ctx.requestId },
  );
});
