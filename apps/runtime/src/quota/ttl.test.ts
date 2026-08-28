/**
 * The adaptive reservation TTL (roadmap P2-07).
 *
 * Every case here is a boundary, and the reason to test them individually is that the two failure
 * modes are asymmetric. E §10.3: "Too short and a slow respondent's reservation vanishes and the
 * cell overfills; too long and abandons hold cells for hours and fieldwork stalls." Overfilling is
 * unrecoverable — the extra completes are paid for and cannot be un-collected — while holding a
 * cell too long only delays fieldwork, which an operator can see and wait out. So a shortened TTL
 * has to be harder to reach than a lengthened one, and that asymmetry is what these assertions pin.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  ABSOLUTE_MAX_TTL_S,
  ABSOLUTE_MIN_TTL_S,
  MIN_COMPLETES_FOR_MEASUREMENT,
  createTtlProvider,
  decideTtl,
} from './ttl.js';

const AUTHORED = 1800; // 30 minutes

describe('decideTtl — below the measurement threshold', () => {
  it('uses the authored value with no completes', () => {
    const d = decideTtl(AUTHORED, { completes: 0, medianSeconds: null });
    expect(d).toEqual({ ttlSeconds: AUTHORED, basis: 'authored', completes: 0 });
  });

  it('uses the authored value one complete short of the threshold', () => {
    // A median over a handful of completes swings on the next respondent, and fieldwork operations
    // cannot reason about a number that moves. A deliberate estimate beats an unstable measurement.
    const d = decideTtl(AUTHORED, {
      completes: MIN_COMPLETES_FOR_MEASUREMENT - 1,
      medianSeconds: 60,
    });
    expect(d.basis).toBe('authored');
    expect(d.ttlSeconds).toBe(AUTHORED);
  });

  it('treats a NULL median as no measurement even above the threshold', () => {
    // "Nothing measured" and "measured zero" are different facts, which is why the RPC returns null.
    // Treating null as 0 would compute a TTL of 0 and expire every reservation instantly.
    const d = decideTtl(AUTHORED, { completes: 500, medianSeconds: null });
    expect(d.basis).toBe('authored');
  });
});

describe('decideTtl — at and above the threshold', () => {
  it('uses 3x the median once there are enough completes', () => {
    const d = decideTtl(AUTHORED, { completes: 50, medianSeconds: 600 });
    expect(d.ttlSeconds).toBe(1800);
    expect(d.basis).toBe('measured');
    expect(d.completes).toBe(50);
  });

  it('extends a TTL the author under-estimated', () => {
    // The overfill case: a 45-minute survey with a 30-minute authored TTL. Measured 3x900 = 2700.
    const d = decideTtl(AUTHORED, { completes: 200, medianSeconds: 900 });
    expect(d.ttlSeconds).toBe(2700);
    expect(d.basis).toBe('measured');
  });

  it('shortens a TTL the author over-estimated, all the way', () => {
    // E §10.3's stalled-fieldwork case: a 4-hour authored TTL on a 10-minute survey. The whole
    // point is that the measurement wins here — see the clamp describe below for why bounding this
    // relative to the authored value defeated it.
    const d = decideTtl(4 * 3600, { completes: 200, medianSeconds: 600 });
    expect(d.ttlSeconds).toBe(1800);
    expect(d.basis).toBe('measured');
  });
});

describe('decideTtl — bounded by ABSOLUTE limits, not by the authored value', () => {
  it('does NOT clamp relative to the authored TTL', () => {
    // The correction this test forced. I first clamped the measurement to [0.5x, 4x] the authored
    // value, which anchors the guard to the least reliable number in the calculation — the guess
    // the mechanism exists to replace. E §10.3's stalled-fieldwork case is a four-hour authored TTL
    // on a ten-minute survey, and a 0.5x floor clamped the fix to two hours: the guard was
    // preventing exactly the repair it was written to make safe.
    const d = decideTtl(4 * 3600, { completes: 200, medianSeconds: 600 });
    expect(d.ttlSeconds).toBe(1800); // 3 x 600, freely, not 7200
    expect(d.basis).toBe('measured');
  });

  it('catches a degenerate measurement with the absolute floor', () => {
    // Fifty sessions that all completed in twenty seconds — somebody load-testing against a live
    // version. 3x20 = 60s would expire a reservation while a respondent was reading.
    const d = decideTtl(AUTHORED, { completes: 200, medianSeconds: 20 });
    expect(d.ttlSeconds).toBe(ABSOLUTE_MIN_TTL_S);
    expect(d.basis).toBe('measured_clamped');
  });

  it('catches an absurd measurement with the absolute ceiling', () => {
    const d = decideTtl(AUTHORED, { completes: 200, medianSeconds: 20000 });
    expect(d.ttlSeconds).toBe(ABSOLUTE_MAX_TTL_S);
    expect(d.basis).toBe('measured_clamped');
  });

  it('reports `measured_clamped` so the dashboard can show the number was bounded', () => {
    // An operator looking at "why is my quota stuck" needs to know whether the TTL is the
    // measurement or the guardrail. A single `measured` basis would hide that.
    expect(decideTtl(AUTHORED, { completes: 99, medianSeconds: 20 }).basis).toBe('measured_clamped');
    expect(decideTtl(AUTHORED, { completes: 99, medianSeconds: 600 }).basis).toBe('measured');
  });

  it('respects the absolute floor even when the author asks for less', () => {
    expect(decideTtl(10, { completes: 0, medianSeconds: null }).ttlSeconds).toBe(ABSOLUTE_MIN_TTL_S);
  });

  it('respects the absolute ceiling even when the author asks for more', () => {
    // Past six hours an abandon is an abandon, whatever anybody configured.
    expect(decideTtl(48 * 3600, { completes: 0, medianSeconds: null }).ttlSeconds).toBe(
      ABSOLUTE_MAX_TTL_S,
    );
  });

  it('survives a nonsense authored value rather than propagating NaN', () => {
    // A NaN TTL reaches a Lua EXPIRE and becomes an error the respondent sees.
    expect(decideTtl(Number.NaN, { completes: 0, medianSeconds: null }).ttlSeconds).toBe(
      ABSOLUTE_MIN_TTL_S,
    );
    expect(decideTtl(Number.POSITIVE_INFINITY, { completes: 0, medianSeconds: null }).ttlSeconds).toBe(
      ABSOLUTE_MIN_TTL_S,
    );
  });
});

describe('createTtlProvider', () => {
  it('uses the authored value when no loader is configured', async () => {
    const p = createTtlProvider();
    expect((await p.decide('ver_1', AUTHORED)).basis).toBe('authored');
  });

  it('measures once and reuses the sample within the cache window', async () => {
    // This is on the reservation path, which E §10.3 holds to a p99 under 10 ms. A median over a
    // growing sessions table is not a query to run per respondent.
    const load = vi.fn(async () => ({ completes: 100, medianSeconds: 600 }));
    let clock = 1_000;
    const p = createTtlProvider({ loadSample: load, now: () => clock, cacheMs: 60_000 });

    await p.decide('ver_1', AUTHORED);
    await p.decide('ver_1', AUTHORED);
    clock += 30_000;
    await p.decide('ver_1', AUTHORED);

    expect(load).toHaveBeenCalledTimes(1);
  });

  it('re-measures after the window', async () => {
    const load = vi.fn(async () => ({ completes: 100, medianSeconds: 600 }));
    let clock = 1_000;
    const p = createTtlProvider({ loadSample: load, now: () => clock, cacheMs: 60_000 });

    await p.decide('ver_1', AUTHORED);
    clock += 61_000;
    await p.decide('ver_1', AUTHORED);

    expect(load).toHaveBeenCalledTimes(2);
  });

  it('caches per VERSION, not globally', async () => {
    const load = vi.fn(async (id: string) => ({
      completes: 100,
      medianSeconds: id === 'ver_1' ? 600 : 1200,
    }));
    const p = createTtlProvider({ loadSample: load });

    expect((await p.decide('ver_1', AUTHORED)).ttlSeconds).toBe(1800);
    expect((await p.decide('ver_2', AUTHORED)).ttlSeconds).toBe(3600);
  });

  it('falls back to the authored value when the measurement throws', async () => {
    const p = createTtlProvider({
      loadSample: async () => {
        throw new Error('connection reset');
      },
    });
    const d = await p.decide('ver_1', AUTHORED);
    expect(d.basis).toBe('authored');
    expect(d.ttlSeconds).toBe(AUTHORED);
  });

  it('does NOT cache a failure, so one blip does not pin the survey until restart', async () => {
    let fail = true;
    const load = vi.fn(async () => {
      if (fail) throw new Error('blip');
      return { completes: 100, medianSeconds: 600 };
    });
    const p = createTtlProvider({ loadSample: load });

    expect((await p.decide('ver_1', AUTHORED)).basis).toBe('authored');
    fail = false;
    expect((await p.decide('ver_1', AUTHORED)).basis).toBe('measured');
  });
});
