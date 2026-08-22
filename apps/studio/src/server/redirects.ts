/**
 * Redirect template validation and coverage — the authoring half of security §12.3.
 *
 * ## Why templates are validated HERE, before any write
 *
 * API §2.9: "every template is validated on write … failures are 422, never stored." A stored
 * template is a URL a respondent's browser will be sent to, and the runtime's own re-validation
 * (`apps/runtime/src/redirect`'s `validateUrl`, security §12.3 check 5) runs at the worst
 * possible moment to discover a typo: the respondent is already terminated, the terminal page is
 * the fallback, and the vendor never gets its callback. So the same structural checks run at
 * authoring time, on the TEMPLATE rather than the interpolated result — which is a different
 * string, which is why the runtime still checks its own.
 *
 * Restated rather than imported, deliberately: `apps/studio` must not depend on `apps/runtime`
 * (app-to-app imports are what `.dependency-cruiser.cjs` forbids), and the two run on different
 * inputs anyway — this one has to reason about `{{PLACEHOLDER}}`s the runtime has already
 * substituted away. The rejection vocabulary is kept identical so an author who sees
 * `scheme_not_https` here and a field team that sees it in a runtime event are reading one enum.
 *
 * ## The placeholder problem
 *
 * A template is not a URL — `https://cb.vendor.com/?rid={{RID}}` fails `new URL()` on some
 * runtimes and parses misleadingly on others — so validation is two passes:
 *
 *   1. REJECT any `{{` inside the scheme or authority, BEFORE substitution. Interpolation is
 *      fine in path, query and fragment (that is what templates are for); in the authority it is
 *      an open redirect kit — `https://{{HOST}}/…` sends the respondent wherever a variable
 *      says, and no post-substitution check at authoring time can see the value the runtime will
 *      substitute.
 *   2. Substitute a benign token for the remaining placeholders and validate the result
 *      structurally: https-only scheme, no userinfo, no IP-literal host.
 *
 * ## What is deliberately NOT checked
 *
 *   - **The org host allowlist.** The runtime's `validateUrl` takes one and skips the host check
 *     when it is empty; the org-level redirect host inventory is a control-plane feature
 *     (security §12.3 check 7) with no authoring path yet, so there is nothing to read and
 *     pretending otherwise would be a check against an invented list. When the inventory lands,
 *     this module gains the same exact-host / single-level-wildcard match the runtime has.
 *   - **PII in placeholders.** That is `CMP-0301`'s job at compile time, where the variable
 *     registry is in hand; a duplicate here would be the copy that goes stale.
 */

import type { ErrorDetail } from '@resscript/observability';
import { REDIRECT_REQUIRED_DISPOSITIONS } from '@resscript/schema';
import type { RedirectRow } from './repo/types.js';

/* -------------------------------------------------------------------------- */
/* Template validation                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The compiler's placeholder alphabet (`analyses/redirects.ts`): `{{NAME}}` and `{{NAME.attr}}`,
 * whitespace tolerated because authors write it. Anything else containing `{{` is NOT treated as
 * a placeholder — it survives substitution and fails as the malformed URL it is.
 */
const PLACEHOLDER = /\{\{\s*[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*\s*\}\}/g;

/** The runtime's `UrlRejection` vocabulary, plus the one only a template can commit. */
export type TemplateRejection =
  | 'interpolation_in_authority'
  | 'unparseable'
  | 'scheme_not_https'
  | 'has_userinfo'
  | 'ip_literal_host';

const REJECTION_MESSAGES: Readonly<Record<TemplateRejection, string>> = {
  interpolation_in_authority:
    'placeholders are allowed in the path, query and fragment only — a {{…}} in the scheme or ' +
    'host would let a variable choose where the respondent is sent',
  unparseable: 'not a parseable URL once placeholders are substituted',
  scheme_not_https: 'redirects must use https://',
  has_userinfo: 'a user@host URL is a phishing shape and is never a vendor callback',
  ip_literal_host: 'the host must be a name, not an IP literal',
};

/**
 * One template, structurally. `ok: false` carries the reason as a machine code so the route can
 * put it in the 422's `details[].code` — the same field the runtime's rejection event uses.
 */
export function validateRedirectTemplate(
  template: string,
): { readonly ok: true } | { readonly ok: false; readonly reason: TemplateRejection } {
  // Pass 1: no placeholder may start before the authority ends. The authority ends at the first
  // `/`, `?` or `#` after `://`; a template with no `://` at all has no authority to protect and
  // falls through to pass 2, where it fails as unparseable or as the wrong scheme.
  const firstPlaceholder = template.indexOf('{{');
  const schemeSep = template.indexOf('://');
  if (firstPlaceholder !== -1 && schemeSep !== -1) {
    const authorityStart = schemeSep + '://'.length;
    const rest = template.slice(authorityStart);
    const stops = ['/', '?', '#']
      .map((stop) => rest.indexOf(stop))
      .filter((index) => index !== -1);
    const authorityEnd = authorityStart + (stops.length > 0 ? Math.min(...stops) : rest.length);
    if (firstPlaceholder < authorityEnd) return { ok: false, reason: 'interpolation_in_authority' };
  }

  // Pass 2: substitute a benign token and validate the string a browser would see. 'x' rather
  // than '' so `?rid={{RID}}` keeps a value and `/p/{{A}}/{{B}}` keeps two path segments.
  let parsed: URL;
  try {
    parsed = new URL(template.replace(PLACEHOLDER, 'x'));
  } catch {
    return { ok: false, reason: 'unparseable' };
  }
  if (parsed.protocol !== 'https:') return { ok: false, reason: 'scheme_not_https' };
  if (parsed.username !== '' || parsed.password !== '') return { ok: false, reason: 'has_userinfo' };
  const host = parsed.hostname.toLowerCase();
  // IPv4 literal, or IPv6 (URL brackets it, hostname keeps the colons) — same test as the runtime.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':') || host.startsWith('[')) {
    return { ok: false, reason: 'ip_literal_host' };
  }
  return { ok: true };
}

/* -------------------------------------------------------------------------- */
/* Whole-set validation — every offending row in ONE 422                       */
/* -------------------------------------------------------------------------- */

/**
 * Everything Zod's per-field pass cannot say about a redirect set: 0010's biconditional CHECKs,
 * the primary key, and the template checks above. Returned as `ErrorDetail`s with the row INDEX
 * in the path (`redirects.3.url_template`) because a PUT is a whole-set replace and "row 3 of
 * what you sent" is the only address the client has — nothing is stored to point at.
 *
 * All rows are checked before anything is returned, so one request's failures arrive as one 422
 * rather than as a fix-resubmit loop of length n.
 */
export function redirectSetDiagnostics(rows: readonly RedirectRow[]): readonly ErrorDetail[] {
  const details: ErrorDetail[] = [];
  const seen = new Map<string, number>();

  rows.forEach((row, index) => {
    // 0010's `redirects_scope_key_shape`: a `default` row with a vendor ref, or a vendor row
    // with no ref, is a redirect that silently never matches.
    if ((row.scope === 'default') !== (row.scope_key === '')) {
      details.push({
        path: `redirects.${index}.scope_key`,
        code: 'scope_key_shape',
        message:
          row.scope === 'default'
            ? 'a default-scope row carries no scope_key'
            : `a ${row.scope}-scope row needs a non-empty scope_key`,
      });
    }
    // 0010's `redirects_custom_key_shape`: `custom_key` selects an entry of the CUSTOM sub-map
    // and means nothing on any other disposition.
    if ((row.disposition === 'CUSTOM') !== (row.custom_key !== '')) {
      details.push({
        path: `redirects.${index}.custom_key`,
        code: 'custom_key_shape',
        message:
          row.disposition === 'CUSTOM'
            ? 'a CUSTOM row needs a non-empty custom_key'
            : 'custom_key applies to CUSTOM rows only',
      });
    }
    // 0010's `redirects_template_nonempty`: a row that exists with a blank template is worse
    // than a missing row — coverage would pass and the respondent would be sent to nothing.
    if (row.url_template.trim() === '') {
      details.push({
        path: `redirects.${index}.url_template`,
        code: 'template_empty',
        message: 'a redirect row with a blank template covers nothing',
      });
    } else {
      const verdict = validateRedirectTemplate(row.url_template);
      if (!verdict.ok) {
        details.push({
          path: `redirects.${index}.url_template`,
          code: verdict.reason,
          message: REJECTION_MESSAGES[verdict.reason],
        });
      }
    }
    // The primary key. Two rows under one (scope, scope_key, disposition, custom_key) would be
    // an INSERT that fails halfway through the replace; named here against the LATER row so the
    // author knows which one to delete.
    const key = `${row.scope} ${row.scope_key} ${row.disposition} ${row.custom_key}`;
    const first = seen.get(key);
    if (first !== undefined) {
      details.push({
        path: `redirects.${index}`,
        code: 'duplicate_row',
        message: `duplicates row ${first} — one template per (scope, scope_key, disposition, custom_key)`,
      });
    } else {
      seen.set(key, index);
    }
  });

  return details;
}

/* -------------------------------------------------------------------------- */
/* Coverage (API §2.9)                                                        */
/* -------------------------------------------------------------------------- */

/** One uncovered population. `vendor`/`language` are null for the bare-link default population. */
export interface MissingRedirect {
  readonly disposition: string;
  readonly vendor: string | null;
  readonly language: string | null;
}

/**
 * Which redirect-required dispositions have no template — the stored-rows half of `CMP-0300`.
 *
 * The disposition list is `REDIRECT_REQUIRED_DISPOSITIONS`, imported and never restated: K §2's
 * registry is the one place that knows "ABANDONED and TIMED_OUT are excluded — nobody to
 * redirect", and the compiler's `CMP-0300` filters by the same array, so the two answers cannot
 * drift apart on WHICH dispositions matter. Where they legitimately differ is reachability: the
 * gate intersects with the compiled flow ("a study with no quotas needs no QUOTA_FULL URL") and
 * this endpoint deliberately does not — it reads rows, not the flow, so it reports against the
 * full required list and the editor renders it as a checklist rather than a blocker. The
 * blocker is the gate's.
 *
 * The precedence is the runtime's (`by_vendor → by_language → default`), which collapses here
 * to: a default-scope template covers every population, and an override map is only worth
 * reporting on where it exists AND the default beneath it is missing. Vendor and language keys
 * are enumerated FROM THE ROWS, never from an inventory — the vendor registry is P2-04 and does
 * not exist to consult, and inventing its contents would report gaps for vendors this version
 * never fields.
 *
 * `CUSTOM` is excluded: coverage of CUSTOM is asked per `custom_key`, the keys are declared by
 * flow nodes this endpoint does not read, and a row-count answer ("some CUSTOM row exists")
 * would be exactly the wrong-in-both-directions check the compiler's header warns against.
 * `CMP-0300` owns it, per key, with the flow in hand.
 */
export function missingRedirectCoverage(rows: readonly RedirectRow[]): readonly MissingRedirect[] {
  const covered = (scope: RedirectRow['scope'], scopeKey: string, disposition: string): boolean =>
    rows.some(
      (row) =>
        row.scope === scope &&
        row.scope_key === scopeKey &&
        row.disposition === disposition &&
        row.url_template.trim() !== '',
    );
  const keysOf = (scope: RedirectRow['scope']): readonly string[] =>
    [...new Set(rows.filter((row) => row.scope === scope).map((row) => row.scope_key))].sort();

  const missing: MissingRedirect[] = [];
  for (const disposition of REDIRECT_REQUIRED_DISPOSITIONS) {
    if (disposition === 'CUSTOM') continue;
    // A default-scope template is the floor of the resolution order: with it, every population
    // resolves and nothing is missing anywhere.
    if (covered('default', '', disposition)) continue;
    missing.push({ disposition, vendor: null, language: null });
    for (const vendor of keysOf('vendor')) {
      if (!covered('vendor', vendor, disposition)) {
        missing.push({ disposition, vendor, language: null });
      }
    }
    for (const language of keysOf('language')) {
      if (!covered('language', language, disposition)) {
        missing.push({ disposition, vendor: null, language });
      }
    }
  }
  return missing;
}
