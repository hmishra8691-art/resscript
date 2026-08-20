import { describe, expect, it } from 'vitest';

import { AppError } from './errors.js';
import { createCapturingLogger, createLogger } from './logger.js';
import { createRedactionPolicy, isDeniedKey, redact, REDACTED, tainted } from './redact.js';

const FIXED = new Date('2026-08-20T10:00:00.000Z');

function capture(bindings?: Record<string, unknown>) {
  return createCapturingLogger({
    service: 'worker',
    now: () => FIXED,
    ...(bindings === undefined ? {} : { bindings }),
  });
}

describe('createLogger', () => {
  it('emits one JSON line per event with the envelope fields first', () => {
    const cap = capture();
    cap.logger.info('job_claimed', { job_id: 'job_1', kind: 'noop' });

    expect(cap.raw).toHaveLength(1);
    const raw = cap.raw[0] ?? '';
    expect(raw.includes('\n')).toBe(false);
    // Field ORDER is part of the contract: a human tailing raw stdout reads left to right.
    expect(Object.keys(JSON.parse(raw) as object).slice(0, 4)).toEqual([
      'ts',
      'level',
      'service',
      'msg',
    ]);
    expect(cap.lines[0]).toMatchObject({
      ts: '2026-08-20T10:00:00.000Z',
      level: 'info',
      service: 'worker',
      msg: 'job_claimed',
      job_id: 'job_1',
      kind: 'noop',
    });
  });

  it('respects the level threshold', () => {
    const lines: string[] = [];
    const log = createLogger({ service: 'runtime', level: 'warn', sink: (l) => lines.push(l) });
    log.debug('a');
    log.info('b');
    log.warn('c');
    log.error('d');
    expect(lines.map((l) => (JSON.parse(l) as { msg: string }).msg)).toEqual(['c', 'd']);
  });

  it('child() accumulates bindings without mutating the parent', () => {
    const cap = capture({ service_instance: 'w1' });
    const child = cap.logger.child({ job_id: 'job_9' });
    const grandchild = child.child({ attempt: 2 });

    grandchild.info('progress');
    cap.logger.info('parent_line');

    expect(cap.lines[0]).toMatchObject({ service_instance: 'w1', job_id: 'job_9', attempt: 2 });
    expect(cap.lines[1]).not.toHaveProperty('job_id');
  });

  it('per-call fields win over logger bindings, which win over ambient bindings', () => {
    const cap = createCapturingLogger({
      service: 'worker',
      now: () => FIXED,
      bindings: { layer: 'logger' },
      context: () => ({ bindings: { layer: 'ambient', from_ambient: true } }),
    });
    cap.logger.info('m', { layer: 'call' });
    expect(cap.lines[0]).toMatchObject({ layer: 'call', from_ambient: true });
  });

  it('takes request_id / trace_id / span_id from the ambient context', () => {
    const cap = createCapturingLogger({
      service: 'runtime',
      now: () => FIXED,
      context: () => ({
        requestId: 'req_01J',
        traceId: 'a'.repeat(32),
        spanId: 'b'.repeat(16),
        orgId: 'org_1',
      }),
    });
    cap.logger.info('page_rendered');
    expect(cap.lines[0]).toMatchObject({
      request_id: 'req_01J',
      trace_id: 'a'.repeat(32),
      span_id: 'b'.repeat(16),
      org_id: 'org_1',
    });
  });

  it('an explicit requestId overrides the ambient one', () => {
    const cap = createCapturingLogger({
      service: 'runtime',
      now: () => FIXED,
      requestId: 'req_explicit',
      context: () => ({ requestId: 'req_ambient' }),
    });
    cap.logger.info('m');
    expect(cap.lines[0]?.['request_id']).toBe('req_explicit');
  });

  it('cannot be tricked into forging the envelope', () => {
    // A handler logging a field called `level` must not be able to make an error line look
    // like a debug line. Reserved names are nested under `fields` instead.
    const cap = capture();
    cap.logger.error('boom', { level: 'debug', ts: 'yesterday', msg: 'other', service: 'studio' });
    expect(cap.lines[0]).toMatchObject({
      level: 'error',
      ts: '2026-08-20T10:00:00.000Z',
      msg: 'boom',
      service: 'worker',
    });
    expect(cap.lines[0]?.['fields']).toEqual({
      level: 'debug',
      ts: 'yesterday',
      msg: 'other',
      service: 'studio',
    });
  });

  it('never throws on an unserialisable value', () => {
    const cap = capture();
    const cyclic: Record<string, unknown> = { name: 'a' };
    cyclic['self'] = cyclic;
    expect(() => cap.logger.info('cyclic', { cyclic, fn: () => 1, big: 10n })).not.toThrow();
    expect(cap.lines[0]).toMatchObject({
      msg: 'cyclic',
      cyclic: { name: 'a', self: '[circular]' },
      big: '10n',
    });
  });

  it('serialises an Error, including an AppError code and context', () => {
    const cap = capture();
    cap.logger.error('job_failed', {
      err: new AppError('unavailable', 'redis down', { context: { store: 'redis' } }),
    });
    const err = cap.lines[0]?.['err'] as Record<string, unknown>;
    expect(err['name']).toBe('AppError');
    expect(err['code']).toBe('unavailable');
    expect(err['retryable']).toBe(true);
    expect(err['context']).toEqual({ store: 'redis' });
    expect(typeof err['stack']).toBe('string');
  });
});

describe('redaction — security §8.1', () => {
  it('drops values whose KEY looks like a credential', () => {
    const cap = capture();
    cap.logger.info('vendor_call', {
      vendor: 'lucid',
      api_key: 'sk_live_abc123',
      authorization: 'Bearer abc',
      hmac_secret: 'shhh',
      access_token: 't',
      cookie: 'session=1',
      private_key: '-----BEGIN',
    });
    const line = cap.lines[0] ?? {};
    expect(line['vendor']).toBe('lucid');
    for (const k of [
      'api_key',
      'authorization',
      'hmac_secret',
      'access_token',
      'cookie',
      'private_key',
    ]) {
      expect(line[k], k).toBe(REDACTED);
    }
    // The strongest assertion available: the secret bytes are not anywhere in the line.
    expect(cap.raw[0]).not.toContain('sk_live_abc123');
    expect(cap.raw[0]).not.toContain('shhh');
  });

  it('drops direct identifiers but keeps their hashed/aggregate siblings', () => {
    const cap = capture();
    cap.logger.info('respondent', {
      email: 'jo@example.com',
      respondent_email: 'jo@example.com',
      phone: '+441234567890',
      last_name: 'Bloggs',
      postcode: 'EC1A 1BB',
      // Allowlisted: security §8.3 keeps these precisely so an operator has something to work
      // with during an incident.
      email_hash: 'deadbeef',
      email_domain: 'example.com',
      ip_hash: 'cafe',
      idempotency_key: 'publish-abc',
    });
    const line = cap.lines[0] ?? {};
    expect(line['email']).toBe(REDACTED);
    expect(line['respondent_email']).toBe(REDACTED);
    expect(line['phone']).toBe(REDACTED);
    expect(line['last_name']).toBe(REDACTED);
    expect(line['postcode']).toBe(REDACTED);
    expect(line['email_hash']).toBe('deadbeef');
    expect(line['email_domain']).toBe('example.com');
    expect(line['ip_hash']).toBe('cafe');
    expect(line['idempotency_key']).toBe('publish-abc');
    expect(cap.raw[0]).not.toContain('jo@example.com');
  });

  it('redacts denied keys at any nesting depth — the regex-scrubbing failure mode', () => {
    // Security §8.1: "regex-based scrubbing fails the first time someone JSON-stringifies a
    // nested object". This is that case, asserted.
    const cap = capture();
    cap.logger.warn('outbound', {
      request: { headers: { authorization: 'Bearer secret-token-value' }, url: '/x' },
      list: [{ nested: { api_key: 'k1' } }],
    });
    expect(cap.raw[0]).not.toContain('secret-token-value');
    expect(cap.raw[0]).not.toContain('k1');
    const req = cap.lines[0]?.['request'] as { headers: Record<string, unknown>; url: string };
    expect(req.headers['authorization']).toBe(REDACTED);
    expect(req.url).toBe('/x');
  });

  it('a tainted value serialises as a placeholder however deeply it is nested', () => {
    // The layer that makes `log({ vars })` safe by construction: the field name here
    // (`Q12`, `answers`) matches no deny pattern at all.
    const cap = capture();
    cap.logger.info('state', {
      vars: {
        Q1: 3,
        Q12: tainted('jo@example.com', 'Q12_email'),
        nested: { deep: [tainted('+441234567890')] },
      },
    });
    expect(cap.raw[0]).not.toContain('jo@example.com');
    expect(cap.raw[0]).not.toContain('+441234567890');
    const vars = cap.lines[0]?.['vars'] as Record<string, unknown>;
    expect(vars['Q1']).toBe(3);
    expect(vars['Q12']).toBe('[pii:Q12_email]');
    expect((vars['nested'] as { deep: unknown[] }).deep[0]).toBe(REDACTED);
  });

  it('unwrapping a tainted value is explicit and greppable', () => {
    const t = tainted('secret-answer', 'Q3');
    expect(t.unsafeUnwrap()).toBe('secret-answer');
    expect(String(redact(t))).toBe('[pii:Q3]');
  });

  it('bounds depth, array length and string length', () => {
    const policy = createRedactionPolicy({ maxDepth: 3, maxArrayLength: 2, maxStringLength: 5 });
    expect(redact({ a: { b: { c: { d: 1 } } } }, policy)).toEqual({ a: { b: { c: '[max_depth]' } } });
    expect(redact([1, 2, 3, 4], policy)).toEqual([1, 2, '[+2 more]']);
    expect(redact('abcdefgh', policy)).toBe('abcde…(+3)');
  });

  it('reports a shared (diamond) reference as a value, not as circular', () => {
    const shared = { id: 1 };
    expect(redact({ left: shared, right: shared })).toEqual({ left: { id: 1 }, right: { id: 1 } });
  });

  it('allowKeys beats denyPatterns so a team can opt a derived field back in', () => {
    expect(isDeniedKey('email')).toBe(true);
    const policy = createRedactionPolicy({ allowKeys: new Set(['email']) });
    expect(isDeniedKey('email', policy)).toBe(false);
  });

  it('normalises Date, Map and Set into JSON-safe shapes', () => {
    expect(redact(new Date('2026-01-02T03:04:05.000Z'))).toBe('2026-01-02T03:04:05.000Z');
    expect(redact(new Map([['a', 1]]))).toEqual({ a: 1 });
    expect(redact(new Set([1, 2]))).toEqual([1, 2]);
    expect(redact(new Map([['api_key', 'x']]))).toEqual({ api_key: REDACTED });
  });
});
