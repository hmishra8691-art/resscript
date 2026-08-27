/**
 * The `webhook` job: drain the outbox, then deliver one claimed attempt (roadmap P2-10).
 *
 * ## One job kind, two phases, and why not two kinds
 *
 * Dispatch (outbox → deliveries) and delivery (one signed POST) are separate concerns, and the
 * obvious design is two kinds. They are one here because of what the failure looks like if they get
 * out of step: a `dispatch` kind that stops being scheduled leaves the outbox growing while the
 * delivery kind reports a clean, empty queue — a webhook system that says everything is fine while
 * nothing has been sent since Tuesday. Making dispatch the first thing every delivery run does
 * means the two cannot be independently broken, and the cost is one cheap query on a job that was
 * going to talk to the network anyway.
 *
 * ## Why one delivery per job and not a batch
 *
 * A batch would amortize the claim, and it would also mean one slow receiver holding the worker
 * while every other subscriber waits. `ops.jobs` already gives per-attempt isolation, retry
 * accounting and a visible failure per unit of work; a batch throws that away and replaces it with
 * a partial-success result nobody can act on. So the unit of work is the unit the receiver sees.
 *
 * ## The retry lives in the database, not in this job's attempts
 *
 * `ops.jobs.attempts` counts THIS JOB's failures — a crash, a lost connection, our own bug. The
 * webhook's own retry schedule is `app.webhook_deliveries.next_attempt_at`, set through
 * `app.webhook_requeue(id, delay)`. Keeping them separate is what makes "the receiver returned 503
 * eleven times" a fact about the endpoint rather than a fact about our worker, and it means a
 * successful job run that recorded a failed delivery is not itself a failure — because it is not.
 * Conflating the two would either mark our worker unhealthy for someone else's outage or bury the
 * outage inside our job history.
 */

import { AppError } from '@resscript/observability';

import { defineJob, payload as p, type JobContext, type JobDefinition } from '../registry.js';
import {
  MAX_ATTEMPTS,
  deliverWebhook,
  type DeliveryRequest,
} from '../webhook/deliver.js';
import type { JsonObject } from '../json.js';

export const WEBHOOK_KIND = 'webhook';

export interface WebhookPayload {
  /** How many outbox rows one run fans out. Bounded by the RPC at 1000. */
  readonly dispatchLimit: number;
}

export interface WebhookJobResult extends JsonObject {
  /** Deliveries created from the outbox this run. */
  dispatched: number;
  /** 'none' when the queue was empty — a normal, frequent outcome and not a failure. */
  outcome: 'delivered' | 'failed' | 'blocked' | 'none';
  delivery_id: string | null;
  response_status: number | null;
  /** Seconds until the next attempt, when one was scheduled. */
  retry_in_s: number | null;
  attempts: number | null;
}

/**
 * What this job needs from the database. An interface rather than a pool so the tests can drive the
 * whole decision tree without Postgres — the SQL is covered by 0020's 60 pgTAP assertions, and
 * re-proving it here would test the database twice and this logic once.
 */
export interface WebhookStore {
  dispatch(limit: number): Promise<number>;
  claim(worker: string): Promise<DeliveryRequest | null>;
  recordAttempt(
    deliveryId: string,
    status: 'delivered' | 'failed' | 'blocked',
    responseStatus: number | null,
    body: string | null,
    error: string | null,
  ): Promise<void>;
  requeue(deliveryId: string, delaySeconds: number): Promise<void>;
}

export interface WebhookEnvironment {
  readonly store: WebhookStore;
  /** Injected in tests; production uses the real network. */
  readonly deliver?: typeof deliverWebhook;
  readonly timeoutMs?: number | undefined;
}

/**
 * The environment a worker with no `DATABASE_URL` gets — same posture as the compile and export
 * kinds and for the same reason (kinds/registry.ts): the kind is registered unconditionally so
 * webhook jobs fail loudly with a message naming the missing variable, instead of queueing forever
 * and looking like a spinner that never finishes.
 */
export function unconfiguredWebhookEnvironment(): WebhookEnvironment {
  const refuse = (): never => {
    throw new AppError('unavailable', 'this worker cannot deliver webhooks: DATABASE_URL is unset', {
      retryable: false,
      context: { kind: WEBHOOK_KIND },
    });
  };
  return {
    store: {
      dispatch: async () => refuse(),
      claim: async () => refuse(),
      recordAttempt: async () => refuse(),
      requeue: async () => refuse(),
    },
  };
}

export function webhookJob(env: WebhookEnvironment): JobDefinition<WebhookPayload, WebhookJobResult> {
  return defineJob({
    parse: (raw): WebhookPayload => ({
      // Default rather than required: this job is normally enqueued by a scheduler with no payload
      // at all, and a required field would make the common case the one that fails.
      dispatchLimit: p.optionalInt(raw, 'dispatch_limit', 200),
    }),
    handle: (ctx) => runWebhook(ctx, env),
  });
}

async function runWebhook(
  ctx: JobContext<WebhookPayload>,
  env: WebhookEnvironment,
): Promise<WebhookJobResult> {
  const deliver = env.deliver ?? deliverWebhook;

  // Phase 1. Cheap, idempotent, and first — see the header on why it is not its own kind.
  const dispatched = await env.store.dispatch(ctx.payload.dispatchLimit);
  if (dispatched > 0) ctx.log.info('webhook_dispatched', { count: dispatched });

  const claimed = await env.store.claim(`worker:${String(ctx.job.id)}`);
  if (claimed === null) {
    // An empty queue is the common case and is NOT a failure. Returning a result rather than
    // throwing matters: a thrown "nothing to do" would burn this job's retry budget and put a red
    // row in the job history every time the queue is quiet, which is most of the time.
    return {
      dispatched,
      outcome: 'none',
      delivery_id: null,
      response_status: null,
      retry_in_s: null,
      attempts: null,
    };
  }

  const outcome = await deliver(claimed, { ...(env.timeoutMs ? { timeoutMs: env.timeoutMs } : {}) });

  if (outcome.status === 'delivered') {
    await env.store.recordAttempt(
      claimed.deliveryId,
      'delivered',
      outcome.responseStatus,
      outcome.body,
      null,
    );
    ctx.log.info('webhook_delivered', {
      delivery_id: claimed.deliveryId,
      event: claimed.event,
      status: outcome.responseStatus,
      attempts: claimed.attempts,
    });
    return {
      dispatched,
      outcome: 'delivered',
      delivery_id: claimed.deliveryId,
      response_status: outcome.responseStatus,
      retry_in_s: null,
      attempts: claimed.attempts,
    };
  }

  if (outcome.status === 'blocked') {
    // Our refusal, never retried. Logged at WARN and not ERROR: the system worked exactly as
    // designed, and the thing needing attention is a customer's configuration. Logged loudly
    // enough to be noticed, because a URL resolving to a metadata address is worth a look.
    await env.store.recordAttempt(claimed.deliveryId, 'blocked', 0, null, outcome.error);
    ctx.log.warn('webhook_blocked', {
      delivery_id: claimed.deliveryId,
      event: claimed.event,
      reason: outcome.error,
    });
    return {
      dispatched,
      outcome: 'blocked',
      delivery_id: claimed.deliveryId,
      response_status: 0,
      retry_in_s: null,
      attempts: claimed.attempts,
    };
  }

  // A failure. Record it first, then schedule the retry — in that order, because a crash between
  // the two must leave the attempt visible rather than leave a delivery that looks untried.
  await env.store.recordAttempt(
    claimed.deliveryId,
    'failed',
    outcome.responseStatus,
    outcome.body,
    outcome.error,
  );
  const retry = outcome.retryInSeconds;
  if (retry !== undefined) {
    await env.store.requeue(claimed.deliveryId, retry);
  }
  ctx.log.warn('webhook_attempt_failed', {
    delivery_id: claimed.deliveryId,
    event: claimed.event,
    status: outcome.responseStatus,
    attempts: claimed.attempts,
    max_attempts: MAX_ATTEMPTS,
    retry_in_s: retry ?? null,
    error: outcome.error,
  });

  // NOT thrown. This job did its work: it claimed a delivery, made the request, and recorded what
  // happened. The receiver's 503 is not our failure, and throwing here would spend this job's retry
  // budget on someone else's outage while the delivery's own schedule — already set above — is what
  // actually governs the next attempt. See the header.
  return {
    dispatched,
    outcome: 'failed',
    delivery_id: claimed.deliveryId,
    response_status: outcome.responseStatus,
    retry_in_s: retry ?? null,
    attempts: claimed.attempts,
  };
}
