/**
 * The allowlisted egress proxy — security §5.3, roadmap P2-11.
 *
 * `survey.http` inside the QuickJS sandbox routes here and nowhere else. The host denies every call
 * when this is absent (`host.ts`: "the named failure from E §13.3"), so this module is the whole
 * difference between a customer script that cannot reach the network and one that can reach a
 * per-org allowlist — and NOT, under any construction, the cloud metadata endpoint.
 *
 * ## Why an allowlist of hosts and a blocklist of addresses, both
 *
 * They stop different attacks and neither alone is sufficient.
 *
 * The **host allowlist** is the org's own policy: this survey may talk to `api.acme.example` and
 * nothing else. It is the control an operator understands and audits.
 *
 * The **address blocklist** is what survives DNS. An allowlisted hostname can resolve to
 * `169.254.169.254`, and then a perfectly legitimate-looking policy reads the cloud instance's IAM
 * credentials. So the resolved addresses are checked too, against RFC1918, link-local, loopback,
 * CGNAT, IPv6 ULA/link-local, and the metadata addresses by name. An allowlist alone would be
 * bypassed by whoever controls a DNS record; a blocklist alone would let a script reach the whole
 * public internet.
 *
 * ## Resolve, check, then connect to the ADDRESS
 *
 * The order matters and the last part is the part implementations get wrong. Checking the hostname,
 * then handing the hostname to `fetch`, leaves a DNS-rebinding window: the name resolves to a
 * public address for the check and to `10.0.0.1` for the connection a millisecond later. So this
 * resolves once, validates every returned address, and then connects to a **pinned address** with
 * the original `Host` header — which is what makes the check and the connection the same decision.
 *
 * The address rules themselves live in `@resscript/egress`, shared with the webhook deliverer.
 *
 * ## What is deliberately refused rather than supported
 *
 * Redirects are not followed. A 30x is returned to the script as-is, because following one means
 * re-running every check above on a URL the script never named, and an allowlisted host that
 * redirects to the metadata endpoint is the cleanest possible bypass. `http:` is refused outright
 * — an org allowlist is not a reason to send a survey's data in clear text. Non-standard ports are
 * refused: an allowlist entry names a host, and a host that also opens 6379 is a Redis nobody
 * meant to expose.
 */

import { lookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { createLogger } from '@resscript/observability';
// The SHARED predicate. apps/worker's webhook delivery imports the same one, because a webhook URL
// and a survey.http URL are the same SSRF sink and two blocklists is strictly worse than one — see
// that package's header.
import { isBlockedAddress } from '@resscript/egress';

const log = createLogger({ service: 'runtime-egress' });

export interface EgressPolicy {
  /**
   * Hostnames this org's scripts may reach, exact match, lowercased. No wildcards: `*.acme.example`
   * would admit `metadata.acme.example` pointed anywhere its owner likes, and an allowlist whose
   * entries an attacker can extend is not one.
   */
  readonly hosts: readonly string[];
  readonly timeoutMs?: number;
  /** Response bytes to read before aborting. A script cannot be allowed to pull a 2 GB body. */
  readonly maxBodyBytes?: number;
  /**
   * DNS, injectable. Not a convenience: the address checks below are the security boundary, and a
   * test whose outcome depends on what a public resolver says today is a test that will one day
   * pass for the wrong reason. Production leaves it absent and gets `node:dns`.
   */
  readonly resolve?: (host: string) => Promise<{ address: string; family: number }[]>;
}

export interface EgressRequest {
  readonly method: string;
  readonly url: string;
  readonly headers?: Record<string, string>;
  readonly body?: string;
}

export interface EgressResponse {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: string;
}

export type EgressDenial =
  | 'scheme'
  | 'host_not_allowlisted'
  | 'port'
  | 'dns'
  | 'blocked_address'
  | 'method'
  | 'header';

export class EgressDenied extends Error {
  constructor(readonly reason: EgressDenial, detail: string) {
    super(`http_denied: ${reason} — ${detail}`);
    this.name = 'EgressDenied';
  }
}

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_BODY = 256 * 1024;

/** Methods a survey script may use. No TRACE, no CONNECT, nothing that probes infrastructure. */
const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']);

/**
 * Headers a script may NOT set.
 *
 * `Host` because it is what pins the request to the address checked above; the hop-by-hop and
 * forwarding headers because a script that could set `X-Forwarded-For` is a script that can lie to
 * whatever is behind the allowlisted host about who called it.
 */
const FORBIDDEN_HEADERS = new Set([
  'host',
  'content-length',
  'connection',
  'transfer-encoding',
  'upgrade',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-real-ip',
  'forwarded',
]);


/**
 * Build the performer `createScriptHost` takes as `input.http`.
 *
 * Synchronous in the host's contract (the sandbox bridge is synchronous), so the actual request is
 * performed by the caller ahead of time in the async variant below. This factory returns the async
 * one; `apps/runtime`'s script-running path awaits it and hands the host a closure over the result.
 * That indirection exists because QuickJS cannot await, and pretending otherwise is how a sandbox
 * acquires a hidden event loop.
 */
export function createEgressProxy(policy: EgressPolicy) {
  const allow = new Set(policy.hosts.map(host => host.toLowerCase()));
  const timeoutMs = policy.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBody = policy.maxBodyBytes ?? DEFAULT_MAX_BODY;

  return {
    /** Validate without connecting. Exported behaviour, because the deny path must be testable. */
    async check(req: EgressRequest): Promise<{ host: string; address: string; family: number }> {
      const method = req.method.toUpperCase();
      if (!ALLOWED_METHODS.has(method)) {
        throw new EgressDenied('method', `${method} is not permitted`);
      }
      for (const name of Object.keys(req.headers ?? {})) {
        if (FORBIDDEN_HEADERS.has(name.toLowerCase())) {
          throw new EgressDenied('header', `a script may not set ${name}`);
        }
      }

      let url: URL;
      try {
        url = new URL(req.url);
      } catch {
        throw new EgressDenied('scheme', `not a URL: ${req.url}`);
      }
      // https only. An org allowlist is not a reason to send a survey's data in clear text, and
      // `file:`/`gopher:`/`dict:` are the classic SSRF schemes.
      if (url.protocol !== 'https:') {
        throw new EgressDenied('scheme', `${url.protocol} is refused; only https is permitted`);
      }
      if (url.port !== '' && url.port !== '443') {
        throw new EgressDenied('port', `port ${url.port} is refused; an allowlist names a host`);
      }
      const host = url.hostname.toLowerCase();
      if (!allow.has(host)) {
        throw new EgressDenied('host_not_allowlisted', `${host} is not in this org's allowlist`);
      }

      let resolved: { address: string; family: number }[];
      try {
        resolved = policy.resolve
          ? await policy.resolve(host)
          : await lookup(host, { all: true });
      } catch (err: unknown) {
        throw new EgressDenied('dns', `${host} did not resolve: ${String(err)}`);
      }
      if (resolved.length === 0) throw new EgressDenied('dns', `${host} resolved to nothing`);

      // EVERY returned address, not the first. A hostname that resolves to one public and one
      // private address would otherwise be a coin flip, and the whole point is that it never is.
      for (const entry of resolved) {
        if (isBlockedAddress(entry.address, entry.family)) {
          log.error('egress_blocked_address', { host, address: entry.address });
          throw new EgressDenied(
            'blocked_address',
            `${host} resolves to ${entry.address}, which is a private, link-local or metadata address`,
          );
        }
      }
      const first = resolved[0] as { address: string; family: number };
      return { host, address: first.address, family: first.family };
    },

    async perform(req: EgressRequest): Promise<EgressResponse> {
      const { host, address } = await this.check(req);
      const url = new URL(req.url);

      return await new Promise<EgressResponse>((resolve, reject) => {
        const clientReq = httpsRequest(
          {
            // The PINNED address, with the original Host header. Handing the hostname to the
            // connection instead would re-resolve it and reopen the rebinding window the check
            // just closed.
            host: address,
            servername: host,
            port: 443,
            method: req.method.toUpperCase(),
            path: `${url.pathname}${url.search}`,
            headers: { ...(req.headers ?? {}), host },
            timeout: timeoutMs,
          },
          response => {
            const chunks: Buffer[] = [];
            let size = 0;
            response.on('data', (chunk: Buffer) => {
              size += chunk.length;
              if (size > maxBody) {
                // Destroyed rather than truncated: a script that could pull an unbounded body is a
                // memory exhaustion vector against the runtime, not just a slow script.
                response.destroy();
                reject(new EgressDenied('header', `response exceeded ${String(maxBody)} bytes`));
                return;
              }
              chunks.push(chunk);
            });
            response.on('end', () => {
              const headers: Record<string, string> = {};
              for (const [k, v] of Object.entries(response.headers)) {
                headers[k] = Array.isArray(v) ? v.join(', ') : String(v ?? '');
              }
              resolve({
                status: response.statusCode ?? 0,
                headers,
                // Redirects are NOT followed — see the module header. The 30x reaches the script.
                body: Buffer.concat(chunks).toString('utf8'),
              });
            });
          },
        );
        clientReq.on('timeout', () => {
          clientReq.destroy();
          reject(new EgressDenied('dns', `${host} timed out after ${String(timeoutMs)}ms`));
        });
        clientReq.on('error', err => reject(err));
        if (req.body !== undefined) clientReq.write(req.body);
        clientReq.end();
      });
    },
  };
}

// Re-exported so this module remains the single import site for a caller doing egress, and so the
// address rules can be tested from here as well as from the package.
export { isBlockedAddress };
