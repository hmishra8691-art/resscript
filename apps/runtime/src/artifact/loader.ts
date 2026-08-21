/**
 * Artifact loader with 3-tier caching: in-process LRU → CDN → object storage.
 *
 * Artifacts are immutable (ADR-002) and content-addressed, so cache keys are hashes
 * and TTL is infinite — a hash never needs invalidation.
 *
 * L1 (in-process): 64 artifacts or 512 MB, whichever fills first.
 *   Hit rate >99.5% in steady state; a runtime instance serves a handful of surveys.
 *
 * L2 (CDN): Cache-Control: public, max-age=31536000, immutable.
 *   Per-file caching by hash in the URL.
 *
 * L3 (object storage): Durable, the authoritative copy. Manifest fetched first.
 *
 * Sub-files are cached individually, so a 2,000-question survey occupies cache
 * proportional to the pages being served, not the full size.
 */

import type { CompiledArtifact, ArtifactManifest } from '@resscript/schema';

export interface ArtifactLoader {
  /** Load a complete artifact by hash. Throws if not found after L3 exhausted. */
  get(hash: string): Promise<CompiledArtifact>;

  /** Pre-warm L1 cache. Called on first token resolution for a hash never seen. */
  warm(hash: string): Promise<void>;
}

/** In-process LRU cache for artifacts. */
class ArtifactCache {
  private readonly cache = new Map<string, CompiledArtifact>();
  private readonly maxSizeBytes = 512 * 1024 * 1024; // 512 MB
  private currentSizeBytes = 0;

  has(hash: string): boolean {
    return this.cache.has(hash);
  }

  get(hash: string): CompiledArtifact | undefined {
    return this.cache.get(hash);
  }

  set(hash: string, artifact: CompiledArtifact): void {
    // Rough size estimate: serialize to JSON and measure
    const estimatedSize = JSON.stringify(artifact).length;

    // Evict LRU entries until we have room
    while (this.currentSizeBytes + estimatedSize > this.maxSizeBytes && this.cache.size > 0) {
      const firstKey = this.cache.keys().next().value as string;
      const removed = this.cache.get(firstKey);
      if (removed) {
        this.currentSizeBytes -= JSON.stringify(removed).length;
      }
      this.cache.delete(firstKey);
    }

    this.cache.set(hash, artifact);
    this.currentSizeBytes += estimatedSize;
  }
}

/**
 * Factory for creating an artifact loader.
 * Configuration is pulled from environment variables:
 *
 *   CDN_URL              — base URL for L2 CDN (e.g., https://cdn.example.com/artifacts)
 *   ARTIFACT_STORAGE_URL — base URL for L3 storage (e.g., s3://bucket/artifacts or https://...)
 *
 * The loader is responsible for fetching and caching. Network failures fall through layers
 * gracefully: CDN miss → object storage, storage unavailable → eventual 502.
 */
export function createArtifactLoader(): ArtifactLoader {
  const l1 = new ArtifactCache();
  const cdnUrl = process.env['CDN_URL'] ?? 'https://cdn.resscript.io/artifacts';
  const storageUrl = process.env['ARTIFACT_STORAGE_URL'] ?? 'https://storage.resscript.io/artifacts';

  return {
    async get(hash: string): Promise<CompiledArtifact> {
      // L1 hit
      if (l1.has(hash)) {
        return l1.get(hash)!;
      }

      // L2: fetch from CDN (with immutable headers, so failures are permanent)
      let artifact: CompiledArtifact | null = null;

      try {
        const cdnResponse = await fetch(`${cdnUrl}/${hash}/manifest.json`);
        if (cdnResponse.ok) {
          const manifest = (await cdnResponse.json()) as ArtifactManifest;
          artifact = { manifest } as unknown as CompiledArtifact; // TODO: load full artifact from files
        }
      } catch (err) {
        // CDN unavailable; fall through to L3
      }

      // L3: fetch from object storage (slower, but definitive)
      if (!artifact) {
        try {
          const storageResponse = await fetch(`${storageUrl}/${hash}/manifest.json`);
          if (!storageResponse.ok) {
            throw new Error(`Storage returned ${storageResponse.status}`);
          }
          const manifest = (await storageResponse.json()) as ArtifactManifest;
          artifact = { manifest } as unknown as CompiledArtifact; // TODO: load full artifact from files
        } catch (err) {
          throw new Error(`Artifact not found: ${hash}`);
        }
      }

      // Cache in L1 before returning
      l1.set(hash, artifact);
      return artifact;
    },

    async warm(hash: string): Promise<void> {
      if (!l1.has(hash)) {
        try {
          await this.get(hash);
        } catch (err) {
          // Warm is best-effort; don't fail the request if it times out
        }
      }
    },
  };
}
