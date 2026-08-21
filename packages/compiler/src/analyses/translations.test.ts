/**
 * What the translation check must get right.
 *
 * The pair that carries the design is the same three-language survey under two policies: one bundle
 * incomplete, `block_publish_if_incomplete` true (error) and false (warning), with the *same*
 * `detail`. If those two ever produce the same code, the policy field has stopped being read; if
 * they produce different `detail`, the acknowledgement key moves when a flag flips and an
 * acknowledgement given under one policy silently transfers to the other.
 *
 * The row-count claim is asserted explicitly — a 3-language survey with two incomplete bundles is
 * two diagnostics, not one per missing key — because that is the property the header is emphatic
 * about and it is the one a well-meaning refactor breaks.
 *
 * Diagnostics are asserted by code and `detail`, never by message prose.
 */

import { describe, expect, it } from 'vitest';
import type { LanguagePolicy, StringBundle, Survey } from '@resscript/schema';

import { deterministicIds } from '../../../schema/src/__fixtures__/mini.js';
import type { CompileDiagnostic } from '../diagnostics.js';
import { MAX_LISTED_KEYS, analyzeTranslations } from './translations.js';

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

interface Spec {
  readonly bundles: { readonly [code: string]: StringBundle };
  readonly available?: readonly string[];
  readonly policy: LanguagePolicy;
}

function run(spec: Spec): readonly CompileDiagnostic[] {
  const ids = deterministicIds();
  const survey: Survey = {
    meta: { id: ids.next('survey'), ref: 'I18N', name: 'Translation fixture' },
    schema_version: 2,
    settings: {
      navigation: { back_allowed: true },
      resume: { enabled: false, window_s: 3600, position: 'last_page' },
      progress_bar: { mode: 'none' },
      screenout: { show_message: false },
    },
    languages: {
      base: 'en',
      available: (spec.available ?? Object.keys(spec.bundles)).map((code) => ({ code })),
      bundles: spec.bundles,
      policy: spec.policy,
    },
    variables: [],
    content: [],
    flow: { nodes: [] },
    logic_rules: [],
  };
  return analyzeTranslations({ survey });
}

const BASE: StringBundle = { 'q1.label': 'One', 'q1.o1': 'Yes', 'q2.label': 'Two' };

/** Three languages, `fr` complete and `de` missing two of the three keys. */
const THREE_LANGUAGES: { readonly [code: string]: StringBundle } = {
  en: BASE,
  fr: { 'q1.label': 'Un', 'q1.o1': 'Oui', 'q2.label': 'Deux' },
  de: { 'q1.label': 'Eins' },
};

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

/* -------------------------------------------------------------------------- */
/* The policy pair                                                             */
/* -------------------------------------------------------------------------- */

describe('the same gap under the two policies', () => {
  it('blocks publish with CMP-0200 when block_publish_if_incomplete is set', () => {
    const diagnostics = run({
      bundles: THREE_LANGUAGES,
      policy: { on_missing: 'fallback_to_base', block_publish_if_incomplete: true },
    });

    // One row, for the one incomplete language. `fr` is complete and `en` is the base.
    expect(codes(diagnostics)).toEqual(['CMP-0200']);
    expect(diagnostics[0]?.severity).toBe('error');
    expect(diagnostics[0]?.path).toBe('/languages/bundles/de');
    const detail = detailOf(diagnostics, 'CMP-0200');
    expect(detail['language']).toBe('de');
    expect(detail['base_language']).toBe('en');
    expect(detail['bundle_present']).toBe(true);
    expect(detail['base_key_count']).toBe(3);
    expect(detail['missing_count']).toBe(2);
    expect(detail['missing_keys']).toEqual(['q1.o1', 'q2.label']);
    expect(detail['truncated']).toBe(false);
    expect(detail['reason']).toBe('publish_blocked_by_policy');
  });

  it('warns with CMP-0201 for the same gap under fallback_to_base', () => {
    const diagnostics = run({
      bundles: THREE_LANGUAGES,
      policy: { on_missing: 'fallback_to_base', block_publish_if_incomplete: false },
    });

    expect(codes(diagnostics)).toEqual(['CMP-0201']);
    expect(diagnostics[0]?.severity).toBe('warning');
    const detail = detailOf(diagnostics, 'CMP-0201');
    // The same facts, so an acknowledgement is keyed on the gap and not on the policy.
    expect(detail['language']).toBe('de');
    expect(detail['missing_count']).toBe(2);
    expect(detail['missing_keys']).toEqual(['q1.o1', 'q2.label']);
    expect(detail['reason']).toBe('fallback_to_base');
  });

  it('warns rather than blocks under show_key, and says which policy it saw', () => {
    const diagnostics = run({
      bundles: THREE_LANGUAGES,
      policy: { on_missing: 'show_key', block_publish_if_incomplete: false },
    });

    expect(codes(diagnostics)).toEqual(['CMP-0201']);
    expect(detailOf(diagnostics, 'CMP-0201')['on_missing']).toBe('show_key');
    expect(detailOf(diagnostics, 'CMP-0201')['reason']).toBe('show_key');
  });

  it('blocks under on_missing: block even when the publish flag is false', () => {
    const diagnostics = run({
      bundles: THREE_LANGUAGES,
      policy: { on_missing: 'block', block_publish_if_incomplete: false },
    });

    expect(codes(diagnostics)).toEqual(['CMP-0200']);
    const detail = detailOf(diagnostics, 'CMP-0200');
    expect(detail['reason']).toBe('runtime_hard_stop');
    expect(detail['block_publish_if_incomplete']).toBe(false);
    expect(detail['on_missing']).toBe('block');
  });
});

/* -------------------------------------------------------------------------- */
/* Shape                                                                       */
/* -------------------------------------------------------------------------- */

describe('the diagnostic is per language and never per key', () => {
  it('produces one row per incomplete language, whatever the key count', () => {
    const base: { [key: string]: string } = {};
    for (let i = 0; i < 400; i += 1) base[`k${String(i).padStart(3, '0')}`] = 'x';

    const diagnostics = run({
      bundles: { en: base, fr: {}, de: {}, es: base },
      policy: { on_missing: 'fallback_to_base', block_publish_if_incomplete: true },
    });

    expect(codes(diagnostics)).toEqual(['CMP-0200', 'CMP-0200']);
    const languages = diagnostics.map((d) => d.detail?.['language']);
    expect([...languages].sort()).toEqual(['de', 'fr']);
    const detail = detailOf(diagnostics, 'CMP-0200');
    expect(detail['missing_count']).toBe(400);
    expect((detail['missing_keys'] as readonly string[]).length).toBe(MAX_LISTED_KEYS);
    expect(detail['truncated']).toBe(true);
  });

  it('reports a declared language with no bundle at all as the limit case', () => {
    const diagnostics = run({
      bundles: { en: BASE },
      available: ['en', 'ja'],
      policy: { on_missing: 'fallback_to_base', block_publish_if_incomplete: true },
    });

    expect(codes(diagnostics)).toEqual(['CMP-0200']);
    const detail = detailOf(diagnostics, 'CMP-0200');
    expect(detail['language']).toBe('ja');
    expect(detail['bundle_present']).toBe(false);
    expect(detail['missing_count']).toBe(3);
  });
});

/* -------------------------------------------------------------------------- */
/* Silence                                                                     */
/* -------------------------------------------------------------------------- */

describe('what must stay silent', () => {
  it('says nothing when every declared language carries every base key', () => {
    expect(
      run({
        bundles: { en: BASE, fr: { 'q1.label': 'Un', 'q1.o1': 'Oui', 'q2.label': 'Deux' } },
        policy: { on_missing: 'block', block_publish_if_incomplete: true },
      }),
    ).toEqual([]);
  });

  it('treats a deliberately blanked string as present, not missing', () => {
    expect(
      run({
        bundles: { en: BASE, fr: { 'q1.label': 'Un', 'q1.o1': '', 'q2.label': 'Deux' } },
        policy: { on_missing: 'fallback_to_base', block_publish_if_incomplete: true },
      }),
    ).toEqual([]);
  });

  it('ignores a stale key a translation carries and the base does not', () => {
    expect(
      run({
        bundles: {
          en: BASE,
          fr: { 'q1.label': 'Un', 'q1.o1': 'Oui', 'q2.label': 'Deux', 'gone.label': 'Parti' },
        },
        policy: { on_missing: 'fallback_to_base', block_publish_if_incomplete: true },
      }),
    ).toEqual([]);
  });

  it('says nothing when the base bundle is empty', () => {
    expect(
      run({
        bundles: { en: {}, fr: {} },
        policy: { on_missing: 'block', block_publish_if_incomplete: true },
      }),
    ).toEqual([]);
  });
});
