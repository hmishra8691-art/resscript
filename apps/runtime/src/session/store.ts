/**
 * Session persistence layer: Redis primary with Postgres fallback.
 *
 * SessionState is serialized to MessagePack and stored in Redis with a TTL of
 * (max_duration + 1 hour). If Redis is unavailable or the key expired, the runtime
 * rebuilds SessionState from response_documents and response_events.
 *
 * The Postgres projection (runtime.sessions table) holds:
 *   - ids, disposition, timings, artifact_hash, revision
 * for dashboards and reconciliation, not for restoration.
 *
 * Per ADR-007: response_events are the source of truth. SessionState is a cache.
 */

import type { SessionState } from './types.js';

export interface SessionStore {
  /** Load SessionState from Redis, falling back to Postgres rebuild if needed. */
  load(sessionId: string): Promise<SessionState | null>;

  /** Save SessionState to Redis (with TTL) and update Postgres projection. */
  save(sessionState: SessionState): Promise<void>;

  /** Hash a resume token for lookups (sess:tok:{hash} -> session_id). */
  saveResumeToken(sessionId: string, resumeToken: string, ttlSeconds: number): Promise<void>;

  /** Look up session_id by resume token. */
  resolveResumeToken(resumeTokenHash: string): Promise<string | null>;
}

/**
 * An in-process session store.
 *
 * Real enough to drive the entry and page-render endpoints end to end, which is what makes an
 * HTTP-level test of those paths possible before Redis exists. Two properties are deliberately
 * faithful so that swapping in Redis does not change behaviour:
 *
 *   - `save` deep-copies, so a caller mutating its `SessionState` after saving cannot alter the
 *     stored copy. A store that handed back the same object would let the endpoints pass while
 *     depending on shared mutable state that Redis will not give them.
 *   - `load` returns a copy too, so two concurrent requests for one session see independent
 *     objects and the `revision` guard is exercised rather than bypassed.
 *
 * Not suitable for more than one process, and it forgets everything on restart.
 */
export function createMemorySessionStore(): SessionStore {
  const sessions = new Map<string, string>();
  const resumeTokens = new Map<string, string>();

  return {
    async load(sessionId: string): Promise<SessionState | null> {
      const raw = sessions.get(sessionId);
      return raw === undefined ? null : (JSON.parse(raw) as SessionState);
    },

    async save(sessionState: SessionState): Promise<void> {
      sessions.set(sessionState.session_id, JSON.stringify(sessionState));
    },

    async saveResumeToken(sessionId: string, resumeToken: string): Promise<void> {
      resumeTokens.set(resumeToken, sessionId);
    },

    async resolveResumeToken(resumeTokenHash: string): Promise<string | null> {
      return resumeTokens.get(resumeTokenHash) ?? null;
    },
  };
}

/**
 * Create a session store backed by Redis and Postgres.
 *
 * Environment variables:
 *   REDIS_URL      — Redis connection string (default: redis://localhost:6379)
 *   DATABASE_URL   — Postgres connection string
 */
export function createSessionStore(): SessionStore {
  const redisUrl = process.env['REDIS_URL'] ?? 'redis://localhost:6379';
  const databaseUrl = process.env['DATABASE_URL'];

  // TODO: Initialize Redis and Postgres clients
  // For now, return a stub implementation
  const stub: SessionStore = {
    async load(sessionId: string): Promise<SessionState | null> {
      // 1. Try Redis GET sess:{sessionId}
      // 2. On miss, query Postgres to rebuild from response_documents + response_events
      // 3. Return null if not found in either
      throw new Error('P1-09: session store not implemented');
    },

    async save(sessionState: SessionState): Promise<void> {
      // 1. Serialize SessionState to MessagePack (compact binary format)
      // 2. Redis SET sess:{id} {bytes} EX {maxDuration + 3600}
      // 3. Postgres UPDATE sessions SET (ids, disposition, timings, artifact_hash, revision)
      // 4. On Redis failure: buffer write to local queue for drain on recovery
      throw new Error('P1-09: session store not implemented');
    },

    async saveResumeToken(
      sessionId: string,
      resumeToken: string,
      ttlSeconds: number,
    ): Promise<void> {
      // Minted at entry, persisted in Redis with a short TTL
      // sess:tok:{sha256(resumeToken)} -> sessionId
      throw new Error('P1-09: session store not implemented');
    },

    async resolveResumeToken(resumeTokenHash: string): Promise<string | null> {
      // Look up in Redis; on miss, query Postgres by resume_token_hash column
      throw new Error('P1-09: session store not implemented');
    },
  };

  return stub;
}
