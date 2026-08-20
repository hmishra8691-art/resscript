import { createCapturingLogger } from '@resscript/observability';
import { describe, expect, it } from 'vitest';

import type { JobRow } from './job-store.js';
import type { JsonObject } from './json.js';
import { buildRegistry } from './kinds/registry.js';
import { noopJob, NOOP_KIND } from './kinds/noop.js';
import { defineJob, JobRegistry, payload as p, type JobContext } from './registry.js';

describe('JobRegistry', () => {
  it('registers a kind and reports it', () => {
    const r = JobRegistry.create().register(NOOP_KIND, noopJob);
    expect(r.kinds()).toEqual(['noop']);
    expect(r.has('noop')).toBe(true);
    expect(r.has('compile')).toBe(false);
    expect(r.size).toBe(1);
    expect(r.get('noop')?.kind).toBe('noop');
    expect(r.get('nope')).toBeUndefined();
  });

  it('is immutable — register returns a NEW registry', () => {
    const base = JobRegistry.create();
    const withNoop = base.register(NOOP_KIND, noopJob);
    expect(base.size).toBe(0);
    expect(withNoop.size).toBe(1);
  });

  it('rejects a duplicate kind at startup rather than letting import order decide', () => {
    const r = JobRegistry.create().register(NOOP_KIND, noopJob);
    expect(() => r.register(NOOP_KIND, noopJob)).toThrow('job kind already registered: noop');
  });

  it('defaults retryUnknownErrors to true and carries maxAttempts through', () => {
    const def = defineJob({
      parse: () => ({}),
      handle: async (): Promise<JsonObject> => ({}),
      maxAttempts: 7,
    });
    const erased = JobRegistry.create().register('x', def).get('x');
    expect(erased?.retryUnknownErrors).toBe(true);
    expect(erased?.maxAttempts).toBe(7);

    const noRetry = JobRegistry.create()
      .register('y', { ...def, retryUnknownErrors: false })
      .get('y');
    expect(noRetry?.retryUnknownErrors).toBe(false);
    expect(noRetry?.maxAttempts).toBe(7);
  });

  it('buildRegistry registers every shipped kind', () => {
    expect(buildRegistry().kinds()).toEqual(['noop']);
  });
});

describe('payload typing', () => {
  it('infers the handler payload from parse — no type arguments at the call site', () => {
    const job = defineJob({
      parse: (raw) => ({
        surveyVersionId: p.requiredString(raw, 'survey_version_id'),
        languages: p.optionalInt(raw, 'languages', 1),
      }),
      handle: async (ctx) => {
        // These lines are the assertion: `ctx.payload` is the parse return type, so a typo or
        // a wrong type here is a compile error rather than a runtime surprise.
        const id: string = ctx.payload.surveyVersionId;
        const n: number = ctx.payload.languages;
        return { id, n } satisfies JsonObject;
      },
    });
    expect(typeof job.handle).toBe('function');

    // @ts-expect-error - 'nope' is not a field of the parsed payload
    void ((ctx: JobContext<{ surveyVersionId: string }>) => ctx.payload.nope);
  });
});

describe('payload helpers', () => {
  it('requiredString rejects missing, empty and wrong-typed values', () => {
    expect(p.requiredString({ a: 'x' }, 'a')).toBe('x');
    expect(() => p.requiredString({}, 'a')).toThrow('payload.a must be a non-empty string');
    expect(() => p.requiredString({ a: '' }, 'a')).toThrow();
    expect(() => p.requiredString({ a: 3 }, 'a')).toThrow();
  });

  it('optionalString treats null and undefined alike', () => {
    expect(p.optionalString({ a: 'x' }, 'a')).toBe('x');
    expect(p.optionalString({ a: null }, 'a')).toBeUndefined();
    expect(p.optionalString({}, 'a')).toBeUndefined();
    expect(() => p.optionalString({ a: 1 }, 'a')).toThrow('payload.a must be a string');
  });

  it('optionalInt falls back and rejects non-integers', () => {
    expect(p.optionalInt({ a: 4 }, 'a', 1)).toBe(4);
    expect(p.optionalInt({}, 'a', 1)).toBe(1);
    expect(p.optionalInt({ a: null }, 'a', 2)).toBe(2);
    expect(() => p.optionalInt({ a: 1.5 }, 'a', 1)).toThrow('payload.a must be an integer');
    expect(() => p.optionalInt({ a: '4' }, 'a', 1)).toThrow();
  });
});

describe('the noop handler in isolation', () => {
  function ctxFor(payloadIn: JsonObject, attempt = 1): {
    ctx: JobContext<ReturnType<typeof noopJob.parse>>;
    progress: { step: number; total: number; message: string }[];
  } {
    const progress: { step: number; total: number; message: string }[] = [];
    const cap = createCapturingLogger({ service: 'worker', level: 'debug' });
    const job = { id: 'job_1', kind: 'noop', attempts: attempt } as unknown as JobRow;
    return {
      progress,
      ctx: {
        job,
        payload: noopJob.parse(payloadIn),
        attempt,
        maxAttempts: 3,
        log: cap.logger,
        signal: new AbortController().signal,
        progress: async (step, total, message = '') => {
          progress.push({ step, total, message });
        },
      },
    };
  }

  it('parses defaults', () => {
    expect(noopJob.parse({})).toEqual({
      steps: 3,
      stepDelayMs: 0,
      label: undefined,
      failTimes: 0,
      failRetryable: true,
    });
  });

  it('rejects an out-of-range step count', () => {
    expect(() => noopJob.parse({ steps: 0 })).toThrow(/between 1 and 1000/);
    expect(() => noopJob.parse({ steps: 1_001 })).toThrow(/between 1 and 1000/);
  });

  it('reports every step and returns a structured result', async () => {
    const { ctx, progress } = ctxFor({ steps: 3, label: 'smoke' });
    await expect(noopJob.handle(ctx)).resolves.toEqual({
      ok: true,
      steps: 3,
      attempt: 1,
      label: 'smoke',
    });
    expect(progress).toEqual([
      { step: 1, total: 3, message: 'noop step 1 of 3' },
      { step: 2, total: 3, message: 'noop step 2 of 3' },
      { step: 3, total: 3, message: 'noop step 3 of 3' },
    ]);
  });

  it('fails on the configured attempts, then succeeds', async () => {
    await expect(noopJob.handle(ctxFor({ failTimes: 2 }, 1).ctx)).rejects.toThrow(
      /deliberate failure on attempt 1/,
    );
    await expect(noopJob.handle(ctxFor({ failTimes: 2 }, 2).ctx)).rejects.toThrow(
      /deliberate failure on attempt 2/,
    );
    await expect(noopJob.handle(ctxFor({ failTimes: 2 }, 3).ctx)).resolves.toMatchObject({
      ok: true,
      attempt: 3,
    });
  });

  it('reports no progress before a deliberate failure, so a retry starts clean', async () => {
    const { ctx, progress } = ctxFor({ failTimes: 1, steps: 5 }, 1);
    await expect(noopJob.handle(ctx)).rejects.toThrow();
    expect(progress).toEqual([]);
  });

  it('honours an aborted signal cooperatively', async () => {
    const controller = new AbortController();
    controller.abort();
    const base = ctxFor({ steps: 5 });
    await expect(noopJob.handle({ ...base.ctx, signal: controller.signal })).rejects.toThrow(
      /aborted during drain/,
    );
    expect(base.progress).toEqual([]);
  });

  it('failRetryable: false produces a non-retryable error', async () => {
    const { ctx } = ctxFor({ failTimes: 1, failRetryable: false }, 1);
    await expect(noopJob.handle(ctx)).rejects.toMatchObject({ retryable: false });
  });
});
