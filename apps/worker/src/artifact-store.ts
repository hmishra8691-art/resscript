/**
 * Where the compiled artifact's bytes live — and the one property that makes ADR-002 worth
 * having.
 *
 * The roadmap's P1-08 DB column says "Supabase Storage bucket for artifacts". THIS REPOSITORY
 * HAS NO STORAGE CLIENT: `apps/studio` links `@supabase/supabase-js` for PostgREST and auth,
 * `apps/worker` links `pg` and nothing else, and `apps/runtime`'s readiness probe reports
 * `artifact_store: 'not_configured'` precisely because the thing does not exist yet. Adding a
 * cloud SDK to `apps/worker` so that a test can pass would put a network client on the critical
 * path of a job that has to be re-runnable offline, and would make the interesting assertion of
 * this milestone — "republishing unchanged content writes no new object" — a claim about a mock.
 *
 * So the seam is an interface of three methods and the shipped implementation is a filesystem
 * tree. `SupabaseArtifactStore` below is an adapter over a *structural* bucket interface: it
 * imports nothing, and the two lines that would construct a real client are the deployment's
 * job. That is the same shape `PgJobStore` uses for `SqlClient` and for the same reason.
 *
 * ## Why `has(key)` is part of the interface and not an implementation detail
 *
 * ADR-002 addresses an artifact by the sha256 of its own content, so two compiles of an
 * unchanged survey produce the same key. The publish path therefore has a genuine no-op:
 * `has()` first, `put()` only on a miss. That is not an optimization — the roadmap's acceptance
 * criterion is "compiling the identical model a second time produces the identical hash and
 * CREATES NO NEW OBJECT", and an implementation that unconditionally `put()`s satisfies the
 * hash half while quietly failing the object half. A store that overwrites the same bytes also
 * defeats object-lock / write-once bucket policies, which is what an auditor asks for when the
 * question is "can a published survey be altered after the fact".
 *
 * `get()` exists for `apps/runtime` (P1-09) and for the rollback test, which proves
 * byte-identity by reading back what a token points at. It is not used by the publish path.
 *
 * ## What this deliberately does not do
 *
 * No signed URLs (H §2.4's `GET /v1/versions/{id}/artifact` needs them; that endpoint is not in
 * this milestone), no deletion (an artifact a version still names must not be collectable, and
 * ADR-002's whole point is that the bytes outlive the draft), and no content-type negotiation —
 * every file in a bundle is UTF-8 text, JSON or CSS, and a store that guessed would be a store
 * that served `theme.css` as `application/json` on the day the guess was wrong.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';

import { AppError } from '@resscript/observability';

/**
 * The storage key for one file of one artifact.
 *
 * `artifact/<hash>/<path>` — hash first, so every file of one artifact shares a prefix and a
 * bucket listing groups by artifact rather than by page number, and so a lifecycle rule or an
 * object-lock policy can be written against one prefix per published version.
 */
export const ARTIFACT_KEY_PREFIX = 'artifact';

export function artifactKey(hash: string, path: string): string {
  return `${ARTIFACT_KEY_PREFIX}/${hash}/${path}`;
}

export interface ArtifactStore {
  /**
   * True when this key already holds bytes. The publish path's first call, because a hit means
   * the whole upload is skipped (see the header).
   */
  has(key: string): Promise<boolean>;
  /** Write the bytes. Callers pass UTF-8 text; the store owns the encoding. */
  put(key: string, bytes: string): Promise<void>;
  /** `null` for a key that was never written, so a caller can distinguish it from empty bytes. */
  get(key: string): Promise<string | null>;
}

/* -------------------------------------------------------------------------- */
/* Filesystem                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The implementation that actually ships in Phase 1: a directory tree.
 *
 * Good enough for a single-node deploy and for `docker compose`, honest about being wrong for a
 * fleet (two workers on two nodes would publish into two trees), and it makes the content-address
 * property inspectable with `find` and `sha256sum` — which is how the determinism test was
 * debugged the first time it failed.
 *
 * Keys are joined onto the root and then checked to still be under it. A key is built here from
 * a sha256 and an artifact-relative path, so traversal is not reachable today; the check is what
 * keeps it unreachable when the first caller passes a key that came from a request.
 */
export class FsArtifactStore implements ArtifactStore {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  private pathFor(key: string): string {
    const full = resolve(join(this.root, key));
    if (full !== this.root && !full.startsWith(this.root + sep)) {
      throw new AppError('malformed_request', 'artifact key escapes the store root', {
        context: { key },
      });
    }
    return full;
  }

  async has(key: string): Promise<boolean> {
    return (await this.get(key)) !== null;
  }

  async put(key: string, bytes: string): Promise<void> {
    const file = this.pathFor(key);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, bytes, 'utf8');
  }

  async get(key: string): Promise<string | null> {
    try {
      return await readFile(this.pathFor(key), 'utf8');
    } catch (err: unknown) {
      if (typeof err === 'object' && err !== null && (err as { code?: string }).code === 'ENOENT') {
        return null;
      }
      throw err;
    }
  }
}

/* -------------------------------------------------------------------------- */
/* In memory                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The test double, which counts its calls.
 *
 * The counter is not test scaffolding bolted on: "republishing unchanged content performs no
 * `put`" is only assertable against a store that can be asked how many writes it took, and a
 * test that instead asserted "the second publish produced the same hash" would pass against an
 * implementation that re-uploaded every byte. So the count is part of the double's contract.
 */
export class MemoryArtifactStore implements ArtifactStore {
  private readonly objects = new Map<string, string>();
  readonly puts: string[] = [];
  readonly hasCalls: string[] = [];

  async has(key: string): Promise<boolean> {
    this.hasCalls.push(key);
    return this.objects.has(key);
  }

  async put(key: string, bytes: string): Promise<void> {
    this.puts.push(key);
    this.objects.set(key, bytes);
  }

  async get(key: string): Promise<string | null> {
    return this.objects.get(key) ?? null;
  }

  get size(): number {
    return this.objects.size;
  }
}

/* -------------------------------------------------------------------------- */
/* Supabase Storage — the adapter, not the client                             */
/* -------------------------------------------------------------------------- */

/**
 * The subset of `SupabaseClient['storage']['from'](bucket)` this store uses, declared
 * structurally so that this module imports nothing from `@supabase/supabase-js`.
 *
 * That is the same technique `PgJobStore`'s `SqlClient` uses, and here it carries a second
 * argument: `apps/worker` deliberately has one dependency (`pg`), and the compile job must be
 * runnable in a test, in CI and on a laptop with no cloud credentials. A deployment that wants
 * Supabase Storage constructs the client in `server.ts` and passes `client.storage.from(bucket)`
 * here; nothing else changes.
 *
 * NOT EXERCISED BY THE SUITE. There is no Supabase in this container, so the tests run against
 * `MemoryArtifactStore` and `FsArtifactStore` and this class is unverified against the real API
 * — which is exactly why it is thirty lines of translation and holds no logic. When a deployment
 * turns it on, `upload`'s `upsert: false` plus the `has()`-before-`put()` in the publish path
 * means a concurrent double publish of the same hash loses the race harmlessly rather than
 * overwriting bytes a version already names.
 */
export interface StorageBucketLike {
  download(path: string): Promise<{ data: { text(): Promise<string> } | null; error: unknown }>;
  upload(
    path: string,
    body: string,
    options?: { readonly contentType?: string; readonly upsert?: boolean },
  ): Promise<{ error: unknown }>;
}

export class SupabaseArtifactStore implements ArtifactStore {
  constructor(private readonly bucket: StorageBucketLike) {}

  async has(key: string): Promise<boolean> {
    return (await this.get(key)) !== null;
  }

  async get(key: string): Promise<string | null> {
    const { data, error } = await this.bucket.download(key);
    if (error !== null && error !== undefined) return null;
    return data === null ? null : await data.text();
  }

  async put(key: string, bytes: string): Promise<void> {
    // `upsert: false`: an artifact key is a content address, so a second write of the same key
    // is either the same bytes (nothing to do) or a hash collision (nothing to do about).
    const { error } = await this.bucket.upload(key, bytes, {
      contentType: contentTypeFor(key),
      upsert: false,
    });
    if (error !== null && error !== undefined) {
      throw new AppError('unavailable', 'artifact upload failed', {
        retryable: true,
        context: { key, error: String(error) },
      });
    }
  }
}

function contentTypeFor(key: string): string {
  if (key.endsWith('.json')) return 'application/json; charset=utf-8';
  if (key.endsWith('.css')) return 'text/css; charset=utf-8';
  return 'text/plain; charset=utf-8';
}

/** sha256 of one file's bytes, for a store that wants to verify what it read. */
export function sha256Of(bytes: string): string {
  return createHash('sha256').update(bytes, 'utf8').digest('hex');
}
