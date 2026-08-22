/**
 * `POST /api/v1/versions/:id/preview-token` — mint the capability the sandboxed preview iframe
 * loads with (P1-11, security §3.2).
 *
 * A POST and not a GET, for the same reason publish is: minting is an action with a
 * consequence (a live capability to walk an unpublished survey), not a read — and a GET here
 * would invite intermediaries and prefetchers to mint tokens nobody asked for.
 *
 * What the route decides:
 *
 *  - **The floor.** `client`, matching `GET /versions/:id` and `/diagnostics`: anyone who may
 *    read the version may preview it — a reviewer or a client following a review link clicks
 *    through the survey they are reviewing. The token opens exactly one artifact, so the floor
 *    grants nothing the read routes did not.
 *  - **The artifact.** The version's own `artifact_hash`, refused with `409` when
 *    `compile_state` is not `compiled` — see `requireCompiledArtifact` for why both columns.
 *  - **Server-side only.** `PREVIEW_SIGNING_SECRET` is read here and nowhere nearer the
 *    browser; what leaves is the derived token, scoped to one hash and ten minutes.
 *
 * `preview_url` is returned assembled rather than as parts, so the client cannot compose it
 * against the wrong origin — the origin in this URL is also what the preview panel checks
 * every incoming `postMessage` against.
 */

import { AppError } from '@resscript/observability';
import { requireRole } from '@/server/auth';
import { requireActiveOrg, route } from '@/server/http/handler';
import { json } from '@/server/http/respond';
import {
  mintPreviewToken,
  previewUrlFor,
  requireCompiledArtifact,
  requirePreviewEnv,
  PREVIEW_TOKEN_TTL_MS,
} from '@/server/preview';

export const POST = route<{ id: string }>(async (ctx, _req, params) => {
  requireRole(ctx.role, 'client');
  requireActiveOrg(ctx);
  const version = await ctx.repos.surveys.getVersion(params.id);
  if (version === null) throw new AppError('not_found', 'version not found');
  const artifactHash = requireCompiledArtifact(version);

  const env = requirePreviewEnv();
  const expiresAtMs = ctx.now().getTime() + PREVIEW_TOKEN_TTL_MS;
  const token = mintPreviewToken(env.signingSecret, artifactHash, expiresAtMs);

  return json(
    {
      artifact_hash: artifactHash,
      preview_token: token,
      expires_at: new Date(expiresAtMs).toISOString(),
      preview_url: previewUrlFor(env, artifactHash, token),
    },
    { requestId: ctx.requestId },
  );
});
