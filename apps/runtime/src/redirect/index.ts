/**
 * Redirect resolution — E §11.
 *
 * The disposition is computed server-side and the templates come from the artifact's compiled
 * `redirects` section; **no part of the destination is ever read from the request** (security
 * §12.3 — there is no `?return_url=`, and this module's inputs make one impossible to add
 * accidentally: `resolve` takes a disposition enum and the artifact map, nothing else).
 *
 * Three stages, separated because they fail differently:
 *
 *   1. `resolveTemplate`  — which template applies (E §11.1's resolution order). A miss is a
 *      normal outcome (the branded terminal page), not an error.
 *   2. `interpolate`      — piping in URL context (E §11.2). `pii: true` variables are blocked
 *      outright: the `allow_pii` override is an org-permission + audit-log feature (P2-04's
 *      vendor work) and until that authoring path exists there is no legitimate way to have
 *      granted it, so the honest runtime behaviour is "always blocked, recorded".
 *   3. `validateUrl`      — structural re-validation of the *interpolated* result (security
 *      §12.3 check 5): https only, no userinfo, no IP-literal host, and the host against an
 *      allowlist when one is configured. The compiler validated the template; this validates
 *      the string the respondent is actually sent to, which is not the same string.
 *
 * A note the reader deserves: E §11.1 step 1 reads
 * `redirects.by_vendor[vendor_ref]?.by_language?[language]?[disposition]`, but the schema's
 * `Redirects` type (C §9) gives `by_vendor` values as plain `RedirectMap`s with no nested
 * language axis. The schema is the contract the compiler enforces, so this module implements
 * the schema's shape and the doc's step 1 collapses into step 2. Recorded as a doc erratum in
 * the status doc rather than silently reconciled either way.
 */

import { createHmac } from 'node:crypto';
import { pipe } from '@resscript/runtime-core';
import type { ArtifactManifest, RedirectMap, Redirects } from '@resscript/schema';

/* ------------------------------------------------------------------ *
 * 1. Resolution order (E §11.1)
 * ------------------------------------------------------------------ */

/** Look one disposition up in one map, honouring the CUSTOM sub-map. */
function fromMap(
  map: RedirectMap | undefined,
  disposition: string,
  customKey: string | null,
): string | null {
  if (!map) return null;
  if (disposition === 'CUSTOM') {
    const custom = map.CUSTOM?.[customKey ?? ''];
    return typeof custom === 'string' ? custom : null;
  }
  const url = (map as Record<string, unknown>)[disposition];
  return typeof url === 'string' ? url : null;
}

/**
 * E §11.1: vendor-specific beats language-specific beats default; inside each map a CUSTOM
 * disposition selects by `custom_key`. `null` means "no template" — the terminal page, which
 * the compiler makes unreachable for reachable dispositions (schema §17) but the runtime
 * handles anyway, because "unreachable" is not a runtime guarantee.
 */
export function resolveTemplate(
  redirects: Redirects | null | undefined,
  disposition: string,
  customKey: string | null,
  vendorRef: string | null,
  language: string,
): string | null {
  if (!redirects) return null;
  return (
    fromMap(vendorRef ? redirects.by_vendor?.[vendorRef] : undefined, disposition, customKey) ??
    fromMap(redirects.by_language?.[language], disposition, customKey) ??
    fromMap(redirects.default, disposition, customKey)
  );
}

/* ------------------------------------------------------------------ *
 * 2. Interpolation (E §11.2)
 * ------------------------------------------------------------------ */

export interface InterpolateInput {
  readonly template: string;
  readonly manifest: ArtifactManifest;
  /** The session's variable state, keyed by variable id. */
  readonly vars: Record<string, unknown>;
  /**
   * The vendor HMAC secret, when the deployment has one for this vendor. `null` disables the
   * `{{HMAC}}` pseudo-variable (it interpolates empty and is recorded), because signing with a
   * made-up key would produce a signature the vendor rejects while LOOKING configured.
   */
  readonly vendorSecret: string | null;
}

export interface InterpolateResult {
  readonly url: string;
  /** pii-flagged refs the template asked for; each was blocked and interpolated as empty. */
  readonly blockedPii: readonly string[];
  /** true when the template used {{HMAC}} but no secret was available. */
  readonly hmacUnavailable: boolean;
}

/**
 * Build the ref → value view the template pipes from. Variables are stored by id; templates
 * are authored against refs (`{{VENDOR_PID}}`), and the manifest is the id↔ref map. `pii:
 * true` refs are withheld from the view entirely — the pipe engine then renders them as the
 * empty token, which composes with percent-encoding to "the parameter is present but empty",
 * the least surprising shape for a vendor parser.
 */
function refView(
  manifest: ArtifactManifest,
  vars: Record<string, unknown>,
): { view: Record<string, unknown>; piiRefs: Set<string> } {
  const view: Record<string, unknown> = {};
  const piiRefs = new Set<string>();
  for (const entry of manifest.variable_manifest) {
    if (entry.pii) {
      piiRefs.add(entry.name);
      continue;
    }
    const value = vars[entry.id];
    if (value !== undefined && value !== null) view[entry.name] = value;
  }
  return { view, piiRefs };
}

/**
 * E §11.2's `{{HMAC}}`: `HMAC_sha256(vendor_secret, canonical(the other interpolated
 * params))`. "Canonical" here is the interpolated URL's query string with the pair carrying
 * the HMAC itself dropped and the remaining pairs sorted by key — sorted because two templates
 * that order parameters differently must not produce different signatures for the same data,
 * and with the HMAC pair dropped because a signature cannot cover itself.
 */
function computeHmac(urlWithSentinel: string, secret: string): string {
  let query = '';
  const qIndex = urlWithSentinel.indexOf('?');
  if (qIndex !== -1) {
    const params = new URLSearchParams(urlWithSentinel.slice(qIndex + 1));
    const pairs: string[] = [];
    for (const [k, v] of params) {
      if (!v.includes(SENTINEL)) pairs.push(`${k}=${v}`);
    }
    query = pairs.sort().join('&');
  }
  return createHmac('sha256', secret).update(query).digest('hex');
}

const HMAC_TOKEN = /\{\{\s*HMAC\s*\}\}/g;
/**
 * The stand-in the pipe engine carries through untouched (it only transforms `{{…}}` tokens).
 * NUL-delimited because no author can type one into a URL template through any editor path,
 * so a collision with literal template text is not possible.
 */
const SENTINEL = '\u0000HMAC\u0000';

export function interpolate(input: InterpolateInput): InterpolateResult {
  const { view, piiRefs } = refView(input.manifest, input.vars);

  // Which pii refs does the template actually reference? Recorded per E §11.2 — a template
  // asking for one is an authoring defect the trace should surface, not a silent empty.
  const blockedPii: string[] = [];
  for (const m of input.template.matchAll(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)/g)) {
    const ref = m[1]!;
    if (piiRefs.has(ref) && !blockedPii.includes(ref)) blockedPii.push(ref);
  }

  const usesHmac = HMAC_TOKEN.test(input.template);
  HMAC_TOKEN.lastIndex = 0;

  // Interpolate everything except {{HMAC}} first — the signature covers the OTHER params, so
  // they must be final strings before it is computed. The token becomes the sentinel, which the
  // pipe engine passes through untouched, and the sentinel becomes the signature (or nothing).
  const withSentinel = pipe(input.template.replace(HMAC_TOKEN, SENTINEL), view, {
    escapeContext: 'url',
    emptyToken: '',
  });

  let url = withSentinel;
  let hmacUnavailable = false;
  if (usesHmac) {
    if (input.vendorSecret) {
      url = withSentinel.replaceAll(SENTINEL, computeHmac(withSentinel, input.vendorSecret));
    } else {
      hmacUnavailable = true;
      url = withSentinel.replaceAll(SENTINEL, '');
    }
  }

  return { url, blockedPii, hmacUnavailable };
}

/* ------------------------------------------------------------------ *
 * 3. Post-interpolation validation (security §12.3 check 5)
 * ------------------------------------------------------------------ */

export type UrlRejection =
  | 'unparseable'
  | 'scheme_not_https'
  | 'has_userinfo'
  | 'ip_literal_host'
  | 'host_not_allowlisted';

/**
 * `allowlist` entries are exact hosts or single-level wildcards (`*.vendor.com` matches
 * `cb.vendor.com` but not `a.b.vendor.com` and not `vendor.com` — one level, exactly, because
 * multi-level wildcards are how `evil.com.vendor.com`-shaped confusions get allowlisted). An
 * EMPTY allowlist skips the host check but never the structural ones: the org-level redirect
 * host inventory is a control-plane feature (security §12.3 check 7) that has no authoring
 * path yet, and refusing every redirect until it exists would make the feature unshippable,
 * while https/userinfo/IP checks cost nothing and close the classic bypasses today.
 */
export function validateUrl(
  url: string,
  allowlist: readonly string[],
): { ok: true; parsed: URL } | { ok: false; reason: UrlRejection } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: 'unparseable' };
  }
  if (parsed.protocol !== 'https:') return { ok: false, reason: 'scheme_not_https' };
  if (parsed.username !== '' || parsed.password !== '') return { ok: false, reason: 'has_userinfo' };

  const host = parsed.hostname.toLowerCase();
  // IPv4 literal, or IPv6 (URL brackets it, hostname keeps the colons).
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':') || host.startsWith('[')) {
    return { ok: false, reason: 'ip_literal_host' };
  }

  if (allowlist.length > 0) {
    const allowed = allowlist.some(entry => {
      const e = entry.toLowerCase();
      if (e.startsWith('*.')) {
        const suffix = e.slice(2);
        return host.endsWith('.' + suffix) && !host.slice(0, -(suffix.length + 1)).includes('.');
      }
      return host === e;
    });
    if (!allowed) return { ok: false, reason: 'host_not_allowlisted' };
  }

  return { ok: true, parsed };
}

/* ------------------------------------------------------------------ *
 * The one call sites use
 * ------------------------------------------------------------------ */

export interface ResolveRedirectInput {
  readonly redirects: Redirects | null;
  readonly manifest: ArtifactManifest;
  readonly vars: Record<string, unknown>;
  readonly disposition: string;
  readonly customKey: string | null;
  readonly vendorRef: string | null;
  readonly language: string;
  readonly hostAllowlist: readonly string[];
  /** `(vendorRef) => secret | null`. Injected so the secret store stays out of this module. */
  readonly vendorSecret?: (vendorRef: string) => string | null;
}

export type RedirectOutcome =
  /** Send them here. `params` is what the interstitial shows in test mode (E §14.1). */
  | { readonly kind: 'redirect'; readonly url: string; readonly params: Record<string, string>;
      readonly blockedPii: readonly string[]; readonly hmacUnavailable: boolean }
  /** No template configured — the branded terminal page (E §11.1 step 6). */
  | { readonly kind: 'none' }
  /** A template existed but the interpolated URL failed validation. Terminal page + event. */
  | { readonly kind: 'rejected'; readonly template: string; readonly url: string;
      readonly reason: UrlRejection };

export function resolveRedirect(input: ResolveRedirectInput): RedirectOutcome {
  const template = resolveTemplate(
    input.redirects, input.disposition, input.customKey, input.vendorRef, input.language,
  );
  if (template === null) return { kind: 'none' };

  const secret =
    input.vendorRef && input.vendorSecret ? input.vendorSecret(input.vendorRef) : null;
  const { url, blockedPii, hmacUnavailable } = interpolate({
    template,
    manifest: input.manifest,
    vars: input.vars,
    vendorSecret: secret,
  });

  const verdict = validateUrl(url, input.hostAllowlist);
  if (!verdict.ok) return { kind: 'rejected', template, url, reason: verdict.reason };

  const params: Record<string, string> = {};
  for (const [k, v] of verdict.parsed.searchParams) params[k] = v;
  return { kind: 'redirect', url, params, blockedPii, hmacUnavailable };
}
