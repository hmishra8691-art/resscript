import { afterEach, describe, expect, it } from 'vitest';

import { resetContextProvider, setContextProvider } from './ambient.js';
import { AppError } from './errors.js';
import { isValidSpanId, isValidTraceId } from './ids.js';
import { formatTraceparent, parseTraceparent } from './request-id.js';
import {
  ConsoleSpanExporter,
  InMemorySpanExporter,
  inSpan,
  NoopSpanExporter,
  startSpan,
} from './trace.js';

afterEach(() => {
  resetContextProvider();
});

function fixedClock(start = 1_000): () => number {
  let t = start;
  return () => {
    t += 5;
    return t;
  };
}

describe('startSpan', () => {
  it('starts a root span with valid W3C ids', () => {
    const exporter = new InMemorySpanExporter();
    const span = startSpan('compile', { exporter, root: true, service: 'worker' });
    span.end();

    const out = exporter.spans[0];
    expect(out).toBeDefined();
    expect(isValidTraceId(out?.context.traceId ?? '')).toBe(true);
    expect(isValidSpanId(out?.context.spanId ?? '')).toBe(true);
    expect(out?.parentSpanId).toBeUndefined();
    expect(out?.service).toBe('worker');
  });

  it('links a child to its parent inside the same trace', () => {
    const exporter = new InMemorySpanExporter();
    const parent = startSpan('http.request', { exporter, root: true, kind: 'server' });
    const child = startSpan('db.query', { exporter, parent, kind: 'client' });
    const grandchild = startSpan('db.row_fetch', { exporter, parent: child });

    grandchild.end();
    child.end();
    parent.end();

    const g = exporter.byName('db.row_fetch');
    const c = exporter.byName('db.query');
    const p = exporter.byName('http.request');

    expect(c?.context.traceId).toBe(p?.context.traceId);
    expect(g?.context.traceId).toBe(p?.context.traceId);
    expect(c?.parentSpanId).toBe(p?.context.spanId);
    expect(g?.parentSpanId).toBe(c?.context.spanId);
    expect(exporter.childrenOf(p?.context.spanId ?? '').map((s) => s.name)).toEqual(['db.query']);
    // Three distinct spans, one trace: the "span tree" M0.4's acceptance criterion asks for.
    expect(new Set(exporter.spans.map((s) => s.context.spanId)).size).toBe(3);
  });

  it('adopts a parent from an inbound traceparent header — the studio -> worker hop', () => {
    const exporter = new InMemorySpanExporter();
    const upstream = startSpan('studio.publish', { exporter, root: true });
    const header = upstream.traceparent();

    // The worker only ever sees this string (out of ops.jobs.payload, not an HTTP header).
    const worker = startSpan('worker.compile', { exporter, parent: header, kind: 'consumer' });
    worker.end();
    upstream.end();

    expect(parseTraceparent(header)?.spanId).toBe(upstream.context.spanId);
    expect(exporter.byName('worker.compile')?.parentSpanId).toBe(upstream.context.spanId);
    expect(exporter.byName('worker.compile')?.context.traceId).toBe(upstream.context.traceId);
  });

  it('starts a new trace when the inbound traceparent is malformed', () => {
    const exporter = new InMemorySpanExporter();
    const span = startSpan('worker.compile', { exporter, parent: 'garbage' });
    span.end();
    expect(exporter.spans[0]?.parentSpanId).toBeUndefined();
    expect(isValidTraceId(exporter.spans[0]?.context.traceId ?? '')).toBe(true);
  });

  it('inherits the ambient context when no parent is given', () => {
    const traceId = 'a'.repeat(31) + '1';
    const spanId = 'b'.repeat(15) + '2';
    setContextProvider(() => ({ traceId, spanId, traceFlags: 1 }));

    const exporter = new InMemorySpanExporter();
    startSpan('nested.work', { exporter }).end();

    expect(exporter.spans[0]?.context.traceId).toBe(traceId);
    expect(exporter.spans[0]?.parentSpanId).toBe(spanId);
  });

  it('root: true ignores the ambient context', () => {
    setContextProvider(() => ({ traceId: 'c'.repeat(32), spanId: 'd'.repeat(16) }));
    const exporter = new InMemorySpanExporter();
    startSpan('cron.sweep', { exporter, root: true }).end();
    expect(exporter.spans[0]?.context.traceId).not.toBe('c'.repeat(32));
    expect(exporter.spans[0]?.parentSpanId).toBeUndefined();
  });

  it('accepts a bare SpanContext as parent', () => {
    const exporter = new InMemorySpanExporter();
    const ctx = { traceId: 'e'.repeat(32), spanId: 'f'.repeat(16), traceFlags: 1 };
    startSpan('x', { exporter, parent: ctx }).end();
    expect(exporter.spans[0]?.context.traceId).toBe(ctx.traceId);
    expect(exporter.spans[0]?.parentSpanId).toBe(ctx.spanId);
  });
});

describe('span lifecycle', () => {
  it('records attributes, events and duration', () => {
    const exporter = new InMemorySpanExporter();
    const span = startSpan('submit', {
      exporter,
      root: true,
      now: fixedClock(),
      attributes: { 'survey.version_id': 'sv_1' },
    });
    span.setAttribute('page.id', 'pg_2').setAttributes({ 'answers.count': 4, cached: true });
    span.addEvent('quota.reserved', { cells: 3 });
    span.setStatus({ code: 'ok' });
    span.end();

    const out = exporter.spans[0];
    expect(out?.attributes).toEqual({
      'survey.version_id': 'sv_1',
      'page.id': 'pg_2',
      'answers.count': 4,
      cached: true,
    });
    expect(out?.events.map((e) => e.name)).toEqual(['quota.reserved']);
    expect(out?.status.code).toBe('ok');
    expect(out?.durationMs).toBeGreaterThan(0);
  });

  it('is idempotent on end()', () => {
    // try/finally + a helper that also ends the span is the normal pattern; a double export
    // would double every latency histogram derived from these spans.
    const exporter = new InMemorySpanExporter();
    const span = startSpan('x', { exporter, root: true });
    span.end();
    span.end();
    expect(exporter.spans).toHaveLength(1);
  });

  it('ignores mutation after end', () => {
    const exporter = new InMemorySpanExporter();
    const span = startSpan('x', { exporter, root: true });
    span.end();
    span.setAttribute('late', 1).addEvent('late');
    expect(exporter.spans[0]?.attributes).toEqual({});
    expect(exporter.spans[0]?.events).toEqual([]);
    expect(span.isRecording()).toBe(false);
  });

  it('recordException uses OTel semantic conventions and lifts an AppError code', () => {
    const exporter = new InMemorySpanExporter();
    const span = startSpan('compile', { exporter, root: true });
    span.recordException(new AppError('compile_errors', '2 errors'));
    span.end();

    const event = exporter.spans[0]?.events[0];
    expect(event?.name).toBe('exception');
    expect(event?.attributes['exception.type']).toBe('AppError');
    expect(event?.attributes['exception.message']).toBe('2 errors');
    expect(event?.attributes['error.code']).toBe('compile_errors');
    expect(typeof event?.attributes['exception.stacktrace']).toBe('string');
    expect(exporter.spans[0]?.status).toEqual({ code: 'error', message: '2 errors' });
  });

  it('records a non-Error throw without losing it', () => {
    const exporter = new InMemorySpanExporter();
    const span = startSpan('x', { exporter, root: true });
    span.recordException('plain string failure');
    span.end();
    expect(exporter.spans[0]?.events[0]?.attributes['exception.message']).toBe(
      'plain string failure',
    );
  });

  it('does not export an unsampled span', () => {
    const exporter = new InMemorySpanExporter();
    const parent = { traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), traceFlags: 0 };
    const span = startSpan('x', { exporter, parent });
    expect(span.isRecording()).toBe(false);
    span.end();
    expect(exporter.spans).toHaveLength(0);
  });

  it('emits a traceparent a child can parse', () => {
    const span = startSpan('x', { exporter: new NoopSpanExporter(), root: true });
    expect(span.traceparent()).toBe(
      formatTraceparent(span.context.traceId, span.context.spanId, span.context.traceFlags),
    );
    expect(parseTraceparent(span.traceparent())?.spanId).toBe(span.context.spanId);
  });
});

describe('inSpan', () => {
  it('marks ok and returns the value', async () => {
    const exporter = new InMemorySpanExporter();
    const got = await inSpan('work', { exporter, root: true }, async () => 42);
    expect(got).toBe(42);
    expect(exporter.spans[0]?.status.code).toBe('ok');
  });

  it('records the exception, ends the span and rethrows', async () => {
    const exporter = new InMemorySpanExporter();
    await expect(
      inSpan('work', { exporter, root: true }, async () => {
        throw new Error('nope');
      }),
    ).rejects.toThrow('nope');
    expect(exporter.spans).toHaveLength(1);
    expect(exporter.spans[0]?.status.code).toBe('error');
    expect(exporter.spans[0]?.events[0]?.name).toBe('exception');
  });
});

describe('ConsoleSpanExporter', () => {
  it('writes one JSON line tagged kind=span', () => {
    const lines: string[] = [];
    const exporter = new ConsoleSpanExporter((l) => lines.push(l));
    const parent = startSpan('a', { exporter, root: true, service: 'worker' });
    const child = startSpan('b', { exporter, parent, service: 'worker' });
    child.end();
    parent.end();

    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0] ?? '{}') as Record<string, unknown>;
    expect(first['kind']).toBe('span');
    expect(first['name']).toBe('b');
    expect(first['parent_span_id']).toBe(parent.context.spanId);
    expect(first['service']).toBe('worker');
  });
});
