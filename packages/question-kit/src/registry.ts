/**
 * The plugin registry — Deliverable F §7.
 *
 * One registry type, four consumers, different views over the same data: the studio palette
 * (`list`), the compiler (`resolveForCompile`), the runtime renderer (`resolve`) and the
 * composition machinery (`listComposable`). They are one type because they are one question
 * asked four ways, and because a second registry would be a second answer to "which version of
 * `matrix` is this?".
 *
 * Three things here are load-bearing:
 *
 *  1. **The key is `${id}@${major}`, not `${id}@${version}`.** F §5's compatibility table
 *     defines "backward compatible" as "same major", and a published survey renders with the
 *     plugin it was compiled against for as long as it can collect data. Keying on the exact
 *     version would force every patch release to ship as a separate runtime module for no
 *     behavioural reason; keying on the bare id would let a minor bump change a live instrument.
 *  2. **Trust is set by the registry, never by the plugin.** `meta.trust` on the object is
 *     advisory; `register` overwrites it with the trust of the *source* it arrived from. A
 *     marketplace bundle declaring `first_party` gains nothing, which is the difference between
 *     a trust tier and a self-assigned label (F §6).
 *  3. **Registration refuses rather than warns.** A plugin id appears in
 *     `question.question_type` in every artifact that ever used it, so it is forever
 *     (`PluginMeta.id`: "Never reused"). A malformed id or version is rejected at registration,
 *     where the fix is free.
 */

import { compileSchema, createSchemaCache, type CompiledSchema, type SchemaCache } from './json-schema.js';
import { PluginRegistryError } from './errors.js';
import { checkA11yContract } from './contract/a11y.js';
import type { AnyPluginCore } from './contract/plugin.js';
import {
  compareSemver,
  parseSemver,
  pluginKey,
  PLUGIN_ID_PATTERN,
  PLUGIN_TRUST_RANK,
  type PluginCategory,
  type PluginMeta,
  type PluginTrust,
  type Semver,
} from './contract/meta.js';

/**
 * Where a plugin came from, which is what its trust tier means (F §6: "the difference is *where
 * the plugin's code executes*").
 */
export type PluginSource =
  /** In the monorepo, code-reviewed. Available to every org. */
  | { readonly trust: 'first_party' }
  /** Authored by one org, attached to that org's artifacts, never visible cross-org. */
  | { readonly trust: 'org_custom'; readonly orgId: string }
  /** Submitted, reviewed and signed by us; the integrity hash is checked at artifact load. */
  | { readonly trust: 'marketplace'; readonly sha384: string };

export interface RegisteredPlugin<P extends AnyPluginCore = AnyPluginCore> {
  readonly key: string;
  readonly plugin: P;
  /** `plugin.meta` with `trust` replaced by the source's tier. Always read this, not `plugin.meta`. */
  readonly meta: PluginMeta;
  readonly semver: Semver;
  readonly source: PluginSource;
}

/** What the palette needs: metadata plus whether this org may actually insert it. */
export interface PluginListEntry {
  readonly key: string;
  readonly meta: PluginMeta;
  /**
   * `false` = list it, disabled, with an upgrade affordance (F §7: "we do not have that" is more
   * useful than "it does not exist").
   *
   * F §7 types `list()` as returning `PluginMeta[]`, which cannot express this — and a palette
   * that cannot distinguish entitled from unentitled has to either hide the type (losing the
   * upgrade affordance) or offer it and fail at publish. Hence the wrapper.
   */
  readonly entitled: boolean;
}

export interface ListFilter {
  readonly orgId: string;
  readonly entitlements: ReadonlySet<string>;
  readonly category?: PluginCategory;
  /** Include types the org is not entitled to, flagged. Default true, per F §7. */
  readonly includeUnentitled?: boolean;
}

export interface RegistryOptions {
  /**
   * Child ids that may be composed into a *more* trusted parent (F §3.1 rule 2's "explicit
   * allowlist"). Empty by default: trust laundering has to be a decision on the record, and an
   * allowlist that defaults to permissive is not one.
   */
  readonly composeTrustAllowlist?: readonly string[];
  /** Injectable so a test can assert the cache is used rather than trusting the comment. */
  readonly schemaCache?: SchemaCache;
}

export interface CompileResolution<P extends AnyPluginCore> {
  readonly plugin: P;
  readonly meta: PluginMeta;
  /** The exact version, which is what goes into the artifact manifest (F §5 step 2). */
  readonly version: string;
  /** The key a compiled page will carry: `"matrix@3"` (F §5 step 3). */
  readonly key: string;
}

export interface PluginRegistry<P extends AnyPluginCore = AnyPluginCore> {
  register(plugin: P, source: PluginSource): RegisteredPlugin<P>;
  /** Exact resolution for the runtime: `resolve('matrix@3')`. A map lookup on the hot path. */
  resolve(idWithMajor: string): P | undefined;
  /** The registration record, for consumers that need `meta` or the compiled config schema. */
  resolveEntry(idWithMajor: string): RegisteredPlugin<P> | undefined;
  /** Compile-time resolution: latest version of a major, or of the latest major. */
  resolveForCompile(id: string, major?: number): CompileResolution<P> | undefined;
  /** Palette listing, filtered by entitlement and org. */
  list(filter: ListFilter): readonly PluginListEntry[];
  /** Composition lookup: only composable, trust-compatible plugins (F §3.1 rules 1 and 2). */
  listComposable(parentTrust: PluginTrust): readonly PluginListEntry[];
  /** May `childId` be composed into a parent at `parentTrust`? The rule, in one place. */
  isComposeTrustAllowed(parentTrust: PluginTrust, childTrust: PluginTrust, childId: string): boolean;
  /** Compiled + cached config schema for one registration. Keyed on the *exact* version. */
  configSchemaFor(entry: RegisteredPlugin<P>): CompiledSchema;
  /** Every registration, in registration order. For diagnostics and for the manifest. */
  entries(): readonly RegisteredPlugin<P>[];
}

export function createRegistry<P extends AnyPluginCore>(
  options: RegistryOptions = {},
): PluginRegistry<P> {
  const byKey = new Map<string, RegisteredPlugin<P>>();
  const order: RegisteredPlugin<P>[] = [];
  const cache = options.schemaCache ?? createSchemaCache();
  const allowlist = new Set(options.composeTrustAllowlist ?? []);

  const registry: PluginRegistry<P> = {
    register(plugin, source) {
      const declared = plugin.meta;
      if (!PLUGIN_ID_PATTERN.test(declared.id)) {
        throw new PluginRegistryError(
          'invalid_plugin_id',
          declared.id,
          `plugin id ${JSON.stringify(declared.id)} must match ${String(PLUGIN_ID_PATTERN)}: it is ` +
            'stored in every artifact that uses it and can never be renamed',
        );
      }
      const semver = parseSemver(declared.version);
      if (semver === undefined) {
        throw new PluginRegistryError(
          'invalid_version',
          declared.id,
          `version ${JSON.stringify(declared.version)} is not semver; the major is the runtime key`,
        );
      }

      // The a11y contract is checked here rather than only in the test kit because a plugin can
      // be registered at runtime (an org_custom bundle attached to an artifact) without ever
      // having run the kit. An incoherent contract — a pointer-dependent type with no keyboard
      // alternative — must not reach a respondent (F §8).
      const a11yProblems = checkA11yContract(plugin.a11y);
      if (a11yProblems.length > 0) {
        throw new PluginRegistryError(
          'invalid_a11y_contract',
          declared.id,
          `a11y contract is incoherent: ${a11yProblems.join('; ')}`,
        );
      }

      // An unsupported keyword in a config schema means the author believes they validated
      // something they did not (see `json-schema.ts`). Refusing at registration is the only
      // moment that belief is cheap to correct.
      const compiled = compileSchema(plugin.configSchema);
      if (compiled.unsupported.length > 0) {
        throw new PluginRegistryError(
          'unsupported_config_schema',
          declared.id,
          `configSchema uses keywords this validator does not implement: ${compiled.unsupported.join(', ')}`,
        );
      }

      const key = pluginKey(declared.id, semver.major);
      const existing = byKey.get(key);
      if (existing !== undefined) {
        if (compareSemver(existing.semver, semver) === 0) {
          throw new PluginRegistryError(
            'duplicate_registration',
            declared.id,
            `${key} is already registered at version ${existing.meta.version}`,
          );
        }
        // Within a major, the highest version wins: F §5 allows only backward-compatible change
        // inside a major, so the newest is by definition a superset. Losing the race silently
        // would make registration order decide which patch level a compile pins.
        if (compareSemver(existing.semver, semver) > 0) return existing;
      }

      const entry: RegisteredPlugin<P> = {
        key,
        plugin,
        meta: { ...declared, trust: source.trust },
        semver,
        source,
      };
      byKey.set(key, entry);
      const at = order.findIndex((e) => e.key === key);
      if (at >= 0) order.splice(at, 1, entry);
      else order.push(entry);
      return entry;
    },

    resolve(idWithMajor) {
      return byKey.get(idWithMajor)?.plugin;
    },

    resolveEntry(idWithMajor) {
      return byKey.get(idWithMajor);
    },

    resolveForCompile(id, major) {
      if (major !== undefined) {
        const hit = byKey.get(pluginKey(id, major));
        return hit === undefined ? undefined : resolution(hit);
      }
      // No major named: the latest one. `question.question_type` in the authoring model is a bare
      // id (F §5 step 1), so this is the common path, and "latest" has to be deterministic —
      // hence a max over parsed majors rather than insertion order.
      let best: RegisteredPlugin<P> | undefined;
      for (const entry of byKey.values()) {
        if (entry.meta.id !== id) continue;
        if (best === undefined || compareSemver(best.semver, entry.semver) < 0) best = entry;
      }
      return best === undefined ? undefined : resolution(best);
    },

    list(filter) {
      const includeUnentitled = filter.includeUnentitled ?? true;
      const out: PluginListEntry[] = [];
      for (const entry of order) {
        if (!visibleToOrg(entry, filter.orgId)) continue;
        if (filter.category !== undefined && entry.meta.category !== filter.category) continue;
        const entitled =
          entry.meta.entitlementKey === null || filter.entitlements.has(entry.meta.entitlementKey);
        if (!entitled && !includeUnentitled) continue;
        out.push({ key: entry.key, meta: entry.meta, entitled });
      }
      return out;
    },

    listComposable(parentTrust) {
      return order
        .filter(
          (entry) =>
            entry.meta.composable &&
            registry.isComposeTrustAllowed(parentTrust, entry.meta.trust, entry.meta.id),
        )
        .map((entry) => ({ key: entry.key, meta: entry.meta, entitled: true }));
    },

    isComposeTrustAllowed(parentTrust, childTrust, childId) {
      // "Child trust must be <= parent trust" (F §3.1 rule 2) with the ranks running
      // first_party 0 → marketplace 2: a *lower* rank is more trusted, so the child's rank must
      // not exceed the parent's. Embedding a marketplace control inside a first-party matrix
      // would let the marketplace code inherit the parent's placement — trust laundering.
      if (PLUGIN_TRUST_RANK[childTrust] <= PLUGIN_TRUST_RANK[parentTrust]) return true;
      return allowlist.has(childId);
    },

    configSchemaFor(entry) {
      return cache.get(`${entry.meta.id}@${entry.meta.version}`, entry.plugin.configSchema);
    },

    entries() {
      return [...order];
    },
  };

  return registry;
}

function resolution<P extends AnyPluginCore>(entry: RegisteredPlugin<P>): CompileResolution<P> {
  return {
    plugin: entry.plugin,
    meta: entry.meta,
    version: entry.meta.version,
    key: entry.key,
  };
}

function visibleToOrg<P extends AnyPluginCore>(entry: RegisteredPlugin<P>, orgId: string): boolean {
  const source = entry.source;
  switch (source.trust) {
    case 'first_party':
    case 'marketplace':
      return true;
    case 'org_custom':
      // Cross-org availability: never (F §6's table). This is the whole containment story for a
      // custom type — an org's plugin is attached to that org's artifacts and nobody else's.
      return source.orgId === orgId;
    default: {
      const never: never = source;
      throw new Error(`Unhandled plugin source: ${JSON.stringify(never)}`);
    }
  }
}
