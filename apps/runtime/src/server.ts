/**
 * apps/runtime — the data plane (ADR-001).
 *
 * Deliberately a bare `node:http` server with no framework. This process sits on the critical
 * path for every respondent page view, so its dependency tree is kept as close to empty as
 * possible: the runtime's dependency count is the single largest lever on cold-start latency for
 * edge deployment (E §16.3), and every dependency is a supply-chain surface on the path of every
 * respondent in every study.
 *
 * It must never link a Supabase client — the `runtime-no-supabase` dependency-cruiser rule fails
 * CI if one appears, because reading an authoring table from here would breach the plane boundary.
 *
 * This file is composition only. The routing and the `Cmd` interpreter live in `handler.ts`,
 * which takes its dependencies by injection so the endpoints can be tested without a socket.
 */

import { createServer } from 'node:http';
import { createLogger } from '@resscript/observability';
import { createArtifactLoader } from './artifact/loader.js';
import { generateSeed, generateULID } from './entry.js';
import { createHandler, type RuntimeDeps } from './handler.js';
import { createMemorySessionStore, createSessionStore } from './session/store.js';
import { createPgTokenResolver, createStaticTokenResolver, type ResolvedToken } from './token.js';

const log = createLogger({ service: 'runtime' });

const PORT = Number(process.env['PORT'] ?? 8081);

/** The domain survey origins live under: a survey is served from `<token>.<domain>` (ADR-005). */
const RUNTIME_DOMAIN = process.env['RUNTIME_DOMAIN'] ?? 'run.local';

/**
 * Local-development token table, as JSON.
 *
 * Exists because `runtime.survey_tokens` needs a Postgres connection that arrives with P1-10,
 * and a runtime that cannot resolve any token is untestable by hand. Refused outside development
 * so it cannot become a production back door that mints survey access from an env var.
 */
function resolveTokens() {
  const raw = process.env['RUNTIME_STATIC_TOKENS'];
  if (!raw) return createPgTokenResolver();

  if (process.env['NODE_ENV'] === 'production') {
    throw new Error('RUNTIME_STATIC_TOKENS is not permitted in production');
  }

  let rows: ResolvedToken[];
  try {
    rows = JSON.parse(raw) as ResolvedToken[];
  } catch (err) {
    throw new Error(`RUNTIME_STATIC_TOKENS is not valid JSON: ${String(err)}`);
  }
  log.warn('static_token_resolver_enabled', { count: rows.length });
  return createStaticTokenResolver(rows);
}

function resolveSessions() {
  // The Redis-backed store throws on use until P1-10. In development, fall back to the in-process
  // one so the entry path is exercisable; in production, fail loudly at startup rather than
  // serving respondents into a store that will throw on the first save.
  if (process.env['REDIS_URL']) return createSessionStore();
  if (process.env['NODE_ENV'] === 'production') return createSessionStore();
  log.warn('memory_session_store_enabled', { reason: 'REDIS_URL unset' });
  return createMemorySessionStore();
}

export function buildDeps(): RuntimeDeps {
  return {
    tokens: resolveTokens(),
    artifacts: createArtifactLoader(),
    sessions: resolveSessions(),
    now: () => Date.now(),
    newId: generateULID,
    newSeed: generateSeed,
    domain: RUNTIME_DOMAIN,
  };
}

/**
 * The default handler, for `import { handler }` in a serverless adapter.
 *
 * Built lazily so that importing this module — which the test suite does — does not construct a
 * Postgres resolver or read the environment.
 */
let defaultHandler: ReturnType<typeof createHandler> | null = null;

export const handler: ReturnType<typeof createHandler> = async (req, res) => {
  defaultHandler ??= createHandler(buildDeps());
  return defaultHandler(req, res);
};

if (process.env['NODE_ENV'] !== 'test') {
  const h = createHandler(buildDeps());
  createServer((req, res) => {
    void h(req, res).catch((err: unknown) => {
      log.error('unhandled_request_error', { err: String(err) });
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: { code: 'internal' } }));
      }
    });
  }).listen(PORT, () => log.info('runtime_listening', { port: PORT, domain: RUNTIME_DOMAIN }));
}
