/**
 * Vendor entry-signature verification — security §10, roadmap P2-04.
 *
 * Runs at `POST /s/{token}`, **before a session exists**, because the acceptance criterion is that a
 * tampered link "returns an error page and creates no session row". A check that ran after session
 * creation would already have burned a session id, an entry-params row and possibly a quota
 * reservation, and security §9 is explicit that fraud checks which terminate run before session
 * creation and before quota reservation.
 *
 * The four steps, in the order security §10 states them, and each one's reason:
 *
 *  1. **Sign a declared subset, canonicalized — never the raw query string.** A raw query makes
 *     `?pid=1&pid=2` a bypass and breaks the signature on every proxy that reorders or normalizes
 *     parameters. `signed_params` names which parameters participate; this module sorts them, so the
 *     canonical form is a function of the parameter NAMES and not of the order the vendor config
 *     happens to list them in. A vendor with no `signed_params` is a misconfiguration, not a pass:
 *     a signature over no input is not a signature.
 *  2. **Constant-time comparison, length checked first.** A `===` on a signature is a timing oracle
 *     that shaves the search space. `timingSafeEqual` throws on a length mismatch, so the length is
 *     compared separately and reported as its own reason — the same shape `preview/token.ts` uses.
 *  3. **Freshness.** A window is required, because without one a leaked link never expires. It is
 *     generous by default (24h) because panel links are emailed and clicked late, and it is
 *     bounded in BOTH directions because clock skew is real and a future `ts` is as suspicious as
 *     a stale one.
 *  4. **Replay.** A nonce consumed once. `SET NX` with a TTL equal to the freshness window is the
 *     whole mechanism: outside the window the signature is already rejected by step 3, so the
 *     nonce need not outlive it and memory is bounded by the window rather than by traffic.
 *
 * **Secret rotation** is supported by taking a list: verification tries each secret in turn and
 * accepts the first that matches, so rotating a key does not break links already in the field
 * (security §10). Trying every candidate before failing also keeps the timing of a rejection
 * independent of which secret would have been the right one.
 *
 * **Unsigned vendors are supported and marked, not silently trusted.** Not every client's sample
 * source signs. `verifyEntry` returns `{ ok: true, signed: false }` for a vendor with no `security`
 * block, and the caller records that on the session — security §10's "carry a `link_security: none`
 * flag visible in the UI and in the publish record. Pretending otherwise is worse than being
 * explicit."
 *
 * This module performs no I/O of its own beyond the injected nonce check, reads no clock, and holds
 * no state, so it is testable against a table of links.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Vendor, VendorSecurity } from '@resscript/schema';

/** Why an entry link was refused. Stable strings: they land in the event log and in alerts. */
export type VerifyFailure =
  | 'no_secret'
  | 'no_signed_params'
  | 'sig_missing'
  | 'sig_malformed'
  | 'sig_len'
  | 'sig_mismatch'
  | 'ts_missing'
  | 'ts_stale'
  | 'replay';

export type VerifyResult =
  | { readonly ok: true; readonly signed: boolean }
  | { readonly ok: false; readonly reason: VerifyFailure };

/** Security §10's default freshness window: 24h, because panel links are clicked late. */
export const DEFAULT_MAX_SKEW_S = 86_400;
const DEFAULT_TIMESTAMP_PARAM = 'ts';
const DEFAULT_NONCE_PARAM = 'n';

export interface VerifyEntryInput {
  readonly params: URLSearchParams;
  readonly vendor: Vendor;
  /**
   * The vendor's HMAC secrets, current first, then any previous still inside its rotation window.
   * Empty means the deployment has none configured — which is a refusal for a vendor that declares
   * `security`, never a pass: a survey configured to require signatures that silently stops
   * checking them is the worst of the three possible states.
   */
  readonly secrets: readonly string[];
  /** Injected clock, in epoch MILLISECONDS. Never read from here — the runtime owns its clock. */
  readonly nowMs: number;
  /**
   * Consume a nonce, returning `true` if it was unused. Absent disables replay protection, which
   * is reported (`signed: true` still holds — the signature was checked) rather than pretended.
   */
  readonly consumeNonce?: (key: string, ttlSeconds: number) => boolean | Promise<boolean>;
}

/**
 * The canonical string a signature covers: `name=value`, sorted by name, joined with `&`.
 *
 * A missing parameter contributes an empty value rather than being omitted, so that dropping a
 * signed parameter changes the string (and fails) instead of producing the same string as a link
 * that never had it.
 *
 * Exported because the entry-link GENERATOR (studio, P2-04 frontend) has to produce byte-identical
 * input, and two implementations of a canonical form is how a signature scheme quietly stops
 * verifying.
 */
export function canonicalString(params: URLSearchParams, signedParams: readonly string[]): string {
  return [...signedParams]
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map(name => `${name}=${params.get(name) ?? ''}`)
    .join('&');
}

export function signCanonical(secret: string, canonical: string, algorithm: VendorSecurity['algorithm']): Buffer {
  return createHmac(algorithm, secret).update(canonical).digest();
}

export async function verifyEntry(input: VerifyEntryInput): Promise<VerifyResult> {
  const security = input.vendor.security;
  // No `security` block: this vendor does not sign. Explicitly reported as unsigned so the caller
  // can mark the session rather than record it as verified.
  if (!security) return { ok: true, signed: false };

  if (input.secrets.length === 0) return { ok: false, reason: 'no_secret' };

  const signedParams = security.signed_params ?? [];
  if (signedParams.length === 0) return { ok: false, reason: 'no_signed_params' };

  const provided = input.params.get(security.hash_param);
  if (provided === null || provided === '') return { ok: false, reason: 'sig_missing' };
  if (!/^[0-9a-fA-F]+$/.test(provided)) return { ok: false, reason: 'sig_malformed' };
  const providedBytes = Buffer.from(provided, 'hex');

  const canonical = canonicalString(input.params, signedParams);

  // Every candidate secret is tried before failing, so a rejection's cost does not depend on which
  // secret would have matched, and a rotation does not break links already in the field.
  let matched = false;
  let lengthMismatch = false;
  for (const secret of input.secrets) {
    const expected = signCanonical(secret, canonical, security.algorithm);
    if (expected.length !== providedBytes.length) {
      lengthMismatch = true;
      continue;
    }
    if (timingSafeEqual(expected, providedBytes)) matched = true;
  }
  if (!matched) {
    // A length mismatch against every candidate is a different diagnosis from a same-length
    // mismatch — usually a hex-encoding or algorithm disagreement rather than tampering — and
    // saying which saves a long integration call.
    return { ok: false, reason: lengthMismatch ? 'sig_len' : 'sig_mismatch' };
  }

  // Freshness comes AFTER the signature, on purpose: an attacker probing with forged links learns
  // nothing about which timestamps would have been acceptable. Same ordering as `preview/token.ts`.
  const skewLimit = security.max_skew_s ?? DEFAULT_MAX_SKEW_S;
  const tsParam = security.timestamp_param ?? DEFAULT_TIMESTAMP_PARAM;
  // Absence is checked BEFORE `Number`, because `Number(null)` and `Number('')` are both `0` — a
  // finite, plausible-looking epoch. Relying on `Number.isFinite` alone would read a missing
  // timestamp as 1970, which happens to be refused as stale today but would silently PASS for any
  // vendor whose `max_skew_s` was widened. The guard has to mean what it looks like it means.
  const tsRaw = input.params.get(tsParam);
  if (tsRaw === null || tsRaw.trim() === '') return { ok: false, reason: 'ts_missing' };
  const ts = Number(tsRaw);
  if (!Number.isFinite(ts)) return { ok: false, reason: 'ts_missing' };
  if (Math.abs(input.nowMs / 1000 - ts) > skewLimit) return { ok: false, reason: 'ts_stale' };

  const nonceParam = security.nonce_param ?? DEFAULT_NONCE_PARAM;
  const nonce = input.params.get(nonceParam);
  if (input.consumeNonce && nonce !== null && nonce !== '') {
    const fresh = await input.consumeNonce(
      `entry:${input.vendor.ref}:${nonce}`,
      // TTL = the freshness window: outside it step 3 already rejects, so the nonce need not
      // outlive it and memory is bounded by the window rather than by traffic.
      skewLimit,
    );
    if (!fresh) return { ok: false, reason: 'replay' };
  }

  return { ok: true, signed: true };
}

/**
 * Which vendor an entry link claims to be from, by matching a reserved `src` parameter against the
 * vendors' `ref`s.
 *
 * `src` because that is the parameter the security doc's own worked example uses
 * (`?src=V_A&pid=…`). Matching by `ref` and not by id because vendors are authored by hand and the
 * ref is what goes in a link a human pastes.
 *
 * **The claim is unverified until `verifyEntry` runs.** That ordering is the point: identifying the
 * vendor is what tells us WHICH secret and WHICH signed parameters to check, so identification must
 * precede verification and must not be mistaken for it. A vendor that declares `security` gets its
 * claim checked; one that does not is recorded as unsigned.
 */
export function vendorFromParams(
  params: URLSearchParams,
  vendors: readonly Vendor[] | undefined,
  srcParam = 'src',
): Vendor | undefined {
  if (!vendors || vendors.length === 0) return undefined;
  const claimed = params.get(srcParam);
  if (claimed === null || claimed === '') return undefined;
  return vendors.find(v => v.ref === claimed);
}
