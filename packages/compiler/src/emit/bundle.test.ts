/**
 * What the bundle must get right — the determinism claims, and the hash framing.
 *
 * The three determinism tests are the milestone's headline property stated three ways, and each one
 * fails on a different bug:
 *
 *  - **twice over one survey** catches a `Map` iteration, a `Set`, a `Date.now()`, or a
 *    `JSON.stringify` anywhere in the pipeline.
 *  - **over a survey whose object keys have been reversed** catches anything that reads insertion
 *    order — which is what a document coming back from Postgres in a different row order looks
 *    like. It is asserted on the *hash* and not merely on `toEqual`, because two structurally equal
 *    artifacts that serialize differently would pass the second and fail ADR-002.
 *  - **one label changed** is the converse, and it is the one people forget: a hash that is stable
 *    under everything is a constant.
 *
 * The framing test uses the exact collision the brief names — `{"a.json": "x", "b": "y"}` against
 * `{"a.jsonx": "", "b": "y"}` — because that pair is indistinguishable under the obvious framing
 * (concatenate path then bytes) and distinguishable under a length-prefixed one. It is asserted on
 * `treeHash` directly rather than through a survey, since no survey produces that pair and the
 * property is about the function.
 */

import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';

import { flattenContent, stableStringify, type QuotaConfig, type Survey } from '@resscript/schema';

import type { ArtifactFile } from '../types.js';
import {
  COMPILED_AT,
  buildSurvey,
  compileFixture,
  fixtureOf,
  withReversedKeys,
} from './__fixtures__/artifact.js';
import { HASH_PREAMBLE, buildBundle, designsOf, scriptsOf, treeHash } from './bundle.js';
import { UNRESOLVED_AT_STORE } from './manifest.js';

describe('the file tree', () => {
  it('carries the manifest, the graph, the logic, every page and every language bundle', () => {
    const { bundle, ids } = compileFixture({ languages: ['de'] });

    expect(bundle.files.map((file) => file.path)).toEqual([
      'graph.json',
      'i18n/de.json',
      'i18n/en.json',
      'logic.json',
      'manifest.json',
      `pages/de/${ids.page1}.json`,
      `pages/de/${ids.page2}.json`,
      `pages/en/${ids.page1}.json`,
      `pages/en/${ids.page2}.json`,
    ]);
  });

  it('adds theme.css and scripts/<ref>.js only when they exist', () => {
    const bare = compileFixture();
    const full = compileFixture({ themeCss: ':root{--a:1}', scriptSource: 'export const a = 1;' });

    expect(bare.bundle.files.map((file) => file.path)).not.toContain('theme.css');
    expect(full.bundle.files.map((file) => file.path)).toContain('theme.css');
    expect(full.bundle.files.map((file) => file.path)).toContain('scripts/tracker.js');
  });

  it('stores author script and CSS verbatim, not canonicalized', () => {
    const source = 'export const a = 1;\n\n// trailing comment\n';
    const { bundle } = compileFixture({ scriptSource: source, themeCss: 'body {  color: red }' });

    expect(fileAt(bundle.files, 'scripts/tracker.js').bytes).toBe(source);
    expect(fileAt(bundle.files, 'theme.css').bytes).toBe('body {  color: red }');
  });

  it('stores every .json file canonically, so key order cannot move the hash', () => {
    const { bundle, artifactLogic } = compileFixture();

    expect(fileAt(bundle.files, 'logic.json').bytes).toBe(stableStringify(artifactLogic));
  });

  it('is sorted by path, which is also the order the hash reads it in', () => {
    const { bundle } = compileFixture({ languages: ['de'] });
    const paths = bundle.files.map((file) => file.path);

    expect(paths).toEqual([...paths].sort());
  });

  it('reports total stored size in bytes, not in code units', () => {
    const { bundle } = compileFixture();
    const expected = bundle.files.reduce(
      (total, file) => total + Buffer.byteLength(file.bytes, 'utf8'),
      0,
    );

    expect(bundle.bytes).toBe(expected);
  });

  it('carries a per-file sha256 of exactly the stored bytes', () => {
    const { bundle } = compileFixture();

    for (const file of bundle.files) {
      expect(file.sha256).toBe(createHash('sha256').update(file.bytes, 'utf8').digest('hex'));
    }
  });
});

describe('the addressing rule', () => {
  it('stores the manifest with artifact_hash and compiled_at empty', () => {
    const { bundle } = compileFixture();
    const stored = JSON.parse(fileAt(bundle.files, 'manifest.json').bytes) as {
      artifact_hash: string;
      compiled_at: string;
    };

    expect(stored.artifact_hash).toBe(UNRESOLVED_AT_STORE);
    expect(stored.compiled_at).toBe(UNRESOLVED_AT_STORE);
  });

  it('fills both fields in the in-memory artifact', () => {
    const { bundle } = compileFixture();

    expect(bundle.artifact.manifest.artifact_hash).toBe(bundle.hash);
    expect(bundle.artifact.manifest.compiled_at).toBe(COMPILED_AT);
  });

  it('blanks the two fields even when the caller passes them filled', () => {
    const fixture = compileFixture();

    const bundle = buildBundle({
      manifest: { ...fixture.manifest, artifact_hash: 'nonsense', compiled_at: '1999-01-01T00:00:00Z' },
      graph: fixture.artifactGraph,
      logic: fixture.artifactLogic,
      pages: fixture.pages.byLanguage,
      baseLanguage: fixture.pages.baseLanguage,
      i18n: { en: fixture.survey.languages.bundles['en'] ?? {} },
      compiledAt: COMPILED_AT,
    });

    expect(bundle.hash).toBe(treeHash(bundle.files));
    const stored = JSON.parse(fileAt(bundle.files, 'manifest.json').bytes) as {
      artifact_hash: string;
    };
    expect(stored.artifact_hash).toBe('');
  });

  it('makes the in-memory pages the base language tree', () => {
    const fixture = compileFixture({ languages: ['de'] });

    expect(fixture.bundle.artifact.pages).toEqual(fixture.pages.byLanguage['en']);
    expect(fixture.bundle.artifact.i18n['de']).toBeDefined();
  });
});

describe('determinism', () => {
  it('hashes identically when the same survey is compiled twice', () => {
    const first = compileFixture({ languages: ['de'] });
    const second = compileFixture({ languages: ['de'] });

    expect(second.bundle.hash).toBe(first.bundle.hash);
    expect(second.bundle.files).toEqual(first.bundle.files);
  });

  it('hashes identically when every object key in the input is reordered', () => {
    const { survey, ids } = buildSurvey({ languages: ['de'] });
    const shuffled = withReversedKeys(survey);

    // The two documents really do differ in key order, at the top level and deep inside a nested
    // plugin config — or the assertion below is vacuous.
    expect(Object.keys(shuffled)).not.toEqual(Object.keys(survey));
    expect(JSON.stringify(shuffled)).not.toBe(JSON.stringify(survey));
    expect(Object.keys(nestedConfig(shuffled))).not.toEqual(Object.keys(nestedConfig(survey)));

    const original = fixtureOf(survey, ids);
    const reordered = fixtureOf(shuffled, ids);

    expect(reordered.bundle.hash).toBe(original.bundle.hash);
    expect(reordered.bundle.files).toEqual(original.bundle.files);
  });

  it('hashes differently when one label changes', () => {
    const before = compileFixture();
    const after = compileFixture({ q1Label: 'Pick exactly one' });

    expect(after.bundle.hash).not.toBe(before.bundle.hash);
  });

  it('hashes differently when a quota plan is added and nothing else changes', () => {
    const { survey, ids } = buildSurvey();
    const withQuotas = { ...survey, quotas: quotaConfig() };

    const before = fixtureOf(survey, ids);
    const after = fixtureOf(withQuotas, ids);

    // The quota plan is in the tree, so it is in the address. An artifact that carried quotas in
    // memory but not in `files` would hash identically here — two different published surveys
    // content-addressed to one object.
    expect(after.bundle.files.map((file) => file.path)).toContain('quotas.json');
    expect(after.bundle.hash).not.toBe(before.bundle.hash);
    expect(after.bundle.artifact.quotas).toEqual(withQuotas.quotas);
  });

  it('reads no clock: compiledAt changes the artifact but not the hash', () => {
    const fixture = compileFixture();
    const parts = {
      manifest: fixture.manifest,
      graph: fixture.artifactGraph,
      logic: fixture.artifactLogic,
      pages: fixture.pages.byLanguage,
      baseLanguage: fixture.pages.baseLanguage,
      i18n: { en: fixture.survey.languages.bundles['en'] ?? {} },
    };

    const monday = buildBundle({ ...parts, compiledAt: '2026-03-01T00:00:00.000Z' });
    const friday = buildBundle({ ...parts, compiledAt: '2026-03-06T00:00:00.000Z' });

    expect(friday.hash).toBe(monday.hash);
    expect(friday.artifact.manifest.compiled_at).not.toBe(monday.artifact.manifest.compiled_at);
  });
});

describe('treeHash framing', () => {
  it('distinguishes two trees that a path-then-bytes concatenation would collide', () => {
    const left = treeHash([file('a.json', 'x'), file('b', 'y')]);
    const right = treeHash([file('a.jsonx', ''), file('b', 'y')]);

    // `"a.json" + "x" + "b" + "y"` and `"a.jsonx" + "" + "b" + "y"` are the same byte stream.
    expect('a.json' + 'x' + 'b' + 'y').toBe('a.jsonx' + '' + 'b' + 'y');
    expect(left).not.toBe(right);
  });

  it('does not depend on the order files are handed to it', () => {
    const files = [file('b', 'y'), file('a.json', 'x'), file('c/d', 'z')];

    expect(treeHash(files)).toBe(treeHash([...files].reverse()));
  });

  it('changes when a file is added, removed, renamed or edited', () => {
    const base = [file('a.json', 'x'), file('b', 'y')];
    const hash = treeHash(base);

    expect(treeHash([...base, file('c', '')])).not.toBe(hash);
    expect(treeHash([base[0] ?? file('a.json', 'x')])).not.toBe(hash);
    expect(treeHash([file('a2.json', 'x'), file('b', 'y')])).not.toBe(hash);
    expect(treeHash([file('a.json', 'x2'), file('b', 'y')])).not.toBe(hash);
  });

  it('counts UTF-8 bytes, so two trees differing outside the BMP cannot collide', () => {
    expect(treeHash([file('a', 'e')])).not.toBe(treeHash([file('a', '\u{1F600}')]));
    expect(treeHash([file('a', 'é')])).not.toBe(treeHash([file('a', 'é')]));
  });

  it('is domain-separated, so the framing version is part of the address', () => {
    const framed = treeHash([file('a.json', 'x')]);
    const unframed = createHash('sha256')
      .update('1\n1\na.json\n1\nx\n', 'utf8')
      .digest('hex');

    expect(HASH_PREAMBLE).toBe('resscript-artifact-tree/1');
    expect(framed).not.toBe(unframed);
  });
});

describe('parts derived from the document', () => {
  it('reports no scripts and no designs when the survey has neither', () => {
    const { survey } = buildSurvey();

    expect(scriptsOf(survey)).toBeUndefined();
    expect(designsOf(survey)).toBeUndefined();
  });

  it('keys scripts by ref, which is what the manifest hash is keyed by', () => {
    const { survey } = buildSurvey({ scriptSource: 'export const a = 1;' });

    expect(scriptsOf(survey)).toEqual({ tracker: 'export const a = 1;' });
  });
});

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function file(path: string, bytes: string): ArtifactFile {
  return { path, bytes, sha256: createHash('sha256').update(bytes, 'utf8').digest('hex') };
}

function fileAt(files: readonly ArtifactFile[], path: string): ArtifactFile {
  const found = files.find((candidate) => candidate.path === path);
  if (found === undefined) throw new Error(`no file at ${path}`);
  return found;
}

/** Q5's plugin config, which is nested two deep — the reversal has to reach it. */
function nestedConfig(survey: Survey): { readonly [key: string]: unknown } {
  for (const node of flattenContent(survey.content)) {
    if (node.type !== 'question') continue;
    const other = node.config?.['other'];
    if (other !== undefined && other !== null && typeof other === 'object') {
      return other as { readonly [key: string]: unknown };
    }
  }
  throw new Error('fixture has no nested config');
}

function quotaConfig(): QuotaConfig {
  return {
    policy: {
      counter_scope: 'version',
      count_at: 'completion',
      reservation_ttl_s: 900,
      on_store_unavailable: 'fail_closed',
    },
    dimensions: [],
    plans: [],
  };
}

/* -------------------------------------------------------------------------- */
/* vendors.json and the secret guard (security §10, roadmap P2-04)             */
/* -------------------------------------------------------------------------- */

/**
 * Security §10 calls an HMAC secret in a CDN-served artifact "the single worst bug available in
 * this design" and says the compiler must hard-reject one. These are that rejection's tests.
 *
 * The whitelist matters as much as the throw: a blacklist of field names to strip would silently
 * pass the next field somebody adds to `VendorSecurity`, and the failure would be invisible until
 * a secret was already on a CDN.
 */
describe('vendors.json', () => {
  const vendor = (security?: Record<string, unknown>) =>
    ({
      id: 'ven_01ABC',
      ref: 'V_A',
      name: 'Panel A',
      inbound_params: [{ param: 'pid', variable_ref: 'VENDOR_PID', required: true }],
      ...(security ? { security } : {}),
    }) as never;

  /** The shared fixture's parts, so these tests vary only `vendors`. */
  function bundleWith(vendors: readonly unknown[]): ReturnType<typeof buildBundle> {
    const fixture = compileFixture();
    return buildBundle({
      manifest: fixture.manifest,
      graph: fixture.artifactGraph,
      logic: fixture.artifactLogic,
      pages: fixture.pages.byLanguage,
      baseLanguage: fixture.pages.baseLanguage,
      i18n: { en: fixture.survey.languages.bundles['en'] ?? {} },
      compiledAt: COMPILED_AT,
      vendors: vendors as never,
    });
  }

  it('emits the file when the survey declares vendors', () => {
    const bundle = bundleWith([vendor()]);

    const file = bundle.files.find(f => f.path === 'vendors.json');
    expect(file).toBeDefined();
    expect(JSON.parse(file?.bytes ?? '[]')).toEqual([
      {
        id: 'ven_01ABC',
        ref: 'V_A',
        name: 'Panel A',
        inbound_params: [{ param: 'pid', variable_ref: 'VENDOR_PID', required: true }],
      },
    ]);
  });

  it('omits the file entirely when there are no vendors', () => {
    expect(bundleWith([]).files.find(f => f.path === 'vendors.json')).toBeUndefined();
  });

  it('carries secret_ref — a pointer — and only the security fields the runtime needs', () => {
    const bundle = bundleWith([
      vendor({
        hash_param: 'hash',
        algorithm: 'sha256',
        secret_ref: 'vault://vendors/v_a',
        signed_params: ['pid', 'ts'],
        max_skew_s: 3600,
      }),
    ]);

    const emitted = JSON.parse(
      bundle.files.find(f => f.path === 'vendors.json')?.bytes ?? '[]',
    ) as { security: Record<string, unknown> }[];
    expect(emitted[0]?.security).toEqual({
      hash_param: 'hash',
      algorithm: 'sha256',
      secret_ref: 'vault://vendors/v_a',
      signed_params: ['pid', 'ts'],
      max_skew_s: 3600,
    });
  });

  it('drops an undeclared field rather than passing it through', () => {
    // The whitelist. A field nobody has reviewed must not reach a CDN just because it was added to
    // the authoring model.
    const bundle = bundleWith([
      vendor({
        hash_param: 'hash',
        algorithm: 'sha256',
        secret_ref: 'vault://v_a',
        some_future_field: 'whatever',
      }),
    ]);

    const emitted = JSON.parse(
      bundle.files.find(f => f.path === 'vendors.json')?.bytes ?? '[]',
    ) as { security: Record<string, unknown> }[];
    expect(emitted[0]?.security).not.toHaveProperty('some_future_field');
  });

  it('THROWS when a security field looks like a secret value rather than a reference', () => {
    // A key-shaped string in any field but `secret_ref`. Quietly dropping it would let the same
    // upstream bug ship again against a vendor whose links then silently fail verification.
    expect(() =>
      bundleWith([
        vendor({
          hash_param: 'hash',
          algorithm: 'sha256',
          secret_ref: 'vault://v_a',
          timestamp_param: 'K7bQ2xR9tZ4mN8pL3vC6yH1sJ5wD0gF2',
        }),
      ]),
    ).toThrow(/looks like a secret value/);
  });

  it('does not flag secret_ref itself, however opaque the path', () => {
    expect(() =>
      bundleWith([
        vendor({
          hash_param: 'hash',
          algorithm: 'sha256',
          secret_ref: 'K7bQ2xR9tZ4mN8pL3vC6yH1sJ5wD0gF2xxxx',
        }),
      ]),
    ).not.toThrow();
  });

  it('does not flag ordinary short parameter names', () => {
    expect(() =>
      bundleWith([
        vendor({ hash_param: 'hash', algorithm: 'sha256', secret_ref: 'v', nonce_param: 'n' }),
      ]),
    ).not.toThrow();
  });
});
