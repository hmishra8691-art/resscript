/**
 * `POST /api/v1/versions/:id/debug-session` — the debug panel's data path (P1-11).
 *
 * ## Why a proxy exists at all
 *
 * The debug panel needs the E §14.2 trace, and the trace travels in the `debug` field of the
 * runtime's JSON responses for `is_test` sessions (`pageBody` in `apps/runtime/src/handler.ts`).
 * The sandboxed iframe cannot hand it over: the client bundle does not forward traces as
 * `preview:trace` messages yet, and the frame is deliberately cross-origin with no
 * `allow-same-origin`. Fetching the preview endpoints from studio CLIENT code fails too — the
 * runtime sets no CORS headers (on purpose; its surfaces are same-origin forms and the client
 * bundle). So the studio drives a PARALLEL test session server-side: this route holds the `pt`
 * token — minted per request from `PREVIEW_SIGNING_SECRET`, never sent to the browser — and
 * relays the runtime's JSON verbatim, `debug` field and all.
 *
 * ## What passes through and what is added
 *
 * Status and body are the runtime's own, untranslated: a `409 stale_page` or a
 * `validation_failed` body is exactly what the debug panel is FOR, and re-enveloping it would
 * hide the thing being debugged. The one addition is on `start`: the version's variable
 * registry (name/kind/vtype/pii), because the panel masks PII values client-side and the pii
 * flag lives in `content.variables`, which the runtime's responses do not carry.
 *
 * Same floor as the preview-token route, and for the same reason: the debug session can do
 * nothing the preview iframe cannot — `setvars` is re-validated server-side by the runtime and
 * accepted only for `is_test` sessions (security §3.2).
 */

import { AppError } from '@resscript/observability';
import { requireRole } from '@/server/auth';
import { parseJsonBody, requireActiveOrg, route } from '@/server/http/handler';
import { json } from '@/server/http/respond';
import { debugSessionSchema } from '@/server/http/schemas';
import {
  mintPreviewToken,
  requireCompiledArtifact,
  requirePreviewEnv,
  PREVIEW_TOKEN_TTL_MS,
} from '@/server/preview';

export const POST = route<{ id: string }>(async (ctx, req, params) => {
  requireRole(ctx.role, 'client');
  requireActiveOrg(ctx);
  const version = await ctx.repos.surveys.getVersion(params.id);
  if (version === null) throw new AppError('not_found', 'version not found');
  const artifactHash = requireCompiledArtifact(version);
  const { value } = await parseJsonBody(req, debugSessionSchema);

  const env = requirePreviewEnv();
  // Minted per proxied call rather than held across steps: the token is stateless and cheap,
  // and a fresh 10-minute expiry per step means a debug session cannot outlive its operator's
  // attention only because a token minted at step one has gone stale by step forty.
  const pt = mintPreviewToken(
    env.signingSecret,
    artifactHash,
    ctx.now().getTime() + PREVIEW_TOKEN_TTL_MS,
  );
  const base = `${env.runtimeOrigin}/preview/${artifactHash}`;
  const search = (extra: Readonly<Record<string, string>>): string =>
    new URLSearchParams({ pt, ...extra }).toString();

  // No `Accept: text/html`, which is how `wantsHtml` routes us to the JSON responses that
  // carry `debug` — the same bytes the client bundle reads, not a second surface.
  let upstream: Response;
  try {
    if (value.action === 'start') {
      const extra: Record<string, string> = {};
      if (value.seed !== undefined) extra['seed'] = value.seed;
      if (value.lang !== undefined) extra['lang'] = value.lang;
      upstream = await fetch(`${base}?${search(extra)}`, {
        headers: { accept: 'application/json' },
      });
    } else if (value.action === 'replay') {
      // The one action that reads rather than drives: the runtime refuses it unless the session
      // is pinned to THIS artifact, so a replay cannot reach another survey's data through a
      // token minted here.
      upstream = await fetch(
        `${base}/replay/${encodeURIComponent(value.session_id)}?${search({})}`,
        { headers: { accept: 'application/json' } },
      );
    } else if (value.action === 'submit') {
      upstream = await fetch(`${base}/submit?${search({ session: value.session_id })}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ page_id: value.page_id, values: value.values }),
      });
    } else {
      upstream = await fetch(`${base}/setvars?${search({ session: value.session_id })}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ vars: value.vars }),
      });
    }
  } catch (err: unknown) {
    throw new AppError('unavailable', 'the preview runtime is unreachable', { cause: err });
  }

  let body: unknown;
  try {
    body = await upstream.json();
  } catch {
    throw new AppError('unavailable', 'the preview runtime answered with something other than JSON');
  }

  if (value.action === 'start' && upstream.ok) {
    // The pii flags for the panel's masking. Read AFTER the runtime call so a start that the
    // runtime refused stays a verbatim passthrough of that refusal.
    const registry = await ctx.repos.registry.forVersion(version.id);
    const variables = (registry?.variables ?? []).map((v) => ({
      name: v.name,
      kind: v.kind,
      vtype: v.vtype,
      pii: v.pii,
    }));
    return json(
      { ...(body as Record<string, unknown>), variables },
      { status: upstream.status, requestId: ctx.requestId },
    );
  }

  return json(body, { status: upstream.status, requestId: ctx.requestId });
});
