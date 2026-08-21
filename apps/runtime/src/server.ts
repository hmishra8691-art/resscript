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
import { createMemorySessionStore } from './session/store.js';
import { createPgWriter, createRedisSessionStore } from './session/durable.js';
import { createQuotaClient } from './quota/index.js';
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
function resolveTokens(writer: ReturnType<typeof resolveWriter>) {
  const raw = process.env['RUNTIME_STATIC_TOKENS'];
  if (!raw) {
    if (!writer) {
      throw new Error(
        'No token source: set RUNTIME_DATABASE_URL (production) or RUNTIME_STATIC_TOKENS (dev).',
      );
    }
    return createPgTokenResolver(writer);
  }

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
  const redisUrl = process.env['REDIS_URL'];
  if (redisUrl) return createRedisSessionStore({ redisUrl });
  if (process.env['NODE_ENV'] === 'production') {
    // A production runtime without Redis would silently hold every session in one process's
    // memory — lost on deploy, invisible until the first respondent mid-interview vanishes.
    throw new Error('REDIS_URL is required in production');
  }
  log.warn('memory_session_store_enabled', { reason: 'REDIS_URL unset' });
  return createMemorySessionStore();
}

function resolveWriter() {
  const url = process.env['RUNTIME_DATABASE_URL'] ?? process.env['DATABASE_URL'];
  if (url) return createPgWriter(url);
  if (process.env['NODE_ENV'] === 'production') {
    throw new Error('RUNTIME_DATABASE_URL is required in production — responses must be durable');
  }
  log.warn('no_postgres_writer', { reason: 'RUNTIME_DATABASE_URL unset; responses not durable' });
  return undefined;
}

export function buildDeps(): RuntimeDeps {
  const writer = resolveWriter();
  const redisUrl = process.env['REDIS_URL'];
  return {
    tokens: resolveTokens(writer),
    artifacts: createArtifactLoader(),
    sessions: resolveSessions(),
    ...(writer ? { writer } : {}),
    // The quota arbiter shares the session Redis. ADR-008 allows a dedicated instance later;
    // splitting is a URL, not a refactor.
    ...(redisUrl ? { quota: createQuotaClient(redisUrl) } : {}),
    now: () => Date.now(),
    newId: generateULID,
    newSeed: generateSeed,
    domain: RUNTIME_DOMAIN,
    // Security §12.3's org redirect-host inventory, environment-shaped until the control-plane
    // feature exists. Empty means "structural URL checks only", which respondFinal documents.
    redirectHosts: (process.env['REDIRECT_HOST_ALLOWLIST'] ?? '')
      .split(',')
      .map(h => h.trim())
      .filter(h => h.length > 0),
    // Vendor HMAC secrets (E §11.2). A JSON object of `vendor_ref → secret`, read once at
    // boot. The control-plane secret store replaces this in P2-04; an env var is honest about
    // what exists today and keeps secrets out of artifacts either way.
    vendorSecret: makeVendorSecretLookup(process.env['RUNTIME_VENDOR_SECRETS']),
  };
}

function makeVendorSecretLookup(raw: string | undefined): (ref: string) => string | null {
  let table: Record<string, string> = {};
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const [k, v] of Object.entries(parsed)) {
          if (typeof v === 'string') table[k] = v;
        }
      }
    } catch {
      // A malformed table must not take the runtime down at boot; it degrades to "no HMAC",
      // which respondFinal logs per finalization — visible, recoverable, not fatal.
      table = {};
    }
  }
  return (ref: string) => table[ref] ?? null;
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
