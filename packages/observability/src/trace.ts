/**
 * A minimal, OpenTelemetry-shaped tracer.
 *
 * WHY not `@opentelemetry/sdk-node`: this package is imported by `apps/runtime`, which is on
 * the respondent critical path (arch §3.3) and whose dependency tree is deliberately near-empty
 * (ADR-010). The OTel SDK plus an OTLP exporter is ~40 packages, brings its own async
 * instrumentation hooks, and would land in the studio's client bundle through the shared
 * logger import. So the DATA MODEL here is OTel-compatible (same span fields, same W3C
 * propagation, same attribute value types) while the SDK is not a dependency.
 *
 * The seam that keeps that honest is `SpanExporter`. Its `export(span)` argument is
 * intentionally shaped like OTel's `ReadableSpan` subset that an OTLP encoder needs, so
 * `OtlpSpanExporter` in a later milestone is a single file in a separate, worker-only package
 * (`apps/worker` and `apps/studio` can afford the dependency; `apps/runtime` cannot) and is
 * installed with `setSpanExporter(new OtlpSpanExporter(...))` at process start. Nothing in
 * application code changes.
 *
 * What this deliberately does NOT do: sampling decisions beyond honouring the inbound
 * `sampled` flag, batching, retry, or context propagation via async_hooks (that lives in
 * `./node`, see ambient.ts). Each is a real feature and each belongs with the exporter, not
 * with the span API.
 */

import { ambientContext } from './ambient.js';
import { newSpanId, newTraceId } from './ids.js';
import { formatTraceparent, parseTraceparent } from './request-id.js';

/** OTel's attribute value domain, exactly. Anything else must be stringified by the caller. */
export type AttributeValue =
  | string
  | number
  | boolean
  | readonly string[]
  | readonly number[]
  | readonly boolean[];

export type Attributes = Record<string, AttributeValue>;

export interface SpanContext {
  readonly traceId: string;
  readonly spanId: string;
  /** Bit 0 = sampled. */
  readonly traceFlags: number;
  readonly traceState?: string | undefined;
}

export type SpanKind = 'internal' | 'server' | 'client' | 'producer' | 'consumer';

export type SpanStatusCode = 'unset' | 'ok' | 'error';

export interface SpanStatus {
  readonly code: SpanStatusCode;
  readonly message?: string;
}

export interface SpanEvent {
  readonly name: string;
  /** Epoch milliseconds. OTel uses nanoseconds; ms is what `Date.now()` gives and is enough. */
  readonly time: number;
  readonly attributes: Attributes;
}

/** The finished-span shape handed to an exporter. Mirrors OTel `ReadableSpan`'s useful half. */
export interface ReadableSpan {
  readonly name: string;
  readonly kind: SpanKind;
  readonly context: SpanContext;
  readonly parentSpanId: string | undefined;
  readonly startTime: number;
  readonly endTime: number;
  readonly durationMs: number;
  readonly attributes: Attributes;
  readonly events: readonly SpanEvent[];
  readonly status: SpanStatus;
  /** Deployable name, so one collector can serve studio, runtime and worker. */
  readonly service: string;
}

export interface Span {
  readonly name: string;
  readonly context: SpanContext;
  readonly parentSpanId: string | undefined;
  setAttribute(key: string, value: AttributeValue): Span;
  setAttributes(attrs: Attributes): Span;
  setStatus(status: SpanStatus): Span;
  addEvent(name: string, attributes?: Attributes): Span;
  /** Records an exception event and sets status to `error`. Does not re-throw. */
  recordException(err: unknown): Span;
  /** Idempotent: a second `end()` is ignored rather than exporting the span twice. */
  end(endTimeMs?: number): void;
  isRecording(): boolean;
  /** The `traceparent` a child of THIS span should receive. */
  traceparent(): string;
}

export interface SpanExporter {
  export(span: ReadableSpan): void;
  /** Optional, for exporters that batch. Called by the worker's graceful drain. */
  forceFlush?(): Promise<void>;
  shutdown?(): Promise<void>;
}

/**
 * The default exporter: one JSON line per finished span on stdout.
 *
 * This is not a placeholder to be ashamed of — with a log-based collector it is a complete,
 * if unindexed, trace pipeline, and it means M0.4's "span tree from a request id" works before
 * any tracing vendor is chosen. `kind: 'span'` distinguishes these lines from log lines.
 */
export class ConsoleSpanExporter implements SpanExporter {
  constructor(private readonly write: (line: string) => void = (line) => {
    const proc = (globalThis as { process?: { stdout?: { write?: (s: string) => boolean } } })
      .process;
    if (proc?.stdout?.write !== undefined) proc.stdout.write(`${line}\n`);
    else console.log(line);
  }) {}

  export(span: ReadableSpan): void {
    this.write(
      JSON.stringify({
        ts: new Date(span.endTime).toISOString(),
        kind: 'span',
        service: span.service,
        name: span.name,
        trace_id: span.context.traceId,
        span_id: span.context.spanId,
        parent_span_id: span.parentSpanId ?? null,
        span_kind: span.kind,
        duration_ms: span.durationMs,
        status: span.status.code,
        status_message: span.status.message ?? null,
        attributes: span.attributes,
        events: span.events,
      }),
    );
  }
}

/** Collects spans in memory. Tests assert on parent/child linkage against this. */
export class InMemorySpanExporter implements SpanExporter {
  readonly spans: ReadableSpan[] = [];

  export(span: ReadableSpan): void {
    this.spans.push(span);
  }

  reset(): void {
    this.spans.length = 0;
  }

  /** Spans whose parent is `spanId`, in export order. */
  childrenOf(spanId: string): ReadableSpan[] {
    return this.spans.filter((s) => s.parentSpanId === spanId);
  }

  byName(name: string): ReadableSpan | undefined {
    return this.spans.find((s) => s.name === name);
  }
}

export class NoopSpanExporter implements SpanExporter {
  export(): void {
    /* intentionally empty */
  }
}

/** Anything a caller can point at as "the parent of this span". */
export type ParentRef = Span | SpanContext | string | undefined;

export interface StartSpanOptions {
  readonly kind?: SpanKind;
  readonly attributes?: Attributes;
  /** A parent span, a raw `SpanContext`, or a W3C `traceparent` header value. */
  readonly parent?: ParentRef;
  /** Skip the ambient context lookup and start a new trace. Use for a scheduled job root. */
  readonly root?: boolean;
  readonly startTimeMs?: number;
  readonly service?: string;
  readonly exporter?: SpanExporter;
  readonly now?: () => number;
}

function isSpan(v: ParentRef): v is Span {
  return typeof v === 'object' && v !== null && 'traceparent' in v && 'context' in v;
}

function resolveParent(opts: StartSpanOptions): SpanContext | undefined {
  const explicit = opts.parent;
  if (typeof explicit === 'string') {
    const parsed = parseTraceparent(explicit);
    if (parsed === undefined) return undefined;
    return { traceId: parsed.traceId, spanId: parsed.spanId, traceFlags: parsed.traceFlags };
  }
  if (isSpan(explicit)) return explicit.context;
  if (explicit !== undefined) return explicit;
  if (opts.root === true) return undefined;

  // Fall back to the ambient context, which is how a span started three call frames deep
  // inside a request handler still lands in the right trace without threading an argument.
  const ctx = ambientContext();
  if (ctx?.traceId === undefined) return undefined;
  return {
    traceId: ctx.traceId,
    spanId: ctx.spanId ?? '',
    traceFlags: ctx.traceFlags ?? 1,
  };
}

class SpanImpl implements Span {
  readonly context: SpanContext;
  readonly parentSpanId: string | undefined;

  private readonly attributes: Attributes = {};
  private readonly events: SpanEvent[] = [];
  private status: SpanStatus = { code: 'unset' };
  private readonly startTime: number;
  private ended = false;

  constructor(
    readonly name: string,
    private readonly kind: SpanKind,
    context: SpanContext,
    parentSpanId: string | undefined,
    private readonly service: string,
    private readonly exporter: SpanExporter,
    private readonly now: () => number,
    startTimeMs: number | undefined,
    attributes: Attributes | undefined,
  ) {
    this.context = context;
    this.parentSpanId = parentSpanId;
    this.startTime = startTimeMs ?? now();
    if (attributes !== undefined) Object.assign(this.attributes, attributes);
  }

  setAttribute(key: string, value: AttributeValue): Span {
    if (!this.ended) this.attributes[key] = value;
    return this;
  }

  setAttributes(attrs: Attributes): Span {
    if (!this.ended) Object.assign(this.attributes, attrs);
    return this;
  }

  setStatus(status: SpanStatus): Span {
    if (!this.ended) this.status = status;
    return this;
  }

  addEvent(name: string, attributes: Attributes = {}): Span {
    if (!this.ended) this.events.push({ name, time: this.now(), attributes });
    return this;
  }

  recordException(err: unknown): Span {
    if (this.ended) return this;
    // OTel's semantic conventions for exception events. Using the standard keys means a
    // vendor UI renders these without configuration once the OTLP exporter drops in.
    const attrs: Attributes = {
      'exception.type': err instanceof Error ? err.name : typeof err,
      'exception.message': err instanceof Error ? err.message : String(err),
    };
    if (err instanceof Error && typeof err.stack === 'string') {
      attrs['exception.stacktrace'] = err.stack;
    }
    // An AppError's machine-readable code is the field an alert routes on (see errors.ts).
    const code = (err as { code?: unknown } | null)?.code;
    if (typeof code === 'string') attrs['error.code'] = code;
    this.events.push({ name: 'exception', time: this.now(), attributes: attrs });
    this.status = {
      code: 'error',
      message: err instanceof Error ? err.message : String(err),
    };
    return this;
  }

  end(endTimeMs?: number): void {
    // Idempotence matters because the common pattern is `try { … } finally { span.end() }`
    // wrapped by a helper that also ends the span; double export would double every latency
    // histogram built from these spans.
    if (this.ended) return;
    this.ended = true;
    const endTime = endTimeMs ?? this.now();
    if ((this.context.traceFlags & 1) === 0) return; // not sampled: nothing to export
    this.exporter.export({
      name: this.name,
      kind: this.kind,
      context: this.context,
      parentSpanId: this.parentSpanId,
      startTime: this.startTime,
      endTime,
      durationMs: endTime - this.startTime,
      attributes: { ...this.attributes },
      events: [...this.events],
      status: this.status,
      service: this.service,
    });
  }

  isRecording(): boolean {
    return !this.ended && (this.context.traceFlags & 1) !== 0;
  }

  traceparent(): string {
    return formatTraceparent(this.context.traceId, this.context.spanId, this.context.traceFlags);
  }
}

let defaultExporter: SpanExporter = new ConsoleSpanExporter();
let defaultService = 'unknown';

/**
 * Install the process-wide exporter. THIS is the OTLP seam: at process start a Node service
 * calls `setSpanExporter(new OtlpSpanExporter({ url, headers }))` and every existing
 * `startSpan` call site starts shipping OTLP with no other change.
 */
export function setSpanExporter(exporter: SpanExporter): void {
  defaultExporter = exporter;
}

export function getSpanExporter(): SpanExporter {
  return defaultExporter;
}

/** Set once at startup so spans carry the deployable name without every call site repeating it. */
export function setTracerService(service: string): void {
  defaultService = service;
}

/**
 * Start a span.
 *
 * Parent resolution order: explicit `parent` → ambient context → new root trace. A parent
 * whose `traceparent` is malformed starts a NEW trace rather than attaching to a bogus id,
 * because a trace with a fabricated parent is worse than two traces.
 */
export function startSpan(name: string, options: StartSpanOptions = {}): Span {
  const parent = resolveParent(options);
  const traceId = parent?.traceId ?? newTraceId();
  const spanId = newSpanId();
  const traceFlags = parent?.traceFlags ?? 1;
  const context: SpanContext = {
    traceId,
    spanId,
    traceFlags,
    ...(parent?.traceState === undefined ? {} : { traceState: parent.traceState }),
  };
  return new SpanImpl(
    name,
    options.kind ?? 'internal',
    context,
    parent?.spanId === undefined || parent.spanId === '' ? undefined : parent.spanId,
    options.service ?? defaultService,
    options.exporter ?? defaultExporter,
    options.now ?? (() => Date.now()),
    options.startTimeMs,
    options.attributes,
  );
}

/**
 * Run `fn` inside a span, recording an exception and re-throwing on failure.
 *
 * Note this does NOT make the span ambient — that needs AsyncLocalStorage and therefore lives
 * in `./node` as `withActiveSpan`. Here, children must be linked explicitly via
 * `{ parent: span }`, which is the only option that works in a browser.
 */
export async function inSpan<T>(
  name: string,
  options: StartSpanOptions,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  const span = startSpan(name, options);
  try {
    const result = await fn(span);
    if (span.isRecording()) span.setStatus({ code: 'ok' });
    return result;
  } catch (err: unknown) {
    span.recordException(err);
    throw err;
  } finally {
    span.end();
  }
}
