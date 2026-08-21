/**
 * What the language bundles must get right.
 *
 * Two claims carry the module. **Bundles are verbatim** — the test asserts a *missing* key stays
 * missing in the shipped bundle, which is the observable difference between emitting and merging,
 * and it is what keeps `CMP-0201`'s "this falls back to base" true of the artifact and not only of
 * the diagnostic. And **the language list is base-first then sorted**, asserted with a base that is
 * not alphabetically first, since `['en','de']` and `sort()` agree on nothing and disagree on
 * everything.
 *
 * `stringResolver` is tested per policy arm rather than through a page, because the arms are the
 * whole content of the function and a page test would only ever exercise the fixture's own policy.
 */

import { describe, expect, it } from 'vitest';
import type { MissingStringPolicy, Survey } from '@resscript/schema';

import { buildSurvey } from './__fixtures__/artifact.js';
import { artifactLanguages, buildI18n, stringResolver } from './i18n.js';

describe('artifactLanguages', () => {
  it('puts the base language first and sorts the rest, whatever order available declares', () => {
    const survey = withLanguages({ base: 'nl', available: ['zh', 'de', 'nl', 'ar'] });

    expect(artifactLanguages(survey)).toEqual(['nl', 'ar', 'de', 'zh']);
  });

  it('includes a language that has a bundle but no available entry, so the hash covers it', () => {
    const survey = withLanguages({ base: 'en', available: ['en'], extraBundles: ['xx'] });

    expect(artifactLanguages(survey)).toEqual(['en', 'xx']);
  });

  it('does not repeat the base language when available lists it too', () => {
    const survey = withLanguages({ base: 'en', available: ['en', 'de'] });

    expect(artifactLanguages(survey)).toEqual(['en', 'de']);
  });
});

describe('buildI18n', () => {
  it('emits each bundle verbatim, so a partially translated language stays partial', () => {
    const { survey } = buildSurvey({ languages: ['de'] });

    const bundles = buildI18n(survey);

    // `q1.o2` is deliberately absent from the German fixture bundle. Merging the base language in
    // would silently make the artifact claim a complete translation.
    expect(bundles['en']?.['q1.o2']).toBe('No');
    expect(bundles['de']?.['q1.o2']).toBeUndefined();
    expect(bundles['de']).toEqual(survey.languages.bundles['de']);
  });

  it('emits an empty bundle for a declared language with none, rather than dropping the file', () => {
    const survey = withLanguages({ base: 'en', available: ['en', 'pt'] });

    const bundles = buildI18n(survey);

    expect(Object.keys(bundles)).toEqual(['en', 'pt']);
    expect(bundles['pt']).toEqual({});
  });
});

describe('stringResolver', () => {
  it('resolves a present key to the language it was asked for', () => {
    const { survey } = buildSurvey({ languages: ['de'] });

    expect(stringResolver(survey, 'de').resolve({ key: 'q1.label' })).toBe('[de] Pick one');
    expect(stringResolver(survey, 'en').resolve({ key: 'q1.label' })).toBe('Pick one');
  });

  it('resolves an absent label reference to null, not to the empty string', () => {
    const { survey } = buildSurvey();
    const resolver = stringResolver(survey, 'en');

    expect(resolver.resolve(undefined)).toBeNull();
    expect(resolver.resolve(null)).toBeNull();
  });

  it('keeps a present-but-empty string empty rather than falling back', () => {
    const survey = withPolicy('fallback_to_base', { 'k.blank': '' });

    expect(stringResolver(survey, 'de').resolveKey('k.blank')).toBe('');
  });

  it('falls back to the base language under fallback_to_base', () => {
    const survey = withPolicy('fallback_to_base');

    expect(stringResolver(survey, 'de').resolveKey('k.only_base')).toBe('base text');
  });

  it('renders the key under show_key', () => {
    const survey = withPolicy('show_key');

    expect(stringResolver(survey, 'de').resolveKey('k.only_base')).toBe('k.only_base');
  });

  it('renders the key under block too, since an incomplete bundle there is already CMP-0200', () => {
    const survey = withPolicy('block');

    expect(stringResolver(survey, 'de').resolveKey('k.only_base')).toBe('k.only_base');
  });

  it('renders the key when it is missing from the base bundle as well', () => {
    const survey = withPolicy('fallback_to_base');

    expect(stringResolver(survey, 'de').resolveKey('k.nowhere')).toBe('k.nowhere');
  });
});

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

function withLanguages(spec: {
  readonly base: string;
  readonly available: readonly string[];
  readonly extraBundles?: readonly string[];
}): Survey {
  const { survey } = buildSurvey();
  const bundles: { [code: string]: { readonly [key: string]: string } } = {};
  for (const code of [...spec.available, ...(spec.extraBundles ?? [])]) bundles[code] = {};
  return {
    ...survey,
    languages: {
      base: spec.base,
      available: spec.available.map((code) => ({ code })),
      bundles,
      policy: survey.languages.policy,
    },
  };
}

function withPolicy(
  policy: MissingStringPolicy,
  extraDe: { readonly [key: string]: string } = {},
): Survey {
  const { survey } = buildSurvey();
  return {
    ...survey,
    languages: {
      base: 'en',
      available: [{ code: 'en' }, { code: 'de' }],
      bundles: {
        en: { 'k.only_base': 'base text', 'k.blank': 'base blank' },
        de: extraDe,
      },
      policy: { on_missing: policy, block_publish_if_incomplete: false },
    },
  };
}
