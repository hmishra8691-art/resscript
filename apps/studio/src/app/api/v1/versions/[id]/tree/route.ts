/**
 * `GET /api/v1/versions/:id/tree` — the outline, summary fields only (API §2.5).
 *
 * §2.5's full `TreeRow` (`label_preview`, `question_type`, `flags`, `rule_summaries`,
 * `diagnostic_counts`) belongs to P1-03's tree editor, whose payload assembly this route must
 * not pre-empt with a second definition. What exists TODAY is the projection
 * `RegistryRepo.forVersion` already reads — id, kind, parent, ref, required, sort order — and
 * that is exactly what P1-12's target picker and usage panels need to render a node by name.
 * Served as the documented route with the documented field names, so the P1-03 payload extends
 * this response rather than replacing it. `?fields=` is accepted and only `summary` exists.
 */

import { AppError } from '@resscript/observability';
import { requireRole } from '@/server/auth';
import { requireActiveOrg, route } from '@/server/http/handler';
import { json } from '@/server/http/respond';

export const GET = route<{ id: string }>(async (ctx, req, params) => {
  requireRole(ctx.role, 'reviewer');
  requireActiveOrg(ctx);
  const fields = new URL(req.url).searchParams.get('fields');
  if (fields !== null && fields !== 'summary') {
    throw new AppError('validation_failed', '1 field failed validation', {
      details: [
        { path: 'fields', code: 'not_implemented', message: 'only fields=summary exists until P1-03' },
      ],
    });
  }
  const rows = await ctx.repos.registry.forVersion(params.id);
  if (rows === null) throw new AppError('not_found', 'version not found');
  return json(
    {
      survey_version_id: rows.survey_version_id,
      data: rows.nodes.map((n) => ({
        id: n.id,
        kind: n.node_kind,
        parent_id: n.parent_id,
        ref: n.ref,
        required: n.required,
        sort_key: n.sort_key,
      })),
    },
    { requestId: ctx.requestId },
  );
});
