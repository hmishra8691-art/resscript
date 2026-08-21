/**
 * Signed preview tokens — the gate on `POST /preview/:artifact_hash/*` (E §1, P1-11).
 *
 * The threat: the preview endpoint renders any artifact BY HASH, before any survey token
 * exists — that is its purpose. Without a gate, anyone who learns a hash (a CDN log, a
 * screenshot of a studio tab) can walk an unpublished survey. The gate is a short-lived HMAC
 * minted by the control plane, which shares `PREVIEW_SIGNING_SECRET` with the runtime; the
 * runtime verifies statelessly, per request, so a preview session needs no server-side grant
 * record and revocation is simply expiry.
 *
 * Shape: `v1.<expires_at_ms>.<hex hmac-sha256(secret, artifact_hash | expires_at_ms)>`.
 * The hash is INSIDE the signature, so a token minted for one artifact opens no other; the
 * expiry is inside it too, so extending a token means minting, not editing. Comparison is
 * constant-time — a preview token is a capability, and capabilities do not get compared with
 * `===` where a timing oracle can shave the search space.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

const VERSION = 'v1';

function signature(secret: string, artifactHash: string, expiresAtMs: number): Buffer {
  return createHmac('sha256', secret).update(`${artifactHash}|${expiresAtMs}`).digest();
}

export function mintPreviewToken(
  secret: string,
  artifactHash: string,
  expiresAtMs: number,
): string {
  return `${VERSION}.${expiresAtMs}.${signature(secret, artifactHash, expiresAtMs).toString('hex')}`;
}

export type PreviewTokenVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'malformed' | 'expired' | 'bad_signature' };

export function verifyPreviewToken(
  secret: string,
  artifactHash: string,
  token: string,
  nowMs: number,
): PreviewTokenVerdict {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== VERSION) return { ok: false, reason: 'malformed' };
  const expiresAtMs = Number(parts[1]);
  if (!Number.isSafeInteger(expiresAtMs)) return { ok: false, reason: 'malformed' };
  const claimed = parts[2] ?? '';
  if (!/^[0-9a-f]{64}$/.test(claimed)) return { ok: false, reason: 'malformed' };

  // Signature BEFORE expiry: an attacker probing with forged tokens learns nothing about
  // which expiries would have been acceptable.
  const expected = signature(secret, artifactHash, expiresAtMs);
  if (!timingSafeEqual(expected, Buffer.from(claimed, 'hex'))) {
    return { ok: false, reason: 'bad_signature' };
  }
  if (nowMs > expiresAtMs) return { ok: false, reason: 'expired' };
  return { ok: true };
}
