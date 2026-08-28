/**
 * The shared rotation ticket (roadmap P2-03).
 *
 * Run against a real Redis when `REDIS_URL` is set, which is where the interesting properties live:
 * a monotonic ticket is a claim about concurrency, and a fake that returns `n++` proves nothing
 * about it.
 *
 * The properties:
 *
 *  * MONOTONIC AND UNIQUE under concurrency. This is the whole feature — the roadmap's acceptance
 *    line ("1,000 sequential entries distribute starting offsets within one of even") is a claim
 *    about a counter nobody skips or repeats.
 *  * ZERO-BASED, so the first respondent of a wave sees the order the author wrote and a manual
 *    spot-check means something.
 *  * NULL, not 0, when Redis is unreachable. A zero would put every respondent at offset 0 during
 *    an outage — a survey with no rotation pretending to have one.
 */

import { afterAll, describe, expect, it } from 'vitest';

import { createRotationCounter, readRotationCounter, ROTATION_KEY_PREFIX } from './rotation.js';

const REDIS_URL = process.env['REDIS_URL'] ?? 'redis://127.0.0.1:6379';
const HAVE_REDIS = process.env['REDIS_URL'] !== undefined || process.env['CI'] === undefined;

const VER = `ver_test_${String(Date.now())}_${String(Math.floor(Math.random() * 1e6))}`;
const counter = createRotationCounter(REDIS_URL);

afterAll(async () => {
  await counter.close();
});

describe.skipIf(!HAVE_REDIS)('createRotationCounter against a real Redis', () => {
  it('is ZERO-based, so the first respondent sees the authored order', async () => {
    // Deliberate: `rotate` leaves the declared order alone at offset 0, which makes a manual
    // spot-check of the first entry meaningful.
    const first = await counter.next(`${VER}_zero`);
    expect(first).toBe(0);
  });

  it('increments once per call', async () => {
    const key = `${VER}_seq`;
    const tickets = [
      await counter.next(key),
      await counter.next(key),
      await counter.next(key),
    ];
    expect(tickets).toEqual([0, 1, 2]);
  });

  it('is UNIQUE and gapless under 200 concurrent calls', async () => {
    // The property the distribution guarantee rests on. A counter that skipped would leave a
    // rotation with holes; one that repeated would double-load a position. Neither is visible
    // without a test like this.
    const key = `${VER}_race`;
    const tickets = await Promise.all(Array.from({ length: 200 }, () => counter.next(key)));
    const set = new Set(tickets);

    expect(set.size).toBe(200); // no repeats
    expect(Math.min(...(tickets as number[]))).toBe(0);
    expect(Math.max(...(tickets as number[]))).toBe(199); // no gaps
  });

  it('keeps counters separate per version', async () => {
    // One counter per fielding version: two surveys must not share a rotation, or each advances at
    // twice the rate and "even across respondents" stops being true of either.
    const a = await counter.next(`${VER}_a`);
    await counter.next(`${VER}_b`);
    await counter.next(`${VER}_b`);
    expect(a).toBe(0);
    expect(await counter.next(`${VER}_a`)).toBe(1);
  });

  it('is readable for the write-behind drain', async () => {
    const { Redis } = await import('ioredis');
    const raw = new Redis(REDIS_URL, { maxRetriesPerRequest: 1 });
    try {
      const key = `${VER}_drain`;
      await counter.next(key);
      await counter.next(key);
      expect(await readRotationCounter(raw, key)).toBe(2);
      // A version nobody has entered reads as null, not 0 — "no counter yet" and "counter at zero"
      // are different facts, and flushing a 0 for the first would write a row that says nothing.
      expect(await readRotationCounter(raw, `${VER}_never`)).toBeNull();
    } finally {
      await raw.quit().catch(() => undefined);
    }
  });

  it('uses the documented key prefix, so the drain and the issuer agree', async () => {
    const { Redis } = await import('ioredis');
    const raw = new Redis(REDIS_URL, { maxRetriesPerRequest: 1 });
    try {
      const key = `${VER}_prefix`;
      await counter.next(key);
      expect(await raw.get(`${ROTATION_KEY_PREFIX}:${key}`)).toBe('1');
    } finally {
      await raw.quit().catch(() => undefined);
    }
  });
});

describe('when Redis is unreachable', () => {
  it('returns NULL rather than 0 or a throw', async () => {
    // A zero would put every respondent at offset 0 during an outage — a survey with no rotation
    // pretending to have one. Null makes `randomize()` report `needs_counter` and leave the declared
    // order alone, which is visibly unrotated rather than silently unbalanced.
    const dead = createRotationCounter('redis://127.0.0.1:1');
    try {
      expect(await dead.next('ver_x')).toBeNull();
    } finally {
      await dead.close();
    }
  }, 15_000);
});
