/**
 * `POST /api/v1/surveys/:id/rollback`
 *
 * `archived → production` plus repointing the survey's token, in one transaction. SYNCHRONOUS, and
 * H §2.4 says why: "it is two column writes and a token update, not a compile". There is no job,
 * no `202`, and no compile — the target version's artifact was built when it was published and
 * ADR-002 addresses it by the sha256 of its own content, so rolling back is repointing a URL at
 * bytes that already exist. That is also what makes the acceptance criterion true: "the runtime
 * serves byte-identical bytes to what was live before" follows from nothing rewriting a hash,
 * rather than from copying anything.
 *
 * ## Keyed on the SURVEY, which deviates from H §2.4's path
 *
 * The deliverable writes `POST /v1/versions/{id}/rollback {to_version_id}`, i.e. two version ids
 * for one operation. `app.rollback_version` takes exactly ONE — the target — and derives the
 * survey and the incumbent from it, because "which version is live" is a single row
 * (`sv_one_production`) and not something a caller should be able to disagree with. A route with
 * both ids would have to either ignore the path id (a parameter that does nothing) or validate it
 * against the row it just read (an argument the caller can only get wrong). The survey is the
 * resource whose live pointer moves, so it is the resource the verb hangs off. Recorded here as a
 * deliberate deviation rather than left for a reader to notice.
 *
 * ## No `If-Match`
 *
 * Every other mutation in this API requires it (API §1.7), and this one deliberately does not.
 * `If-Match` protects a read-modify-write against a colleague's interleaved write, and there is no
 * read-modify-write here: the caller supplies a target id, and the function reads, locks
 * (`FOR UPDATE` on the version and then on the survey) and writes inside one transaction. A
 * revision the route checked would be a revision that could move between the check and the RPC —
 * a lock that appears to exist and does not, which is worse than no lock. The concurrency
 * guarantee is the function's row lock, and `sv_one_production` is the invariant it protects.
 *
 * The audit row is written by `app.rollback_version` itself (`version.rolled_back`, carrying the
 * from/to version ids, the hash and the token), so this route writes none on success — a second
 * row would make the trail say a rollback happened twice. It DOES write one on refusal: see
 * `src/server/publish.ts`.
 */

import { AppError } from '@resscript/observability';
import { requireActiveOrg, parseJsonBody, route } from '@/server/http/handler';
import { json } from '@/server/http/respond';
import { rollbackSurveySchema } from '@/server/http/schemas';
import { ROLLBACK_FLOOR, requireCapabilityAudited } from '@/server/publish';

export const POST = route<{ id: string }>(async (ctx, req, params) => {
  requireActiveOrg(ctx);
  const survey = await ctx.repos.surveys.get(params.id);
  if (survey === null) throw new AppError('not_found', 'survey not found');

  const { value } = await parseJsonBody(req, rollbackSurveySchema);
  const target = await ctx.repos.surveys.getVersion(value.to_version_id);
  // A target in another survey — or another org — is `404` on the TARGET and not `422`, because
  // "that version is not in this survey" and "that version does not exist" must read the same to a
  // caller who is guessing ids. The function makes the same conflation for the same reason.
  if (target === null || target.survey_id !== survey.id) {
    throw new AppError('not_found', 'rollback target not found', {
      details: [{ path: 'to_version_id', code: 'not_found', message: value.to_version_id }],
    });
  }

  await requireCapabilityAudited(
    ctx,
    ROLLBACK_FLOOR,
    'version.rollback_refused',
    { surveyId: survey.id, surveyVersionId: target.id },
    { to_version_id: target.id, to_status: target.status },
  );

  const result = await ctx.repos.surveys.rollback(target.id, ctx.requestId);
  const promoted = await ctx.repos.surveys.getVersion(result.to_version_id);

  return json(
    {
      survey_id: result.survey_id,
      from_version_id: result.from_version_id,
      to_version_id: result.to_version_id,
      // The hash the token now points at. Unchanged by the rollback — that is the point — so a
      // client can compare it with what it recorded as live before and see the identity directly.
      artifact_hash: result.artifact_hash,
      token: result.token,
      version: promoted,
      links: { version: '/api/v1/versions/' + result.to_version_id },
    },
    { requestId: ctx.requestId },
  );
});
