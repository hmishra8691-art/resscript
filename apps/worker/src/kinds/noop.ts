/**
 * The `noop` job.
 *
 * Roadmap M0.4: "One trivial job (`noop`) exercising the whole path", with the acceptance
 * criterion "Triggering a `noop` job from studio shows live progress". So it is trivial but not
 * empty — it must actually walk every mechanism the real jobs will use, otherwise the first
 * `compile` job is the first time the harness is tested end to end:
 *
 *  - typed payload parsed out of `jsonb`,
 *  - N progress updates, so the studio's "step N of M" component has something to render,
 *  - a structured result written to `ops.jobs.result`,
 *  - `ctx.signal` honoured, so the drain path is exercised,
 *  - an optional deliberate failure, so retry/backoff is reachable from a test or a staging
 *    poke without adding a second fake job kind.
 */

import { AppError } from '@resscript/observability';

import { defineJob, payload as p, type JobDefinition } from '../registry.js';
import type { JsonObject } from '../json.js';

export const NOOP_KIND = 'noop';

export interface NoopPayload {
  /** How many progress steps to report. Default 3. */
  readonly steps: number;
  /** Sleep per step, so a human can watch progress advance in the studio. Default 0. */
  readonly stepDelayMs: number;
  /** A label echoed into the result, so a poke can be identified in the job list. */
  readonly label: string | undefined;
  /**
   * Throw on the first N attempts. The harness's retry path, reachable without a second job
   * kind: `{ failTimes: 2 }` is the "crashes twice then succeeds" case.
   */
  readonly failTimes: number;
  /** Whether the deliberate failure is retryable. Default true. */
  readonly failRetryable: boolean;
}

export interface NoopResult extends JsonObject {
  readonly ok: true;
  readonly steps: number;
  readonly attempt: number;
  readonly label: string | null;
}

export const noopJob: JobDefinition<NoopPayload, NoopResult> = defineJob({
  parse: (raw): NoopPayload => {
    const steps = p.optionalInt(raw, 'steps', 3);
    if (steps < 1 || steps > 1_000) {
      throw new RangeError(`payload.steps must be between 1 and 1000, got ${String(steps)}`);
    }
    return {
      steps,
      stepDelayMs: p.optionalInt(raw, 'stepDelayMs', 0),
      label: p.optionalString(raw, 'label'),
      failTimes: p.optionalInt(raw, 'failTimes', 0),
      failRetryable: raw['failRetryable'] !== false,
    };
  },

  handle: async (ctx): Promise<NoopResult> => {
    const { steps, stepDelayMs, label, failTimes, failRetryable } = ctx.payload;

    if (ctx.attempt <= failTimes) {
      // Thrown BEFORE any progress, so a retried job's progress starts clean rather than
      // showing a half-finished previous attempt.
      throw new AppError('unavailable', `noop: deliberate failure on attempt ${ctx.attempt}`, {
        retryable: failRetryable,
        context: { attempt: ctx.attempt, fail_times: failTimes },
      });
    }

    for (let step = 1; step <= steps; step += 1) {
      if (ctx.signal.aborted) {
        // Cooperative cancellation. A real handler (a streamed export) checks this between
        // batches; failing loudly here means the drain path is covered by the noop test.
        throw new AppError('unavailable', 'noop aborted during drain', {
          retryable: true,
          context: { step, steps },
        });
      }
      await ctx.progress(step, steps, `noop step ${String(step)} of ${String(steps)}`);
      if (stepDelayMs > 0) await sleep(stepDelayMs);
    }

    return { ok: true, steps, attempt: ctx.attempt, label: label ?? null };
  },
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (typeof t === 'object' && 'unref' in t) t.unref();
  });
}
