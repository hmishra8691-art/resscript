import { describe, expect, it } from 'vitest';

import {
  createMetrics,
  describeSample,
  getMetricSink,
  InMemorySink,
  LogMetricSink,
  METRICS,
  metrics as ambientMetrics,
  MultiSink,
  NoopSink,
  setMetricSink,
  type MetricName,
} from './metrics.js';

/** The exact list from roadmap M0.4. If this test needs editing, a design review is due. */
const ROADMAP_METRIC_NAMES = [
  'logic.divergence',
  'quota.reserve.latency',
  'quota.drift',
  'artifact.cache.hit',
  'compile.duration',
  'submit.duration',
  'page.render.duration',
  'script.sandbox.violation',
] as const;

describe('the metric vocabulary', () => {
  it('is exactly the roadmap M0.4 list — no additions, no omissions', () => {
    expect(Object.keys(METRICS).sort()).toEqual([...ROADMAP_METRIC_NAMES].sort());
  });

  it('declares a kind, a unit and a closed label set for every metric', () => {
    for (const [name, def] of Object.entries(METRICS)) {
      expect(['counter', 'histogram', 'gauge'], name).toContain(def.kind);
      expect(def.description.length, name).toBeGreaterThan(10);
      expect(def.labels.length, name).toBeGreaterThan(0);
      // A duration must be in ms so dashboards can be built without per-metric unit lookups.
      if (name.endsWith('.duration') || name.endsWith('.latency')) {
        expect(def.unit, name).toBe('ms');
      }
    }
  });
});

/**
 * Compile-time assertions.
 *
 * These live in a function that is never called: `@ts-expect-error` is checked by `tsc`, so the
 * assertion is made by `pnpm typecheck` failing if any of these lines becomes LEGAL. Running
 * them would be meaningless (and would exercise the facade's out-of-contract guard rather than
 * the type system), so we type-check them and do not execute them.
 */
function __typeAssertions(): void {
  const m = createMetrics(new NoopSink());

  // The whole point of the facade: a name that is not in the registry does not compile.
  // @ts-expect-error - 'logic.divergance' is a typo and must not be a valid metric name
  m.increment('logic.divergance');

  // @ts-expect-error - a plausible but unregistered name; adding one is a design decision
  m.observe('worker.job.duration', 5);

  // @ts-expect-error - counters cannot be observed as histograms
  m.observe('logic.divergence', 1);

  // @ts-expect-error - histograms cannot be incremented as counters
  m.increment('submit.duration');

  // @ts-expect-error - gauges are neither incremented nor observed
  m.increment('quota.drift');

  // @ts-expect-error - 'respondent_id' is unbounded cardinality and is not a declared label
  m.increment('logic.divergence', { respondent_id: 'r_1' });

  // @ts-expect-error - a typo in an otherwise-declared label key
  m.increment('logic.divergence', { survey_version_ids: 'sv_1' });

  // @ts-expect-error - 'store' belongs to quota.reserve.latency, not to submit.duration
  m.observe('submit.duration', 1, { store: 'redis' });

  // @ts-expect-error - gauges take a value
  m.gauge('quota.drift');
}

describe('typing', () => {
  it('has compile-time assertions that tsc enforces', () => {
    // The real assertion is in __typeAssertions above, verified by `tsc -b`. This test exists
    // so the function is referenced (and so the intent is visible in the test report).
    expect(typeof __typeAssertions).toBe('function');
  });

  it('drops an out-of-contract metric name instead of throwing', () => {
    // Defence in depth for a JS caller that got past the type system.
    const sink = new InMemorySink();
    const m = createMetrics(sink) as unknown as { increment(n: string): void };
    expect(() => m.increment('not.a.metric')).not.toThrow();
    expect(sink.samples).toHaveLength(0);
  });

  it('accepts every declared label key', () => {
    const sink = new InMemorySink();
    const m = createMetrics(sink);
    m.increment('logic.divergence', {
      survey_version_id: 'sv_1',
      page_id: 'pg_1',
      divergence_kind: 'shown_set',
    });
    m.observe('quota.reserve.latency', 4, {
      survey_version_id: 'sv_1',
      outcome: 'reserved',
      store: 'redis',
    });
    m.gauge('quota.drift', 2, { survey_version_id: 'sv_1', quota_plan_ref: 'MAIN', cell_id: 'c1' });
    m.increment('artifact.cache.hit', { tier: 'lru', result: 'hit' });
    m.observe('compile.duration', 1200, { survey_version_id: 'sv_1', outcome: 'succeeded' });
    m.observe('submit.duration', 180, { survey_version_id: 'sv_1', page_id: 'pg_1', outcome: 'ok' });
    m.observe('page.render.duration', 90, { survey_version_id: 'sv_1', cache: 'warm' });
    m.increment('script.sandbox.violation', { hook: 'onPageSubmit', violation: 'network' });
    expect(sink.samples).toHaveLength(8);
  });
});

describe('recording', () => {
  it('increments a counter, defaulting to 1', () => {
    const sink = new InMemorySink();
    const m = createMetrics(sink);
    m.increment('logic.divergence', { survey_version_id: 'sv_1' });
    m.increment('logic.divergence', { survey_version_id: 'sv_1' }, 4);
    m.increment('logic.divergence', { survey_version_id: 'sv_2' });

    expect(sink.counterValue('logic.divergence')).toBe(6);
    expect(sink.counterValue('logic.divergence', { survey_version_id: 'sv_1' })).toBe(5);
    expect(sink.of('logic.divergence')[0]).toMatchObject({ kind: 'counter', unit: '1', value: 1 });
  });

  it('observes a histogram and reads back the observations in order', () => {
    const sink = new InMemorySink();
    const m = createMetrics(sink);
    m.observe('submit.duration', 120, { outcome: 'ok' });
    m.observe('submit.duration', 240, { outcome: 'ok' });
    expect(sink.observations('submit.duration')).toEqual([120, 240]);
    expect(sink.of('submit.duration')[0]?.unit).toBe('ms');
  });

  it('keeps only the last value of a gauge', () => {
    const sink = new InMemorySink();
    const m = createMetrics(sink);
    m.gauge('quota.drift', 5, { cell_id: 'c1' });
    m.gauge('quota.drift', 2, { cell_id: 'c1' });
    expect(sink.gaugeValue('quota.drift', { cell_id: 'c1' })).toBe(2);
    expect(sink.gaugeValue('quota.drift', { cell_id: 'nope' })).toBeUndefined();
  });

  it('startTimer measures elapsed ms and merges labels supplied at stop', () => {
    let t = 1_000;
    const sink = new InMemorySink();
    const m = createMetrics(sink, () => t);
    const stop = m.startTimer('compile.duration', { survey_version_id: 'sv_1' });
    t += 1_234;
    const elapsed = stop({ outcome: 'succeeded' });

    expect(elapsed).toBe(1_234);
    expect(sink.of('compile.duration')[0]).toMatchObject({
      value: 1_234,
      labels: { survey_version_id: 'sv_1', outcome: 'succeeded' },
    });
  });

  it('drops undefined labels rather than emitting a null series', () => {
    const sink = new InMemorySink();
    createMetrics(sink).observe('submit.duration', 1, {
      survey_version_id: 'sv_1',
      page_id: undefined,
    });
    expect(sink.samples[0]?.labels).toEqual({ survey_version_id: 'sv_1' });
  });

  it('stamps each sample with a timestamp from the injected clock', () => {
    const sink = new InMemorySink();
    createMetrics(sink, () => 42).increment('artifact.cache.hit', { result: 'miss' });
    expect(sink.samples[0]?.at).toBe(42);
  });
});

describe('sinks', () => {
  it('NoopSink discards without throwing', () => {
    const m = createMetrics(new NoopSink());
    expect(() => m.increment('logic.divergence')).not.toThrow();
  });

  it('LogMetricSink emits one JSON line per sample, tagged kind=metric', () => {
    const lines: string[] = [];
    createMetrics(new LogMetricSink((l) => lines.push(l), 'runtime'), () => 0).observe(
      'page.render.duration',
      12,
      { cache: 'cold' },
    );
    expect(JSON.parse(lines[0] ?? '{}')).toEqual({
      ts: '1970-01-01T00:00:00.000Z',
      kind: 'metric',
      service: 'runtime',
      metric: 'page.render.duration',
      type: 'histogram',
      value: 12,
      unit: 'ms',
      labels: { cache: 'cold' },
    });
  });

  it('MultiSink fans out', async () => {
    const a = new InMemorySink();
    const b = new InMemorySink();
    createMetrics(new MultiSink([a, b])).increment('logic.divergence');
    expect(a.samples).toHaveLength(1);
    expect(b.samples).toHaveLength(1);
    await expect(new MultiSink([a, b]).flush()).resolves.toBeUndefined();
  });

  it('InMemorySink.reset clears', () => {
    const sink = new InMemorySink();
    createMetrics(sink).increment('logic.divergence');
    sink.reset();
    expect(sink.samples).toHaveLength(0);
  });

  it('withSink returns an independent facade', () => {
    const a = new InMemorySink();
    const b = new InMemorySink();
    const m = createMetrics(a);
    m.withSink(b).increment('logic.divergence');
    expect(a.samples).toHaveLength(0);
    expect(b.samples).toHaveLength(1);
  });
});

describe('the ambient facade', () => {
  it('resolves the sink at call time, not at import time', () => {
    // The classic metric-singleton bug: a module that captured `metrics` at import must still
    // write to a sink configured later in startup.
    const original = getMetricSink();
    try {
      const late = new InMemorySink();
      ambientMetrics.increment('logic.divergence'); // goes to the default NoopSink
      setMetricSink(late);
      ambientMetrics.increment('logic.divergence');
      expect(late.samples).toHaveLength(1);
      expect(ambientMetrics.sink).toBe(late);
    } finally {
      setMetricSink(original);
    }
  });
});

describe('describeSample', () => {
  it('formats each kind', () => {
    const at = 0;
    expect(
      describeSample({
        name: 'logic.divergence',
        kind: 'counter',
        value: 2,
        unit: '1',
        labels: {},
        at,
      }),
    ).toBe('logic.divergence +2');
    expect(
      describeSample({
        name: 'submit.duration',
        kind: 'histogram',
        value: 9,
        unit: 'ms',
        labels: {},
        at,
      }),
    ).toBe('submit.duration = 9ms');
    expect(
      describeSample({ name: 'quota.drift', kind: 'gauge', value: 1, unit: '1', labels: {}, at }),
    ).toBe('quota.drift -> 1');
  });

  it('throws on a kind outside the union — the never guard', () => {
    const rogue = {
      name: 'quota.drift' as MetricName,
      kind: 'summary',
      value: 1,
      unit: '1',
      labels: {},
      at: 0,
    } as unknown as Parameters<typeof describeSample>[0];
    expect(() => describeSample(rogue)).toThrow('unhandled metric kind: summary');
  });
});
