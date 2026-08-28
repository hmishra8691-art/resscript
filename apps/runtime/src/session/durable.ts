/**
 * The durable half of session storage: Redis primary, Postgres record (E §3.2).
 *
 * Redis is a CACHE WITH A DURABLE BACKING, not the system of record. `sess:{id}` holds the
 * full `SessionState` and is what every request reads; the record is `runtime.response_events`
 * plus the two projections, written through 0011's SECURITY DEFINER RPCs. If Redis loses the
 * key, `rebuildSession` reconstructs a workable state from `runtime.load_session` — slower
 * (~one Postgres round trip) but correct, which is the 01 §7 "Redis down → fall back to
 * Postgres" path.
 *
 * ## Write order: Postgres, then Redis
 *
 * E §5 step 8 fixes it and the reason is loss asymmetry: if the Redis write fails after the
 * Postgres commit, the session rebuilds from Postgres and nothing is lost; the reverse order
 * can lose a submit that the respondent watched succeed.
 *
 * ## The CAS
 *
 * E §3.4: two POSTs for one session (double-click, mobile retry, two tabs) must not both
 * commit. The Redis save is a Lua compare-and-swap on `revision` — strictly greater or the
 * write is refused — and the LOSER of the race re-reads and replays or 409s. The Postgres
 * side has its own guard (`last_event_seq`), so even a CAS bug cannot double-append.
 *
 * ## What the rebuild cannot recover, stated honestly
 *
 * `history` (the back stack) and `var_provenance` live only in Redis until the event-tail
 * replay lands (the events carry everything needed; the replay is P1-12 polish). A session
 * rebuilt after Redis loss therefore continues FORWARD correctly — vars, seed, pin, position,
 * seq and revision are all recovered — but back-navigation is refused until the next page
 * advance repopulates history. Refusing is the safe direction: invalidate-forward without
 * history would have to guess what each visit wrote.
 */

import { Redis } from 'ioredis';
import pg from 'pg';
import { createLogger } from '@resscript/observability';
import type { Disposition } from '@resscript/schema';
import { createSession } from '../entry.js';
import type { SessionState } from './types.js';
import type { SessionStore } from './store.js';

const log = createLogger({ service: 'runtime-session' });

/* ------------------------------------------------------------------ *
 * Redis store
 * ------------------------------------------------------------------ */

/** Refused writes surface as a typed error so the handler can replay-or-409 (E §3.4). */
export class RevisionConflict extends Error {
  constructor(readonly session_id: string) {
    super(`session ${session_id}: a newer revision is already stored`);
    this.name = 'RevisionConflict';
  }
}

/**
 * Compare-and-swap save. KEYS[1] = sess:{id}; ARGV = [json, revision, ttl_seconds].
 *
 * Strictly-greater rather than not-equal: the state is written whole, so replaying revision
 * N over stored N would be a byte-identical no-op, but allowing it would also allow an
 * equal-revision write with DIFFERENT bytes — the two-tab case — and the cheapest place to
 * refuse that is here.
 */
const CAS_SAVE = `
local cur = redis.call('GET', KEYS[1])
if cur then
  local stored = cjson.decode(cur)
  if tonumber(stored.revision) >= tonumber(ARGV[2]) then return 0 end
end
redis.call('SET', KEYS[1], ARGV[1], 'EX', tonumber(ARGV[3]))
return 1
`;

export interface DurableStoreOptions {
  readonly redisUrl: string;
  /** Session TTL. E §3.2: max_duration + 1h; the default is 24h + 1h until settings land. */
  readonly ttlSeconds?: number;
}

export function createRedisSessionStore(opts: DurableStoreOptions): SessionStore & {
  saveCas(state: SessionState): Promise<void>;
  close(): Promise<void>;
} {
  // Lazy so that constructing the store (module import, tests) never dials the network —
  // E §16.3's cold-start rule: no work at import time, no awaits at module scope.
  let client: Redis | null = null;
  const redis = () => (client ??= new Redis(opts.redisUrl, { lazyConnect: false }));
  const ttl = opts.ttlSeconds ?? 25 * 60 * 60;

  return {
    async load(sessionId: string): Promise<SessionState | null> {
      const raw = await redis().get(`sess:${sessionId}`);
      return raw === null ? null : (JSON.parse(raw) as SessionState);
    },

    async save(state: SessionState): Promise<void> {
      // The unguarded save, used at entry where the key cannot exist yet. Everything after
      // entry goes through saveCas.
      await redis().set(`sess:${state.session_id}`, JSON.stringify(state), 'EX', ttl);
    },

    async saveCas(state: SessionState): Promise<void> {
      const ok = await redis().eval(
        CAS_SAVE, 1, `sess:${state.session_id}`,
        JSON.stringify(state), String(state.revision), String(ttl),
      );
      if (ok !== 1) throw new RevisionConflict(state.session_id);
    },

    async saveResumeToken(sessionId: string, resumeTokenHash: string, ttlSeconds: number) {
      // The HASH is the key. The raw token exists only in the respondent's URL.
      await redis().set(`sess:tok:${resumeTokenHash}`, sessionId, 'EX', ttlSeconds);
    },

    async resolveResumeToken(resumeTokenHash: string): Promise<string | null> {
      return redis().get(`sess:tok:${resumeTokenHash}`);
    },

    async close(): Promise<void> {
      if (client) await client.quit();
    },
  };
}

/* ------------------------------------------------------------------ *
 * Postgres writer — the 0011 RPCs, nothing else
 * ------------------------------------------------------------------ */

/** What `runtime.load_session` returns; the rebuild's raw material. */
export interface LoadedDocument {
  readonly session_id: string;
  readonly survey_version_id: string;
  readonly artifact_hash: string;
  readonly random_seed: string;
  readonly revision: number;
  readonly status: string;
  readonly disposition: string | null;
  readonly is_test: boolean;
  readonly language: string;
  readonly current_page_id: string | null;
  readonly vars: Record<string, unknown>;
  readonly page_timings: Record<string, unknown>;
  readonly last_event_seq: number;
}

export interface SubmitWrite {
  readonly session_id: string;
  readonly expected_seq: number;
  readonly event_id: string;
  readonly event_type: string;
  readonly page_id: string | null;
  readonly vars: Record<string, unknown>;
  readonly values: Record<string, unknown> | null;
  readonly rejected_values: Record<string, unknown> | null;
  readonly payload: Record<string, unknown>;
  readonly client_trace: Record<string, unknown> | null;
  readonly duration_ms: number | null;
  readonly status: string;
  readonly disposition: string | null;
  readonly current_page_id: string | null;
  readonly page_timings: Record<string, unknown>;
  readonly revision: number;
}

/**
 * One recorded event of a session, as `runtime.replay_session` returns it (migration 0014).
 *
 * `values` is what the server ACCEPTED for that submit, post-filter — the input replay re-drives
 * with. The rejections are deliberately not here: 0014 §0 keeps them on the audit read, because
 * feeding a discarded value back in would replay a state no respondent ever had.
 */
export interface ReplayEvent {
  readonly seq: number;
  readonly event_type: string;
  /** Null when the page id was not an `app.ulid` (a fixture id the typed column cannot hold). */
  readonly page_id: string | null;
  readonly values: Record<string, unknown> | null;
  readonly payload: Record<string, unknown>;
}

/**
 * Everything a replay needs and nothing else (E §12.3): the seed, the pin, and the inputs.
 *
 * The session fields are repeated on every row the RPC returns and collapsed here, because the
 * function is a join — a session with no events cannot exist (0011 writes the row and its
 * `session_start` event in one transaction), so the collapse never has to invent a session.
 */
export interface ReplaySource {
  readonly session_id: string;
  readonly survey_version_id: string;
  /** ADR-006's replay key. Without it a replay would be a re-simulation with fresh randomness. */
  readonly random_seed: string;
  /** E §3.3's pin. The replay URL's hash must equal this or the request is a category error. */
  readonly artifact_hash: string;
  readonly language: string;
  readonly is_test: boolean;
  /** Epoch ms. The replay's fixed clock, so two replays of one session are byte-identical. */
  readonly started_at: number;
  readonly events: readonly ReplayEvent[];
}

export interface RuntimeWriter {
  resolveToken(token: string): Promise<{
    survey_version_id: string; artifact_hash: string; is_test: boolean; status: string;
  } | null>;
  startSession(p: {
    token: string; session_id: string; random_seed: string; language: string;
    is_test: boolean; respondent_key?: string | null; resume_token_hash?: Buffer | null;
    /**
     * The vendor whose entry link created this session, or null for direct traffic.
     *
     * Added in P2-04. `runtime.start_session` has taken a `p_vendor_ref` since 0011 and
     * `runtime.sessions.vendor_ref` has existed since 0011, and this call passed a literal NULL in
     * that slot — so the column was ALWAYS null. The in-memory session carried the vendor and the
     * durable row did not, which means a session rebuilt from Postgres after a Redis loss came back
     * as direct traffic: its redirect would resolve through `default` instead of `by_vendor`, and
     * any per-vendor field report was empty.
     */
    vendor_ref?: string | null;
    entry_payload?: Record<string, unknown>;
  }): Promise<void>;
  loadSession(sessionId: string): Promise<LoadedDocument | null>;
  /** Returns the document's last_event_seq after the call — see 0011's guard semantics. */
  submitPage(w: SubmitWrite): Promise<number>;
  findByResume(resumeTokenHash: Buffer): Promise<string | null>;
  /**
   * E §12.3's replay read (migration 0014). `null` for a session that does not exist — the id,
   * reached through a signed replay token, IS the capability, so "no such session" and "not
   * yours" are one answer. This is the ONLY read on this interface that returns respondent
   * ANSWERS, which is why its caller redacts pii before anything leaves the process (security
   * §8.1) and why the RPC is granted to `runtime_writer` alone.
   */
  replaySession(sessionId: string): Promise<ReplaySource | null>;
  close(): Promise<void>;
}

/** Raised when start_session hits the respondent_key unique index — the dedup conflict. */
export class DuplicateRespondent extends Error {
  constructor(readonly respondent_key: string) {
    super(`respondent_key already entered this version: ${respondent_key}`);
    this.name = 'DuplicateRespondent';
  }
}

export function createPgWriter(databaseUrl: string): RuntimeWriter {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 8,
    // The runtime's writes are single short transactions (each RPC is one), so a small pool
    // suffices and transaction-mode pooling upstream stays viable (E §16.4).
    statement_timeout: 5_000,
    // EVERY backend starts as runtime_writer, before its first query. This is ADR-001
    // enforced in the process, not only in CI: a bug that tries to SELECT content.nodes gets
    // 42501 from the database, whatever the connection string's login role could have done.
    //
    // Startup `options` rather than a `pool.on('connect')` SET ROLE, because the connect
    // hook does not await — its query would RACE the caller's first statement, and losing
    // that race once means one statement runs with the login role's full privileges. `role`
    // is a GUC, so the backend applies it before accepting any query at all.
    options: '-c role=runtime_writer',
  });

  return {
    async resolveToken(token) {
      const r = await pool.query(
        'SELECT survey_version_id, artifact_hash, is_test, status FROM runtime.resolve_token($1)',
        [token],
      );
      const row = r.rows[0];
      if (!row) return null;
      return {
        survey_version_id: row.survey_version_id,
        artifact_hash: row.artifact_hash,
        is_test: row.is_test,
        status: row.status,
      };
    },

    async startSession(p) {
      try {
        await pool.query(
          // The 7th positional is `p_vendor_ref`. It was a literal NULL here until P2-04 — see the
          // interface comment; the three NULLs that remain are device / ua_class / country, which
          // the entry path does not yet capture.
          'SELECT runtime.start_session($1, $2, $3, $4, $5, $6, $7, NULL, NULL, NULL, $8, $9)',
          [p.token, p.session_id, p.random_seed, p.language, p.is_test,
           p.respondent_key ?? null, p.vendor_ref ?? null, p.resume_token_hash ?? null,
           JSON.stringify(p.entry_payload ?? {})],
        );
      } catch (err) {
        if ((err as { code?: string }).code === '23505' && p.respondent_key) {
          // The unique index IS the dedup check (01 §3.3 step 4) — checking first would race.
          throw new DuplicateRespondent(p.respondent_key);
        }
        throw err;
      }
    },

    async loadSession(sessionId) {
      const r = await pool.query('SELECT runtime.load_session($1) AS doc', [sessionId]);
      return (r.rows[0]?.doc ?? null) as LoadedDocument | null;
    },

    async submitPage(w) {
      const r = await pool.query(
        'SELECT runtime.submit_page($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) AS seq',
        [w.session_id, w.expected_seq, w.event_id, w.event_type, w.page_id,
         JSON.stringify(w.vars),
         w.values === null ? null : JSON.stringify(w.values),
         w.rejected_values === null ? null : JSON.stringify(w.rejected_values),
         JSON.stringify(w.payload),
         w.client_trace === null ? null : JSON.stringify(w.client_trace),
         w.duration_ms, w.status, w.disposition, w.current_page_id,
         JSON.stringify(w.page_timings), w.revision],
      );
      return r.rows[0].seq as number;
    },

    async findByResume(resumeTokenHash) {
      const r = await pool.query('SELECT runtime.find_session_by_resume($1) AS sid',
        [resumeTokenHash]);
      return (r.rows[0]?.sid ?? null) as string | null;
    },

    async replaySession(sessionId) {
      // The columns are named, not `SELECT *`: the RPC's shape is a contract, and a widened
      // function must not start feeding a column nobody here decided to serve.
      const r = await pool.query(
        'SELECT session_id, survey_version_id, random_seed, artifact_hash, language, is_test, ' +
          'started_at, seq, event_type, page_id, "values", payload ' +
          'FROM runtime.replay_session($1)',
        [sessionId],
      );
      const first = r.rows[0];
      if (!first) return null;
      return {
        session_id: first.session_id,
        survey_version_id: first.survey_version_id,
        random_seed: first.random_seed,
        artifact_hash: first.artifact_hash,
        language: first.language,
        is_test: first.is_test,
        // `timestamptz` arrives as a Date; the replay clock is a number everywhere else.
        started_at: new Date(first.started_at).getTime(),
        // Already ordered by seq inside the function — 0014 orders there rather than here so
        // every caller of the RPC gets the ordering, not only this one.
        events: r.rows.map(row => ({
          seq: row.seq as number,
          event_type: row.event_type as string,
          page_id: (row.page_id ?? null) as string | null,
          values: (row.values ?? null) as Record<string, unknown> | null,
          payload: (row.payload ?? {}) as Record<string, unknown>,
        })),
      };
    },

    async close() {
      await pool.end();
    },
  };
}

/* ------------------------------------------------------------------ *
 * The rebuild
 * ------------------------------------------------------------------ */

/**
 * Reconstruct a workable `SessionState` from the Postgres record after a Redis loss.
 *
 * Everything needed to continue FORWARD is recovered: vars, seed, pin, position, seq,
 * revision, timings, outcome. `history` and `var_provenance` are not (see the module header)
 * — the visits live in the event log and their replay is deferred — so `history` restarts
 * empty and back-navigation refuses until it repopulates. The machine's own rule that entry
 * ignores the stored cursor does not apply here: this is not entry, and `current_page_id`
 * plus `machine_state` are restored so the respondent lands exactly where they were.
 */
export function rebuildSession(doc: LoadedDocument): SessionState {
  const base = createSession({
    session_id: doc.session_id,
    // The respondent id lived only in Redis. The export join key for the DOCUMENT is the
    // session id, so analysis is unaffected; "started twice" analytics degrade for rebuilt
    // sessions until the event replay lands. Derived from the session id so it is stable
    // across repeated rebuilds rather than freshly random each time.
    respondent_id: `rsp_${doc.session_id.slice(4)}`,
    survey_id: '',
    artifact_hash: doc.artifact_hash,
    random_seed: doc.random_seed,
    language: doc.language,
  });

  const finalized = doc.status === 'completed' || doc.status === 'terminated';

  return {
    ...base,
    survey_version_id: doc.survey_version_id,
    is_test: doc.is_test,
    vars: doc.vars as SessionState['vars'],
    machine_state:
      finalized && doc.disposition
        ? { state: 'FINALIZED', disposition: doc.disposition as Disposition }
        : doc.current_page_id
          ? { state: 'PAGE_LOOP', current_page_id: doc.current_page_id as never }
          : { state: 'CREATED' },
    current_page_id: (doc.current_page_id ?? null) as SessionState['current_page_id'],
    disposition: (doc.disposition ?? null) as SessionState['disposition'],
    page_timings: doc.page_timings as SessionState['page_timings'],
    revision: doc.revision,
    last_event_seq: doc.last_event_seq,
  };
}
