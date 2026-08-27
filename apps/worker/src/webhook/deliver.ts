/**
 * The `webhook` job: sign one pending delivery and POST it (roadmap P2-10).
 *
 * ## What this job is NOT allowed to be
 *
 * A webhook delivery is an outbound HTTP request to a URL a customer typed, made from inside our
 * network, with our network position. That is the definition of an SSRF sink, and it is the SAME
 * sink `survey.http` is — so this file does not grow its own set of address rules. It imports
 * `isBlockedAddress` from `@resscript/egress`, the same module apps/runtime's proxy uses; that
 * package's header explains why sharing is not merely tidier.
 *
 * ## Signing
 *
 * `X-ResScript-Signature: t=<unix>,v1=<hex hmac>` over `"<t>.<body>"`, the construction Stripe
 * popularised. The reason to copy it rather than sign the body alone: a signature over the body is
 * replayable forever. Anyone who captures one valid request can resend it at any time and it
 * verifies, which for a `session.completed` webhook means a receiver's completion count can be
 * inflated by anybody who ever saw one request. Binding the timestamp INTO the signed string lets a
 * receiver reject anything stale, and the timestamp cannot be edited without breaking the MAC.
 *
 * `t` is seconds and the body is sent byte-for-byte as signed — the two together are the whole
 * contract, and a receiver that re-serializes the JSON before verifying will fail, correctly.
 *
 * ## Retry
 *
 * Exponential backoff with full jitter, capped, through `app.webhook_requeue(id, delay)` — the same
 * `next_attempt_at` field the claim lease uses, so a retry and a lease cannot disagree about when a
 * delivery may next be tried. Jitter is not decoration: without it, a receiver that goes down while
 * 5,000 deliveries are outstanding gets all 5,000 retries in the same second, repeatedly, which is
 * a self-inflicted thundering herd against an endpoint that is already unwell.
 *
 * What is retried and what is not:
 *
 *  * **5xx, 429, timeout, transport error** — retried. The receiver may recover.
 *  * **2xx** — delivered.
 *  * **4xx other than 429** — FAILED, not retried. A 400 or a 404 will be a 400 or a 404 in eight
 *    hours too, and retrying it eight times only fills the receiver's logs and ours.
 *  * **A blocked address, a refused scheme** — `blocked`, never retried. This is our refusal rather
 *    than their failure, and the two are separate statuses precisely so an SSRF attempt does not
 *    read as a flaky endpoint in a dashboard.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';

import { isBlockedAddress } from '@resscript/egress';

export const SIGNATURE_HEADER = 'x-resscript-signature';
export const SIGNATURE_VERSION = 'v1';

/**
 * How many attempts before a delivery is given up on. Eight attempts under the backoff below spans
 * a few hours, which is the useful shape: it survives a receiver's overnight deploy without
 * pretending a permanently dead endpoint will come back next week.
 */
export const MAX_ATTEMPTS = 8;

/** Response bytes kept. The column bound is 4096; reading more only to discard it is waste. */
const MAX_RESPONSE_BYTES = 4096;
const DEFAULT_TIMEOUT_MS = 10_000;

export type DeliveryOutcome =
  | { readonly status: 'delivered'; readonly responseStatus: number; readonly body: string }
  | {
      readonly status: 'failed';
      readonly responseStatus: number;
      readonly body: string;
      readonly error: string;
      /** Present when the caller should requeue rather than give up. */
      readonly retryInSeconds?: number;
    }
  | { readonly status: 'blocked'; readonly error: string };

export interface DeliveryRequest {
  readonly deliveryId: string;
  readonly url: string;
  readonly secret: string;
  readonly event: string;
  readonly eventKey: string;
  readonly payload: unknown;
  readonly attempts: number;
}

/* -------------------------------------------------------------------------- */
/* Signing                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The signed string, exported so a receiver's verification and this code cannot drift.
 *
 * `${t}.${body}` and not a JSON object: the delimiter has to be one whose position a body cannot
 * shift. A period after a decimal integer is unambiguous — the receiver splits on the FIRST period
 * and everything after it is the body, however many periods that body contains.
 */
export function signedString(timestamp: number, body: string): string {
  return `${String(timestamp)}.${body}`;
}

export function signBody(secret: string, timestamp: number, body: string): string {
  return createHmac('sha256', secret).update(signedString(timestamp, body)).digest('hex');
}

export function signatureHeader(secret: string, timestamp: number, body: string): string {
  return `t=${String(timestamp)},${SIGNATURE_VERSION}=${signBody(secret, timestamp, body)}`;
}

/**
 * Verify a header the way a receiver should. Not used by the sender — exported because it is the
 * executable form of the documentation, and a signing scheme whose verifier exists only as prose in
 * an integration guide is one nobody can check against.
 *
 * `timingSafeEqual` rather than `===`: string comparison short-circuits on the first differing
 * byte, which leaks how much of a guessed signature was right. That is a real attack against a
 * verifier an attacker can call repeatedly, which is exactly what a webhook endpoint is.
 */
export function verifySignature(
  header: string,
  secret: string,
  body: string,
  nowSeconds: number,
  toleranceSeconds = 300,
): { ok: true } | { ok: false; reason: 'malformed' | 'stale' | 'mismatch' } {
  const parts = new Map<string, string>();
  for (const piece of header.split(',')) {
    const eq = piece.indexOf('=');
    if (eq > 0) parts.set(piece.slice(0, eq).trim(), piece.slice(eq + 1).trim());
  }
  const t = parts.get('t');
  const v = parts.get(SIGNATURE_VERSION);
  if (t === undefined || v === undefined || t === '' || v === '') {
    return { ok: false, reason: 'malformed' };
  }

  const ts = Number(t);
  // Checked BEFORE the coercion is used. Number('') is 0, so a blank timestamp would read as epoch
  // 1970 and the staleness check below would reject it for the wrong reason — or, with a wide
  // tolerance, accept it. The same mistake was in vendor/verify.ts' first version.
  if (!Number.isFinite(ts)) return { ok: false, reason: 'malformed' };
  if (Math.abs(nowSeconds - ts) > toleranceSeconds) return { ok: false, reason: 'stale' };

  const expected = Buffer.from(signBody(secret, ts, body), 'utf8');
  const actual = Buffer.from(v, 'utf8');
  // Length compared first because timingSafeEqual throws on a length mismatch. Length is not a
  // secret — a hex sha256 is always 64 characters — so this leaks nothing.
  if (expected.length !== actual.length) return { ok: false, reason: 'mismatch' };
  return timingSafeEqual(expected, actual) ? { ok: true } : { ok: false, reason: 'mismatch' };
}

/* -------------------------------------------------------------------------- */
/* Backoff                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Seconds to wait before the next attempt, given `attempts` made so far.
 *
 * `random` is injected rather than read from `Math.random` so the schedule is testable — the whole
 * point of jitter is that it is unpredictable, which makes an un-injected version testable only by
 * statistics.
 */
export function backoffSeconds(attempts: number, random: () => number = Math.random): number {
  // 30s, 60s, 120s ... capped at an hour. FULL jitter (uniform over [0, window]) rather than equal
  // jitter: full jitter is what actually spreads a synchronized herd, and the cost — an occasional
  // very short wait — is harmless when MAX_ATTEMPTS is what bounds total effort.
  const window = Math.min(30 * 2 ** Math.max(0, attempts - 1), 3600);
  return Math.max(5, Math.round(random() * window));
}

/** Is this outcome worth another attempt? See the header for why a 4xx is not. */
export function isRetryable(responseStatus: number): boolean {
  if (responseStatus === 429) return true;
  if (responseStatus === 0) return true; // no status at all: transport error or timeout
  return responseStatus >= 500;
}

/* -------------------------------------------------------------------------- */
/* Delivery                                                                   */
/* -------------------------------------------------------------------------- */

export interface DeliverOptions {
  readonly timeoutMs?: number;
  readonly now?: () => number;
  readonly random?: () => number;
  /** Injected for tests; production uses node:dns. The same seam egress.ts uses, for the same reason. */
  readonly resolve?: (host: string) => Promise<{ address: string; family: number }[]>;
}

export async function deliverWebhook(
  req: DeliveryRequest,
  options: DeliverOptions = {},
): Promise<DeliveryOutcome> {
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let url: URL;
  try {
    url = new URL(req.url);
  } catch {
    return { status: 'blocked', error: `not a URL: ${req.url}` };
  }
  // 0020's CHECKs already refuse http:, userinfo and IP literals at write time. Re-checked here
  // because a constraint added later does not retroactively clean rows already stored, and because
  // this function must be correct for a URL that reached it by any route.
  if (url.protocol !== 'https:') {
    return { status: 'blocked', error: `${url.protocol} is refused; only https is permitted` };
  }
  if (url.port !== '' && url.port !== '443') {
    return { status: 'blocked', error: `port ${url.port} is refused` };
  }

  const host = url.hostname.toLowerCase();
  const retryIn = (): { retryInSeconds: number } | Record<string, never> =>
    req.attempts < MAX_ATTEMPTS
      ? { retryInSeconds: backoffSeconds(req.attempts, options.random) }
      : {};

  let resolved: { address: string; family: number }[];
  try {
    resolved = options.resolve ? await options.resolve(host) : await lookup(host, { all: true });
  } catch (err: unknown) {
    // DNS failure is the receiver's problem and may be transient, so it is a retryable FAILURE and
    // not a block. `blocked` means we decided not to make the request.
    return {
      status: 'failed',
      responseStatus: 0,
      body: '',
      error: `dns: ${host} did not resolve (${String(err)})`,
      ...retryIn(),
    };
  }
  if (resolved.length === 0) {
    return {
      status: 'failed',
      responseStatus: 0,
      body: '',
      error: `dns: ${host} resolved to nothing`,
      ...retryIn(),
    };
  }
  // EVERY address, not the first — whoever controls the DNS record chooses the order, so checking
  // one of two turns a private address into a coin flip.
  for (const entry of resolved) {
    if (isBlockedAddress(entry.address, entry.family)) {
      return {
        status: 'blocked',
        error:
          `${host} resolves to ${entry.address}, which is a private, link-local or metadata address`,
      };
    }
  }

  const body = JSON.stringify({
    event: req.event,
    event_key: req.eventKey,
    delivery_id: req.deliveryId,
    attempt: req.attempts,
    data: req.payload,
  });
  const timestamp = Math.floor(now() / 1000);
  const pinned = resolved[0] as { address: string; family: number };

  return await new Promise<DeliveryOutcome>((resolve) => {
    const clientReq = httpsRequest(
      {
        // The PINNED address with the original Host header, for the reason egress.ts states: handing
        // the hostname to the connection re-resolves it and reopens the DNS-rebinding window the
        // check above just closed.
        host: pinned.address,
        servername: host,
        port: 443,
        method: 'POST',
        path: `${url.pathname}${url.search}`,
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          'user-agent': 'ResScript-Webhooks/1',
          [SIGNATURE_HEADER]: signatureHeader(req.secret, timestamp, body),
          // The receiver's dedupe key. At-least-once delivery is the outbox's cost, so this is the
          // other half of that contract: the same key means the same event.
          'x-resscript-event-key': req.eventKey,
          'x-resscript-event': req.event,
          'x-resscript-attempt': String(req.attempts),
        },
        timeout: timeoutMs,
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          if (size >= MAX_RESPONSE_BYTES) return;
          size += chunk.length;
          chunks.push(chunk);
        });
        response.on('end', () => {
          const status = response.statusCode ?? 0;
          const text = Buffer.concat(chunks).toString('utf8').slice(0, MAX_RESPONSE_BYTES);
          if (status >= 200 && status < 300) {
            resolve({ status: 'delivered', responseStatus: status, body: text });
            return;
          }
          resolve({
            status: 'failed',
            responseStatus: status,
            body: text,
            error: `HTTP ${String(status)}`,
            ...(isRetryable(status) ? retryIn() : {}),
          });
        });
      },
    );
    clientReq.on('timeout', () => {
      clientReq.destroy();
      resolve({
        status: 'failed',
        responseStatus: 0,
        body: '',
        error: `timeout after ${String(timeoutMs)}ms`,
        ...retryIn(),
      });
    });
    clientReq.on('error', (err) => {
      resolve({
        status: 'failed',
        responseStatus: 0,
        body: '',
        error: String(err),
        ...retryIn(),
      });
    });
    clientReq.write(body);
    clientReq.end();
  });
}
