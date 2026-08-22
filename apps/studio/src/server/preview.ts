/**
 * Preview-token minting, studio side (P1-11, security §3.2).
 *
 * The runtime's preview surface (`GET /preview/<artifact_hash>?pt=…`) renders any artifact BY
 * HASH, before any survey token exists; its gate is a short-lived HMAC the control plane mints
 * with `PREVIEW_SIGNING_SECRET` and the runtime verifies statelessly per request. This module
 * is the control-plane half of that handshake.
 *
 * WHY the recipe is RESTATED rather than imported: the verifier lives in
 * `apps/runtime/src/preview/token.ts`, and app-to-app imports are what
 * `.dependency-cruiser.cjs` forbids (the same reason `JobProgressShape` in `repo/types.ts` is
 * restated from `apps/worker`). The recipe — not the code — is the wire contract:
 *
 *   `v1.<expires_at_ms>.<hex hmac-sha256(secret, artifact_hash | expires_at_ms)>`
 *
 * The hash is INSIDE the signature, so a token minted for one artifact opens no other; the
 * expiry is inside it too, so extending a token means minting, not editing.
 * `preview.test.ts` re-derives the signature from `node:crypto` directly, so a drift in either
 * copy of the recipe fails a test instead of failing a preview in the field. If a third minting
 * site ever appears, the recipe belongs in a package, not in a third restatement.
 */

import { createHmac } from 'node:crypto';
import { AppError } from '@resscript/observability';
import { previewEnv, type PreviewEnv } from './env.js';
import type { SurveyVersionRow } from './repo/types.js';

const VERSION = 'v1';

/**
 * 10 minutes. A preview token is a capability to walk an unpublished survey, so the window is
 * as short as a QA click-through allows; the runtime's revocation IS expiry (no grant record),
 * and the studio's "restart" simply mints again.
 */
export const PREVIEW_TOKEN_TTL_MS = 10 * 60_000;

export function mintPreviewToken(
  secret: string,
  artifactHash: string,
  expiresAtMs: number,
): string {
  const signature = createHmac('sha256', secret)
    .update(`${artifactHash}|${expiresAtMs}`)
    .digest('hex');
  return `${VERSION}.${expiresAtMs}.${signature}`;
}

/** The entry URL of the runtime's preview surface for one artifact, token attached. */
export function previewUrlFor(env: PreviewEnv, artifactHash: string, token: string): string {
  return `${env.runtimeOrigin}/preview/${artifactHash}?pt=${encodeURIComponent(token)}`;
}

/**
 * The env pair, or a 503 the client can act on. `unavailable` and not `internal_error`,
 * because "the deployment lacks a preview runtime" is an operational state, not a bug —
 * and it must not read as "your survey is broken".
 */
export function requirePreviewEnv(): PreviewEnv {
  const env = previewEnv();
  if (env === undefined) {
    throw new AppError('unavailable', 'preview is not configured for this deployment', {
      details: [
        { path: null, code: 'env_required', message: 'PREVIEW_SIGNING_SECRET' },
        { path: null, code: 'env_required', message: 'RUNTIME_PREVIEW_ORIGIN' },
      ],
    });
  }
  return env;
}

/**
 * The artifact a preview would render, or a 409.
 *
 * BOTH columns are checked (K §3's two axes): `artifact_hash` alone could name the artifact of
 * an earlier successful compile on a version whose latest compile failed, and previewing stale
 * bytes as if they were the draft is worse than refusing. The actionable message is "compile
 * first", which is why this is `illegal_transition` rather than `not_found` — the version
 * exists and the caller may see it; it is the preview that is premature.
 */
export function requireCompiledArtifact(version: SurveyVersionRow): string {
  if (version.compile_state !== 'compiled' || version.artifact_hash === null) {
    throw new AppError('illegal_transition', 'this version has no compiled artifact to preview', {
      details: [
        { path: null, code: 'compile_state', message: version.compile_state },
        { path: null, code: 'compile_first', message: 'POST /api/v1/versions/{id}/publish' },
      ],
    });
  }
  return version.artifact_hash;
}
