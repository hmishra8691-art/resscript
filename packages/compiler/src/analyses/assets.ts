/**
 * Author-supplied code and markup: `CMP-0500` (HTML that does not survive an allowlist),
 * `CMP-0501` (a script asset whose declared execution target and lifecycle hooks are incoherent),
 * `CMP-0502` (deliberately silent — see below), plus the script hashes and CSP directives the
 * artifact manifest carries — C §11, ADR-003, ADR-005, roadmap P1-08.
 *
 * ## The sanitizer is a detector, not a rewriter
 *
 * A rewriting sanitizer at compile time is the wrong tool twice over: it would silently change what
 * the author wrote (ADR-003's whole premise is that a programmer must be able to see that the
 * visual view is not the whole truth, and a compiler that quietly deletes an attribute makes the
 * stored document and the shipped artifact disagree), and it would put the security decision at the
 * moment nobody is watching. So this reports, with the offending tag or attribute and its character
 * offset, and refuses the publish. The author fixes the source.
 *
 * It is an **allowlist**, and a deliberately strict one: unknown tags and unknown attributes are
 * findings, not warnings. That direction is the only one that is safe against the thing this check
 * exists for — the next attribute the platform learns about is one the browser already supports.
 * The cost is that a legitimate but unlisted tag blocks a publish until the list grows, which is a
 * five-minute change on the record rather than a hole nobody notices. No npm dependency: a real
 * HTML5 tokenizer is 40kB of behaviour whose *disagreements* with a browser are exactly where the
 * bypasses live, and the parsing this needs (tags, attributes, quoted values, comments) is a small
 * hand-written scanner whose gaps are conservative by construction.
 *
 * The four classes the brief names are each covered by a rule below rather than by a special case:
 * an inline `on*` handler is an attribute outside the allowlist (and is *also* named explicitly, so
 * `detail.reason` says `event_handler` rather than `unknown_attribute`); `<script>` is a tag outside
 * the allowlist — a `ScriptAsset` is the declared surface for script, and its `source` is not
 * scanned here; a `javascript:` or non-image `data:` URL is a scheme check on every URL-bearing
 * attribute; and `<svg onload>` is the first rule again, which is the point of writing it as an
 * allowlist instead of as a list of known attacks.
 *
 * Two surfaces are scanned: `HtmlTemplateAsset.source`, and **every string in every language
 * bundle**. The second is not paranoia — a label is authored as an i18n key, so the HTML an author
 * writes into a question label lives in the bundle, and a translation bundle is the one place a
 * string can be edited by somebody who never sees the survey. `CssAsset.source` is not scanned:
 * CSS is not HTML, its dangerous constructs are different ones, and a checker that pretended
 * otherwise would give false assurance.
 *
 * ## CMP-0501 and the hook split
 *
 * `runs_on` is required by the type and `types/assets.ts` says why: "A client script and a server
 * script have completely different security models (ADR-005) … mixing them up is a vulnerability,
 * not a mistake. So the author declares intent and the compiler enforces the matching
 * restrictions." This is that enforcement. It reads a document that predates the required field
 * (hence the cast) and it checks the declared hooks against `SCRIPT_HOOK_TARGETS`.
 *
 * ## CMP-0502 is emitted nowhere, on purpose
 *
 * `validateStructural` already resolves every asset reference in the model, and there are exactly
 * ten of them: `BlockSettings.on_enter_scripts` / `on_exit_scripts`, `PageSettings.
 * html_template_ref` / `css_ref`, `QuestionScripts.on_load` / `on_answer` / `on_validate`,
 * `OptionMedia.image_asset_id`, `TextNode.html_template_ref`, `ApiCallNode.asset_id` and
 * `Design.generated.matrix_asset_id` — every field in the schema typed `AssetId`, each checked
 * against `collectAssetIds(survey)` through `checkIdRef`. A second pass would report the same
 * dangling id under a second code, which is what `flow.ts` and `registry.ts` both decline to do.
 * The code stays reserved for a reference surface the model does not have yet (an asset id inside a
 * plugin config, say, which no schema field types).
 */

import { createHash } from 'node:crypto';

import {
  SCRIPT_HOOKS,
  pointer,
  type JsonValue,
  type ScriptAsset,
  type ScriptHook,
  type ScriptTarget,
  type Survey,
} from '@resscript/schema';

import { cmpDiagnostic, sortCompileDiagnostics, type CompileDiagnostic } from '../diagnostics.js';

/* ========================================================================== */
/* 1. The allowlists                                                           */
/* ========================================================================== */

/**
 * Tags author HTML may use.
 *
 * Formatting, structure and links — the vocabulary a survey label or a page shell actually needs.
 * Everything that loads or executes something is absent and that is the list's whole content:
 * no `script`, no `iframe`, no `object`, no `embed`, no `form`, no `base`, no `svg` (an inline SVG
 * is a scripting surface, and a survey that needs one can reference a `media` asset).
 */
export const ALLOWED_HTML_TAGS: readonly string[] = [
  'a',
  'abbr',
  'b',
  'br',
  'caption',
  'code',
  'col',
  'colgroup',
  'div',
  'em',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'i',
  'img',
  'li',
  'ol',
  'p',
  'picture',
  'pre',
  's',
  'small',
  'source',
  'span',
  'strong',
  'sub',
  'sup',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'tr',
  'u',
  'ul',
  'wbr',
];

/**
 * Attributes author HTML may carry, plus `data-*` (checked separately).
 *
 * `style` is present and `class` is present because conditional formatting through the theme is a
 * declared feature (`QuestionItem.custom_class`). No `srcdoc`, no `formaction`, no `xlink:href`, and no
 * `on*` — the last is checked by prefix rather than by absence from this list, so its finding can
 * say `event_handler` instead of `disallowed_attribute`.
 */
export const ALLOWED_HTML_ATTRIBUTES: readonly string[] = [
  'alt',
  'aria-describedby',
  'aria-hidden',
  'aria-label',
  'aria-labelledby',
  'class',
  'colspan',
  'dir',
  'height',
  'href',
  'id',
  'lang',
  'loading',
  'media',
  'rel',
  'role',
  'rowspan',
  'scope',
  'sizes',
  'src',
  'srcset',
  'style',
  'target',
  'title',
  'type',
  'width',
];

/** Attributes whose value is a URL, and therefore gets the scheme check. */
const URL_ATTRIBUTES: readonly string[] = ['href', 'src', 'srcset', 'action', 'formaction', 'poster'];

/** Schemes a URL attribute may use. Relative and protocol-relative URLs carry no scheme. */
const ALLOWED_URL_SCHEMES: readonly string[] = ['http', 'https', 'mailto', 'tel'];

/**
 * Which execution targets each lifecycle hook exists on.
 *
 * **A security-relevant claim, which is why it is a named exported constant with this comment
 * rather than a `switch` inside a validator.** ADR-005 makes the two targets different trust
 * domains: a client script is sandboxed in the respondent's browser and cannot be trusted with
 * anything, a server script executes with server privileges. A hook that exists on only one side
 * and is declared on the other is a script that either never runs (dead code the author believes is
 * enforcing something) or runs in the wrong trust domain.
 *
 *  - `onSurveyStart` — **both**. The server creates the session; the client initialises its shell.
 *  - `onPageLoad` — **client only**. A page render happens in a browser. The server ships an
 *    artifact, not a rendered page, so there is no server-side moment for this hook to be.
 *  - `onAnswer` — **client only**. It fires as the respondent changes an answer; the server never
 *    sees intermediate answers, only a page submit.
 *  - `onValidate` — **both**, and deliberately so: ADR-004's dual evaluation means the client
 *    validates for instant feedback and the server validates authoritatively.
 *  - `onPageSubmit` — **both**. The client's pre-submit pass and the server's on-receipt pass.
 *  - `onSurveyEnd` — **server only**. The respondent is being redirected off-site; nothing
 *    client-side is guaranteed to run after the last submit, and everything that genuinely happens
 *    at survey end (disposition, quota commit, vendor callback) is server work.
 *
 * This mapping should be re-checked against the runtime's hook dispatcher when P1-09 lands; until
 * there is a dispatcher to read, it is derived from where each moment exists.
 */
export const SCRIPT_HOOK_TARGETS: { readonly [K in ScriptHook]: readonly ScriptTarget[] } = {
  onSurveyStart: ['client', 'server'],
  onPageLoad: ['client'],
  onAnswer: ['client'],
  onValidate: ['client', 'server'],
  onPageSubmit: ['client', 'server'],
  onSurveyEnd: ['server'],
};

/** How many findings one `CMP-0500` lists. A 500-line template has one cause, not 200. */
export const MAX_LISTED_FINDINGS = 20;

export interface AssetsInput {
  readonly survey: Survey;
}

export function analyzeAssets(input: AssetsInput): readonly CompileDiagnostic[] {
  return sortCompileDiagnostics([...unsafeHtml(input.survey), ...incoherentScripts(input.survey)]);
}

/* ========================================================================== */
/* 2. CMP-0500 — the HTML scanner                                              */
/* ========================================================================== */

export interface HtmlFinding {
  /** `disallowed_tag` | `event_handler` | `disallowed_attribute` | `disallowed_url_scheme`. */
  readonly reason: string;
  /** Lowercased tag name the finding is inside. */
  readonly tag: string;
  /** Attribute name, for the two attribute reasons. */
  readonly attribute: string | null;
  /** Character offset of the offending construct in the scanned source. */
  readonly at: number;
  /** The scheme, for `disallowed_url_scheme`. */
  readonly scheme: string | null;
}

/**
 * Scan a string of author HTML against the allowlists.
 *
 * Exported because it is the interesting half of this module and it is worth testing directly on
 * strings rather than only through a survey fixture. The scanner is intentionally simple: find
 * `<`, read a tag name, then read attribute names and quoted or unquoted values until `>`. It does
 * not build a tree, does not track nesting, and does not attempt to be a browser — every construct
 * it fails to understand is reported rather than skipped, which is the conservative direction.
 */
export function scanHtml(source: string): readonly HtmlFinding[] {
  const findings: HtmlFinding[] = [];
  const allowedTags = new Set(ALLOWED_HTML_TAGS);
  const allowedAttributes = new Set(ALLOWED_HTML_ATTRIBUTES);
  const urlAttributes = new Set(URL_ATTRIBUTES);

  let i = 0;
  while (i < source.length) {
    const open = source.indexOf('<', i);
    if (open < 0) break;

    // A comment is inert, and its contents are not markup — but an unterminated one would let
    // everything after it hide, so the scan stops rather than continuing past the end.
    if (source.startsWith('<!--', open)) {
      const close = source.indexOf('-->', open + 4);
      if (close < 0) break;
      i = close + 3;
      continue;
    }
    // `<!doctype …>` and processing instructions: skipped, not reported. They carry no attributes
    // this check has an opinion about.
    if (source.startsWith('<!', open) || source.startsWith('<?', open)) {
      const close = source.indexOf('>', open);
      if (close < 0) break;
      i = close + 1;
      continue;
    }

    let cursor = open + 1;
    const closing = source[cursor] === '/';
    if (closing) cursor += 1;
    const nameStart = cursor;
    while (cursor < source.length && /[A-Za-z0-9:_-]/.test(source[cursor] ?? '')) cursor += 1;
    const tag = source.slice(nameStart, cursor).toLowerCase();
    if (tag === '') {
      // A bare `<` in prose. Not markup, not a finding.
      i = open + 1;
      continue;
    }

    if (!allowedTags.has(tag)) {
      findings.push({ reason: 'disallowed_tag', tag, attribute: null, at: open, scheme: null });
    }

    if (closing) {
      const close = source.indexOf('>', cursor);
      i = close < 0 ? source.length : close + 1;
      continue;
    }

    // Attributes.
    for (;;) {
      while (cursor < source.length && /\s/.test(source[cursor] ?? '')) cursor += 1;
      const ch = source[cursor];
      if (ch === undefined) break;
      if (ch === '>') {
        cursor += 1;
        break;
      }
      if (ch === '/') {
        cursor += 1;
        continue;
      }
      const attrStart = cursor;
      while (cursor < source.length && /[^\s=>/]/.test(source[cursor] ?? '')) cursor += 1;
      const rawName = source.slice(attrStart, cursor);
      if (rawName === '') {
        cursor += 1;
        continue;
      }
      const name = rawName.toLowerCase();

      // Value, if any.
      let value = '';
      let after = cursor;
      while (after < source.length && /\s/.test(source[after] ?? '')) after += 1;
      if (source[after] === '=') {
        after += 1;
        while (after < source.length && /\s/.test(source[after] ?? '')) after += 1;
        const quote = source[after];
        if (quote === '"' || quote === "'") {
          const end = source.indexOf(quote, after + 1);
          value = end < 0 ? source.slice(after + 1) : source.slice(after + 1, end);
          after = end < 0 ? source.length : end + 1;
        } else {
          const valueStart = after;
          while (after < source.length && /[^\s>]/.test(source[after] ?? '')) after += 1;
          value = source.slice(valueStart, after);
        }
      }
      cursor = after;

      if (name.startsWith('on')) {
        findings.push({
          reason: 'event_handler',
          tag,
          attribute: name,
          at: attrStart,
          scheme: null,
        });
      } else if (!allowedAttributes.has(name) && !name.startsWith('data-')) {
        findings.push({
          reason: 'disallowed_attribute',
          tag,
          attribute: name,
          at: attrStart,
          scheme: null,
        });
      }

      if (urlAttributes.has(name) && value !== '') {
        const scheme = schemeOf(value);
        if (scheme !== undefined && !isAllowedScheme(scheme, value)) {
          findings.push({
            reason: 'disallowed_url_scheme',
            tag,
            attribute: name,
            at: attrStart,
            scheme,
          });
        }
      }
    }

    i = cursor;
  }

  return findings;
}

/**
 * The scheme of a URL value, or `undefined` when it has none (relative, or protocol-relative).
 *
 * Whitespace and control characters are stripped before the test, and that is the whole reason this
 * is a function: `java\nscript:alert(1)` is a working `javascript:` URL in a browser, and a naive
 * `startsWith('javascript:')` misses it. Same for the HTML-entity spellings, which is why anything
 * containing `&#` before its colon is treated as having an unrecognizable scheme rather than none.
 */
function schemeOf(value: string): string | undefined {
  const stripped = value.replace(/[\s\u0000-\u001F\u007F]/g, '');
  const colon = stripped.indexOf(':');
  if (colon <= 0) return undefined;
  const head = stripped.slice(0, colon);
  // A colon inside a path or a query is not a scheme (`/a/b:c`, `?x=1:2`).
  if (/[/?#]/.test(head)) return undefined;
  if (head.includes('&#')) return 'entity_encoded';
  return head.toLowerCase();
}

/** `data:` is allowed for images only, which is the one legitimate inline-asset case. */
function isAllowedScheme(scheme: string, value: string): boolean {
  if (ALLOWED_URL_SCHEMES.includes(scheme)) return true;
  if (scheme !== 'data') return false;
  return /^\s*data:image\/(png|jpeg|jpg|gif|webp|avif)\s*;/i.test(value.replace(/\s+/g, ''));
}

interface HtmlSurface {
  readonly source: string;
  readonly path: string;
  readonly origin: string;
  readonly detail: { readonly [key: string]: JsonValue };
}

function htmlSurfaces(survey: Survey): readonly HtmlSurface[] {
  const out: HtmlSurface[] = [];

  (survey.assets?.html_templates ?? []).forEach((asset, index) => {
    out.push({
      source: asset.source,
      path: pointer('assets', 'html_templates', index, 'source'),
      origin: 'html_template',
      detail: { asset_id: asset.id, asset_ref: asset.ref },
    });
  });

  // Every bundle, base included, and in sorted key order so the diagnostics array is stable.
  const bundles = survey.languages.bundles;
  for (const language of Object.keys(bundles).sort()) {
    const bundle = bundles[language];
    if (bundle === undefined) continue;
    for (const key of Object.keys(bundle).sort()) {
      const value = bundle[key];
      // Cheap pre-filter: a string with no `<` cannot produce a tag finding, and the overwhelming
      // majority of a bundle is plain text.
      if (value === undefined || !value.includes('<')) continue;
      out.push({
        source: value,
        path: pointer('languages', 'bundles', language, key),
        origin: 'i18n_string',
        detail: { language, i18n_key: key },
      });
    }
  }

  return out;
}

function unsafeHtml(survey: Survey): readonly CompileDiagnostic[] {
  const out: CompileDiagnostic[] = [];
  for (const surface of htmlSurfaces(survey)) {
    const findings = scanHtml(surface.source);
    if (findings.length === 0) continue;
    const first = findings[0];
    out.push(
      cmpDiagnostic(
        'CMP-0500',
        `Author HTML in ${surface.origin} did not survive sanitization: ` +
          `${String(findings.length)} disallowed construct(s), the first being ` +
          `${describe(first)} at offset ${String(first?.at ?? 0)}.`,
        surface.path,
        {
          ...surface.detail,
          origin: surface.origin,
          finding_count: findings.length,
          truncated: findings.length > MAX_LISTED_FINDINGS,
          reasons: [...new Set(findings.map((finding) => finding.reason))].sort(),
          findings: findings.slice(0, MAX_LISTED_FINDINGS).map((finding) => ({
            reason: finding.reason,
            tag: finding.tag,
            attribute: finding.attribute,
            at: finding.at,
            scheme: finding.scheme,
          })),
        },
      ),
    );
  }
  return out;
}

function describe(finding: HtmlFinding | undefined): string {
  if (finding === undefined) return 'nothing';
  switch (finding.reason) {
    case 'disallowed_tag':
      return `the tag <${finding.tag}>`;
    case 'event_handler':
      return `the inline event handler ${finding.attribute ?? ''} on <${finding.tag}>`;
    case 'disallowed_url_scheme':
      return `the ${finding.scheme ?? ''} URL in ${finding.attribute ?? ''} on <${finding.tag}>`;
    default:
      return `the attribute ${finding.attribute ?? ''} on <${finding.tag}>`;
  }
}

/* ========================================================================== */
/* 3. CMP-0501 — script target coherence                                       */
/* ========================================================================== */

function incoherentScripts(survey: Survey): readonly CompileDiagnostic[] {
  const out: CompileDiagnostic[] = [];
  (survey.assets?.scripts ?? []).forEach((asset, index) => {
    const base = pointer('assets', 'scripts', index);
    const target = declaredTarget(asset);

    if (target === undefined) {
      out.push(
        cmpDiagnostic(
          'CMP-0501',
          `Script asset ${asset.ref} declares no runs_on. A client script and a server script ` +
            'have different trust domains (ADR-005) and the difference cannot be inferred from ' +
            'the source, so the compile refuses to guess.',
          `${base}/runs_on`,
          {
            asset_id: asset.id,
            asset_ref: asset.ref,
            scope: asset.scope,
            reason: 'runs_on_absent',
            hooks: [...asset.hooks],
          },
        ),
      );
      return;
    }

    const incompatible = asset.hooks.filter((hook) => {
      const targets = SCRIPT_HOOK_TARGETS[hook];
      // A hook name this build does not know is not a compatibility claim to make: it is either a
      // newer schema or a typo, and `SCRIPT_HOOKS` is what would report it.
      return targets !== undefined && !targets.includes(target);
    });
    if (incompatible.length === 0) return;

    out.push(
      cmpDiagnostic(
        'CMP-0501',
        `Script asset ${asset.ref} runs on the ${target} and declares ` +
          `${incompatible.join(', ')}, which ` +
          `${incompatible.length === 1 ? 'is a hook that does' : 'are hooks that do'} not exist ` +
          `on the ${target}. The script would never run at that point, so whatever it enforces is ` +
          'not enforced.',
        `${base}/hooks`,
        {
          asset_id: asset.id,
          asset_ref: asset.ref,
          scope: asset.scope,
          runs_on: target,
          reason: 'hook_target_mismatch',
          hooks: [...asset.hooks],
          incompatible_hooks: [...incompatible],
          known_hooks: [...SCRIPT_HOOKS],
        },
      ),
    );
  });
  return out;
}

/**
 * `runs_on`, read defensively.
 *
 * The field is required by the type, so this reads through a cast — the case it exists for is a
 * document written before the field was added, which parses as a `ScriptAsset` and has nothing
 * there. Anything that is not one of the two declared targets is treated as absent rather than
 * passed through: a typo'd target is not a third trust domain.
 */
function declaredTarget(asset: ScriptAsset): ScriptTarget | undefined {
  const declared = (asset as { readonly runs_on?: unknown }).runs_on;
  return declared === 'client' || declared === 'server' ? declared : undefined;
}

/* ========================================================================== */
/* 4. Script hashes and CSP                                                    */
/* ========================================================================== */

/**
 * `ScriptAsset.ref → base64 sha256 of its source`, which is `ArtifactManifest.script_hashes`.
 *
 * Base64 and not hex, because the only consumer that has a required format is CSP and it requires
 * base64 (`'sha256-<base64>'`); carrying hex in the manifest and converting at the directive would
 * mean two encodings of one number in one artifact, and the wrong one would eventually reach a
 * header. `cspDirectives` therefore takes these values verbatim.
 *
 * The digest is **computed, never read from `ScriptAsset.sha256`**. That field is author-supplied
 * (or written by an earlier tool), and an integrity hash whose value comes from the same place as
 * the bytes it covers verifies nothing. A declared hash that disagrees with the computed one is a
 * finding worth having and has no code in this milestone; it is not silently preferred.
 *
 * Keyed by `ref` because that is what the manifest field is documented as (`ref → sha256`) and what
 * a CSP violation report can be traced back to. A duplicate ref is `SCH-1014`'s neighbour and is
 * not this function's to report: last one wins, deterministically, in document order.
 */
export function scriptHashes(survey: Survey): { readonly [ref: string]: string } {
  const out: { [ref: string]: string } = {};
  for (const asset of survey.assets?.scripts ?? []) {
    out[asset.ref] = createHash('sha256').update(asset.source, 'utf8').digest('base64');
  }
  return out;
}

/**
 * `ArtifactManifest.csp_directives`, from the script hashes.
 *
 * `default-src 'none'` first, because a policy that enumerates what is allowed and forgets a
 * fetch directive falls back to the default, and the safe default is nothing. Everything else is
 * the narrowest thing the runtime actually needs: hashed inline scripts, `'self'` styles plus
 * inline (the compiled theme is a `<style>` block), images from `self`, `data:` (the one inline
 * asset case the HTML scanner also allows) and `https:` for a media CDN, XHR to `'self'` only, and
 * `frame-ancestors 'none'` so a survey cannot be framed into a clickjacking harness — the preview
 * iframe is same-origin studio chrome and gets its own policy.
 *
 * Server-target scripts contribute a hash too. Their source never reaches the browser, so the entry
 * permits a script that can never load: inert, and the alternative — filtering by `runs_on` here —
 * would need this function to take the survey rather than the hashes, which is the coupling the
 * separate `scriptHashes` exists to avoid.
 *
 * Directive values are sorted, because these bytes are hashed into the artifact id.
 */
export function cspDirectives(hashes: {
  readonly [ref: string]: string;
}): { readonly [directive: string]: readonly string[] } {
  const sources = Object.keys(hashes)
    .sort()
    .map((ref) => `'sha256-${hashes[ref] ?? ''}'`);
  return {
    'default-src': ["'none'"],
    'script-src': ["'self'", ...sources],
    'style-src': ["'self'", "'unsafe-inline'"],
    'img-src': ["'self'", 'data:', 'https:'],
    'connect-src': ["'self'"],
    'frame-ancestors': ["'none'"],
  };
}
