import { describe, expect, it } from 'vitest';

import {
  isValidSpanId,
  isValidTraceId,
  newSpanId,
  newTraceId,
  ulid,
  __resetUlidState,
} from './ids.js';
import {
  correlationFrom,
  formatTraceparent,
  headerValue,
  isRequestId,
  outboundHeaders,
  parseTraceparent,
  requestIdFrom,
} from './request-id.js';

describe('headerValue', () => {
  it('reads a node:http style record, case-insensitively', () => {
    expect(headerValue({ 'x-request-id': 'req_1' }, 'X-Request-Id')).toBe('req_1');
    expect(headerValue({ 'X-Request-ID': 'req_2' }, 'x-request-id')).toBe('req_2');
  });

  it('takes the first value of a repeated header', () => {
    expect(headerValue({ 'x-request-id': ['a', 'b'] }, 'x-request-id')).toBe('a');
  });

  it('reads a Fetch/Next.js Headers instance', () => {
    // The reason HeaderBag accepts a `get()` duck type: both ends of the propagation chain
    // must be able to call the same parser without an adapter.
    const h = new Headers({ 'x-request-id': 'req_3', traceparent: 'x' });
    expect(headerValue(h, 'x-request-id')).toBe('req_3');
    expect(headerValue(h, 'missing')).toBeUndefined();
  });

  it('is undefined for an absent bag', () => {
    expect(headerValue(undefined, 'x-request-id')).toBeUndefined();
  });
});

describe('requestIdFrom', () => {
  it('echoes a safe inbound x-request-id', () => {
    expect(requestIdFrom({ 'x-request-id': 'req_01JC8KX9Q2M4V7ZB3F0T5N6R8W' })).toBe(
      'req_01JC8KX9Q2M4V7ZB3F0T5N6R8W',
    );
  });

  it('mints req_<ULID> when the header is absent', () => {
    const id = requestIdFrom({});
    expect(isRequestId(id)).toBe(true);
    expect(requestIdFrom({})).not.toBe(id);
  });

  it('rejects a header that could forge a log line', () => {
    // x-request-id is client-controlled and lands in a JSON-lines stream and an audit row.
    for (const hostile of [
      'req_1\n{"level":"info","msg":"forged"}',
      'req_1 with spaces',
      'x'.repeat(200),
      '',
      'req_\t1',
    ]) {
      const got = requestIdFrom({ 'x-request-id': hostile });
      expect(got, hostile).not.toBe(hostile);
      expect(isRequestId(got)).toBe(true);
    }
  });
});

describe('parseTraceparent', () => {
  const traceId = '4bf92f3577b34da6a3ce929d0e0e4736';
  const spanId = '00f067aa0ba902b7';

  it('parses the W3C example', () => {
    expect(parseTraceparent(`00-${traceId}-${spanId}-01`)).toEqual({
      version: '00',
      traceId,
      spanId,
      traceFlags: 1,
    });
  });

  it('accepts an unknown future version with extra fields', () => {
    const got = parseTraceparent(`01-${traceId}-${spanId}-01-extra`);
    expect(got?.traceId).toBe(traceId);
  });

  it('rejects malformed, all-zero and version-ff headers', () => {
    for (const bad of [
      undefined,
      '',
      'garbage',
      `00-${traceId}-${spanId}`,
      `00-${traceId}-${spanId}-01-extra`, // version 00 must have exactly 4 fields
      `ff-${traceId}-${spanId}-01`,
      `00-${'0'.repeat(32)}-${spanId}-01`,
      `00-${traceId}-${'0'.repeat(16)}-01`,
      `00-${traceId.toUpperCase()}-${spanId}-01`,
      `00-${traceId}-${spanId}-zz`,
    ]) {
      expect(parseTraceparent(bad), String(bad)).toBeUndefined();
    }
  });

  it('round-trips through formatTraceparent', () => {
    const header = formatTraceparent(traceId, spanId, 1);
    expect(header).toBe(`00-${traceId}-${spanId}-01`);
    expect(parseTraceparent(header)).toEqual({ version: '00', traceId, spanId, traceFlags: 1 });
    expect(formatTraceparent(traceId, spanId, 0)).toBe(`00-${traceId}-${spanId}-00`);
  });
});

describe('correlationFrom', () => {
  const traceId = '4bf92f3577b34da6a3ce929d0e0e4736';
  const spanId = '00f067aa0ba902b7';

  it('joins an inbound trace and keeps the caller request id', () => {
    const c = correlationFrom({
      'x-request-id': 'req_01JC8KX9Q2M4V7ZB3F0T5N6R8W',
      traceparent: `00-${traceId}-${spanId}-01`,
      tracestate: 'vendor=abc',
    });
    expect(c).toEqual({
      requestId: 'req_01JC8KX9Q2M4V7ZB3F0T5N6R8W',
      traceId,
      parentSpanId: spanId,
      traceFlags: 1,
      inherited: true,
      traceState: 'vendor=abc',
    });
  });

  it('starts a new sampled trace when nothing is inbound', () => {
    const c = correlationFrom({});
    expect(c.inherited).toBe(false);
    expect(isValidTraceId(c.traceId)).toBe(true);
    expect(c.parentSpanId).toBeUndefined();
    expect(c.traceFlags).toBe(1);
  });

  it('starts a NEW trace when traceparent is malformed rather than fabricating a parent', () => {
    const c = correlationFrom({ traceparent: 'not-a-traceparent' });
    expect(c.inherited).toBe(false);
    expect(isValidTraceId(c.traceId)).toBe(true);
  });

  it('mints a request id even when a trace is inherited', () => {
    // The two identifiers are independent on purpose: `request_id` must stay ULID-shaped for
    // app.audit_log (DB §10) whatever the upstream trace id looks like.
    const c = correlationFrom({ traceparent: `00-${traceId}-${spanId}-01` });
    expect(isRequestId(c.requestId)).toBe(true);
    expect(c.traceId).toBe(traceId);
  });

  it('honours an unsampled inbound flag', () => {
    expect(correlationFrom({ traceparent: `00-${traceId}-${spanId}-00` }).traceFlags).toBe(0);
  });
});

describe('outboundHeaders', () => {
  it('emits the headers the far side parses back', () => {
    const traceId = '4bf92f3577b34da6a3ce929d0e0e4736';
    const spanId = '00f067aa0ba902b7';
    const out = outboundHeaders({ requestId: 'req_x', traceId, spanId, traceState: 'v=1' });
    expect(out).toEqual({
      'x-request-id': 'req_x',
      traceparent: `00-${traceId}-${spanId}-01`,
      tracestate: 'v=1',
    });
    // A full studio -> worker hop, asserted end to end.
    const back = correlationFrom(out);
    expect(back.requestId).toBe('req_x');
    expect(back.traceId).toBe(traceId);
    expect(back.parentSpanId).toBe(spanId);
  });

  it('omits an empty tracestate', () => {
    const out = outboundHeaders({
      requestId: 'req_x',
      traceId: 'a'.repeat(32),
      spanId: 'b'.repeat(16),
    });
    expect(out).not.toHaveProperty('tracestate');
  });
});

describe('ids', () => {
  it('mints a 26-char Crockford base32 ULID', () => {
    __resetUlidState();
    const id = ulid();
    expect(id).toHaveLength(26);
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it('sorts lexicographically by time', () => {
    __resetUlidState();
    const a = ulid(1_700_000_000_000);
    const b = ulid(1_700_000_001_000);
    expect(a < b).toBe(true);
  });

  it('stays monotonic within one millisecond', () => {
    // ops.jobs.id and app.audit_log ids are ULIDs read back in PK order; two rows written in
    // the same millisecond must not sort backwards.
    __resetUlidState();
    const ids = Array.from({ length: 50 }, () => ulid(1_700_000_000_000));
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(50);
  });

  it('generates valid, non-zero trace and span ids', () => {
    for (let i = 0; i < 50; i += 1) {
      expect(isValidTraceId(newTraceId())).toBe(true);
      expect(isValidSpanId(newSpanId())).toBe(true);
    }
  });
});
