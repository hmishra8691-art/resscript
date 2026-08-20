/**
 * Tests for the Node-only surface: AsyncLocalStorage-backed correlation propagation.
 *
 * The property under test is the one M0.4's acceptance criterion depends on: a request id set
 * once at the edge appears on a log line written by code several async hops away, without
 * anyone threading an argument.
 */
import { describe, expect, it } from 'vitest';

import { createCapturingLogger } from './logger.js';
import {
  getContext,
  runWithContext,
  runWithHeaders,
  withActiveSpan,
  withContext,
} from './node.js';
import { formatTraceparent } from './request-id.js';
import { InMemorySpanExporter, setSpanExporter, startSpan } from './trace.js';

describe('runWithContext', () => {
  it('is undefined outside any scope', () => {
    expect(getContext()).toBeUndefined();
  });

  it('propagates the request id across awaits, timers and promise callbacks', async () => {
    const seen: (string | undefined)[] = [];

    await runWithContext({ requestId: 'req_A', traceId: 'a'.repeat(32) }, async () => {
      seen.push(getContext()?.requestId);
      await new Promise((r) => setTimeout(r, 1));
      seen.push(getContext()?.requestId);
      await Promise.resolve().then(() => {
        seen.push(getContext()?.requestId);
      });
      await deepAsync(3, () => seen.push(getContext()?.requestId));
    });

    expect(seen).toEqual(['req_A', 'req_A', 'req_A', 'req_A']);
    expect(getContext()).toBeUndefined();
  });

  it('keeps two concurrent requests separate', async () => {
    const results = await Promise.all([
      runWithContext({ requestId: 'req_1' }, async () => {
        await new Promise((r) => setTimeout(r, 5));
        return getContext()?.requestId;
      }),
      runWithContext({ requestId: 'req_2' }, async () => {
        await new Promise((r) => setTimeout(r, 1));
        return getContext()?.requestId;
      }),
    ]);
    expect(results).toEqual(['req_1', 'req_2']);
  });

  it('feeds the logger without the logger being told anything', () => {
    // The logger is constructed OUTSIDE the scope, as a module-level singleton would be.
    const cap = createCapturingLogger({ service: 'worker' });
    runWithContext(
      { requestId: 'req_B', traceId: 'b'.repeat(32), spanId: 'c'.repeat(16), orgId: 'org_9' },
      () => {
        cap.logger.info('inside');
      },
    );
    cap.logger.info('outside');

    expect(cap.lines[0]).toMatchObject({
      msg: 'inside',
      request_id: 'req_B',
      trace_id: 'b'.repeat(32),
      span_id: 'c'.repeat(16),
      org_id: 'org_9',
    });
    expect(cap.lines[1]).not.toHaveProperty('request_id');
  });
});

describe('withContext', () => {
  it('merges a patch and merges bindings rather than replacing them', () => {
    runWithContext({ requestId: 'req_C', bindings: { a: 1 } }, () => {
      withContext({ orgId: 'org_1', bindings: { b: 2 } }, () => {
        expect(getContext()).toEqual({
          requestId: 'req_C',
          orgId: 'org_1',
          bindings: { a: 1, b: 2 },
        });
      });
      // The outer scope is untouched: a store is a value, not a mutable bag.
      expect(getContext()?.orgId).toBeUndefined();
    });
  });
});

describe('runWithHeaders', () => {
  it('derives correlation from inbound headers and runs the handler inside it', () => {
    const traceId = '4bf92f3577b34da6a3ce929d0e0e4736';
    const spanId = '00f067aa0ba902b7';
    const cap = createCapturingLogger({ service: 'runtime' });

    const { context, result } = runWithHeaders(
      { 'x-request-id': 'req_D', traceparent: formatTraceparent(traceId, spanId) },
      (ctx) => {
        cap.logger.info('handled');
        return ctx.requestId;
      },
    );

    expect(result).toBe('req_D');
    expect(context.traceId).toBe(traceId);
    expect(context.spanId).toBe(spanId);
    expect(cap.lines[0]).toMatchObject({ request_id: 'req_D', trace_id: traceId });
  });
});

describe('withActiveSpan', () => {
  it('builds a real span TREE without any call site passing a parent', async () => {
    const exporter = new InMemorySpanExporter();
    setSpanExporter(exporter);
    try {
      await runWithContext({ requestId: 'req_E' }, async () => {
        await withActiveSpan('studio.publish', { kind: 'server' }, async () => {
          // Note: no `{ parent: … }` anywhere below. That is the point.
          await withActiveSpan('worker.claim', { kind: 'consumer' }, async () => {
            startSpan('db.update').end();
          });
          await withActiveSpan('runtime.warm', {}, async () => undefined);
        });
      });
    } finally {
      setSpanExporter(new InMemorySpanExporter());
    }

    const root = exporter.byName('studio.publish');
    const claim = exporter.byName('worker.claim');
    const dbUpdate = exporter.byName('db.update');
    const warm = exporter.byName('runtime.warm');

    expect(exporter.spans).toHaveLength(4);
    const traceIds = new Set(exporter.spans.map((s) => s.context.traceId));
    expect(traceIds.size).toBe(1);
    expect(root?.parentSpanId).toBeUndefined();
    expect(claim?.parentSpanId).toBe(root?.context.spanId);
    expect(dbUpdate?.parentSpanId).toBe(claim?.context.spanId);
    expect(warm?.parentSpanId).toBe(root?.context.spanId);
  });

  it('puts the active span id on log lines written inside it', async () => {
    const exporter = new InMemorySpanExporter();
    const cap = createCapturingLogger({ service: 'worker' });
    await withActiveSpan('job.run', { exporter, root: true }, async (span) => {
      cap.logger.info('working');
      expect(cap.lines[0]?.['span_id']).toBe(span.context.spanId);
      expect(cap.lines[0]?.['trace_id']).toBe(span.context.traceId);
    });
  });

  it('records the exception, ends the span and rethrows', async () => {
    const exporter = new InMemorySpanExporter();
    await expect(
      withActiveSpan('job.run', { exporter, root: true }, async () => {
        throw new Error('handler blew up');
      }),
    ).rejects.toThrow('handler blew up');
    expect(exporter.spans).toHaveLength(1);
    expect(exporter.spans[0]?.status.code).toBe('error');
  });
});

async function deepAsync(depth: number, leaf: () => void): Promise<void> {
  if (depth === 0) {
    leaf();
    return;
  }
  await new Promise((r) => setImmediate(r));
  await deepAsync(depth - 1, leaf);
}
