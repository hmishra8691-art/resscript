/**
 * `survey.http` via replay — roadmap P2-11.
 *
 * The bridge runs a script once per http call plus one, memoizing each answer by call ordinal. The
 * properties that make that sound, and that nothing else checks:
 *
 *  - **A completed run's result is the LAST attempt's**, and the abandoned attempts' writes, flags
 *    and logs do not leak. An overlay accumulated across replays would double every write.
 *  - **Each distinct call is performed exactly once**, however many attempts it takes to finish.
 *    Re-issuing a POST on every replay is the failure mode that turns one event into four.
 *  - **Two deliberate identical calls stay two calls.** This is why the cache is keyed by ordinal
 *    rather than by request content.
 *  - **A script that diverges on replay is refused**, not answered. Replay is unsound for a
 *    non-deterministic program, and computing a result from a different program than the one that
 *    asked is worse than failing.
 *  - **A denial reaches the script as a response**, so an author's fallback path runs, rather than
 *    as a crash that screens the respondent out.
 *
 * A stub `ScriptHost` stands in for QuickJS. That is the right seam: the WASM host has its own
 * suite, and what is under test here is the replay protocol — how many times the script runs, what
 * it sees on each run, and what survives. Driving real QuickJS would test the sandbox again and
 * this protocol only incidentally.
 */

import { describe, expect, it, vi } from 'vitest';

import { EgressDenied, type EgressRequest, type EgressResponse } from './egress.js';
import { withEgress } from './egress-bridge.js';
import type { RunScriptInput, ScriptHost, ScriptResult } from './host.js';

/* ---------------------------------------------------------------- *
 * A stub host that behaves like the real one in the ways that matter
 * ---------------------------------------------------------------- */

/**
 * `script` is the body: it receives the same synchronous `http` the sandbox would, and whatever it
 * throws becomes an `ok: false` result — which is exactly how `host.ts` reports a throw. Fresh
 * `writes`/`flags`/`logs` per run, because that per-run freshness is the property that makes an
 * abandoned attempt harmless, and a stub that shared them would hide a real bug.
 */
function stubHost(
  script: (http: NonNullable<RunScriptInput['http']>, run: number) => Record<string, unknown>,
): ScriptHost & { runs: number } {
  let runs = 0;
  const host = {
    get runs() {
      return runs;
    },
    async run(input: RunScriptInput): Promise<ScriptResult> {
      runs += 1;
      const http =
        input.http ??
        (() => {
          throw new Error('http_denied: no allowlisted egress proxy is configured');
        });
      try {
        const writes = script(http, runs);
        return {
          ok: true,
          writes,
          flags: [],
          terminate: null,
          reject: null,
          logs: [],
          wall_ms: 1,
          interrupts: 0,
        };
      } catch (err: unknown) {
        return {
          ok: false,
          reason: 'throw',
          error: String(err),
          logs: [],
          wall_ms: 1,
          interrupts: 0,
        };
      }
    },
  };
  return host as ScriptHost & { runs: number };
}

const INPUT: RunScriptInput = {
  source: '',
  assetRef: 'sc_1',
  seed: 'seed',
  context: {} as never,
  getValue: () => undefined,
  varKind: () => 'hidden',
  wasShown: () => false,
};

function performer(handler: (req: EgressRequest) => Promise<EgressResponse>) {
  return { perform: vi.fn(handler) };
}

const OK = (body: string): EgressResponse => ({ status: 200, headers: {}, body });

/* ---------------------------------------------------------------- *
 * The default: no performer, no egress
 * ---------------------------------------------------------------- */

describe('without a performer', () => {
  it('returns the host unchanged, so the host denies every call', async () => {
    // The secure default. A deployment that has not configured an allowlist must deny, not fall
    // back to an unrestricted fetch.
    const host = stubHost(http => ({ x: http({ method: 'GET', url: 'https://a/' }).body }));
    expect(withEgress(host, undefined)).toBe(host);

    const result = await withEgress(host, undefined).run(INPUT);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('http_denied');
  });
});

/* ---------------------------------------------------------------- *
 * The replay protocol
 * ---------------------------------------------------------------- */

describe('replay', () => {
  it('runs a script with no http calls exactly once', async () => {
    const host = stubHost(() => ({ A: 1 }));
    const p = performer(async () => OK('never'));

    const result = await withEgress(host, p).run(INPUT);

    expect(result.ok).toBe(true);
    expect(host.runs).toBe(1);
    expect(p.perform).not.toHaveBeenCalled();
  });

  it('runs twice for one call, and the second run sees the response', async () => {
    const host = stubHost(http => ({
      A: http({ method: 'GET', url: 'https://api.acme.example/x' }).body,
    }));
    const p = performer(async () => OK('answer'));

    const result = await withEgress(host, p).run(INPUT);

    expect(host.runs).toBe(2);
    expect(p.perform).toHaveBeenCalledTimes(1);
    expect(result.ok && result.writes).toEqual({ A: 'answer' });
  });

  it('performs each distinct call exactly once across all attempts', async () => {
    // The property that stops a POST becoming four POSTs. Two calls means three runs, and the first
    // call is re-served from cache on runs 2 and 3 rather than re-issued.
    const seen: string[] = [];
    const host = stubHost(http => {
      const a = http({ method: 'POST', url: 'https://api.acme.example/1' }).body;
      const b = http({ method: 'POST', url: 'https://api.acme.example/2' }).body;
      return { A: a, B: b };
    });
    const p = performer(async req => {
      seen.push(req.url);
      return OK(req.url.endsWith('1') ? 'one' : 'two');
    });

    const result = await withEgress(host, p).run(INPUT);

    expect(host.runs).toBe(3);
    expect(seen).toEqual(['https://api.acme.example/1', 'https://api.acme.example/2']);
    expect(result.ok && result.writes).toEqual({ A: 'one', B: 'two' });
  });

  it('keeps two deliberate identical calls as two calls', async () => {
    // Content-keying would collapse these into one. `POST /events` twice is two events, and a
    // survey that logs a respondent's progress twice must not silently log it once.
    let n = 0;
    const host = stubHost(http => {
      const a = http({ method: 'POST', url: 'https://api.acme.example/events', body: 'e' }).body;
      const b = http({ method: 'POST', url: 'https://api.acme.example/events', body: 'e' }).body;
      return { A: a, B: b };
    });
    const p = performer(async () => OK(`call${String((n += 1))}`));

    const result = await withEgress(host, p).run(INPUT);

    expect(p.perform).toHaveBeenCalledTimes(2);
    expect(result.ok && result.writes).toEqual({ A: 'call1', B: 'call2' });
  });

  it('returns only the LAST attempt\'s writes, so nothing accumulates', async () => {
    // An overlay carried across replays would double every write. The stub builds a fresh one per
    // run for the same reason the real host does.
    const host = stubHost((http, run) => {
      const a = http({ method: 'GET', url: 'https://api.acme.example/x' }).body;
      return { A: a, RUN: run };
    });
    const p = performer(async () => OK('v'));

    const result = await withEgress(host, p).run(INPUT);

    expect(result.ok && result.writes).toEqual({ A: 'v', RUN: 2 });
  });
});

/* ---------------------------------------------------------------- *
 * Divergence
 * ---------------------------------------------------------------- */

describe('divergence', () => {
  it('refuses a script whose call #1 differs on replay', async () => {
    // Replay is only sound for a deterministic program. This one asks for a different URL each
    // time, so the answer it would receive was computed for a different question.
    const host = stubHost((http, run) => ({
      A: http({ method: 'GET', url: `https://api.acme.example/${String(run)}` }).body,
    }));
    const p = performer(async () => OK('v'));

    const result = await withEgress(host, p).run(INPUT);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('http_denied');
      expect(result.error).toContain('call #1');
      expect(result.error).toContain('does not take the same path when re-run');
    }
  });

  it('names the ordinal that diverged, not the first one', async () => {
    const host = stubHost((http, run) => {
      http({ method: 'GET', url: 'https://api.acme.example/stable' });
      return {
        B: http({ method: 'GET', url: `https://api.acme.example/${String(run)}` }).body,
      };
    });
    const p = performer(async () => OK('v'));

    const result = await withEgress(host, p).run(INPUT);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('call #2');
  });

  it('treats a changed body or header as divergence, not just a changed URL', async () => {
    const host = stubHost((http, run) => ({
      A: http({
        method: 'POST',
        url: 'https://api.acme.example/x',
        body: `run=${String(run)}`,
      }).body,
    }));
    const p = performer(async () => OK('v'));

    const result = await withEgress(host, p).run(INPUT);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('http_denied');
  });

  it('does NOT call divergence on header order or case', async () => {
    // The identity is canonical, so a script that builds its headers in a different order — which a
    // deterministic script legitimately may, object key order is not part of its meaning — is not
    // accused of non-determinism.
    const host = stubHost((http, run) => ({
      A: http({
        method: 'GET',
        url: 'https://api.acme.example/x',
        headers:
          run === 1
            ? { 'Content-Type': 'a', Authorization: 'b' }
            : { authorization: 'b', 'content-type': 'a' },
      }).body,
    }));
    const p = performer(async () => OK('v'));

    const result = await withEgress(host, p).run(INPUT);
    expect(result.ok).toBe(true);
  });
});

/* ---------------------------------------------------------------- *
 * Failures reach the script as responses
 * ---------------------------------------------------------------- */

describe('failures', () => {
  it('hands a denial to the script as a status-0 response', async () => {
    // A survey that falls back to a default when its enrichment API is unreachable is the behaviour
    // an author wants; a denial should look like any other failure, not screen the respondent out.
    const host = stubHost(http => {
      const r = http({ method: 'GET', url: 'https://blocked.example/' });
      return { STATUS: r.status, BODY: r.body };
    });
    const p = performer(async () => {
      throw new EgressDenied('blocked_address', 'resolves to 169.254.169.254');
    });

    const result = await withEgress(host, p).run(INPUT);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.writes['STATUS']).toBe(0);
      expect(String(result.writes['BODY'])).toContain('blocked_address');
    }
  });

  it('hands a transport failure to the script the same way', async () => {
    const host = stubHost(http => ({
      STATUS: http({ method: 'GET', url: 'https://api.acme.example/' }).status,
    }));
    const p = performer(async () => {
      throw new Error('ECONNRESET');
    });

    const result = await withEgress(host, p).run(INPUT);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.writes['STATUS']).toBe(0);
  });

  it('does not retry a failed call — the answer is cached, including the failure', async () => {
    // Otherwise a script in a loop turns one unreachable host into `max_http_calls` attempts, and
    // the budget stops meaning what it says.
    const host = stubHost(http => ({
      A: http({ method: 'GET', url: 'https://api.acme.example/' }).status,
      B: http({ method: 'GET', url: 'https://api.acme.example/' }).status,
    }));
    const p = performer(async () => {
      throw new Error('ECONNRESET');
    });

    await withEgress(host, p).run(INPUT);
    // Two ordinals, two performs — but neither is retried.
    expect(p.perform).toHaveBeenCalledTimes(2);
  });

  it('returns a genuine script error as itself, not as a pause', async () => {
    const host = stubHost(() => {
      throw new Error('TypeError: x is not a function');
    });
    const p = performer(async () => OK('v'));

    const result = await withEgress(host, p).run(INPUT);

    expect(host.runs).toBe(1);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('throw');
      expect(result.error).toContain('not a function');
    }
  });

  it('stops at the call budget rather than replaying forever', async () => {
    // A script whose call count exceeds the budget must terminate. The real host enforces the same
    // ceiling from inside; this asserts the outer loop does not spin.
    const host = stubHost(http => {
      for (let i = 0; i < 50; i += 1) {
        http({ method: 'GET', url: `https://api.acme.example/${String(i)}` });
      }
      return {};
    });
    const p = performer(async () => OK('v'));

    const result = await withEgress(host, p).run({ ...INPUT, budgets: { max_http_calls: 3 } });

    expect(result.ok).toBe(false);
    expect(host.runs).toBe(4); // attempts 0..3 inclusive
  });
});
