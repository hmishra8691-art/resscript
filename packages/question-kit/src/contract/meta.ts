/**
 * Plugin identity — Deliverable F §1 (`PluginMeta`) and §5 (versioning).
 *
 * `meta` is the only part of a plugin the studio palette, the compiler's entitlement pass and
 * the runtime's resolver read *without* loading the plugin's code. That is why it is a plain
 * data object with no functions on it: `list()` must stay cheap with fifty types installed
 * (F §7), which is only true if metadata can be shipped separately from behaviour.
 */

/**
 * A key into a language bundle (`03-survey-schema.md` §16). The kit takes the bare string
 * rather than schema's `I18nRef` wrapper because a plugin never constructs a translation —
 * it only ever names one — and `{ key: 'x' }` at every call site is ceremony that buys
 * nothing here. `I18nRef.key` is exactly this string, so the two convert by field access.
 */
export type I18nKey = string;

export const PLUGIN_CATEGORIES = [
  'choice',
  'text',
  'numeric',
  'grid',
  'ranking',
  'scale',
  'media',
  'advanced',
  'experimental',
  'content',
] as const;
export type PluginCategory = (typeof PLUGIN_CATEGORIES)[number];

/**
 * Trust tiers, in ascending order of "how little we know about this code" (F §6). The order
 * matters: composition may only ever go *down* this list (a first-party matrix must not embed
 * a marketplace cell control without an explicit allowlist), so the rank below is the
 * comparison the compose rules run.
 */
export const PLUGIN_TRUST_TIERS = ['first_party', 'org_custom', 'marketplace'] as const;
export type PluginTrust = (typeof PLUGIN_TRUST_TIERS)[number];

export const PLUGIN_TRUST_RANK: Readonly<Record<PluginTrust, number>> = {
  first_party: 0,
  org_custom: 1,
  marketplace: 2,
};

export interface PluginMeta {
  /** Stable, lowercase, snake_case. Appears in `question.question_type`. Never reused. */
  readonly id: string;
  /** Semver. The major participates in runtime resolution (F §5). */
  readonly version: string;
  readonly displayName: I18nKey;
  readonly description: I18nKey;
  readonly category: PluginCategory;
  /** Icon id from the studio icon set. Plugins ship no image assets. */
  readonly icon: string;
  /**
   * Entitlement gate (`01-system-architecture.md` §5). `null` = available on every plan. The
   * compiler copies this into `survey.entitlement_reqs`, which is the enforcement that
   * matters — a user cannot route around it by calling the API directly.
   */
  readonly entitlementKey: string | null;
  /**
   * Trust tier. **Set by the registry, not by the plugin author** (F §6). A plugin object may
   * state a tier, but `createRegistry` overwrites it with the tier of the source it was
   * registered from, so a marketplace bundle declaring `first_party` gains nothing.
   */
  readonly trust: PluginTrust;
  /** Can this type be used as a cell control inside a mixed matrix? (F §3) */
  readonly composable: boolean;
  /** Does this type render anything the respondent answers? `false` for content nodes. */
  readonly emitsData: boolean;
}

/** The plugin id pattern. Enforced at registration, because an id is forever. */
export const PLUGIN_ID_PATTERN = /^[a-z][a-z0-9_]{1,47}$/;

export interface Semver {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  /** Prerelease/build metadata, kept verbatim so a version round-trips. */
  readonly rest: string;
}

const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:[-+](.+))?$/;

/**
 * Parse a semver, or return `undefined`.
 *
 * Hand-rolled rather than pulling in `semver`: the kit needs exactly one operation (extract
 * the major so `${id}@${major}` can be a map key) and `packages/schema` already established
 * that this package family stays dependency-free.
 */
export function parseSemver(version: string): Semver | undefined {
  const m = SEMVER_RE.exec(version);
  if (m === null) return undefined;
  const [, major, minor, patch, rest] = m;
  if (major === undefined || minor === undefined || patch === undefined) return undefined;
  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    rest: rest ?? '',
  };
}

/** Compare two semvers. Prerelease ordering is not modelled — Phase 1 ships no prereleases. */
export function compareSemver(a: Semver, b: Semver): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

/**
 * The registry key, and the string that appears in a compiled page's `question_type`
 * (F §5.3: `"question_type": "matrix@3"`).
 *
 * Keyed on the *major* rather than the exact version on purpose: a live artifact must render
 * with the plugin it was compiled against for as long as it can collect data, and "the same
 * major" is precisely the compatibility promise §5's table defines. Pinning the full version
 * would force every patch release to ship as a new runtime module for no behavioural reason.
 */
export function pluginKey(id: string, major: number): string {
  return `${id}@${major}`;
}

export interface ParsedPluginKey {
  readonly id: string;
  readonly major: number;
}

export function parsePluginKey(key: string): ParsedPluginKey | undefined {
  const at = key.lastIndexOf('@');
  if (at <= 0) return undefined;
  const id = key.slice(0, at);
  const majorText = key.slice(at + 1);
  if (!PLUGIN_ID_PATTERN.test(id)) return undefined;
  if (!/^(0|[1-9]\d*)$/.test(majorText)) return undefined;
  return { id, major: Number(majorText) };
}
