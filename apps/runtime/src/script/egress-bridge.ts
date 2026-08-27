/**
 * `survey.http` from inside a synchronous sandbox — replay with memoized effects.
 *
 * ## The problem this exists to solve
 *
 * The QuickJS bridge is synchronous. `__host(op, argsJson)` returns a string; there is no way for
 * the sandboxed script to await anything, and `RunScriptInput.http` is typed synchronous for that
 * reason. Real egress is asynchronous. The three ways out, and why two are wrong:
 *
 *  1. **Block the event loop** (`Atomics.wait` on a worker's SharedArrayBuffer). It works, and it is
 *     what most sync-over-async shims do. It is unusable here: `apps/runtime` serves every
 *     concurrent respondent on one event loop, so a 5-second fetch by one survey's script would
 *     stall every other respondent on the node. A per-script budget that a script can spend out of
 *     *everyone else's* latency is not a budget.
 *  2. **Declare the calls up front** and prefetch. Nothing in the schema declares them, and a URL
 *     computed from a respondent's answers — which is the entire point of `survey.http` — cannot be
 *     known before the script runs.
 *  3. **Run, stop at the first call, perform it, run AGAIN with the answer memoized.** This is what
 *     is implemented.
 *
 * ## Why replay is sound here specifically
 *
 * Replay is only correct for a deterministic program, and this one is deterministic by
 * construction rather than by hope. ADR-006 put a seeded counter-based PRNG in the engine and
 * banned `Math.random` and the clock; `host.ts` exposes randomness only as
 * `survey.context.random(salt)`, which is a pure function of the salt. So a script re-run with the
 * same inputs takes the same path and issues the same calls in the same order.
 *
 * The aborted run's side effects cannot leak, and this is a property of the host rather than
 * something this module has to clean up: `host.run` builds `writes`, `flags`, `logs` and
 * `terminate` fresh per run and returns them only on the `ok: true` branch. An abandoned attempt
 * returns `ok: false` and its overlay is discarded with the context.
 *
 * ## Memoized by ORDINAL, and verified
 *
 * The cache is keyed by call index — first call, second call — not by the request's content. Two
 * reasons, and the second is the important one:
 *
 *  - Content-keying collapses two deliberate identical calls into one. `POST /events` twice is two
 *    events, and a survey that logs a respondent's progress twice must not silently log it once.
 *  - Ordinal-keying gives a **divergence check for free**. On replay, call `n` must be the same
 *    request it was last time. If it is not, the script is not deterministic — and replay is
 *    unsound for a non-deterministic script, so the run fails with a named reason rather than
 *    quietly returning an answer computed from a different program than the one that asked. This is
 *    ADR-004's divergence-detector reasoning applied to the sandbox: an assumption the system
 *    depends on is checked, not trusted.
 *
 * ## Cost
 *
 * A script making `n` http calls is executed `n + 1` times. That is bounded and cheap: each attempt
 * is capped by the instruction and wall-clock budgets in `host.ts`, `n` is capped by
 * `budgets.max_http_calls`, and the wall-clock budget is re-armed per attempt while the fetches —
 * the actually slow part — happen once each. The alternative was stalling every other respondent.
 */

import type { EgressRequest, EgressResponse } from './egress.js';
import { EgressDenied } from './egress.js';
import type { RunScriptInput, ScriptHost, ScriptResult } from './host.js';

/** What a run needs in order to reach the network at all. Absent = `host.ts` denies every call. */
export interface EgressPerformer {
  perform(req: EgressRequest): Promise<EgressResponse>;
}

/**
 * The sentinel a paused attempt throws. Carries nothing: the request travels on the side channel,
 * because a message parsed back out of an error string is a contract nobody can typecheck.
 */
const PAUSE_MESSAGE = 'http_pending: the runtime will perform this call and re-run the script';

interface Recorded {
  readonly req: EgressRequest;
  readonly res: EgressResponse;
}

/** Same canonical form on both sides of the divergence check. */
function requestIdentity(req: EgressRequest): string {
  const headers = Object.entries(req.headers ?? {})
    .map(([k, v]) => `${k.toLowerCase()}:${v}`)
    .sort()
    .join('\n');
  return `${req.method.toUpperCase()} ${req.url}\n${headers}\n${req.body ?? ''}`;
}

/**
 * Wrap a `ScriptHost` so `survey.http` works, routed through `performer` and nothing else.
 *
 * Without a performer this returns the host unchanged, which is the secure default: `host.ts`
 * throws `http_denied` when `input.http` is absent, so a deployment that has not configured an
 * allowlist denies every call rather than falling back to an unrestricted fetch.
 */
export function withEgress(host: ScriptHost, performer?: EgressPerformer): ScriptHost {
  if (performer === undefined) return host;

  return {
    async run(input: RunScriptInput): Promise<ScriptResult> {
      const recorded: Recorded[] = [];
      // The ceiling on attempts is the host's own call budget. Read here rather than re-derived so
      // the two cannot drift: if `host.ts` raises `max_http_calls`, this follows.
      const maxCalls = input.budgets?.max_http_calls ?? DEFAULT_MAX_HTTP_CALLS;

      let last: ScriptResult | null = null;
      for (let attempt = 0; attempt <= maxCalls; attempt += 1) {
        let pending: EgressRequest | null = null;
        let divergedAt: number | null = null;
        let calls = 0;

        const httpBridge = (req: EgressRequest): EgressResponse => {
          const index = calls;
          calls += 1;
          const hit = recorded[index];
          if (hit !== undefined) {
            if (requestIdentity(hit.req) !== requestIdentity(req)) {
              // The script asked for something different than it did last time. Replay is unsound
              // for a non-deterministic script; see the header.
              divergedAt = index;
              throw new Error('http_denied: the script is not deterministic across replay');
            }
            return hit.res;
          }
          // First time this ordinal has been reached. Pause the attempt; the caller performs it.
          pending = req;
          throw new Error(PAUSE_MESSAGE);
        };

        const result = await host.run({ ...input, http: httpBridge });
        last = result;

        if (result.ok) return result;
        if (divergedAt !== null) {
          return {
            ...result,
            reason: 'http_denied',
            error:
              `survey.http call #${String(divergedAt + 1)} differed from the same call on the ` +
              'previous attempt, so the script does not take the same path when re-run. The ' +
              'engine is deterministic by design (ADR-006), so this means the script itself is ' +
              'not — most often a captured value that changes between calls. The result is ' +
              'refused rather than computed from a different program than the one that asked.',
          };
        }
        // Not-ok for any reason other than a pause is the real outcome: a timeout, an OOM, a
        // genuine throw. Returned as-is, so a broken script reports what broke it.
        if (pending === null) return result;

        try {
          const res = await performer.perform(pending);
          recorded.push({ req: pending, res });
        } catch (err: unknown) {
          if (err instanceof EgressDenied) {
            // A refusal is data the script can handle, not a crash: a survey that falls back to a
            // default when its enrichment API is unreachable is the behaviour an author wants, and
            // a denial should look the same to the script as any other failure. The reason travels
            // in the body so the author can see WHY in their own logs.
            recorded.push({
              req: pending,
              res: {
                status: 0,
                headers: {},
                body: JSON.stringify({ error: err.reason, message: err.message }),
              },
            });
          } else {
            // A transport failure, likewise, rather than a 500 for the respondent.
            recorded.push({
              req: pending,
              res: {
                status: 0,
                headers: {},
                body: JSON.stringify({ error: 'transport', message: String(err) }),
              },
            });
          }
        }
      }

      // Exhausted the attempt ceiling. `host.ts` enforces the same budget from inside, so reaching
      // this means the script made exactly `maxCalls` calls and then needed one more attempt to
      // finish; the last attempt's own failure is the honest thing to report.
      return (
        last ?? {
          ok: false,
          reason: 'http_denied',
          error: 'the script exceeded its http call budget',
          logs: [],
          wall_ms: 0,
          interrupts: 0,
        }
      );
    },
  };
}

/** Mirrors `host.ts`' default. Duplicated because it is not exported there; asserted in the tests. */
const DEFAULT_MAX_HTTP_CALLS = 2;
