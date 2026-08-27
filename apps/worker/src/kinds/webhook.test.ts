/**
 * The `webhook` job's decision tree, driven through the real harness (roadmap P2-10).
 *
 * Real `Consumer`, real `MemoryJobStore`, real `buildRegistry` — so these assertions also prove the
 * kind is actually registered, which is the failure `kinds/registry.ts`' own header warns about:
 * a kind that exists but is not in `registry.kinds()` leaves jobs `queued` forever and shows up as
 * a spinner that never finishes and nothing at all in the logs.
 *
 * What is asserted, and why each one has a plausible wrong answer:
 *
 *  * **An empty queue is a SUCCESS.** The queue is quiet most of the time. A job that threw
 *    "nothing to do" would burn its retry budget and paint the job history red on every idle poll.
 *  * **A failed DELIVERY is not a failed JOB.** The receiver's 503 is not our outage. Throwing
 *    would spend our retry budget on their downtime while the delivery's own `next_attempt_at`
 *    already governs the next attempt — and would hide a receiver problem inside our job history.
 *  * **A blocked delivery is never requeued.** `blocked` is our refusal; retrying a refusal is
 *    both pointless and, for an SSRF attempt, a repeated attempt to reach something we said no to.
 *  * **Dispatch runs first, every time.** That is the reason this is one kind and not two, so it is
 *    asserted rather than assumed.
 *  * **The attempt is recorded BEFORE the requeue.** A crash between them must leave a visible
 *    attempt, not a delivery that looks untried.
 */

import { createCapturingLogger } from '@resscript/observability';
import { describe, expect, it } from 'vitest';

import { Consumer } from '../consumer.js';
import type { JsonObject } from '../json.js';
import { MemoryJobStore } from '../memory-job-store.js';
import { buildRegistry } from './registry.js';
import { WEBHOOK_KIND, type WebhookEnvironment, type WebhookStore } from './webhook.js';
import type { DeliveryOutcome, DeliveryRequest } from '../webhook/deliver.js';

function tid(prefix: string, tag: string): string {
  return `${prefix}_0${tag.toUpperCase().padEnd(25, '0')}`;
}

const ORG = tid('org', 'a');
const DELIVERY = tid('whd', 'd1');

const CLAIMED: DeliveryRequest = {
  deliveryId: DELIVERY,
  url: 'https://hooks.acme.example/resscript',
  secret: 'a'.repeat(44),
  event: 'session.completed',
  eventKey: `${tid('ses', 's1')}:COMPLETE`,
  payload: { session_id: tid('ses', 's1'), disposition: 'COMPLETE' },
  attempts: 1,
};

/**
 * A store that records the ORDER of its calls, because two of the properties under test are
 * ordering properties — dispatch before claim, and record before requeue — and a store that only
 * counted calls could not see either.
 */
class MemoryWebhookStore implements WebhookStore {
  readonly calls: string[] = [];
  readonly recorded: {
    status: string;
    responseStatus: number | null;
    error: string | null;
  }[] = [];
  readonly requeued: { id: string; delaySeconds: number }[] = [];

  constructor(
    private readonly toClaim: DeliveryRequest | null,
    private readonly dispatchCount = 0,
  ) {}

  async dispatch(limit: number): Promise<number> {
    this.calls.push(`dispatch:${String(limit)}`);
    return this.dispatchCount;
  }

  async claim(worker: string): Promise<DeliveryRequest | null> {
    this.calls.push(worker === '' ? 'claim:anonymous' : 'claim');
    return this.toClaim;
  }

  async recordAttempt(
    deliveryId: string,
    status: 'delivered' | 'failed' | 'blocked',
    responseStatus: number | null,
    _body: string | null,
    error: string | null,
  ): Promise<void> {
    this.calls.push(`record:${status}`);
    this.recorded.push({ status, responseStatus, error });
  }

  async requeue(deliveryId: string, delaySeconds: number): Promise<void> {
    this.calls.push('requeue');
    this.requeued.push({ id: deliveryId, delaySeconds });
  }
}

interface Harness {
  readonly store: MemoryWebhookStore;
  run(payload?: JsonObject): Promise<{
    status: string;
    result: JsonObject | null;
    attempts: number;
  }>;
}

function harness(options: {
  readonly claim?: DeliveryRequest | null;
  readonly dispatchCount?: number;
  readonly outcome?: DeliveryOutcome;
}): Harness {
  const store = new MemoryWebhookStore(
    options.claim === undefined ? CLAIMED : options.claim,
    options.dispatchCount ?? 0,
  );
  const env: WebhookEnvironment = {
    store,
    deliver: async () =>
      options.outcome ?? { status: 'delivered', responseStatus: 200, body: 'ok' },
  };
  const jobs = new MemoryJobStore();
  const consumer = new Consumer({
    store: jobs,
    registry: buildRegistry({ webhook: env }),
    logger: createCapturingLogger({ service: 'worker', level: 'error' }).logger,
    concurrency: 1,
    pollIntervalMs: 2,
    heartbeatIntervalMs: 5,
    stalledAfterMs: 50_000,
    sweepIntervalMs: 0,
    drainTimeoutMs: 2_000,
    backoffMs: () => 0,
  });

  return {
    store,
    run: async (payload = {}) => {
      const { id } = await jobs.enqueue({
        kind: WEBHOOK_KIND,
        payload,
        orgId: ORG,
        maxAttempts: 1,
      });
      await consumer.runUntilIdle();
      const job = await jobs.get(id);
      return {
        status: job?.status ?? 'missing',
        result: (job?.result ?? null) as JsonObject | null,
        attempts: job?.attempts ?? 0,
      };
    },
  };
}

/* ---------------------------------------------------------------- *
 * Registration
 * ---------------------------------------------------------------- */

describe('registration', () => {
  it('is in the registry, so the kind actually drains', () => {
    // The failure this guards against: a kind that exists but is not in `registry.kinds()` leaves
    // its jobs `queued` forever, which reads as a spinner that never finishes and nothing in the
    // logs at all.
    expect(buildRegistry().kinds()).toContain(WEBHOOK_KIND);
  });

  it('is registered even with no environment, and fails loudly instead of queueing forever', async () => {
    const jobs = new MemoryJobStore();
    const consumer = new Consumer({
      store: jobs,
      registry: buildRegistry(), // no webhook env at all
      logger: createCapturingLogger({ service: 'worker', level: 'error' }).logger,
      concurrency: 1,
      pollIntervalMs: 2,
      heartbeatIntervalMs: 5,
      stalledAfterMs: 50_000,
      sweepIntervalMs: 0,
      drainTimeoutMs: 2_000,
      backoffMs: () => 0,
    });
    const { id } = await jobs.enqueue({ kind: WEBHOOK_KIND, payload: {}, orgId: ORG, maxAttempts: 1 });
    await consumer.runUntilIdle();
    const job = await jobs.get(id);

    expect(job?.status).toBe('failed');
    // Naming the missing variable is the whole point — a queue that drains into a clear error beats
    // a queue that silently does not drain.
    expect(JSON.stringify(job?.error)).toContain('DATABASE_URL');
  });
});

/* ---------------------------------------------------------------- *
 * The empty queue
 * ---------------------------------------------------------------- */

describe('an empty queue', () => {
  it('SUCCEEDS with outcome "none" rather than throwing', async () => {
    const h = harness({ claim: null });
    const r = await h.run();

    expect(r.status).toBe('succeeded');
    expect(r.result?.['outcome']).toBe('none');
    expect(r.result?.['delivery_id']).toBeNull();
  });

  it('still runs dispatch, because that is why this is one kind and not two', async () => {
    // A `dispatch` kind that stopped being scheduled would leave the outbox growing while the
    // delivery kind reported a clean, empty queue.
    const h = harness({ claim: null, dispatchCount: 7 });
    const r = await h.run();

    expect(h.store.calls[0]).toBe('dispatch:200');
    expect(r.result?.['dispatched']).toBe(7);
  });

  it('takes the dispatch limit from the payload when one is given', async () => {
    const h = harness({ claim: null });
    await h.run({ dispatch_limit: 50 });

    expect(h.store.calls[0]).toBe('dispatch:50');
  });

  it('dispatches BEFORE claiming, always', async () => {
    const h = harness({});
    await h.run();

    expect(h.store.calls.indexOf('claim')).toBeGreaterThan(0);
    expect(h.store.calls[0]).toContain('dispatch');
  });
});

/* ---------------------------------------------------------------- *
 * Delivered
 * ---------------------------------------------------------------- */

describe('a successful delivery', () => {
  it('records the outcome and does not requeue', async () => {
    const h = harness({ outcome: { status: 'delivered', responseStatus: 202, body: 'queued' } });
    const r = await h.run();

    expect(r.status).toBe('succeeded');
    expect(r.result?.['outcome']).toBe('delivered');
    expect(r.result?.['response_status']).toBe(202);
    expect(h.store.recorded).toEqual([
      { status: 'delivered', responseStatus: 202, error: null },
    ]);
    expect(h.store.requeued).toEqual([]);
  });

  it('reports the delivery id and the attempt number, so a log line is actionable', async () => {
    const h = harness({});
    const r = await h.run();

    expect(r.result?.['delivery_id']).toBe(DELIVERY);
    expect(r.result?.['attempts']).toBe(1);
  });
});

/* ---------------------------------------------------------------- *
 * Failed — the receiver's problem, not ours
 * ---------------------------------------------------------------- */

describe('a failed delivery', () => {
  it('SUCCEEDS as a job while recording the delivery as failed', async () => {
    // The headline. This job claimed a delivery, made the request and recorded what happened —
    // that is a complete unit of work. Throwing would spend OUR retry budget on THEIR outage and
    // bury a receiver problem inside our job history.
    const h = harness({
      outcome: {
        status: 'failed',
        responseStatus: 503,
        body: 'unavailable',
        error: 'HTTP 503',
        retryInSeconds: 42,
      },
    });
    const r = await h.run();

    expect(r.status).toBe('succeeded');
    expect(r.attempts).toBe(1); // the job did not retry itself
    expect(r.result?.['outcome']).toBe('failed');
    expect(r.result?.['retry_in_s']).toBe(42);
  });

  it('requeues with the delay the deliverer computed', async () => {
    const h = harness({
      outcome: {
        status: 'failed',
        responseStatus: 500,
        body: '',
        error: 'HTTP 500',
        retryInSeconds: 137,
      },
    });
    await h.run();

    expect(h.store.requeued).toEqual([{ id: DELIVERY, delaySeconds: 137 }]);
  });

  it('records the attempt BEFORE requeueing it', async () => {
    // A crash between the two must leave a visible attempt rather than a delivery that looks
    // untried — which is the direction that makes a stuck endpoint diagnosable.
    const h = harness({
      outcome: {
        status: 'failed',
        responseStatus: 500,
        body: '',
        error: 'HTTP 500',
        retryInSeconds: 30,
      },
    });
    await h.run();

    expect(h.store.calls.indexOf('record:failed')).toBeLessThan(h.store.calls.indexOf('requeue'));
  });

  it('does NOT requeue when the deliverer offered no retry', async () => {
    // A 404, or the attempt budget exhausted. The absence of `retryInSeconds` is the deliverer's
    // decision and this job does not second-guess it — one place decides retryability.
    const h = harness({
      outcome: { status: 'failed', responseStatus: 404, body: 'no such hook', error: 'HTTP 404' },
    });
    const r = await h.run();

    expect(h.store.requeued).toEqual([]);
    expect(r.result?.['retry_in_s']).toBeNull();
    expect(r.result?.['outcome']).toBe('failed');
  });
});

/* ---------------------------------------------------------------- *
 * Blocked — our refusal
 * ---------------------------------------------------------------- */

describe('a blocked delivery', () => {
  const blocked: DeliveryOutcome = {
    status: 'blocked',
    error: 'hooks.acme.example resolves to 169.254.169.254, which is a metadata address',
  };

  it('is recorded as blocked and NEVER requeued', async () => {
    // Retrying a refusal is pointless, and for an SSRF attempt it is a repeated attempt to reach
    // something we already said no to.
    const h = harness({ outcome: blocked });
    const r = await h.run();

    expect(r.status).toBe('succeeded');
    expect(r.result?.['outcome']).toBe('blocked');
    expect(h.store.requeued).toEqual([]);
    expect(h.store.recorded[0]?.status).toBe('blocked');
  });

  it('records response_status 0, distinguishing "no status" from "not attempted"', async () => {
    const h = harness({ outcome: blocked });
    await h.run();

    expect(h.store.recorded[0]?.responseStatus).toBe(0);
  });

  it('keeps the reason, so an operator can see WHY it was refused', async () => {
    const h = harness({ outcome: blocked });
    await h.run();

    expect(h.store.recorded[0]?.error).toContain('169.254.169.254');
  });
});
