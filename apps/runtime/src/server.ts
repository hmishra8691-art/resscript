/**
 * apps/runtime — the data plane (ADR-001).
 *
 * Deliberately a bare node:http server with no framework. This process sits on the
 * critical path for every respondent page view, so its dependency tree is kept as close
 * to empty as possible. It must never link a Supabase client: the dependency-cruiser rule
 * `runtime-no-supabase` fails CI if one appears.
 *
 * P1-09 scope: artifact loader, session store, state machine, entry (/s/:token) and
 * submit (/s/:token/submit) endpoints, PRNG, randomization, masking, piping.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createLogger, requestIdFrom } from '@resscript/observability';

const log = createLogger({ service: 'runtime' });
const PORT = Number(process.env['PORT'] ?? 8081);

/** Domain for public survey endpoints. Default: run.local for dev. */
const RUNTIME_DOMAIN = process.env['RUNTIME_DOMAIN'] ?? 'run.local';

/** Parse survey token from hostname and validate origin per ADR-005.
 *  Host must match exactly: <token>.run.local (or configured domain).
 *  A mismatched survey token receives 404, not a redirect. */
function validateOriginAndParseToken(
  req: IncomingMessage,
): { token: string } | null {
  const host = req.headers.host;
  if (!host) {
    return null;
  }

  const parts = host.split(':')[0]?.split('.') ?? [];

  // Expect: token.run.local or token.domain
  const domainParts = RUNTIME_DOMAIN.split('.');
  if (parts.length !== domainParts.length + 1) {
    return null;
  }

  const token = parts[0];
  if (!token) {
    return null;
  }

  const hostDomain = parts.slice(1).join('.');

  if (hostDomain !== RUNTIME_DOMAIN) {
    return null;
  }

  // Token format: 26 lowercase alphanumeric (base36, from SURVEY_TOKEN_PATTERN in schema)
  if (!/^[0-9a-z]{26}$/.test(token)) {
    return null;
  }

  return { token };
}

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

  // Health checks are available on any origin
  if (url.pathname === '/health') {
    json(res, 200, { status: 'ok', service: 'runtime', request_id: requestId });
    return;
  }

  if (url.pathname === '/ready') {
    const { ready, checks } = await readiness();
    json(res, ready ? 200 : 503, { ready, checks, request_id: requestId });
    return;
  }

  // All other routes require valid survey token origin (ADR-005)
  const origin = validateOriginAndParseToken(req);
  if (!origin) {
    json(res, 404, { error: { code: 'not_found' }, request_id: requestId });
    return;
  }

  const { token } = origin;

  // Survey entry: GET /s/{token}
  // Resolves token → artifact hash → create session with seed → render first page
  if (req.method === 'GET' && url.pathname === '/s/' + token) {
    json(res, 501, {
      error: { code: 'not_implemented', message: 'P1-09: GET /s/:token' },
      request_id: requestId,
    });
    return;
  }

  // Page render: GET /s/{token}/p/{page_id}
  // Also the back-navigation target (re-render with values prefilled)
  const pageMatch = url.pathname.match(/^\/s\/\w+\/p\/(.+)$/);
  if (req.method === 'GET' && pageMatch) {
    const pageId = pageMatch[1];
    json(res, 501, {
      error: {
        code: 'not_implemented',
        message: `P1-09: GET /s/:token/p/${pageId}`,
      },
      request_id: requestId,
    });
    return;
  }

  // Page submit: POST /s/{token}/submit
  // Validates, advances state machine, persists event, returns next page or disposition
  if (req.method === 'POST' && url.pathname === '/s/' + token + '/submit') {
    json(res, 501, {
      error: { code: 'not_implemented', message: 'P1-09: POST /s/:token/submit' },
      request_id: requestId,
    });
    return;
  }

  // Client telemetry: POST /s/{token}/event
  // Timings, focus loss, trace digest
  if (req.method === 'POST' && url.pathname === '/s/' + token + '/event') {
    json(res, 501, {
      error: { code: 'not_implemented', message: 'P1-09: POST /s/:token/event' },
      request_id: requestId,
    });
    return;
  }

  // Resume: GET /s/{token}/resume/{resume_token}
  // Revive abandoned sessions
  const resumeMatch = url.pathname.match(/^\/s\/\w+\/resume\/(.+)$/);
  if (req.method === 'GET' && resumeMatch) {
    const resumeToken = resumeMatch[1];
    json(res, 501, {
      error: {
        code: 'not_implemented',
        message: `P1-09: GET /s/:token/resume/${resumeToken}`,
      },
      request_id: requestId,
    });
    return;
  }

  // Preview: POST /preview/{artifact_hash}/*
  // Test mode under studio control
  if (req.method === 'POST' && url.pathname.startsWith('/preview/')) {
    json(res, 501, {
      error: { code: 'not_implemented', message: 'P1-09: POST /preview/:artifact_hash' },
      request_id: requestId,
    });
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
