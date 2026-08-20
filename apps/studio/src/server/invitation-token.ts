/**
 * Invitation tokens.
 *
 * The plaintext token exists in exactly two places — the API response and the email body — and
 * is NEVER persisted. What the database stores is `sha256(token)`, produced by
 * `app.hash_invitation_token()`; this module is the client-side half of that one write path, so
 * that "the plaintext is never stored" stays greppable rather than aspirational.
 *
 * sha256 and not argon2id, deliberately: unlike a password this is 160+ bits of CSPRNG output
 * with no offline-guessing exposure, so a slow hash buys nothing and costs a lookup on every
 * accept. `app.api_keys.key_hash` is argon2id for the opposite reason — API keys are
 * long-lived and low-entropy at the edges.
 */

import { createHash, randomBytes } from 'node:crypto';

/** 32 bytes of CSPRNG, base64url — 256 bits, comfortably above the 128-bit target. */
export function newInvitationToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Hex, matching `encode(digest(token,'sha256'),'hex')` on the SQL side. */
export function hashInvitationToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** 72 h, per API §2.2's "72 h expiry not extended" on resend. */
export const INVITATION_TTL_MS = 72 * 60 * 60 * 1000;

export function invitationExpiry(now: Date): string {
  return new Date(now.getTime() + INVITATION_TTL_MS).toISOString();
}
