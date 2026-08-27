/**
 * Webhook signing, backoff and the delivery decision (roadmap P2-10).
 *
 * The HTTP call itself is not exercised here — a test that opens a socket to a real host tests the
 * network. What IS tested is everything that decides what gets sent and what happens next, because
 * each of those has a wrong answer that looks fine:
 *
 *  * **The signature covers the timestamp.** A signature over the body alone is replayable forever,
 *    and the symptom is not an error — it is a receiver whose completion count can be inflated by
 *    anyone who ever saw one valid request.
 *  * **Verification is constant-time and rejects a stale or malformed header.** Included because
 *    `verifySignature` is the executable form of the integration documentation: if it is wrong, the
 *    docs are wrong.
 *  * **A 4xx is not retried and a 5xx is.** Retrying a 404 eight times fills two sets of logs and
 *    fixes nothing; giving up on a 503 loses a delivery to a deploy.
 *  * **Backoff has jitter and a cap.** Without jitter, 5,000 outstanding deliveries retry in the
 *    same second, repeatedly, against an endpoint that is already unwell.
 *  * **A blocked address is `blocked`, not `failed`.** Separate statuses so an SSRF attempt does not
 *    read as a flaky endpoint, and so it is never retried.
 */

import { describe, expect, it } from 'vitest';

import {
  MAX_ATTEMPTS,
  SIGNATURE_HEADER,
  backoffSeconds,
  deliverWebhook,
  isRetryable,
  signBody,
  signatureHeader,
  signedString,
  verifySignature,
} from './deliver.js';

const SECRET = 'a'.repeat(44);
const BODY = '{"event":"session.completed","data":{"x":1}}';

/* ---------------------------------------------------------------- *
 * Signing
 * ---------------------------------------------------------------- */

describe('signing', () => {
  it('signs the timestamp together with the body', () => {
    // The property. If these two were equal, the signature would not cover the timestamp and a
    // captured request could be replayed with any `t` the attacker liked.
    expect(signBody(SECRET, 1000, BODY)).not.toBe(signBody(SECRET, 2000, BODY));
  });

  it('produces a header a receiver can split on the FIRST period', () => {
    // The delimiter contract: everything after the first period is the body, however many periods
    // the body itself contains.
    const withPeriods = '{"a":"1.2.3"}';
    const s = signedString(1700000000, withPeriods);
    const firstDot = s.indexOf('.');
    expect(s.slice(0, firstDot)).toBe('1700000000');
    expect(s.slice(firstDot + 1)).toBe(withPeriods);
  });

  it('formats the header as t=<unix>,v1=<hex>', () => {
    const header = signatureHeader(SECRET, 1700000000, BODY);
    expect(header).toMatch(/^t=1700000000,v1=[0-9a-f]{64}$/);
  });

  it('changes the signature when the secret changes, so rotation invalidates', () => {
    expect(signBody(SECRET, 1000, BODY)).not.toBe(signBody('b'.repeat(44), 1000, BODY));
  });

  it('uses a lowercase header name, since Node lowercases them anyway', () => {
    expect(SIGNATURE_HEADER).toBe(SIGNATURE_HEADER.toLowerCase());
  });
});

describe('verifySignature — the executable documentation', () => {
  const now = 1700000000;
  const header = signatureHeader(SECRET, now, BODY);

  it('accepts a fresh, correct signature', () => {
    expect(verifySignature(header, SECRET, BODY, now)).toEqual({ ok: true });
  });

  it('rejects a body that changed by one byte', () => {
    expect(verifySignature(header, SECRET, `${BODY} `, now)).toEqual({
      ok: false,
      reason: 'mismatch',
    });
  });

  it('rejects the wrong secret', () => {
    expect(verifySignature(header, 'b'.repeat(44), BODY, now)).toEqual({
      ok: false,
      reason: 'mismatch',
    });
  });

  it('rejects a stale timestamp — the whole reason the timestamp is signed', () => {
    expect(verifySignature(header, SECRET, BODY, now + 3600)).toEqual({
      ok: false,
      reason: 'stale',
    });
    // ...and a timestamp from the FUTURE, since clock skew cuts both ways and a far-future `t`
    // would otherwise be a signature valid forever.
    expect(verifySignature(header, SECRET, BODY, now - 3600)).toEqual({
      ok: false,
      reason: 'stale',
    });
  });

  it('accepts within the tolerance', () => {
    expect(verifySignature(header, SECRET, BODY, now + 120)).toEqual({ ok: true });
  });

  it('rejects a malformed header rather than throwing', () => {
    for (const bad of ['', 'garbage', 't=1700000000', 'v1=abc', 't=,v1=abc', 't=abc,v1=def']) {
      const r = verifySignature(bad, SECRET, BODY, now);
      expect(r.ok).toBe(false);
    }
  });

  it('treats an empty timestamp as malformed, not as epoch 1970', () => {
    // Number('') is 0. Without the isFinite check this reads as 1970 and the staleness comparison
    // answers a question about the wrong instant — the same bug vendor/verify.ts had.
    expect(verifySignature('t=,v1=abc', SECRET, BODY, now)).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });

  it('tolerates whitespace and extra fields, which real proxies add', () => {
    const padded = `t=${String(now)} , v1=${signBody(SECRET, now, BODY)} , v2=future`;
    expect(verifySignature(padded, SECRET, BODY, now)).toEqual({ ok: true });
  });
});

/* ---------------------------------------------------------------- *
 * Retry policy
 * ---------------------------------------------------------------- */

describe('isRetryable', () => {
  it('retries 5xx, 429 and no-status-at-all', () => {
    for (const s of [500, 502, 503, 504, 429, 0]) expect(isRetryable(s)).toBe(true);
  });

  it('does NOT retry a 4xx other than 429', () => {
    // A 400 or a 404 will be a 400 or a 404 in eight hours too, and retrying it only fills two
    // sets of logs.
    for (const s of [400, 401, 403, 404, 410, 422]) expect(isRetryable(s)).toBe(false);
  });

  it('does not retry a success', () => {
    for (const s of [200, 201, 202, 204]) expect(isRetryable(s)).toBe(false);
  });

  it('does not retry a 3xx — a redirect we deliberately do not follow', () => {
    // Following a 30x would re-run every SSRF check against a URL the customer never configured,
    // which is the cleanest possible bypass. So a redirect is a misconfiguration to report, not a
    // condition to retry.
    for (const s of [301, 302, 307, 308]) expect(isRetryable(s)).toBe(false);
  });
});

describe('backoffSeconds', () => {
  it('grows the window exponentially', () => {
    // random() = 1 gives the top of each window, which is what shows the shape.
    const top = (n: number) => backoffSeconds(n, () => 1);
    expect(top(1)).toBe(30);
    expect(top(2)).toBe(60);
    expect(top(3)).toBe(120);
    expect(top(4)).toBe(240);
  });

  it('caps the window at an hour', () => {
    expect(backoffSeconds(20, () => 1)).toBe(3600);
    expect(backoffSeconds(50, () => 1)).toBe(3600);
  });

  it('applies FULL jitter — the delay is spread across the window, not fixed at it', () => {
    // The property that matters: two deliveries at the same attempt count must not agree on when to
    // retry, or a receiver's outage produces a synchronized herd on recovery.
    const a = backoffSeconds(5, () => 0.1);
    const b = backoffSeconds(5, () => 0.9);
    expect(a).not.toBe(b);
    expect(a).toBeLessThan(b);
  });

  it('never returns zero, so a retry is never an immediate hot loop', () => {
    expect(backoffSeconds(1, () => 0)).toBeGreaterThanOrEqual(5);
    expect(backoffSeconds(0, () => 0)).toBeGreaterThanOrEqual(5);
  });

  it('gives up after MAX_ATTEMPTS, which spans hours not weeks', () => {
    // Asserted as a property of the constant rather than a magic number, so changing it is a
    // deliberate act: the sum of the top-of-window waits is the worst-case span.
    let total = 0;
    for (let n = 1; n <= MAX_ATTEMPTS; n += 1) total += backoffSeconds(n, () => 1);
    expect(total).toBeGreaterThan(3600); // survives a deploy
    expect(total).toBeLessThan(24 * 3600); // does not pretend a dead endpoint will return
  });
});

/* ---------------------------------------------------------------- *
 * The delivery decision, up to the socket
 * ---------------------------------------------------------------- */

const PUBLIC = [{ address: '93.184.216.34', family: 4 }];

function req(url: string, attempts = 1) {
  return {
    deliveryId: 'whd_01',
    url,
    secret: SECRET,
    event: 'session.completed',
    eventKey: 'ses_01:COMPLETE',
    payload: { x: 1 },
    attempts,
  };
}

describe('deliverWebhook — refusals, before any socket is opened', () => {
  const resolve = async () => PUBLIC;

  it('BLOCKS a URL that resolves to the metadata endpoint', async () => {
    // The headline, and the reason this file imports @resscript/egress rather than growing its own
    // rules: a webhook URL is the same SSRF sink survey.http is.
    const r = await deliverWebhook(req('https://hooks.acme.example/x'), {
      resolve: async () => [{ address: '169.254.169.254', family: 4 }],
    });
    expect(r.status).toBe('blocked');
    if (r.status === 'blocked') expect(r.error).toContain('169.254.169.254');
  });

  it('BLOCKS when any resolved address is private, not just the first', async () => {
    const r = await deliverWebhook(req('https://hooks.acme.example/x'), {
      resolve: async () => [
        { address: '93.184.216.34', family: 4 },
        { address: '10.0.0.5', family: 4 },
      ],
    });
    expect(r.status).toBe('blocked');
  });

  it('BLOCKS a mapped-IPv6 private address', async () => {
    const r = await deliverWebhook(req('https://hooks.acme.example/x'), {
      resolve: async () => [{ address: '::ffff:127.0.0.1', family: 6 }],
    });
    expect(r.status).toBe('blocked');
  });

  it('BLOCKS http, and does not retry it', async () => {
    const r = await deliverWebhook(req('http://hooks.acme.example/x'), { resolve });
    expect(r.status).toBe('blocked');
    // `blocked` carries no retryInSeconds at all, which is what makes "our refusal" unretryable by
    // construction rather than by the caller remembering.
    expect('retryInSeconds' in r).toBe(false);
  });

  it('BLOCKS a non-standard port', async () => {
    const r = await deliverWebhook(req('https://hooks.acme.example:6379/x'), { resolve });
    expect(r.status).toBe('blocked');
  });

  it('BLOCKS an unparseable URL rather than throwing', async () => {
    const r = await deliverWebhook(req('not a url'), { resolve });
    expect(r.status).toBe('blocked');
  });

  it('treats a DNS failure as a retryable FAILURE, not as a block', async () => {
    // The distinction is the whole reason the two statuses exist: DNS may recover, our refusal
    // will not.
    const r = await deliverWebhook(req('https://hooks.acme.example/x'), {
      resolve: async () => {
        throw new Error('ENOTFOUND');
      },
    });
    expect(r.status).toBe('failed');
    if (r.status === 'failed') {
      expect(r.responseStatus).toBe(0);
      expect(r.retryInSeconds).toBeGreaterThan(0);
    }
  });

  it('stops offering a retry once MAX_ATTEMPTS is reached', async () => {
    const r = await deliverWebhook(req('https://hooks.acme.example/x', MAX_ATTEMPTS), {
      resolve: async () => {
        throw new Error('ENOTFOUND');
      },
    });
    expect(r.status).toBe('failed');
    if (r.status === 'failed') expect(r.retryInSeconds).toBeUndefined();
  });

  it('treats an empty DNS answer as a failure, not as a green light', async () => {
    const r = await deliverWebhook(req('https://hooks.acme.example/x'), {
      resolve: async () => [],
    });
    expect(r.status).toBe('failed');
  });
});
