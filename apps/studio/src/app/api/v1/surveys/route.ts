/**
 * `GET|POST /api/v1/surveys`
 *
 * Creating a survey ALWAYS creates its `draft` version (API §2.3: "a survey with no version is
 * not addressable"), so the response is `{survey, draft_version}` and the studio can navigate
 * straight into the editor.
 */

import { requireRole } from '@/server/auth';
import { parseJsonBody, requireActiveOrg, route } from '@/server/http/handler';
import { idempotencyKeyOf, withIdempotency } from '@/server/http/idempotency';
import { idPosition, pageEnvelope, pageQueryFrom } from '@/server/http/pagination';
import { json } from '@/server/http/respond';
import { createSurveySchema } from '@/server/http/schemas';

export const GET = route(async (ctx, req) => {
  requireRole(ctx.role, 'client');
  requireActiveOrg(ctx);
  const url = new URL(req.url);
  const page = pageQueryFrom(url);
  const projectId = url.searchParams.get('project_id');
  const q = url.searchParams.get('q');
  const { rows, hasMore } = await ctx.repos.surveys.list({
    ...page,
    ...(projectId === null ? {} : { project_id: projectId }),
    ...(q === null ? {} : { q }),
    include_archived: url.searchParams.get('archived') === 'true',
  });
  return json(pageEnvelope(rows, hasMore, page.limit, idPosition), { requestId: ctx.requestId });
});

export const POST = route(async (ctx, req) => {
  // `surveys_insert` is programmer-and-above within project scope.
  requireRole(ctx.role, 'programmer');
  const orgId = requireActiveOrg(ctx);
  const { value, raw } = await parseJsonBody(req, createSurveySchema);
  return withIdempotency(
    {
      store: ctx.repos.idempotency,
      orgId,
      endpoint: 'POST /surveys',
      key: idempotencyKeyOf(req),
      body: raw,
      requestId: ctx.requestId,
      now: ctx.now,
    },
    async () => {
      const created = await ctx.repos.surveys.create({
        project_id: value.project_id,
        ref: value.ref,
        name: value.name,
        ...(value.description === undefined ? {} : { description: value.description }),
        ...(value.survey_kind === undefined ? {} : { survey_kind: value.survey_kind }),
        ...(value.default_language === undefined ? {} : { default_language: value.default_language }),
        ...(value.parent_survey_id === undefined ? {} : { parent_survey_id: value.parent_survey_id }),
      });
      await ctx.repos.audit.write({
        action: 'survey.created',
        target_kind: 'survey',
        target_id: created.survey.id,
        project_id: created.survey.project_id,
        survey_id: created.survey.id,
        survey_version_id: created.draft_version.id,
        summary: 'created survey ' + created.survey.ref,
        request_id: ctx.requestId,
      });
      return { status: 201, body: { survey: created.survey, draft_version: created.draft_version } };
    },
  );
});
