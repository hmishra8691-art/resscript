/**
 * Entry-signature verification — security §10, roadmap P2-04.
 *
 * This is a security boundary, so the tests are written around the ways it could be *wrong while
 * looking right*, not around the happy path:
 *
 *  - a signature computed over the RAW query string would pass parameter-pollution and reordering
 *    attacks and would break behind a normalizing proxy, so the canonical form is asserted directly
 *    and a reordered query is asserted to verify identically;
 *  - a vendor with no `signed_params` signs nothing checkable, and "verified" over no input must be
 *    a refusal rather than a pass;
 *  - a missing deployment secret for a vendor that DECLARES signing must refuse, because a survey
 *    configured to require signatures and silently not checking them is the worst of the three
 *    states;
 *  - the acceptance criterion itself: one character of `pid` changed must fail.
 *
 * The freshness and replay tests pin the ordering too (signature before timestamp), because
 * checking the cheap thing first would turn the error into an oracle for which timestamps are
 * acceptable.
 */

import { describe, expect, it } from 'vitest';
import type { Vendor } from '@resscript/schema';

import { canonicalString, signCanonical, vendorFromParams, verifyEntry } from './verify.js';

const SECRET = 'a-vendor-shared-secret';
const NOW_MS = 1_755_690_000_000;
const TS = Math.floor(NOW_MS / 1000);

function vendor(over: Partial<Vendor['security']> = {}, hasSecurity = true): Vendor {
  return {
    id: 'ven_01ABC' as never,
    ref: 'V_A',
    name: 'Panel A',
    inbound_params: [{ param: 'pid', variable_ref: 'VENDOR_PID', required: true }],
    ...(hasSecurity
      ? {
          security: {
            hash_param: 'hash',
            algorithm: 'sha256',
            secret_ref: 'vault://vendors/v_a',
            signed_params: ['pid', 'sid', 'ts', 'n'],
            ...over,
          } as never,
        }
      : {}),
  } as Vendor;
}

/** A correctly-signed link, so each test can mutate exactly one thing about it. */
function signedParams(over: Record<string, string> = {}, v: Vendor = vendor()): URLSearchParams {
  const params = new URLSearchParams({
    src: 'V_A',
    pid: 'P12345',
    sid: 'S99',
    ts: String(TS),
    n: '8f2c1d4e',
    ...over,
  });
  const security = v.security;
  if (!security) return params;
  const hash = signCanonical(
    SECRET,
    canonicalString(params, security.signed_params ?? []),
    security.algorithm,
  ).toString('hex');
  params.set(security.hash_param, hash);
  return params;
}

function verify(params: URLSearchParams, over: Partial<Parameters<typeof verifyEntry>[0]> = {}) {
  return verifyEntry({
    params,
    vendor: vendor(),
    secrets: [SECRET],
    nowMs: NOW_MS,
    ...over,
  });
}

/* ---------------------------------------------------------------- *
 * The canonical string
 * ---------------------------------------------------------------- */

describe('canonicalString', () => {
  it('is name=value, sorted by name, joined with &', () => {
    const params = new URLSearchParams({ pid: 'P1', ts: '100', sid: 'S1' });

    expect(canonicalString(params, ['ts', 'pid', 'sid'])).toBe('pid=P1&sid=S1&ts=100');
  });

  it('covers only the declared params, never the whole query', () => {
    // Signing the raw query makes every extra tracking parameter a signature break, and makes
    // parameter pollution a bypass.
    const params = new URLSearchParams({ pid: 'P1', utm_source: 'email', ts: '100' });

    expect(canonicalString(params, ['pid', 'ts'])).toBe('pid=P1&ts=100');
  });

  it('gives an absent declared param an empty value rather than omitting it', () => {
    // Omitting it would make a link that DROPPED a signed parameter produce the same canonical
    // string as one that never had it — the same signature for two different links.
    expect(canonicalString(new URLSearchParams({ pid: 'P1' }), ['pid', 'sid'])).toBe('pid=P1&sid=');
  });

  it('is insensitive to the order parameters appear in the query', () => {
    const a = new URLSearchParams('pid=P1&sid=S1&ts=100');
    const b = new URLSearchParams('ts=100&pid=P1&sid=S1');

    expect(canonicalString(a, ['pid', 'sid', 'ts'])).toBe(canonicalString(b, ['pid', 'sid', 'ts']));
  });
});

/* ---------------------------------------------------------------- *
 * Verification
 * ---------------------------------------------------------------- */

describe('verifyEntry', () => {
  it('accepts a correctly signed link and reports it as signed', async () => {
    const r = await verify(signedParams());

    expect(r).toEqual({ ok: true, signed: true });
  });

  it('REFUSES a link with one character of pid changed — the acceptance criterion', async () => {
    const params = signedParams();
    params.set('pid', 'P12346');

    const r = await verify(params);

    expect(r).toEqual({ ok: false, reason: 'sig_mismatch' });
  });

  it('verifies identically when the query is reordered', async () => {
    // What a normalizing proxy does. Signing the raw query string would break here.
    const original = signedParams();
    const reordered = new URLSearchParams(
      [...original.entries()].reverse().map(([k, v]) => [k, v] as [string, string]),
    );

    expect(await verify(reordered)).toEqual({ ok: true, signed: true });
  });

  it('is not fooled by a duplicated signed parameter', async () => {
    // `?pid=P12345&pid=evil`. `URLSearchParams.get` returns the FIRST, which is what the canonical
    // form uses, so the appended value cannot silently change the signed content.
    const params = signedParams();
    params.append('pid', 'evil');

    expect(await verify(params)).toEqual({ ok: true, signed: true });
  });

  it('ignores unsigned extra parameters, so tracking params do not break a link', async () => {
    const params = signedParams();
    params.set('utm_source', 'email');

    expect(await verify(params)).toEqual({ ok: true, signed: true });
  });

  it('passes an unsigned vendor through, marked as unsigned', async () => {
    // Not every sample source signs. Reported explicitly so the caller can mark the session
    // rather than record it as verified.
    const r = await verifyEntry({
      params: new URLSearchParams({ pid: 'P1' }),
      vendor: vendor({}, false),
      secrets: [],
      nowMs: NOW_MS,
    });

    expect(r).toEqual({ ok: true, signed: false });
  });

  it('refuses when the deployment has no secret for a vendor that DECLARES signing', async () => {
    // The worst of the three states is "configured to require signatures, silently not checking".
    const r = await verify(signedParams(), { secrets: [] });

    expect(r).toEqual({ ok: false, reason: 'no_secret' });
  });

  it('refuses a vendor that declares signing over no parameters', async () => {
    // A signature over no input is not a signature.
    const v = vendor({ signed_params: [] });
    const r = await verifyEntry({
      params: signedParams({}, v),
      vendor: v,
      secrets: [SECRET],
      nowMs: NOW_MS,
    });

    expect(r).toEqual({ ok: false, reason: 'no_signed_params' });
  });

  it('refuses a missing or malformed signature by name', async () => {
    const missing = signedParams();
    missing.delete('hash');
    expect(await verify(missing)).toEqual({ ok: false, reason: 'sig_missing' });

    const malformed = signedParams();
    malformed.set('hash', 'not-hex!!');
    expect(await verify(malformed)).toEqual({ ok: false, reason: 'sig_malformed' });
  });

  it('distinguishes a wrong-length signature from a wrong one', async () => {
    // Usually a hex-encoding or algorithm disagreement rather than tampering, and saying which
    // saves a long integration call.
    const params = signedParams();
    params.set('hash', 'ab'.repeat(8));

    expect(await verify(params)).toEqual({ ok: false, reason: 'sig_len' });
  });

  it('accepts a link signed with the PREVIOUS secret during a rotation', async () => {
    // Rotation must not break links already in the field.
    const params = signedParams();

    const r = await verify(params, { secrets: ['the-new-secret', SECRET] });

    expect(r).toEqual({ ok: true, signed: true });
  });

  it('still refuses a forgery when several secrets are active', async () => {
    const params = signedParams();
    params.set('pid', 'P99999');

    const r = await verify(params, { secrets: ['new', SECRET, 'older'] });

    expect(r.ok).toBe(false);
  });
});

/* ---------------------------------------------------------------- *
 * Freshness and replay
 * ---------------------------------------------------------------- */

describe('freshness', () => {
  it('refuses a stale timestamp', async () => {
    const stale = TS - 90_000; // beyond the 24h default
    const params = signedParams({ ts: String(stale) });

    expect(await verify(params)).toEqual({ ok: false, reason: 'ts_stale' });
  });

  it('refuses a FUTURE timestamp beyond the window, not just a past one', async () => {
    // The window is bounded both ways: a link stamped far in the future is as suspicious as a
    // stale one, and an unbounded future would make a leaked link valid forever.
    const params = signedParams({ ts: String(TS + 90_000) });

    expect(await verify(params)).toEqual({ ok: false, reason: 'ts_stale' });
  });

  it('accepts modest clock skew in either direction', async () => {
    expect(await verify(signedParams({ ts: String(TS - 3600) }))).toEqual({ ok: true, signed: true });
    expect(await verify(signedParams({ ts: String(TS + 3600) }))).toEqual({ ok: true, signed: true });
  });

  it('refuses a missing timestamp', async () => {
    const params = signedParams();
    params.delete('ts');
    // Re-sign so the failure is the timestamp and not the signature over the now-empty ts.
    const security = vendor().security;
    params.set(
      'hash',
      signCanonical(SECRET, canonicalString(params, security?.signed_params ?? []), 'sha256').toString('hex'),
    );

    expect(await verify(params)).toEqual({ ok: false, reason: 'ts_missing' });
  });

  it('honours a tightened per-vendor window', async () => {
    const v = vendor({ max_skew_s: 60 });
    const params = signedParams({ ts: String(TS - 3600) }, v);

    const r = await verifyEntry({ params, vendor: v, secrets: [SECRET], nowMs: NOW_MS });

    expect(r).toEqual({ ok: false, reason: 'ts_stale' });
  });

  it('checks the signature BEFORE the timestamp, so the error is not a timestamp oracle', async () => {
    // A forged link with a stale timestamp reports the signature failure, telling the attacker
    // nothing about which timestamps would have been accepted.
    const params = signedParams({ ts: String(TS - 90_000) });
    params.set('pid', 'tampered');

    expect(await verify(params)).toEqual({ ok: false, reason: 'sig_mismatch' });
  });
});

describe('replay', () => {
  it('consumes the nonce once and refuses the second use', async () => {
    const seen = new Set<string>();
    const consumeNonce = (key: string) => {
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    };
    const params = signedParams();

    expect(await verify(params, { consumeNonce })).toEqual({ ok: true, signed: true });
    expect(await verify(params, { consumeNonce })).toEqual({ ok: false, reason: 'replay' });
  });

  it('scopes the nonce key by vendor, so two vendors cannot collide', async () => {
    const keys: string[] = [];
    await verify(signedParams(), {
      consumeNonce: key => {
        keys.push(key);
        return true;
      },
    });

    expect(keys).toEqual(['entry:V_A:8f2c1d4e']);
  });

  it('sets the nonce TTL to the freshness window', async () => {
    // Outside the window the signature is already refused, so the nonce need not outlive it —
    // memory is bounded by the window rather than by traffic.
    const ttls: number[] = [];
    await verify(signedParams(), {
      consumeNonce: (_key, ttl) => {
        ttls.push(ttl);
        return true;
      },
    });

    expect(ttls).toEqual([86_400]);
  });

  it('does not claim replay protection when no nonce store is configured', async () => {
    // A single-node dev deployment has no shared state. The link still verifies — the signature
    // was genuinely checked — and the absence of the check is the caller's to know about.
    expect(await verify(signedParams())).toEqual({ ok: true, signed: true });
  });
});

/* ---------------------------------------------------------------- *
 * Vendor identification
 * ---------------------------------------------------------------- */

describe('vendorFromParams', () => {
  const vendors = [vendor(), { ...vendor(), ref: 'V_B', id: 'ven_02' as never }];

  it('matches src against a vendor ref', () => {
    expect(vendorFromParams(new URLSearchParams({ src: 'V_B' }), vendors)?.ref).toBe('V_B');
  });

  it('answers undefined for an unrecognized or absent src', () => {
    expect(vendorFromParams(new URLSearchParams({ src: 'GHOST' }), vendors)).toBeUndefined();
    expect(vendorFromParams(new URLSearchParams(), vendors)).toBeUndefined();
  });

  it('answers undefined when the artifact declares no vendors', () => {
    expect(vendorFromParams(new URLSearchParams({ src: 'V_A' }), undefined)).toBeUndefined();
    expect(vendorFromParams(new URLSearchParams({ src: 'V_A' }), [])).toBeUndefined();
  });
});
