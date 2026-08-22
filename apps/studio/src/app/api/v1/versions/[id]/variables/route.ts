/**
 * `GET /api/v1/versions/:id/variables` — the version's variable registry (API §2.6).
 *
 * The minimal read of §2.6's row: what the rule builder's pickers need — `vtype` drives the
 * operator dropdown, `enum_domain` fills the value dropdown, `source_question_id` groups the
 * picker by question. Sorted by `sort_key`, which §2.6 pins as "manifest order = export column
 * order". The write half of §2.6 (`POST`, `PATCH`, `DELETE` with `rules_affected`) belongs with
 * the variables editor, not this milestone; unpaginated because the read reuses
 * `RegistryRepo.forVersion` — the same one request the DSL endpoints make per keystroke.
 */

import { AppError } from '@resscript/observability';
import { requireRole } from '@/server/auth';
import { requireActiveOrg, route } from '@/server/http/handler';
import { json } from '@/server/http/respond';

export const GET = route<{ id: string }>(async (ctx, _req, params) => {
  requireRole(ctx.role, 'reviewer');
  requireActiveOrg(ctx);
  const rows = await ctx.repos.registry.forVersion(params.id);
  if (rows === null) throw new AppError('not_found', 'version not found');
  return json(
    {
      survey_version_id: rows.survey_version_id,
      data: rows.variables.map((v) => ({
        id: v.id,
        name: v.name,
        kind: v.kind,
        vtype: v.vtype,
        enum_domain: v.enum_domain,
        source_question_id: v.source_question_id,
        pii: v.pii,
      })),
    },
    { requestId: ctx.requestId },
  );
});
