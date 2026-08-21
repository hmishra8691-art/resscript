/**
 * `ArtifactBundle`: the file tree, the canonical bytes, and the content hash — ADR-002, C §17,
 * roadmap P1-08.
 *
 * ## The addressing rule, implemented
 *
 * `types.ts`' `ArtifactBundle` comment states it and this file is where it happens. `manifest.json`
 * is written with `artifact_hash` and `compiled_at` as the empty string; the hash is taken over the
 * stored files; the in-memory `artifact` gets both fields filled. The consequence the roadmap asks
 * for is that republishing an unchanged survey a week later produces the identical hash — so the
 * two fields that *would* differ (the hash itself, and the wall clock) are the two the stored bytes
 * do not carry. `buildBundle` overwrites them rather than trusting its input, so a caller that
 * built a manifest with a timestamp in it cannot accidentally poison the address.
 *
 * ## The hash framing
 *
 * The input to `sha256` is not a concatenation of file contents. Concatenation is ambiguous: the
 * trees `{"a.json": "x", "b": "y"}` and `{"a.jsonx": "", "b": "y"}` produce the same byte stream if
 * you write `path + bytes` for each file in sorted order, so two genuinely different artifacts
 * would share one address — and under ADR-002 sharing an address means the second publish silently
 * reuses the first one's object. So every field is **length-prefixed**, which makes the framing
 * injective: the length is read before the field, so no field can be confused with its neighbour's
 * prefix.
 *
 *     HASH_PREAMBLE "\n" <file count> "\n"
 *     for each file, sorted by path (code-point order):
 *       <byte length of path> "\n" <path> "\n" <byte length of bytes> "\n" <bytes> "\n"
 *
 * Lengths are UTF-8 **byte** counts, not UTF-16 code-unit counts, so a survey whose labels differ
 * only outside the BMP cannot collide. The newlines are redundant given the lengths and are kept
 * because they make the framing readable in a hexdump when somebody is debugging a hash mismatch
 * at two in the morning.
 *
 * `HASH_PREAMBLE` carries a framing version. Changing the framing changes every artifact's address,
 * which is exactly right — an artifact addressed under one framing and one under another are not
 * interchangeable objects — and the version makes that intentional rather than a silent mass
 * invalidation nobody notices.
 *
 * ## Canonical JSON everywhere, and why `quotas.json` exists
 *
 * Every `.json` file goes through `stableStringify` and never `JSON.stringify` (CONTEXT decision
 * 2): key order is what makes the hash a function of the survey rather than of the order Postgres
 * returned rows in. Non-JSON files — `theme.css`, `scripts/<ref>.js` — are stored verbatim, since
 * there is no canonical form of CSS and rewriting author code is ADR-003's prohibition.
 *
 * `quotas.json` is in the tree even though the milestone brief's file list does not name it, and
 * the reason is the hash rather than the runtime: `CompiledArtifact.quotas` is part of the artifact,
 * so an artifact whose quota plan changed while nothing else did *must* get a new address. Leaving
 * quotas out of the files would make two different published surveys content-address to one object,
 * which is the precise failure the length-prefixed framing above exists to prevent — a hole in the
 * hash's coverage is worse than an ambiguity in its framing, because it cannot be detected by
 * looking at the hash.
 *
 * ## What this module refuses to do
 *
 * It does not compile. Every part arrives built (`manifest.ts`, `graph.ts`, `pages.ts`,
 * `logic.ts`, `i18n.ts`), so this file has no opinion about content and cannot introduce a
 * disagreement between what was checked and what was stored. It also reads no clock: `compiledAt`
 * is a parameter, per CONTEXT decision 3, because a compiler that reads a clock cannot be tested
 * for determinism.
 */

import { createHash } from 'node:crypto';

import {
  stableStringify,
  type ArtifactGraph,
  type ArtifactLogic,
  type Redirects,
  type ArtifactManifest,
  type CompiledArtifact,
  type CompiledPage,
  type Design,
  type Iso8601,
  type JsonObject,
  type QuotaConfig,
  type StringBundle,
  type Survey,
} from '@resscript/schema';

import type { ArtifactFile, ArtifactBundle } from '../types.js';
import { UNRESOLVED_AT_STORE } from './manifest.js';
import { pagePath } from './pages.js';

/**
 * The framing domain separator and its version. Bumping the version re-addresses every artifact,
 * deliberately: see the header.
 */
export const HASH_PREAMBLE = 'resscript-artifact-tree/1';

export interface BundleParts {
  readonly manifest: ArtifactManifest;
  readonly graph: ArtifactGraph;
  readonly logic: ArtifactLogic;
  /** `language → pageId → page`, as `buildPages` returns it. */
  readonly pages: { readonly [language: string]: { readonly [pageId: string]: CompiledPage } };
  /** Which language's tree becomes `artifact.pages`. See `pages.ts`' header. */
  readonly baseLanguage: string;
  readonly i18n: { readonly [language: string]: StringBundle };
  /** Filled into `artifact.manifest.compiled_at`; never into the stored bytes. */
  readonly compiledAt: Iso8601;
  readonly quotas?: QuotaConfig | null;
  readonly redirects?: Redirects | null;
  readonly designs?: { readonly [designRef: string]: JsonObject };
  readonly themeCss?: string | null;
  readonly scripts?: { readonly [ref: string]: string };
}

export function buildBundle(parts: BundleParts): ArtifactBundle {
  // The stored manifest, with the two volatile fields blanked whatever the caller passed.
  const stored: ArtifactManifest = {
    ...parts.manifest,
    artifact_hash: UNRESOLVED_AT_STORE,
    compiled_at: UNRESOLVED_AT_STORE as Iso8601,
  };

  const files: ArtifactFile[] = [
    jsonFile('manifest.json', stored),
    jsonFile('graph.json', parts.graph),
    jsonFile('logic.json', parts.logic),
  ];

  for (const language of Object.keys(parts.pages).sort()) {
    const tree = parts.pages[language] ?? {};
    for (const pageId of Object.keys(tree).sort()) {
      const page = tree[pageId];
      if (page !== undefined) files.push(jsonFile(pagePath(language, pageId), page));
    }
  }

  for (const language of Object.keys(parts.i18n).sort()) {
    files.push(jsonFile(`i18n/${language}.json`, parts.i18n[language] ?? {}));
  }

  const quotas = parts.quotas;
  if (quotas !== undefined && quotas !== null) files.push(jsonFile('quotas.json', quotas));

  // Redirects, same optional-file shape as quotas. In the artifact because the RUNTIME resolves
  // them at finalization (E §11) and ADR-001 forbids it reading content.redirects — the same
  // argument as every other section. Absent when the survey declares none, which CMP-0300
  // already makes unpublishable for any survey whose flow can reach COMPLETE.
  const redirects = parts.redirects;
  if (redirects !== undefined && redirects !== null) {
    files.push(jsonFile('redirects.json', redirects));
  }

  const designs = parts.designs;
  if (designs !== undefined) {
    for (const ref of Object.keys(designs).sort()) {
      const design = designs[ref];
      if (design !== undefined) files.push(jsonFile(`designs/${ref}.json`, design));
    }
  }

  const scripts = parts.scripts;
  if (scripts !== undefined) {
    for (const ref of Object.keys(scripts).sort()) {
      // Verbatim, not canonicalized: it is author JavaScript, its integrity hash is in the
      // manifest, and the CSP directive that permits it is a hash of exactly these bytes.
      files.push(textFile(`scripts/${ref}.js`, scripts[ref] ?? ''));
    }
  }

  const themeCss = parts.themeCss;
  if (themeCss !== undefined && themeCss !== null) files.push(textFile('theme.css', themeCss));

  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const hash = treeHash(files);
  const bytes = files.reduce((total, file) => total + byteLength(file.bytes), 0);

  const artifact: CompiledArtifact = {
    manifest: { ...stored, artifact_hash: hash, compiled_at: parts.compiledAt },
    graph: parts.graph,
    // The base language tree. A language with no tree at all cannot happen — `buildPages` emits
    // one per `manifest.languages` entry and the base is always the first — but an empty record is
    // the total answer rather than a throw, for the reason `flow.ts` gives about a pass that
    // throws turning a diagnostic into a 500.
    pages: parts.pages[parts.baseLanguage] ?? {},
    logic: parts.logic,
    ...(quotas === undefined || quotas === null ? {} : { quotas }),
    ...(redirects === undefined || redirects === null ? {} : { redirects }),
    ...(designs === undefined ? {} : { designs }),
    i18n: parts.i18n,
    ...(themeCss === undefined || themeCss === null ? {} : { theme_css: themeCss }),
    ...(scripts === undefined ? {} : { scripts }),
  };

  return { hash, files, bytes, artifact };
}

/* ========================================================================== */
/* The hash                                                                    */
/* ========================================================================== */

/**
 * `sha256` over the stored files, sorted by path, with every field length-prefixed.
 *
 * Exported so a caller can verify a stored tree without rebuilding it — which is what a storage
 * integrity check does, and it must use this function rather than its own reading of the framing
 * comment above.
 */
export function treeHash(files: readonly ArtifactFile[]): string {
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const digest = createHash('sha256');
  digest.update(`${HASH_PREAMBLE}\n${String(sorted.length)}\n`, 'utf8');
  for (const file of sorted) {
    digest.update(`${String(byteLength(file.path))}\n${file.path}\n`, 'utf8');
    digest.update(`${String(byteLength(file.bytes))}\n${file.bytes}\n`, 'utf8');
  }
  return digest.digest('hex');
}

/** Hex, not base64: `ArtifactFile.sha256` is read by humans comparing two stored trees. */
function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

function jsonFile(path: string, value: unknown): ArtifactFile {
  return textFile(path, stableStringify(value));
}

function textFile(path: string, bytes: string): ArtifactFile {
  return { path, bytes, sha256: sha256(bytes) };
}

/* ========================================================================== */
/* Parts derived straight from the document                                    */
/* ========================================================================== */

/**
 * `ScriptAsset.ref → source`, the payload half of `manifest.script_hashes`.
 *
 * Both targets are carried. A server script's source never reaches the browser, but the artifact is
 * the record of what was published and the server executes from it too; filtering by `runs_on`
 * here would make the artifact an incomplete account of the survey, and `cspDirectives` already
 * documents that a server script's hash in the policy is inert rather than wrong.
 */
export function scriptsOf(survey: Survey): { readonly [ref: string]: string } | undefined {
  const assets = survey.assets?.scripts ?? [];
  if (assets.length === 0) return undefined;
  const out: { [ref: string]: string } = {};
  // Last wins on a duplicate ref, in document order — the same tie-break `scriptHashes` makes, so
  // the hash in the manifest is the hash of the source in the tree.
  for (const asset of assets) out[asset.ref] = asset.source;
  return out;
}

/**
 * `Design.ref → the design`, for `CompiledArtifact.designs`.
 *
 * The whole design and not just `generated`, because C §10 makes the *reviewed* numbers the
 * shipped numbers: "a researcher has to defend the design's balance to a client, and regenerating
 * it later would produce a different matrix", so the spec, the seed and the stored diagnostics all
 * belong in the artifact next to the matrix they describe.
 */
export function designsOf(survey: Survey): { readonly [designRef: string]: JsonObject } | undefined {
  const designs = survey.designs ?? [];
  if (designs.length === 0) return undefined;
  const out: { [designRef: string]: JsonObject } = {};
  for (const design of designs) out[design.ref] = asJsonObject(design);
  return out;
}

/**
 * A `Design` is a record of JSON-valued fields, but an interface has no implicit index signature,
 * so it is not a `JsonValue` to the type system. Same cast, same reasoning, as `pages.ts` makes for
 * `PageSettings`.
 */
function asJsonObject(design: Design): JsonObject {
  return design as unknown as JsonObject;
}
