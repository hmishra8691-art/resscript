/**
 * The registry — F §7's four views, and the refusals that make trust mean something.
 *
 * The tests that matter most here are the ones about *rejection*: a registry that accepts a
 * marketplace bundle claiming `first_party`, or a second `matrix@3` at a lower version, is a
 * registry whose answers cannot be relied on by the compiler, the runtime and the exporter at the
 * same time — which is the whole reason there is one registry and not three.
 */

import { describe, expect, it } from 'vitest';
import { createRegistry } from './registry.js';
import { createSchemaCache } from './json-schema.js';
import { PluginRegistryError } from './errors.js';
import { multiSelectCore } from './plugins/multi-select/core.js';
import { npsCore } from './plugins/nps/core.js';
import { singleSelectCore } from './plugins/single-select/core.js';
import { testParentCore } from './testkit/parent.js';
import { FIRST_PARTY_CORES } from './index.js';
import type { AnyPluginCore } from './contract/plugin.js';

function variant(
  base: AnyPluginCore,
  meta: Partial<AnyPluginCore['meta']>,
): AnyPluginCore {
  return { ...base, meta: { ...base.meta, ...meta } };
}

// No casts: every function on `QuestionTypePluginCore` is method syntax, which TypeScript compares
// bivariantly, so a concrete core is an `AnyPluginCore` without one. If that ever stops being true
// this file stops compiling, which is the signal we want — the registry would then need casts at
// every call site.
const single: AnyPluginCore = singleSelectCore;
const multi: AnyPluginCore = multiSelectCore;
const npsAny: AnyPluginCore = npsCore;
const parent: AnyPluginCore = testParentCore;

describe('registration', () => {
  it('keys on id and MAJOR, not the exact version', () => {
    const registry = createRegistry<AnyPluginCore>();
    const entry = registry.register(variant(single, { version: '3.7.2' }), { trust: 'first_party' });
    expect(entry.key).toBe('single_select@3');
    // F §5 step 3: a compiled page carries `"matrix@3"`, so a patch release must resolve to the
    // same key or every patch would need its own runtime module.
    expect(registry.resolve('single_select@3')).toBeDefined();
    expect(registry.resolve('single_select@3.7.2')).toBeUndefined();
  });

  it('overwrites the plugin’s own trust claim with the source’s', () => {
    const registry = createRegistry<AnyPluginCore>();
    // The object says `first_party` (every first-party core does). Registered from a marketplace
    // source, it is marketplace — otherwise `meta.trust` would be a self-assigned label.
    const entry = registry.register(single, { trust: 'marketplace', sha384: 'sha384-x' });
    expect(entry.meta.trust).toBe('marketplace');
    expect(registry.resolveEntry('single_select@1')?.meta.trust).toBe('marketplace');
  });

  it('refuses a malformed id, because an id is forever', () => {
    const registry = createRegistry<AnyPluginCore>();
    for (const id of ['Single_Select', '1select', 'single-select', '', 'a'.repeat(60)]) {
      expect(() => registry.register(variant(single, { id }), { trust: 'first_party' })).toThrow(
        PluginRegistryError,
      );
    }
  });

  it('refuses a non-semver version, because the major is the runtime key', () => {
    const registry = createRegistry<AnyPluginCore>();
    for (const version of ['1', '1.2', 'v1.2.3', '1.2.x', '']) {
      expect(() => registry.register(variant(single, { version }), { trust: 'first_party' })).toThrow(
        /not semver/,
      );
    }
  });

  it('refuses an incoherent a11y contract before a respondent can see it', () => {
    const registry = createRegistry<AnyPluginCore>();
    const tooSmall: AnyPluginCore = {
      ...single,
      a11y: { ...single.a11y, minTouchTargetPx: 32 },
    };
    expect(() => registry.register(tooSmall, { trust: 'first_party' })).toThrow(/incoherent/);

    const pointerNoKeyboard: AnyPluginCore = {
      ...single,
      a11y: { ...single.a11y, pointerDependent: true },
    };
    expect(() => registry.register(pointerNoKeyboard, { trust: 'first_party' })).toThrow(
      /keyboardAlternative/,
    );
  });

  it('refuses a config schema using keywords the validator does not implement', () => {
    const registry = createRegistry<AnyPluginCore>();
    const withFormat: AnyPluginCore = {
      ...single,
      configSchema: { type: 'object', properties: { x: { type: 'string', format: 'email' } } } as never,
    };
    // Ajv would ignore `format` silently and the author would believe they validated an address.
    expect(() => registry.register(withFormat, { trust: 'first_party' })).toThrow(/format/);
  });

  it('refuses an exact duplicate and keeps the highest version within a major', () => {
    const registry = createRegistry<AnyPluginCore>();
    registry.register(variant(single, { version: '1.4.0' }), { trust: 'first_party' });
    expect(() =>
      registry.register(variant(single, { version: '1.4.0' }), { trust: 'first_party' }),
    ).toThrow(/already registered/);

    // A later registration at a lower version must not win: registration order would then decide
    // which patch level a compile pins.
    registry.register(variant(single, { version: '1.2.0' }), { trust: 'first_party' });
    expect(registry.resolveForCompile('single_select', 1)?.version).toBe('1.4.0');

    registry.register(variant(single, { version: '1.9.1' }), { trust: 'first_party' });
    expect(registry.resolveForCompile('single_select', 1)?.version).toBe('1.9.1');
  });
});

describe('resolution', () => {
  const registry = createRegistry<AnyPluginCore>();
  registry.register(variant(single, { version: '1.4.0' }), { trust: 'first_party' });
  registry.register(variant(single, { version: '2.0.1' }), { trust: 'first_party' });
  registry.register(multi, { trust: 'first_party' });

  it('resolves a named major exactly', () => {
    expect(registry.resolveForCompile('single_select', 1)?.version).toBe('1.4.0');
    expect(registry.resolveForCompile('single_select', 2)?.version).toBe('2.0.1');
    expect(registry.resolveForCompile('single_select', 9)).toBeUndefined();
  });

  it('resolves a bare id to the latest major, deterministically', () => {
    // The authoring model stores a bare id (F §5 step 1), so "latest" has to be a max over parsed
    // versions rather than whatever was registered last.
    expect(registry.resolveForCompile('single_select')?.key).toBe('single_select@2');
  });

  it('returns the exact version for the manifest, and the key for the page', () => {
    const resolution = registry.resolveForCompile('multi_select');
    expect(resolution?.version).toBe(multi.meta.version);
    expect(resolution?.key).toBe(`multi_select@${multi.meta.version.split('.')[0] ?? ''}`);
  });

  it('does not resolve an unregistered type', () => {
    expect(registry.resolveForCompile('acme_dial')).toBeUndefined();
    expect(registry.resolve('acme_dial@0')).toBeUndefined();
  });
});

describe('list, entitlements and org scoping', () => {
  const registry = createRegistry<AnyPluginCore>();
  registry.register(single, { trust: 'first_party' });
  registry.register(variant(multi, { entitlementKey: 'advanced_types' }), { trust: 'first_party' });
  registry.register(variant(npsAny, { id: 'acme_dial' }), {
    trust: 'org_custom',
    orgId: 'org_acme',
  });

  it('lists an unentitled type as present-but-disabled', () => {
    const listed = registry.list({ orgId: 'org_acme', entitlements: new Set() });
    const gated = listed.find((entry) => entry.meta.id === 'multi_select');
    // F §7: "we do not have that" is more useful than "it does not exist".
    expect(gated?.entitled).toBe(false);
    expect(listed.find((entry) => entry.meta.id === 'single_select')?.entitled).toBe(true);
  });

  it('can be asked to omit unentitled types', () => {
    const listed = registry.list({
      orgId: 'org_acme',
      entitlements: new Set(),
      includeUnentitled: false,
    });
    expect(listed.some((entry) => entry.meta.id === 'multi_select')).toBe(false);
  });

  it('never shows one org’s custom type to another org', () => {
    const acme = registry.list({ orgId: 'org_acme', entitlements: new Set(['advanced_types']) });
    const other = registry.list({ orgId: 'org_other', entitlements: new Set(['advanced_types']) });
    expect(acme.some((entry) => entry.meta.id === 'acme_dial')).toBe(true);
    // Cross-org availability: never (F §6's table). This is the containment story for a custom type.
    expect(other.some((entry) => entry.meta.id === 'acme_dial')).toBe(false);
  });

  it('filters by category', () => {
    const scales = registry.list({
      orgId: 'org_acme',
      entitlements: new Set(),
      category: 'scale',
    });
    expect(scales.map((entry) => entry.meta.id)).toEqual(['acme_dial']);
  });
});

describe('composition eligibility', () => {
  it('lists only composable, trust-compatible children', () => {
    const registry = createRegistry<AnyPluginCore>();
    registry.register(single, { trust: 'first_party' });
    registry.register(multi, { trust: 'first_party' });
    registry.register(parent, { trust: 'first_party' });

    const ids = registry.listComposable('first_party').map((entry) => entry.meta.id);
    // Both selects are composable since the row-scope fan-out landed (P1-05); the parent —
    // composable: false — is what stays out of its own picker.
    expect(ids).toEqual(['single_select', 'multi_select']);
    expect(ids).not.toContain('test_parent');
  });

  it('lets trust go down but not up', () => {
    const registry = createRegistry<AnyPluginCore>();
    expect(registry.isComposeTrustAllowed('marketplace', 'first_party', 'single_select')).toBe(true);
    expect(registry.isComposeTrustAllowed('first_party', 'first_party', 'single_select')).toBe(true);
    // Trust laundering: marketplace code inheriting a first-party parent's placement.
    expect(registry.isComposeTrustAllowed('first_party', 'marketplace', 'single_select')).toBe(false);
    expect(registry.isComposeTrustAllowed('org_custom', 'marketplace', 'single_select')).toBe(false);
  });

  it('honours an explicit allowlist, and nothing else', () => {
    const registry = createRegistry<AnyPluginCore>({ composeTrustAllowlist: ['acme_dial'] });
    expect(registry.isComposeTrustAllowed('first_party', 'marketplace', 'acme_dial')).toBe(true);
    expect(registry.isComposeTrustAllowed('first_party', 'marketplace', 'other_dial')).toBe(false);
  });
});

describe('the compiled-schema cache', () => {
  it('caches on the exact version, not the major', () => {
    const cache = createSchemaCache();
    const registry = createRegistry<AnyPluginCore>({ schemaCache: cache });
    const a = registry.register(variant(single, { version: '1.4.0' }), { trust: 'first_party' });
    registry.configSchemaFor(a);
    registry.configSchemaFor(a);
    expect(cache.size).toBe(1);

    // 1.5.0 may legitimately add an optional field (F §5), so serving it the 1.4.0 schema would
    // either reject a valid config or accept an unknown one.
    const b = registry.register(variant(single, { version: '1.5.0' }), { trust: 'first_party' });
    registry.configSchemaFor(b);
    expect(cache.size).toBe(2);
  });
});

describe('the first-party set is data, not code', () => {
  it('registers every Phase-1 core with no per-plugin wiring', () => {
    const registry = createRegistry<AnyPluginCore>();
    for (const core of FIRST_PARTY_CORES) registry.register(core, { trust: 'first_party' });
    // P1-04's acceptance criterion: adding a fourth plugin is a list entry, not a code change.
    expect(registry.entries().map((entry) => entry.key)).toEqual([
      'single_select@1',
      'multi_select@1',
      'nps@1',
      'binary@1',
      'rating@1',
      'text@1',
      'textarea@1',
      'text_list@1',
      'numeric@1',
      'numeric_list@1',
      'date@1',
      'matrix@1',
      'content_text@1',
      'content_media@1',
      'consent@1',
    ]);
  });
});
