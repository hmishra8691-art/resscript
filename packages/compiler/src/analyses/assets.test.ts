/**
 * What the asset checks must get right.
 *
 * `scanHtml` is tested directly on strings as well as through a survey, because it is the security
 * surface and the interesting cases are string-shaped: an `onerror=` attribute, a `javascript:`
 * href, the same href with whitespace inside the scheme (which a browser accepts and a naive
 * `startsWith` misses), and the one `data:` URL that is allowed. The allowlist direction is asserted
 * too — an unlisted tag is a finding — because that is the property that makes the next unknown
 * attribute safe by default rather than safe by luck.
 *
 * `SCRIPT_HOOK_TARGETS` is asserted in both directions (a server script on a client-only hook and a
 * client script on the server-only one), since a mapping that is right in one direction and empty
 * in the other looks identical in a one-sided test.
 *
 * `cspDirectives` is asserted on the encoding: base64, `'sha256-…'`, `default-src 'none'`. Hex
 * would fail every browser silently, which is exactly the kind of thing a unit test is for.
 *
 * Diagnostics are asserted by code and `detail`, never by message prose.
 */

import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';
import type { Assets, ScriptAsset, StringBundle, Survey } from '@resscript/schema';

import { deterministicIds } from '../../../schema/src/__fixtures__/mini.js';
import type { CompileDiagnostic } from '../diagnostics.js';
import {
  SCRIPT_HOOK_TARGETS,
  analyzeAssets,
  cspDirectives,
  scanHtml,
  scriptHashes,
} from './assets.js';

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

interface Spec {
  readonly assets?: Assets;
  readonly bundle?: StringBundle;
}

function surveyOf(spec: Spec): Survey {
  const ids = deterministicIds();
  return {
    meta: { id: ids.next('survey'), ref: 'ASSET', name: 'Asset fixture' },
    schema_version: 2,
    settings: {
      navigation: { back_allowed: true },
      resume: { enabled: false, window_s: 3600, position: 'last_page' },
      progress_bar: { mode: 'none' },
      screenout: { show_message: false },
    },
    languages: {
      base: 'en',
      available: [{ code: 'en' }],
      bundles: { en: spec.bundle ?? {} },
      policy: { on_missing: 'fallback_to_base', block_publish_if_incomplete: false },
    },
    variables: [],
    content: [],
    flow: { nodes: [] },
    logic_rules: [],
    ...(spec.assets === undefined ? {} : { assets: spec.assets }),
  };
}

function run(spec: Spec): readonly CompileDiagnostic[] {
  return analyzeAssets({ survey: surveyOf(spec) });
}

function template(source: string): Assets {
  const ids = deterministicIds(11);
  return { html_templates: [{ id: ids.next('asset'), ref: 'shell', source }] };
}

function script(overrides: Partial<ScriptAsset>): Assets {
  const ids = deterministicIds(12);
  return {
    scripts: [
      {
        id: ids.next('asset'),
        ref: 'tracker',
        scope: 'survey',
        hooks: ['onPageLoad'],
        source: 'export function onPageLoad() {}',
        runs_on: 'client',
        ...overrides,
      },
    ],
  };
}

function codes(diagnostics: readonly CompileDiagnostic[]): readonly string[] {
  return diagnostics.map((d) => d.code);
}

function detailOf(
  diagnostics: readonly CompileDiagnostic[],
  code: string,
): { readonly [key: string]: unknown } {
  const found = diagnostics.find((d) => d.code === code);
  if (found?.detail === undefined) throw new Error(`no ${code} with detail`);
  return found.detail;
}

interface Finding {
  readonly reason: string;
  readonly tag: string;
  readonly attribute: string | null;
  /** Character offset in the scanned source — the "position" the brief asks `detail` to carry. */
  readonly at: number;
  readonly scheme: string | null;
}

function findings(diagnostics: readonly CompileDiagnostic[]): readonly Finding[] {
  return detailOf(diagnostics, 'CMP-0500')['findings'] as readonly Finding[];
}

/* -------------------------------------------------------------------------- */
/* The scanner                                                                 */
/* -------------------------------------------------------------------------- */

describe('scanHtml', () => {
  it('finds an inline event handler', () => {
    expect(scanHtml('<img src="/logo.png" onerror="fetch(evil)">')).toEqual([
      { reason: 'event_handler', tag: 'img', attribute: 'onerror', at: 21, scheme: null },
    ]);
  });

  it('finds an onload on an svg, and the svg itself', () => {
    const found = scanHtml('<svg onload="x()"></svg>');
    expect(found.map((finding) => finding.reason)).toEqual([
      'disallowed_tag',
      'event_handler',
      'disallowed_tag',
    ]);
  });

  it('finds a javascript: href', () => {
    const found = scanHtml('<a href="javascript:alert(1)">click</a>');
    expect(found.length).toBe(1);
    expect(found[0]?.reason).toBe('disallowed_url_scheme');
    expect(found[0]?.scheme).toBe('javascript');
    expect(found[0]?.attribute).toBe('href');
  });

  it('finds a javascript: href split by whitespace, which a browser still executes', () => {
    const found = scanHtml('<a href="java\nscript:alert(1)">click</a>');
    expect(found.map((finding) => finding.scheme)).toEqual(['javascript']);
  });

  it('finds a script tag, which only a ScriptAsset may declare', () => {
    const found = scanHtml('<p>hello</p><script>evil()</script>');
    expect(found.map((finding) => finding.tag)).toEqual(['script', 'script']);
    expect(found.every((finding) => finding.reason === 'disallowed_tag')).toBe(true);
  });

  it('treats an unlisted tag as a finding, which is what makes the list an allowlist', () => {
    expect(scanHtml('<marquee>hi</marquee>').map((finding) => finding.tag)).toEqual([
      'marquee',
      'marquee',
    ]);
  });

  it('allows an image data URL and rejects any other data URL', () => {
    expect(scanHtml('<img src="data:image/png;base64,AAAA">')).toEqual([]);
    const found = scanHtml('<img src="data:text/html;base64,AAAA">');
    expect(found.map((finding) => finding.scheme)).toEqual(['data']);
  });

  it('accepts the ordinary formatting a survey label actually contains', () => {
    expect(
      scanHtml(
        '<p class="lead">Please <strong>read</strong> the <a href="https://example.com" ' +
          'target="_blank" rel="noopener">terms</a>.<br><img src="/i.png" alt="x" ' +
          'data-track="1"></p>',
      ),
    ).toEqual([]);
  });

  it('does not treat a bare angle bracket in prose as markup', () => {
    expect(scanHtml('Is your income < 50,000 or > 50,000?')).toEqual([]);
  });

  it('stops at an unterminated comment rather than letting the rest hide inside it', () => {
    expect(scanHtml('<!-- <script>evil()</script>')).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* CMP-0500                                                                    */
/* -------------------------------------------------------------------------- */

describe('CMP-0500', () => {
  it('reports an html template with an onerror attribute', () => {
    const diagnostics = run({ assets: template('<div><img src="/x.png" onerror="go()"></div>') });

    expect(codes(diagnostics)).toEqual(['CMP-0500']);
    expect(diagnostics[0]?.severity).toBe('error');
    expect(diagnostics[0]?.path).toBe('/assets/html_templates/0/source');
    const detail = detailOf(diagnostics, 'CMP-0500');
    expect(detail['origin']).toBe('html_template');
    expect(detail['asset_ref']).toBe('shell');
    expect(detail['finding_count']).toBe(1);
    expect(detail['reasons']).toEqual(['event_handler']);
    expect(findings(diagnostics)[0]?.attribute).toBe('onerror');
    // The position, so an author with a 500-line template does not have to bisect it.
    expect(findings(diagnostics)[0]?.at).toBe(23);
    expect(findings(diagnostics)[0]?.tag).toBe('img');
  });

  it('reports a javascript: href smuggled into a translation bundle', () => {
    const diagnostics = run({
      bundle: { 'q1.label': 'ok', 'q1.help': '<a href="javascript:steal()">help</a>' },
    });

    expect(codes(diagnostics)).toEqual(['CMP-0500']);
    expect(diagnostics[0]?.path).toBe('/languages/bundles/en/q1.help');
    const detail = detailOf(diagnostics, 'CMP-0500');
    expect(detail['origin']).toBe('i18n_string');
    expect(detail['language']).toBe('en');
    expect(detail['i18n_key']).toBe('q1.help');
    expect(detail['reasons']).toEqual(['disallowed_url_scheme']);
  });

  it('is one diagnostic per source, not one per finding', () => {
    const diagnostics = run({
      assets: template('<img onerror="a()"><img onload="b()"><img onclick="c()">'),
    });

    expect(codes(diagnostics)).toEqual(['CMP-0500']);
    expect(detailOf(diagnostics, 'CMP-0500')['finding_count']).toBe(3);
    expect(findings(diagnostics).length).toBe(3);
  });

  it('says nothing about a clean template and a clean bundle', () => {
    expect(
      run({
        assets: template('<div class="shell"><p>Thank you.</p></div>'),
        bundle: { 'q1.label': 'Plain text', 'q1.help': '<em>emphasis</em>' },
      }),
    ).toEqual([]);
  });

  it('does not scan a ScriptAsset source, which is the declared surface for script', () => {
    expect(run({ assets: script({ source: 'if (a < b) { document.write("<script>") }' }) })).toEqual(
      [],
    );
  });
});

/* -------------------------------------------------------------------------- */
/* CMP-0501                                                                    */
/* -------------------------------------------------------------------------- */

describe('CMP-0501', () => {
  it('reports a script asset with no runs_on', () => {
    const assets = script({});
    const stripped = {
      scripts: (assets.scripts ?? []).map((asset) => {
        const { runs_on, ...rest } = asset;
        void runs_on;
        return rest as ScriptAsset;
      }),
    };
    const diagnostics = run({ assets: stripped });

    expect(codes(diagnostics)).toEqual(['CMP-0501']);
    expect(diagnostics[0]?.path).toBe('/assets/scripts/0/runs_on');
    expect(detailOf(diagnostics, 'CMP-0501')['reason']).toBe('runs_on_absent');
  });

  it('reports a server script hooking a client-only lifecycle point', () => {
    const diagnostics = run({
      assets: script({ runs_on: 'server', hooks: ['onPageSubmit', 'onPageLoad', 'onAnswer'] }),
    });

    expect(codes(diagnostics)).toEqual(['CMP-0501']);
    expect(diagnostics[0]?.path).toBe('/assets/scripts/0/hooks');
    const detail = detailOf(diagnostics, 'CMP-0501');
    expect(detail['runs_on']).toBe('server');
    expect(detail['reason']).toBe('hook_target_mismatch');
    expect(detail['incompatible_hooks']).toEqual(['onPageLoad', 'onAnswer']);
  });

  it('reports a client script hooking the server-only lifecycle point', () => {
    const diagnostics = run({
      assets: script({ runs_on: 'client', hooks: ['onPageLoad', 'onSurveyEnd'] }),
    });

    expect(codes(diagnostics)).toEqual(['CMP-0501']);
    expect(detailOf(diagnostics, 'CMP-0501')['incompatible_hooks']).toEqual(['onSurveyEnd']);
  });

  it('is silent for hooks that exist on both targets', () => {
    expect(
      run({
        assets: script({
          runs_on: 'server',
          hooks: ['onSurveyStart', 'onValidate', 'onPageSubmit', 'onSurveyEnd'],
        }),
      }),
    ).toEqual([]);
  });

  it('declares every hook, so a new one cannot default to permissive', () => {
    for (const hook of Object.keys(SCRIPT_HOOK_TARGETS)) {
      const targets = SCRIPT_HOOK_TARGETS[hook as keyof typeof SCRIPT_HOOK_TARGETS];
      expect(targets.length).toBeGreaterThan(0);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Hashes and CSP                                                              */
/* -------------------------------------------------------------------------- */

describe('script hashes and CSP', () => {
  it('hashes each script source by ref, in base64', () => {
    const source = 'export function onPageLoad() {}';
    const hashes = scriptHashes(surveyOf({ assets: script({ source }) }));
    const expected = createHash('sha256').update(source, 'utf8').digest('base64');

    expect(hashes).toEqual({ tracker: expected });
    // Base64, not hex: the CSP directive below embeds this value verbatim.
    expect(expected).not.toMatch(/^[0-9a-f]{64}$/);
  });

  it('computes the digest rather than trusting a declared sha256', () => {
    const source = 'export function onPageLoad() {}';
    const hashes = scriptHashes(
      surveyOf({ assets: script({ source, sha256: 'not-the-real-hash' }) }),
    );
    expect(hashes['tracker']).toBe(createHash('sha256').update(source, 'utf8').digest('base64'));
  });

  it('produces a locked-down policy with one sha256 source per script', () => {
    const hashes = { b: 'BBBB', a: 'AAAA' };
    const directives = cspDirectives(hashes);

    expect(directives['default-src']).toEqual(["'none'"]);
    // Sorted by ref, because these bytes are hashed into the artifact id.
    expect(directives['script-src']).toEqual(["'self'", "'sha256-AAAA'", "'sha256-BBBB'"]);
    expect(directives['style-src']).toEqual(["'self'", "'unsafe-inline'"]);
    expect(directives['img-src']).toEqual(["'self'", 'data:', 'https:']);
    expect(directives['connect-src']).toEqual(["'self'"]);
    expect(directives['frame-ancestors']).toEqual(["'none'"]);
  });

  it('produces a policy with no script sources when the survey has no scripts', () => {
    expect(cspDirectives(scriptHashes(surveyOf({})))['script-src']).toEqual(["'self'"]);
  });
});
