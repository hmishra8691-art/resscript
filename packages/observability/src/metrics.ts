/**
 * The metrics facade.
 *
 * M0.4 exists partly to fix the metric vocabulary BEFORE the milestones that emit against it:
 * "A metrics facade with the names that later milestones will emit against, defined now so they
 * are not invented ad hoc". The eight names in `METRICS` are the complete list from the
 * roadmap. Adding a ninth is a design decision that belongs in a review, not in a pull request
 * that happens to need a counter — so the registry below is closed, and `MetricName` is derived
 * from it. A typo (`logic.divergance`) or an unregistered name is a compile error, not a metric
 * that silently never appears on a dashboard.
 *
 * Label keys are declared per metric for the same reason, plus a harder one: in every
 * dimensional backend, cardinality is cost. A label set that varies per call site produces
 * unqueryable series and a surprise bill. Declaring `labels` makes the allowed dimensions part
 * of the type, so `metrics.increment('logic.divergence', { respondent_id })` — an unbounded
 * label, the classic mistake — does not compile.
 *
 * Deliberately NOT here: a Prometheus/OTLP exporter. `MetricSink` is the seam; the concrete
 * sink is chosen per deployable at startup, because `apps/runtime` cannot afford a client
 * library (ADR-010) while `apps/worker` can.
 */

export type MetricKind = 'counter' | 'histogram' | 'gauge';

export interface MetricDefinition {
  readonly kind: MetricKind;
  /** The allowed label keys. Closed set: cardinality is cost. */
  readonly labels: readonly string[];
  /** UCUM-ish unit. `ms` for durations, `1` for dimensionless counts. */
  readonly unit: string;
  readonly description: string;
}

/**
 * The closed metric registry.
 *
 * `as const satisfies` rather than a plain annotation: `satisfies` checks each entry against
 * `MetricDefinition` while `as const` keeps the literal key and label types, which is what
 * makes per-metric label typing possible.
 */
export const METRICS = {
  /**
   * arch §3.3 step 9: the client's logic verdict disagreed with the server's. This is the
   * canary for engine bugs (ADR-004 dual evaluation) and the single most important number in
   * the system — a non-zero rate means preview and field disagree.
   */
  'logic.divergence': {
    kind: 'counter',
    labels: ['survey_version_id', 'page_id', 'divergence_kind'],
    unit: '1',
    description: 'Client logic verdict differed from the authoritative server verdict',
  },

  /** arch §8 budget: quota reservation < 10 ms p99. One Redis Lua round trip (ADR-008). */
  'quota.reserve.latency': {
    kind: 'histogram',
    labels: ['survey_version_id', 'outcome', 'store'],
    unit: 'ms',
    description: 'Latency of an all-or-none quota reservation',
  },

  /**
   * Redis counters vs the authoritative Postgres count. Non-zero drift means the reconciler
   * has work to do; growing drift means it is losing.
   */
  'quota.drift': {
    kind: 'gauge',
    labels: ['survey_version_id', 'quota_plan_ref', 'cell_id'],
    unit: '1',
    description: 'Absolute difference between the cached and reconciled quota cell count',
  },

  /** ADR-002: artifacts are immutable, so cache misses are the only reason to touch the CDN. */
  'artifact.cache.hit': {
    kind: 'counter',
    labels: ['tier', 'result'],
    unit: '1',
    description: 'Artifact fetch resolved from a cache tier (in-process LRU, Redis, CDN)',
  },

  /** arch §8 budget: compile 500 questions x 5 languages < 5 s. Emitted by apps/worker. */
  'compile.duration': {
    kind: 'histogram',
    labels: ['survey_version_id', 'outcome', 'language_count'],
    unit: 'ms',
    description: 'Wall time of a publish/compile job',
  },

  /** arch §8 budget: page submit p95 < 250 ms. The respondent-visible write path. */
  'submit.duration': {
    kind: 'histogram',
    labels: ['survey_version_id', 'page_id', 'outcome'],
    unit: 'ms',
    description: 'Server time to validate, apply and advance one page submit',
  },

  /** arch §8 budget: page render p95 < 300 ms server. */
  'page.render.duration': {
    kind: 'histogram',
    labels: ['survey_version_id', 'page_id', 'cache'],
    unit: 'ms',
    description: 'Server time to render one respondent page',
  },

  /**
   * security §5: a custom script tried something the QuickJS sandbox forbids. Every increment
   * is a security event, and the `violation` label is what an alert routes on.
   */
  'script.sandbox.violation': {
    kind: 'counter',
    labels: ['survey_version_id', 'hook', 'violation'],
    unit: '1',
    description: 'A sandboxed author script attempted a forbidden operation',
  },
} as const satisfies Record<string, MetricDefinition>;

export type MetricRegistry = typeof METRICS;
export type MetricName = keyof MetricRegistry;

/** All metric names of a given kind, so `increment` cannot be handed a histogram. */
export type MetricNameOfKind<K extends MetricKind> = {
  [N in MetricName]: MetricRegistry[N]['kind'] extends K ? N : never;
}[MetricName];

export type CounterName = MetricNameOfKind<'counter'>;
export type HistogramName = MetricNameOfKind<'histogram'>;
export type GaugeName = MetricNameOfKind<'gauge'>;

/**
 * The label object accepted for a given metric.
 *
 * Optional (`?`) rather than required: a submit that failed before the page was resolved has no
 * `page_id`, and forcing a placeholder there would put the string `'unknown'` into a real
 * series. Because the type has no index signature, an object literal with an unlisted key is
 * rejected by TypeScript's excess-property check — which is the compile error we want.
 */
export type LabelsOf<N extends MetricName> = {
  // `| undefined` in the value type (rather than relying on `?` alone) because
  // `exactOptionalPropertyTypes` is on repo-wide: a caller writing
  // `{ page_id: maybeUndefined }` is the normal case, and `cleanLabels` drops it.
  readonly [K in MetricRegistry[N]['labels'][number]]?: string | number | boolean | undefined;
};

export interface MetricSample {
  readonly name: MetricName;
  readonly kind: MetricKind;
  readonly value: number;
  readonly unit: string;
  readonly labels: Readonly<Record<string, string | number | boolean>>;
  /** Epoch milliseconds. */
  readonly at: number;
}

export interface MetricSink {
  record(sample: MetricSample): void;
  flush?(): Promise<void>;
}

/**
 * Discards everything. The default in `apps/runtime` until a real sink is configured, and the
 * sink used by `packages/logic`'s tests, where a metric write would be a side effect in a
 * function that is required to be pure.
 */
export class NoopSink implements MetricSink {
  record(): void {
    /* intentionally empty */
  }
}

/** Accumulates samples for assertions. */
export class InMemorySink implements MetricSink {
  readonly samples: MetricSample[] = [];

  record(sample: MetricSample): void {
    this.samples.push(sample);
  }

  reset(): void {
    this.samples.length = 0;
  }

  of(name: MetricName): MetricSample[] {
    return this.samples.filter((s) => s.name === name);
  }

  /** Sum of a counter's increments, optionally restricted to samples matching `labels`. */
  counterValue(name: CounterName, labels?: Readonly<Record<string, string | number | boolean>>): number {
    return this.matching(name, labels).reduce((acc, s) => acc + s.value, 0);
  }

  /** Every observation of a histogram, in order. */
  observations(name: HistogramName, labels?: Readonly<Record<string, string | number | boolean>>): number[] {
    return this.matching(name, labels).map((s) => s.value);
  }

  /** Last value written to a gauge, or `undefined`. */
  gaugeValue(name: GaugeName, labels?: Readonly<Record<string, string | number | boolean>>): number | undefined {
    const matches = this.matching(name, labels);
    return matches.length === 0 ? undefined : matches[matches.length - 1]?.value;
  }

  private matching(
    name: MetricName,
    labels?: Readonly<Record<string, string | number | boolean>>,
  ): MetricSample[] {
    return this.samples.filter((s) => {
      if (s.name !== name) return false;
      if (labels === undefined) return true;
      return Object.entries(labels).every(([k, v]) => s.labels[k] === v);
    });
  }
}

/**
 * Emits each sample as a JSON line. Usable immediately (log-based metrics are a real, if
 * coarse, pipeline) and the reference implementation for a future OTLP/Prometheus sink.
 */
export class LogMetricSink implements MetricSink {
  constructor(
    private readonly write: (line: string) => void,
    private readonly service = 'unknown',
  ) {}

  record(sample: MetricSample): void {
    this.write(
      JSON.stringify({
        ts: new Date(sample.at).toISOString(),
        kind: 'metric',
        service: this.service,
        metric: sample.name,
        type: sample.kind,
        value: sample.value,
        unit: sample.unit,
        labels: sample.labels,
      }),
    );
  }
}

/** Fans one sample out to several sinks. Used when a log sink runs alongside a real exporter. */
export class MultiSink implements MetricSink {
  constructor(private readonly sinks: readonly MetricSink[]) {}

  record(sample: MetricSample): void {
    for (const sink of this.sinks) sink.record(sample);
  }

  async flush(): Promise<void> {
    await Promise.all(this.sinks.map((s) => s.flush?.()));
  }
}

/**
 * Human-readable summary of a sample. Exists mainly to hold the exhaustive switch that makes
 * adding a fourth `MetricKind` a compile error everywhere it must be handled.
 */
export function describeSample(sample: MetricSample): string {
  switch (sample.kind) {
    case 'counter':
      return `${sample.name} +${sample.value}`;
    case 'histogram':
      return `${sample.name} = ${sample.value}${sample.unit}`;
    case 'gauge':
      return `${sample.name} -> ${sample.value}`;
    default: {
      const exhaustive: never = sample.kind;
      throw new Error(`unhandled metric kind: ${String(exhaustive)}`);
    }
  }
}

export interface Metrics {
  increment<N extends CounterName>(name: N, labels?: LabelsOf<N>, by?: number): void;
  observe<N extends HistogramName>(name: N, value: number, labels?: LabelsOf<N>): void;
  gauge<N extends GaugeName>(name: N, value: number, labels?: LabelsOf<N>): void;
  /**
   * Start a duration timer for a histogram. Returns the stop function, so a caller writes
   * `const stop = metrics.startTimer('submit.duration', { … }); … ; stop({ outcome: 'ok' })`
   * and cannot forget the unit conversion.
   */
  startTimer<N extends HistogramName>(name: N, labels?: LabelsOf<N>): (extra?: LabelsOf<N>) => number;
  readonly sink: MetricSink;
  withSink(sink: MetricSink): Metrics;
}

function cleanLabels(
  labels: Readonly<Record<string, string | number | boolean | undefined>> | undefined,
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  if (labels === undefined) return out;
  for (const [k, v] of Object.entries(labels)) {
    // Drop undefined rather than emitting `"page_id": null`: an absent label and a label whose
    // value is the string "null" are different series in every backend.
    if (v !== undefined) out[k] = v;
  }
  return out;
}

export function createMetrics(sink: MetricSink, now: () => number = () => Date.now()): Metrics {
  const record = (name: MetricName, value: number, labels: LabelsOf<MetricName> | undefined): void => {
    // The registry lookup is guarded even though `MetricName` makes a miss impossible in typed
    // code, because a JS caller (a test, an untyped edge) must not be able to crash the process
    // through the metrics facade. Dropping an unregistered sample is the right failure: a metric
    // that never appears is a dashboard gap, a throw here is an outage.
    const def: MetricDefinition | undefined = METRICS[name];
    if (def === undefined) return;
    sink.record({
      name,
      kind: def.kind,
      value,
      unit: def.unit,
      labels: cleanLabels(labels),
      at: now(),
    });
  };

  const api: Metrics = {
    sink,
    increment: (name, labels, by = 1) => record(name, by, labels as LabelsOf<MetricName>),
    observe: (name, value, labels) => record(name, value, labels as LabelsOf<MetricName>),
    gauge: (name, value, labels) => record(name, value, labels as LabelsOf<MetricName>),
    startTimer: (name, labels) => {
      const started = now();
      return (extra) => {
        const elapsed = now() - started;
        record(name, elapsed, { ...labels, ...extra } as LabelsOf<MetricName>);
        return elapsed;
      };
    },
    withSink: (next) => createMetrics(next, now),
  };
  return api;
}

let defaultSink: MetricSink = new NoopSink();

/**
 * Install the process-wide sink. Noop until a deployable opts in, so importing this module
 * from `packages/logic` or a client bundle costs nothing and emits nothing.
 */
export function setMetricSink(sink: MetricSink): void {
  defaultSink = sink;
}

export function getMetricSink(): MetricSink {
  return defaultSink;
}

/**
 * The ambient facade. Delegates to whatever sink is installed AT CALL TIME, so a module that
 * captured `metrics` at import still writes to a sink configured later in startup — the usual
 * ordering bug with metric singletons.
 */
export const metrics: Metrics = {
  get sink() {
    return defaultSink;
  },
  increment: (name, labels, by) => createMetrics(defaultSink).increment(name, labels, by),
  observe: (name, value, labels) => createMetrics(defaultSink).observe(name, value, labels),
  gauge: (name, value, labels) => createMetrics(defaultSink).gauge(name, value, labels),
  startTimer: (name, labels) => createMetrics(defaultSink).startTimer(name, labels),
  withSink: (sink) => createMetrics(sink),
};
