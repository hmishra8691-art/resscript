import { describe, expect, it } from 'vitest';

import {
  AppError,
  compileErrors,
  DOCS_BASE_URL,
  entitlementRequired,
  frozenVersion,
  internalError,
  isRetryableCode,
  notFound,
  rateLimited,
  revisionConflict,
  statusForCode,
  stepUpRequired,
  unavailable,
  validationFailed,
  type ErrorCode,
} from './errors.js';

const ALL_CODES: readonly ErrorCode[] = [
  'malformed_request',
  'unknown_field',
  'invalid_cursor',
  'unauthenticated',
  'token_expired',
  'key_revoked',
  'forbidden',
  'step_up_required',
  'entitlement_required',
  'not_found',
  'already_exists',
  'illegal_transition',
  'frozen_version',
  'cursor_stale',
  'revision_conflict',
  'validation_failed',
  'compile_errors',
  'idempotency_key_reuse',
  'precondition_required',
  'rate_limited',
  'internal_error',
  'unavailable',
];

describe('AppError', () => {
  it('derives the status from the code per API §1.5', () => {
    const expected: Record<ErrorCode, number> = {
      malformed_request: 400,
      unknown_field: 400,
      invalid_cursor: 400,
      unauthenticated: 401,
      token_expired: 401,
      key_revoked: 401,
      forbidden: 403,
      step_up_required: 403,
      entitlement_required: 403,
      not_found: 404,
      already_exists: 409,
      illegal_transition: 409,
      frozen_version: 409,
      cursor_stale: 409,
      revision_conflict: 412,
      validation_failed: 422,
      compile_errors: 422,
      idempotency_key_reuse: 422,
      precondition_required: 428,
      rate_limited: 429,
      internal_error: 500,
      unavailable: 503,
    };
    for (const code of ALL_CODES) {
      expect(new AppError(code, 'm').status, code).toBe(expected[code]);
      expect(statusForCode(code), code).toBe(expected[code]);
    }
  });

  it('marks only 429/500/503 retryable by default', () => {
    const retryable = ALL_CODES.filter((c) => isRetryableCode(c));
    expect(retryable.sort()).toEqual(['internal_error', 'rate_limited', 'unavailable']);
  });

  it('does NOT mark revision_conflict retryable', () => {
    // Auto-retrying an optimistic-lock failure is a silent overwrite, the exact failure
    // P1-03's conflict dialog exists to prevent. This is retryable by a human, not a machine.
    expect(revisionConflict('r1', 'r2').retryable).toBe(false);
    expect(revisionConflict('r1', 'r2').status).toBe(412);
  });

  it('honours an explicit retryable override', () => {
    // A `not_found` on an artifact fetch during a CDN purge IS worth one retry.
    expect(new AppError('not_found', 'artifact', { retryable: true }).retryable).toBe(true);
  });

  it('is an Error, catchable by instanceof, and preserves the cause', () => {
    const cause = new Error('ECONNRESET');
    const err = internalError('pg unreachable', { cause });
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(AppError);
    expect(err.name).toBe('AppError');
    expect(err.cause).toBe(cause);
    expect(typeof err.stack).toBe('string');
  });

  it('freezes context so a shared error cannot be mutated downstream', () => {
    const err = new AppError('forbidden', 'nope', { context: { role: 'viewer' } });
    expect(err.context).toEqual({ role: 'viewer' });
    expect(Object.isFrozen(err.context)).toBe(true);
  });
});

describe('toEnvelope — the wire contract', () => {
  it('produces API §1.5 exactly', () => {
    const err = validationFailed([
      { path: 'options[3].code', code: 'duplicate_code', message: 'code 2 is already used' },
      { path: 'config.max_selections', code: 'out_of_range', message: 'must be <= 5' },
    ]);
    expect(err.toEnvelope('req_01JC8')).toEqual({
      error: {
        code: 'validation_failed',
        message: '2 fields failed validation',
        request_id: 'req_01JC8',
        docs_url: `${DOCS_BASE_URL}validation_failed`,
        details: [
          { path: 'options[3].code', code: 'duplicate_code', message: 'code 2 is already used' },
          { path: 'config.max_selections', code: 'out_of_range', message: 'must be <= 5' },
        ],
        retry_after_s: null,
      },
    });
  });

  it('never leaks detail from a 500 — request_id is the handle', () => {
    const err = internalError('pg: relation "content.nodes" does not exist', {
      details: [{ path: null, code: 'sql_state', message: '42P01' }],
      context: { table: 'content.nodes' },
    });
    const envelope = err.toEnvelope('req_1');
    expect(envelope.error.message).toBe('An unexpected error occurred.');
    expect(envelope.error.details).toEqual([]);
    expect(JSON.stringify(envelope)).not.toContain('content.nodes');
    // …but the internal record keeps everything, which is the point.
    expect(err.message).toContain('content.nodes');
    expect(err.toJSON()['context']).toEqual({ table: 'content.nodes' });
  });

  it('never puts internal context on the wire', () => {
    const err = frozenVersion('sv_1');
    expect(err.toEnvelope()).not.toHaveProperty('error.context');
    expect(JSON.stringify(err.toEnvelope())).not.toContain('sv_1');
    expect(err.toJSON()['context']).toEqual({ survey_version_id: 'sv_1' });
  });

  it('carries retry_after_s for 429 and 503', () => {
    expect(rateLimited(30).toEnvelope().error.retry_after_s).toBe(30);
    expect(unavailable().toEnvelope().error.retry_after_s).toBe(5);
    expect(unavailable(11).retryAfterS).toBe(11);
  });

  it('prefers an explicit request id over the embedded one', () => {
    const err = new AppError('forbidden', 'm', { requestId: 'req_embedded' });
    expect(err.toEnvelope().error.request_id).toBe('req_embedded');
    expect(err.toEnvelope('req_override').error.request_id).toBe('req_override');
    expect(new AppError('forbidden', 'm').toEnvelope().error.request_id).toBeNull();
  });
});

describe('toJSON — the ops.jobs.error shape', () => {
  it('is JSON-round-trippable and keeps code/retryable', () => {
    const err = unavailable(5, { store: 'redis' });
    const round = JSON.parse(JSON.stringify(err.toJSON())) as Record<string, unknown>;
    expect(round).toEqual({
      code: 'unavailable',
      message: 'service temporarily unavailable',
      status: 503,
      retryable: true,
      context: { store: 'redis' },
      retry_after_s: 5,
    });
  });

  it('omits empty details and context rather than writing empty objects to jsonb', () => {
    expect(new AppError('forbidden', 'm').toJSON()).toEqual({
      code: 'forbidden',
      message: 'm',
      status: 403,
      retryable: false,
    });
  });
});

describe('AppError.from', () => {
  it('passes an AppError through unchanged', () => {
    const original = notFound('survey', 'sv_1');
    expect(AppError.from(original)).toBe(original);
  });

  it('wraps a plain Error as internal_error, keeping the cause', () => {
    const cause = new TypeError('x is not a function');
    const wrapped = AppError.from(cause);
    expect(wrapped.code).toBe('internal_error');
    expect(wrapped.message).toBe('x is not a function');
    expect(wrapped.cause).toBe(cause);
    expect(wrapped.context['thrown_name']).toBe('TypeError');
  });

  it('wraps a non-Error throw without stringifying it to [object Object]', () => {
    const wrapped = AppError.from({ weird: true }, 'job handler threw');
    expect(wrapped.code).toBe('internal_error');
    expect(wrapped.message).toBe('job handler threw');
    expect(wrapped.context['thrown_type']).toBe('object');
    expect(wrapped.retryable).toBe(true);
  });

  it('wraps a thrown string', () => {
    const wrapped = AppError.from('boom');
    expect(wrapped.context['thrown_value']).toBe('boom');
  });

  it('isAppError narrows', () => {
    expect(AppError.isAppError(notFound('x'))).toBe(true);
    expect(AppError.isAppError(new Error('x'))).toBe(false);
    expect(AppError.isAppError(null)).toBe(false);
  });
});

describe('helpers', () => {
  it('notFound is the cross-tenant answer, and leaks no existence detail', () => {
    const err = notFound('survey', 'sv_other_org');
    expect(err.status).toBe(404);
    expect(err.toEnvelope().error.message).toBe('survey not found');
    expect(JSON.stringify(err.toEnvelope())).not.toContain('sv_other_org');
  });

  it('compileErrors carries logic-engine diagnostics verbatim', () => {
    const err = compileErrors([
      {
        path: null,
        code: 'LGC-F001',
        severity: 'error',
        message: "Q13's display rule reads Q9",
        node_id: 'qst_q13',
        rule_id: 'rul_1',
        source_span: { start: 42, end: 55 },
      },
      { path: null, code: 'QTA-W002', severity: 'warning', message: 'over-constrained' },
    ]);
    expect(err.status).toBe(422);
    expect(err.message).toBe('compilation failed with 1 error(s)');
    expect(err.toEnvelope().error.details[0]?.code).toBe('LGC-F001');
    expect(err.toEnvelope().error.details[0]?.source_span).toEqual({ start: 42, end: 55 });
  });

  it('stepUpRequired advertises the available methods', () => {
    const err = stepUpRequired();
    expect(err.status).toBe(403);
    expect(err.toEnvelope().error.details.map((d) => d.message)).toEqual(['totp', 'webauthn']);
  });

  it('entitlementRequired names the feature key', () => {
    const err = entitlementRequired('conjoint');
    expect(err.status).toBe(403);
    expect(err.toEnvelope().error.details[0]).toEqual({
      path: null,
      code: 'feature_key',
      message: 'conjoint',
    });
  });

  it('validationFailed pluralises', () => {
    expect(validationFailed([{ path: 'a', code: 'x', message: 'm' }]).message).toBe(
      '1 field failed validation',
    );
  });
});
