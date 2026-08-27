/**
 * Artifact loading, per Deliverable C §17 and E §16.
 *
 * The contract that shapes this module: **rendering one page costs `manifest` + `graph` + `logic`
 * + one page.** The first three are fetched once per session and cached, so survey size affects
 * the one-time cost and not the per-page cost — a 2,000-question survey renders its 40th page with
 * the same number of byte-reads as a 20-question one. So the interface is deliberately split:
 * `head()` for the once-per-session part, `page()` for the per-page part. A `get()` returning a
 * whole `CompiledArtifact` cannot honour that, because the caller has no way to express "just this
 * page" and every entry would pull every page.
 *
 * The compiler's file tree (`packages/compiler/src/emit/bundle.ts`):
 *
 *   manifest.json
 *   graph.json
 *   logic.json
 *   pages/<language>/<page id>.json     <- per language, which is why `page()` takes one
 *   i18n/<language>.json
 *   quotas.json                          (optional)
 *   redirects.json                       (optional)
 *   designs/<ref>.json                   (optional)
 *
 * Artifacts are immutable and content-addressed (ADR-002), so cache keys are hashes and there is
 * no TTL and no invalidation: a hash never changes meaning.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createLogger } from '@resscript/observability';
import type {
  ArtifactGraph,
  QuotaConfig,
  ArtifactLogic,
  ArtifactManifest,
  CompiledPage,
  Redirects,
} from '@resscript/schema';

const log = createLogger({ service: 'runtime-artifacts' });

/** The once-per-session part of an artifact. */
export interface ArtifactHead {
  readonly hash: string;
  readonly manifest: ArtifactManifest;
  readonly graph: ArtifactGraph;
  readonly logic: ArtifactLogic;
  /**
   * `quotas.json`, absent when the survey declares none.
   *
   * Part of the HEAD rather than fetched at the gate: a quota gate is exactly the moment a
   * respondent is waiting on a decision, and a fourth round trip there would put storage latency
   * on the one step that already has to talk to Redis. It is small (a plan is dimensions and
   * targets) and immutable like the rest of the artifact, so the head's cache covers it.
   */
  readonly quotas?: QuotaConfig;
  /**
   * Set when `quotas.json` could not be read — a tier broke and no tier answered — as opposed to
   * the survey simply not having one.
   *
   * The distinction matters at the gate and nowhere else: absent means "no plans, admit everyone",
   * which is correct, while indeterminate means the plans may exist and be unreadable, and
   * admitting everyone then silently overshoots the client's quota. The gate emits a distinct,
   * louder event for this case rather than the benign one.
   */
  readonly quotasIndeterminate?: boolean;
}

export class ArtifactNotFound extends Error {
  constructor(readonly hash: string, readonly path: string) {
    super(`Artifact file not found: ${hash}/${path}`);
    this.name = 'ArtifactNotFound';
  }
}

export interface ArtifactLoader {
  /** `manifest` + `graph` + `logic`. Cached per hash for the process lifetime. */
  head(hash: string): Promise<ArtifactHead>;
  /** One page in one language, or null when the artifact has no such page. */
  page(hash: string, language: string, pageId: string): Promise<CompiledPage | null>;
  /**
   * The artifact's redirect maps, or null when the survey declares none. NOT part of `head()`:
   * redirects are read once per session at finalization, and folding them into the head would
   * put an extra fetch on the entry path of every session to save one on the exit path.
   */
  redirects(hash: string): Promise<Redirects | null>;
  /**
   * One script asset's source, verbatim (`scripts/<ref>.js` is a text file, not JSON), or
   * null when the artifact carries no such script. Cached like pages: an artifact's bytes
   * never change, so a null is as cacheable as a hit.
   */
  script(hash: string, ref: string): Promise<string | null>;
  /**
   * One language's string bundle (`i18n/<language>.json`), or null when the artifact carries
   * no such language. Read once per session render language, not folded into `head()` — a
   * multi-language artifact would otherwise pay for every language on every entry.
   */
  i18n(hash: string, language: string): Promise<Record<string, string> | null>;
  /** Best-effort pre-warm of the head. Never throws. */
  warm(hash: string): Promise<void>;
}

/* ------------------------------------------------------------------ *
 * Caching
 * ------------------------------------------------------------------ */

/**
 * An LRU keyed by `<hash>/<path>`.
 *
 * Bounded by entry count rather than bytes: measuring a decoded object's retained size in JS
 * requires either a serialization pass per insert or a guess, and a wrong guess in the direction
 * of "smaller than it is" turns the byte cap into an OOM. Entry count is honest about what it
 * bounds. Pages are cached individually, so a large survey occupies cache proportional to the
 * pages actually being served (C §17), not to its total size.
 */
class LruCache<T> {
  private readonly entries = new Map<string, T>();

  constructor(private readonly maxEntries: number) {}

  get(key: string): T | undefined {
    const hit = this.entries.get(key);
    if (hit === undefined) return undefined;
    // Re-insert to mark as most-recently-used.
    this.entries.delete(key);
    this.entries.set(key, hit);
    return hit;
  }

  set(key: string, value: T): void {
    if (this.entries.has(key)) this.entries.delete(key);
    this.entries.set(key, value);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }

  get size(): number {
    return this.entries.size;
  }
}

/* ------------------------------------------------------------------ *
 * Sources
 * ------------------------------------------------------------------ */

/** Fetch one file of one artifact. Returns null for a definite absence, throws on failure. */
export interface ArtifactSource {
  readonly name: string;
  fetch(hash: string, path: string): Promise<string | null>;
}

/**
 * A local directory laid out as `<dir>/<hash>/<path>`.
 *
 * For development and tests. Without it there is no way to run the runtime against a real
 * compiled artifact without standing up object storage, which makes the entry path unexercisable
 * by hand.
 */
export function fileSource(dir: string): ArtifactSource {
  return {
    name: 'file',
    async fetch(hash: string, path: string): Promise<string | null> {
      try {
        return await readFile(join(dir, hash, path), 'utf8');
      } catch (err) {
        if ((err as { code?: string }).code === 'ENOENT') return null;
        throw err;
      }
    },
  };
}

/** An HTTP source: a CDN or object storage, both addressed as `<base>/<hash>/<path>`. */
export function httpSource(name: string, base: string): ArtifactSource {
  return {
    name,
    async fetch(hash: string, path: string): Promise<string | null> {
      const res = await fetch(`${base}/${hash}/${path}`);
      // 404 is a definite absence and must not fall through to the next tier as an error: the
      // artifact genuinely has no such page, which `page()` reports as null.
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`${name} returned ${res.status}`);
      return res.text();
    },
  };
}

/* ------------------------------------------------------------------ *
 * The loader
 * ------------------------------------------------------------------ */

export interface LoaderOptions {
  readonly sources: readonly ArtifactSource[];
  /** Heads to keep. Each is one survey's manifest+graph+logic. */
  readonly maxHeads?: number;
  /** Pages to keep, across all surveys. */
  readonly maxPages?: number;
}

export function createLoader(opts: LoaderOptions): ArtifactLoader {
  const heads = new LruCache<ArtifactHead>(opts.maxHeads ?? 64);
  const pages = new LruCache<CompiledPage | null>(opts.maxPages ?? 512);
  // Sized like heads: one entry per active survey. Nulls are cached — "this survey has no
  // redirects" is as immutable as any other fact about a content-addressed artifact.
  const redirects = new LruCache<Redirects | null>(opts.maxHeads ?? 64);
  // Scripts are small and few per survey; the page budget is the right order of magnitude.
  const scripts = new LruCache<string | null>(opts.maxPages ?? 512);
  // One bundle per (artifact, language) — head-sized cardinality, not page-sized.
  const bundles = new LruCache<Record<string, string> | null>(opts.maxHeads ?? 64);

  if (opts.sources.length === 0) {
    throw new Error('createLoader: at least one artifact source is required');
  }

  /** Try each source in order. A null from every source means the file does not exist. */
  async function fetchFile(hash: string, path: string): Promise<string | null> {
    let lastError: unknown = null;
    for (const source of opts.sources) {
      try {
        const body = await source.fetch(hash, path);
        if (body !== null) return body;
      } catch (err) {
        // A tier being unreachable is not the same as the file being absent, so keep going and
        // only surface the error if no tier can answer at all.
        lastError = err;
        log.warn('artifact_source_failed', { source: source.name, hash, path, err: String(err) });
      }
    }
    if (lastError !== null) throw lastError;
    return null;
  }

  async function fetchJson<T>(hash: string, path: string): Promise<T | null> {
    const body = await fetchFile(hash, path);
    if (body === null) return null;
    try {
      return JSON.parse(body) as T;
    } catch (err) {
      // A truncated or corrupted artifact file must fail loudly. Returning a partial object is
      // how a survey ends up rendering with no questions and no error anywhere.
      throw new Error(`Artifact file is not valid JSON: ${hash}/${path}: ${String(err)}`);
    }
  }

  /**
   * Fetch a file whose ABSENCE is a legitimate answer, distinguishing it from "could not tell".
   *
   * `fetchFile` deliberately treats an unreachable tier as different from an absent file and
   * rethrows when no tier could answer — correct for the three required files, because a head
   * without them cannot render anything. Applied to an optional file it has a bad consequence: one
   * flaky tier would fail every head load for the overwhelming majority of surveys, which simply
   * do not have the file.
   *
   * But swallowing the error is worse than it looks. If the survey DOES declare quotas and the read
   * failed, "absent" would mean the gate runs with no plan and admits everyone — a silent quota
   * overshoot, which is the failure mode ADR-008's fail-closed option exists to avoid. So the two
   * cases are returned separately: `{ value: null, indeterminate: false }` is "the survey has no
   * such file", and `indeterminate: true` is "a tier broke and nothing answered". The caller decides
   * what the second one means; nothing here guesses.
   */
  async function fetchOptionalJson<T>(
    hash: string,
    path: string,
  ): Promise<{ value: T | null; indeterminate: boolean }> {
    try {
      return { value: await fetchJson<T>(hash, path), indeterminate: false };
    } catch (err) {
      log.warn('artifact_optional_file_indeterminate', { hash, path, err: String(err) });
      return { value: null, indeterminate: true };
    }
  }

  return {
    async head(hash: string): Promise<ArtifactHead> {
      const cached = heads.get(hash);
      if (cached) return cached;

      // Fetched together: the required three are always all needed, and serially they would cost
      // three round trips on the first page view of every session. `quotas.json` joins them
      // because a quota gate is the one step already waiting on Redis — see the field's own note.
      const [manifest, graph, logic, quotas] = await Promise.all([
        fetchJson<ArtifactManifest>(hash, 'manifest.json'),
        fetchJson<ArtifactGraph>(hash, 'graph.json'),
        fetchJson<ArtifactLogic>(hash, 'logic.json'),
        fetchOptionalJson<QuotaConfig>(hash, 'quotas.json'),
      ]);

      if (!manifest) throw new ArtifactNotFound(hash, 'manifest.json');
      if (!graph) throw new ArtifactNotFound(hash, 'graph.json');
      if (!logic) throw new ArtifactNotFound(hash, 'logic.json');

      // The graph is what the machine routes on. A head missing `nodes` or `page_entry` would
      // send every respondent straight to TERMINATE with no indication why, so it is rejected
      // here where the hash is still in hand.
      if (!Array.isArray(graph.nodes) || graph.nodes.length === 0) {
        throw new Error(`Artifact graph has no flow nodes: ${hash}`);
      }
      if (typeof graph.page_entry !== 'object' || graph.page_entry === null) {
        throw new Error(`Artifact graph has no page_entry index: ${hash}`);
      }
      // The variable manifest is the closed world the anti-tamper filter reads and the types
      // `tagVars` needs to hand the engine comparable values. A head without one evaluates every
      // rule against an empty variable world — no error, no answer, every condition UNKNOWN —
      // which is the safe-direction-wrong failure this loader already refuses for `graph.nodes`.
      if (!Array.isArray(manifest.variable_manifest)) {
        throw new Error(`Artifact manifest has no variable_manifest: ${hash}`);
      }

      const head: ArtifactHead = {
        hash,
        manifest,
        graph,
        logic,
        ...(quotas.value ? { quotas: quotas.value } : {}),
        ...(quotas.indeterminate ? { quotasIndeterminate: true } : {}),
      };
      heads.set(hash, head);
      log.info('artifact_head_loaded', {
        hash,
        nodes: graph.nodes.length,
        pages: graph.page_order.length,
      });
      return head;
    },

    async page(hash: string, language: string, pageId: string): Promise<CompiledPage | null> {
      const key = `${hash}/${language}/${pageId}`;
      const cached = pages.get(key);
      if (cached !== undefined) return cached;

      const page = await fetchJson<CompiledPage>(hash, `pages/${language}/${pageId}.json`);
      // A null is cached too: a page absent in one language is absent on every request for it,
      // and re-fetching a known-missing file on every render is a per-page cost that C §17's
      // contract does not allow.
      pages.set(key, page);
      return page;
    },

    async redirects(hash: string): Promise<Redirects | null> {
      const cached = redirects.get(hash);
      if (cached !== undefined) return cached;
      const loaded = await fetchJson<Redirects>(hash, 'redirects.json');
      redirects.set(hash, loaded);
      return loaded;
    },

    async script(hash: string, ref: string): Promise<string | null> {
      // The ref reaches a URL path; a traversal-shaped ref must die here, not at the CDN.
      if (!/^[A-Za-z0-9_-]+$/.test(ref)) return null;
      const key = `${hash}/scripts/${ref}`;
      const cached = scripts.get(key);
      if (cached !== undefined) return cached;
      const source = await fetchFile(hash, `scripts/${ref}.js`);
      scripts.set(key, source);
      return source;
    },

    async i18n(hash: string, language: string): Promise<Record<string, string> | null> {
      if (!/^[A-Za-z0-9-]{1,16}$/.test(language)) return null; // it reaches a URL path
      const key = `${hash}/i18n/${language}`;
      const cached = bundles.get(key);
      if (cached !== undefined) return cached;
      const bundle = await fetchJson<Record<string, string>>(hash, `i18n/${language}.json`);
      bundles.set(key, bundle);
      return bundle;
    },

    async warm(hash: string): Promise<void> {
      try {
        await this.head(hash);
      } catch (err) {
        // Best-effort by definition: a failed warm must not fail the request that triggered it.
        log.warn('artifact_warm_failed', { hash, err: String(err) });
      }
    },
  };
}

/**
 * Build a loader from the environment.
 *
 *   ARTIFACT_DIR         — a local directory, tried first when set. Development only.
 *   CDN_URL              — L2, immutable-cached by hash.
 *   ARTIFACT_STORAGE_URL — L3, the durable authoritative copy.
 */
export function createArtifactLoader(): ArtifactLoader {
  const sources: ArtifactSource[] = [];

  const dir = process.env['ARTIFACT_DIR'];
  if (dir) {
    if (process.env['NODE_ENV'] === 'production') {
      throw new Error('ARTIFACT_DIR is not permitted in production');
    }
    log.warn('artifact_file_source_enabled', { dir });
    sources.push(fileSource(dir));
  }

  const cdn = process.env['CDN_URL'];
  if (cdn) sources.push(httpSource('cdn', cdn));

  const storage = process.env['ARTIFACT_STORAGE_URL'];
  if (storage) sources.push(httpSource('storage', storage));

  if (sources.length === 0) {
    // Defaulting to a hard-coded hostname would make a misconfigured deployment look healthy
    // until the first respondent, and then fail on every request. Fail at startup instead.
    throw new Error(
      'No artifact source configured. Set ARTIFACT_DIR (development) or CDN_URL / ARTIFACT_STORAGE_URL.',
    );
  }

  return createLoader({ sources });
}
