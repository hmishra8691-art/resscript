/**
 * Signed preview tokens — the gate on the preview surface.
 *
 * The negative cases matter more than the positive one: a preview token is a capability to
 * read an unpublished survey, and each rejection reason below is a distinct forgery attempt.
 */

import { describe, expect, it } from 'vitest';
import { mintPreviewToken, verifyPreviewToken } from './token.js';

const SECRET = 'test-signing-secret';
const HASH = 'c'.repeat(64);
const NOW = 1_700_000_000_000;

describe('preview tokens', () => {
  it('verifies its own mint', () => {
    const t = mintPreviewToken(SECRET, HASH, NOW + 60_000);
    expect(verifyPreviewToken(SECRET, HASH, t, NOW)).toEqual({ ok: true });
  });

  it('a token minted for one artifact opens NO other', () => {
    const t = mintPreviewToken(SECRET, HASH, NOW + 60_000);
    const other = 'd'.repeat(64);
    expect(verifyPreviewToken(SECRET, other, t, NOW)).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('expiry is inside the signature: editing it invalidates the token', () => {
    const t = mintPreviewToken(SECRET, HASH, NOW + 60_000);
    const parts = t.split('.');
    const extended = `${parts[0]}.${NOW + 999_999_999}.${parts[2]}`;
    expect(verifyPreviewToken(SECRET, HASH, extended, NOW))
      .toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('an expired token is expired, not merely odd', () => {
    const t = mintPreviewToken(SECRET, HASH, NOW - 1);
    expect(verifyPreviewToken(SECRET, HASH, t, NOW)).toEqual({ ok: false, reason: 'expired' });
  });

  it('the wrong secret fails', () => {
    const t = mintPreviewToken('other-secret', HASH, NOW + 60_000);
    expect(verifyPreviewToken(SECRET, HASH, t, NOW)).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it.each(['', 'v1', 'v1.abc.def', 'v0.123.' + 'a'.repeat(64), 'v1.123.zz'])(
    'malformed input %j is malformed, never a throw',
    bad => {
      expect(verifyPreviewToken(SECRET, HASH, bad, NOW).ok).toBe(false);
    },
  );
});
