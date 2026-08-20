/**
 * apps/runtime — the data plane (ADR-001).
 *
 * Deliberately a bare node:http server with no framework. This process sits on the
 * critical path for every respondent page view, so its dependency tree is kept as close
 * to empty as possible. It must never link a Supabase client: the dependency-cruiser rule
 * `runtime-no-supabase` fails CI if one appears.
 *
 * M0.1 scope: /health and /ready only. The state machine, artifact loader and submit path
 * arrive in P1-09 and P1-10.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createLogger, requestIdFrom } from '@resscript/observability';

const log = createLogger({ service: 'runtime' });
const PORT = Number(process.env['PORT'] ?? 8081);

/** Readiness is distinct from liveness: a runtime with no reachable artifact store is
 *  alive but must not receive respondent traffic. Wired properly in P1-09. */
async function readiness(): Promise<{ ready: boolean; checks: Record<string, string> }> {
  const checks: Record<string, string> = {
    artifact_store: 'not_configured',
    session_store: 'not_configured',
  };
  return { ready: true, checks };
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    // ADR-005: the runtime origin is cookieless. Asserted by test in P1-11.
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
  });
  res.end(payload);
}

export const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
  const requestId = requestIdFrom(req.headers);
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  if (url.pathname === '/health') {
    json(res, 200, { status: 'ok', service: 'runtime', request_id: requestId });
    return;
  }

  if (url.pathname === '/ready') {
    const { ready, checks } = await readiness();
    json(res, ready ? 200 : 503, { ready, checks, request_id: requestId });
    return;
  }

  json(res, 404, { error: { code: 'not_found' }, request_id: requestId });
};

if (process.env['NODE_ENV'] !== 'test') {
  createServer((req, res) => {
    void handler(req, res).catch((err: unknown) => {
      log.error('unhandled_request_error', { err: String(err) });
      if (!res.headersSent) json(res, 500, { error: { code: 'internal' } });
    });
  }).listen(PORT, () => log.info('runtime_listening', { port: PORT }));
}
