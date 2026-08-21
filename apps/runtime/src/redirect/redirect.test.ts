/**
 * Redirect resolution — E §11.
 *
 * The three stages are tested separately because they fail differently (a resolution miss is
 * normal, an interpolation block is a recorded degradation, a validation failure is a refusal),
 * and then together through `resolveRedirect`, which is what the handler calls.
 */

import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ArtifactManifest, Redirects } from '@resscript/schema';
import { interpolate, resolveRedirect, resolveTemplate, validateUrl } from './index.js';

const REDIRECTS: Redirects = {
  default: {
    COMPLETE: 'https://vendor.example/c?pid={{VENDOR_PID}}',
    SCREENOUT: 'https://vendor.example/s?pid={{VENDOR_PID}}',
    CUSTOM: { early_close: 'https://vendor.example/x?k=early' },
  },
  by_vendor: {
    acme: { COMPLETE: 'https://cb.acme.example/done?pid={{VENDOR_PID}}' },
  },
  by_language: {
    de: { COMPLETE: 'https://vendor.example/c?pid={{VENDOR_PID}}&lang=de' },
  },
};

function manifest(over: Partial<ArtifactManifest> = {}): ArtifactManifest {
  return {
    artifact_schema_version: 1,
    survey_id: 'srv_1',
    survey_version_id: 'ver_1',
    artifact_hash: 'h'.repeat(64),
    compiled_at: '2026-08-21T00:00:00Z',
    base_language: 'en',
    languages: ['en'],
    variable_manifest: [
      { id: 'var_pid', name: 'VENDOR_PID', kind: 'hidden', type: 'text',
        export_column: 'VENDOR_PID', export_include: true, pii: false, persist: true },
      { id: 'var_email', name: 'EMAIL', kind: 'response', type: 'text',
        export_column: 'EMAIL', export_include: true, pii: true, persist: true },
      { id: 'var_age', name: 'AGE', kind: 'response', type: 'number',
        export_column: 'AGE', export_include: true, pii: false, persist: true },
    ],
    entitlements: [],
    plugin_versions: {},
    ...over,
  } as ArtifactManifest;
}

describe('resolveTemplate — E §11.1 resolution order', () => {
  it('vendor-specific beats language-specific beats default', () => {
    expect(resolveTemplate(REDIRECTS, 'COMPLETE', null, 'acme', 'de'))
      .toBe('https://cb.acme.example/done?pid={{VENDOR_PID}}');
    expect(resolveTemplate(REDIRECTS, 'COMPLETE', null, null, 'de'))
      .toBe('https://vendor.example/c?pid={{VENDOR_PID}}&lang=de');
    expect(resolveTemplate(REDIRECTS, 'COMPLETE', null, null, 'en'))
      .toBe('https://vendor.example/c?pid={{VENDOR_PID}}');
  });

  it('a vendor map missing the disposition falls through to the next tier', () => {
    // acme declares only COMPLETE; a SCREENOUT for an acme respondent uses the default.
    expect(resolveTemplate(REDIRECTS, 'SCREENOUT', null, 'acme', 'en'))
      .toBe('https://vendor.example/s?pid={{VENDOR_PID}}');
  });

  it('CUSTOM selects by custom_key, and an unknown key is a miss, not a throw', () => {
    expect(resolveTemplate(REDIRECTS, 'CUSTOM', 'early_close', null, 'en'))
      .toBe('https://vendor.example/x?k=early');
    expect(resolveTemplate(REDIRECTS, 'CUSTOM', 'nonexistent', null, 'en')).toBeNull();
    expect(resolveTemplate(REDIRECTS, 'CUSTOM', null, null, 'en')).toBeNull();
  });

  it('no redirects section at all is a miss (E §11.1 step 6)', () => {
    expect(resolveTemplate(null, 'COMPLETE', null, null, 'en')).toBeNull();
    expect(resolveTemplate(undefined, 'COMPLETE', null, null, 'en')).toBeNull();
  });
});

describe('interpolate — E §11.2', () => {
  it('pipes by ref with automatic percent-encoding', () => {
    const r = interpolate({
      template: 'https://v.example/c?pid={{VENDOR_PID}}',
      manifest: manifest(),
      vars: { var_pid: 'a b&c=d' },
      vendorSecret: null,
    });
    expect(r.url).toBe('https://v.example/c?pid=a%20b%26c%3Dd');
  });

  it('BLOCKS pii variables and records which — the incident class E §11.2 names', () => {
    const r = interpolate({
      template: 'https://v.example/c?pid={{VENDOR_PID}}&e={{EMAIL}}',
      manifest: manifest(),
      vars: { var_pid: 'p1', var_email: 'someone@example.com' },
      vendorSecret: null,
    });
    // Present but empty: the vendor's parser sees the parameter, never the value.
    expect(r.url).toBe('https://v.example/c?pid=p1&e=');
    expect(r.blockedPii).toEqual(['EMAIL']);
  });

  it('computes {{HMAC}} over the OTHER params, sorted, excluding the signature pair', () => {
    const r = interpolate({
      template: 'https://v.example/c?zeta={{AGE}}&pid={{VENDOR_PID}}&sig={{HMAC}}',
      manifest: manifest(),
      vars: { var_pid: 'p1', var_age: 34 },
      vendorSecret: 'topsecret',
    });
    // Canonical form: pairs sorted by key, HMAC pair dropped, decoded values.
    const expected = createHmac('sha256', 'topsecret')
      .update(['pid=p1', 'zeta=34'].sort().join('&'))
      .digest('hex');
    expect(r.url).toBe(`https://v.example/c?zeta=34&pid=p1&sig=${expected}`);
    expect(r.hmacUnavailable).toBe(false);
  });

  it('{{HMAC}} with no secret interpolates empty and says so, rather than signing with junk', () => {
    const r = interpolate({
      template: 'https://v.example/c?pid={{VENDOR_PID}}&sig={{HMAC}}',
      manifest: manifest(),
      vars: { var_pid: 'p1' },
      vendorSecret: null,
    });
    expect(r.url).toBe('https://v.example/c?pid=p1&sig=');
    expect(r.hmacUnavailable).toBe(true);
  });

  it('an unset variable interpolates as the empty token, not "undefined"', () => {
    const r = interpolate({
      template: 'https://v.example/c?pid={{VENDOR_PID}}',
      manifest: manifest(),
      vars: {},
      vendorSecret: null,
    });
    expect(r.url).toBe('https://v.example/c?pid=');
  });
});

describe('validateUrl — security §12.3 check 5, re-validated post-interpolation', () => {
  it('accepts a well-formed https URL', () => {
    expect(validateUrl('https://cb.vendor.example/done?pid=1', []).ok).toBe(true);
  });

  it.each([
    ['http://vendor.example/c', 'scheme_not_https'],
    ['javascript:alert(1)', 'scheme_not_https'],
    ['https://vendor.example@evil.example/c', 'has_userinfo'],
    ['https://203.0.113.9/c', 'ip_literal_host'],
    ['https://[2001:db8::1]/c', 'ip_literal_host'],
    ['not a url', 'unparseable'],
  ] as const)('rejects %s as %s', (url, reason) => {
    const v = validateUrl(url, []);
    expect(v).toEqual({ ok: false, reason });
  });

  it('enforces the allowlist: exact hosts and SINGLE-level wildcards only', () => {
    const list = ['vendor.example', '*.acme.example'];
    expect(validateUrl('https://vendor.example/c', list).ok).toBe(true);
    expect(validateUrl('https://cb.acme.example/c', list).ok).toBe(true);
    // One level exactly: the multi-level match is how evil.com.vendor.com gets allowlisted.
    expect(validateUrl('https://a.b.acme.example/c', list).ok).toBe(false);
    // The wildcard does not match the bare apex.
    expect(validateUrl('https://acme.example/c', list).ok).toBe(false);
    expect(validateUrl('https://evil.example/c', list).ok).toBe(false);
  });

  it('an empty allowlist skips the host check but never the structural ones', () => {
    expect(validateUrl('https://anywhere.example/c', []).ok).toBe(true);
    expect(validateUrl('http://anywhere.example/c', []).ok).toBe(false);
  });
});

describe('resolveRedirect — the composed call', () => {
  it('resolves, interpolates, validates, and surfaces the params for the interstitial', () => {
    const out = resolveRedirect({
      redirects: REDIRECTS,
      manifest: manifest(),
      vars: { var_pid: 'p 1' },
      disposition: 'COMPLETE',
      customKey: null,
      vendorRef: 'acme',
      language: 'en',
      hostAllowlist: ['*.acme.example'],
    });
    expect(out).toMatchObject({
      kind: 'redirect',
      url: 'https://cb.acme.example/done?pid=p%201',
      params: { pid: 'p 1' },
    });
  });

  it('a template that interpolates to a disallowed host is a REFUSAL, never a redirect', () => {
    const out = resolveRedirect({
      redirects: REDIRECTS,
      manifest: manifest(),
      vars: {},
      disposition: 'COMPLETE',
      customKey: null,
      vendorRef: null,
      language: 'en',
      hostAllowlist: ['*.acme.example'], // vendor.example is not on it
    });
    expect(out.kind).toBe('rejected');
    if (out.kind === 'rejected') expect(out.reason).toBe('host_not_allowlisted');
  });

  it('no template -> none (the branded terminal page)', () => {
    const out = resolveRedirect({
      redirects: null,
      manifest: manifest(),
      vars: {},
      disposition: 'COMPLETE',
      customKey: null,
      vendorRef: null,
      language: 'en',
      hostAllowlist: [],
    });
    expect(out).toEqual({ kind: 'none' });
  });
});
