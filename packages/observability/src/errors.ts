/**
 * The error envelope, defined once.
 *
 * API §1.5 specifies one error shape "everywhere, including the runtime API". It lives in
 * `@resscript/observability` rather than in an API package because three different layers need
 * to construct it — the HTTP boundary, `apps/worker`'s job failure path (`ops.jobs.error`), and
 * the logger's error serialisation — and a shape defined in the API layer would be imported
 * backwards by the other two.
 *
 * The two fields that are NOT in API §1.5 and are added here on purpose:
 *
 *  - `retryable`. The wire envelope communicates retryability implicitly, through status and
 *    `retry_after_s`. That is fine for a client but useless for `apps/worker`, which must
 *    decide between "backoff and try again" and "mark failed, stop burning attempts"
 *    (`ops.fail_job(id, error, retryable)`). Deriving it from the status code at each call
 *    site is how a transient 503 ends up permanently failed.
 *  - `context`. Structured fields for the log line, kept separate from `details` because
 *    `details` is a public contract shown to the caller and `context` is internal. Mixing them
 *    is how an internal table name ends up in a customer-visible payload.
 *
 * `message` is explicitly not a contract (API §1.5: "human, English, never parsed by clients").
 * `code` is.
 */

import type { LogFields } from './logger.js';

/**
 * The top-level codes from API §1.5's table, verbatim. A closed union rather than `string`,
 * so an alert routing policy (M0.4) can switch exhaustively over the set and a new code
 * cannot appear without the routing being updated.
 */
export type ErrorCode =
  // 400
  | 'malformed_request'
  | 'unknown_field'
  | 'invalid_cursor'
  // 401
  | 'unauthenticated'
  | 'token_expired'
  | 'key_revoked'
  // 403
  | 'forbidden'
  | 'step_up_required'
  | 'entitlement_required'
  // 404
  | 'not_found'
  // 409
  | 'already_exists'
  | 'illegal_transition'
  | 'frozen_version'
  | 'cursor_stale'
  // 412
  | 'revision_conflict'
  // 422
  | 'validation_failed'
  | 'compile_errors'
  | 'idempotency_key_reuse'
  // 428
  | 'precondition_required'
  // 429
  | 'rate_limited'
  // 500
  | 'internal_error'
  // 503
  | 'unavailable';

/** The canonical status for each code, so a call site never has to remember it. */
const STATUS_BY_CODE: Record<ErrorCode, number> = {
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

/**
 * Default retryability.
 *
 * Only 429 and 503 are retryable by default, plus `internal_error` — a 500 is by definition a
 * bug of unknown extent, and the worker's bounded `max_attempts` (DB §10.1, default 3) makes
 * retrying it cheap and occasionally correct. Everything 4xx and deterministic is NOT
 * retryable: retrying a `validation_failed` compile three times just delays the user's error
 * message by the backoff interval.
 *
 * `revision_conflict` is deliberately false. It is retryable by a HUMAN after a merge, not by
 * a machine — auto-retrying an optimistic-lock failure is how you get a silent overwrite, the
 * exact failure P1-03's conflict dialog exists to prevent.
 */
const RETRYABLE_BY_CODE: Record<ErrorCode, boolean> = {
  malformed_request: false,
  unknown_field: false,
  invalid_cursor: false,
  unauthenticated: false,
  token_expired: false,
  key_revoked: false,
  forbidden: false,
  step_up_required: false,
  entitlement_required: false,
  not_found: false,
  already_exists: false,
  illegal_transition: false,
  frozen_version: false,
  cursor_stale: false,
  revision_conflict: false,
  validation_failed: false,
  compile_errors: false,
  idempotency_key_reuse: false,
  precondition_required: false,
  rate_limited: true,
  internal_error: true,
  unavailable: true,
};

export const DOCS_BASE_URL = 'https://docs.rescript.io/errors/';

/** One entry of API §1.5's `details[]`. `path` is a dotted path into the REQUEST body. */
export interface ErrorDetail {
  readonly path: string | null;
  readonly code: string;
  readonly message: string;
  /** Logic-engine diagnostics carry these (API §1.5's `compile_errors` example). */
  readonly node_id?: string;
  readonly rule_id?: string;
  readonly severity?: 'error' | 'warning';
  readonly source_span?: { readonly start: number; readonly end: number };
}

/** The exact JSON body served to a client. */
export interface ErrorEnvelope {
  readonly error: {
    readonly code: ErrorCode;
    readonly message: string;
    readonly request_id: string | null;
    readonly docs_url: string;
    readonly details: readonly ErrorDetail[];
    readonly retry_after_s: number | null;
  };
}

export interface AppErrorOptions {
  readonly status?: number;
  readonly retryable?: boolean;
  readonly details?: readonly ErrorDetail[];
  /** Internal structured fields for the log line. Never serialised to a client. */
  readonly context?: LogFields;
  readonly requestId?: string;
  readonly retryAfterS?: number;
  readonly cause?: unknown;
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly retryable: boolean;
  readonly details: readonly ErrorDetail[];
  readonly context: Readonly<LogFields>;
  readonly requestId: string | undefined;
  readonly retryAfterS: number | undefined;

  constructor(code: ErrorCode, message: string, options: AppErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AppError';
    this.code = code;
    this.status = options.status ?? STATUS_BY_CODE[code];
    this.retryable = options.retryable ?? RETRYABLE_BY_CODE[code];
    this.details = options.details ?? [];
    this.context = Object.freeze({ ...options.context });
    this.requestId = options.requestId;
    this.retryAfterS = options.retryAfterS;
  }

  /** The client-facing body. `details` and `message` only; `context` stays internal. */
  toEnvelope(requestId?: string): ErrorEnvelope {
    return {
      error: {
        code: this.code,
        message:
          // API §1.5: a 500 "never carries detail. `request_id` is the handle." Enforced here
          // rather than at each throw site, because the throw site is where the useful
          // internal message is written and it must survive into the logs.
          this.code === 'internal_error' ? 'An unexpected error occurred.' : this.message,
        request_id: requestId ?? this.requestId ?? null,
        docs_url: `${DOCS_BASE_URL}${this.code}`,
        details: this.code === 'internal_error' ? [] : this.details,
        retry_after_s: this.retryAfterS ?? null,
      },
    };
  }

  /**
   * The shape written to `ops.jobs.error` (DB §10.1) and picked up by the logger's error
   * serialisation. Includes `context` — this side of the boundary is internal.
   */
  toJSON(): Record<string, unknown> {
    return {
      code: this.code,
      message: this.message,
      status: this.status,
      retryable: this.retryable,
      ...(this.details.length > 0 ? { details: this.details } : {}),
      ...(Object.keys(this.context).length > 0 ? { context: this.context } : {}),
      ...(this.requestId === undefined ? {} : { request_id: this.requestId }),
      ...(this.retryAfterS === undefined ? {} : { retry_after_s: this.retryAfterS }),
    };
  }

  /**
   * Coerce anything a `catch` can produce into an `AppError`.
   *
   * `useUnknownInCatchVariables` is on repo-wide, so every catch block needs this. Non-AppError
   * values become `internal_error` and keep the original as `cause`, which is what makes an
   * unexpected throw show up in the logs with its stack instead of as `"[object Object]"`.
   */
  static from(err: unknown, fallbackMessage = 'unexpected error'): AppError {
    if (err instanceof AppError) return err;
    if (err instanceof Error) {
      return new AppError('internal_error', err.message || fallbackMessage, {
        cause: err,
        context: { thrown_name: err.name },
      });
    }
    return new AppError('internal_error', fallbackMessage, {
      cause: err,
      context: { thrown_type: typeof err, thrown_value: String(err) },
    });
  }

  static isAppError(err: unknown): err is AppError {
    return err instanceof AppError;
  }
}

/** Status for a code, for callers that need it without constructing an error. */
export function statusForCode(code: ErrorCode): number {
  return STATUS_BY_CODE[code];
}

export function isRetryableCode(code: ErrorCode): boolean {
  return RETRYABLE_BY_CODE[code];
}

/*
 * Helpers for the common shapes. These exist so that the ~90% of throw sites that need no
 * options read as one line, and so that the mapping from situation to code is made once here
 * instead of guessed per call site (which is how `not_found` and `forbidden` get mixed up —
 * see API §1.5: a cross-tenant read is 404, not 403, because confirming existence leaks).
 */

export function malformedRequest(message: string, details?: readonly ErrorDetail[]): AppError {
  return new AppError('malformed_request', message, details === undefined ? {} : { details });
}

export function unauthenticated(message = 'authentication required'): AppError {
  return new AppError('unauthenticated', message);
}

export function forbidden(message: string, details?: readonly ErrorDetail[]): AppError {
  return new AppError('forbidden', message, details === undefined ? {} : { details });
}

/** API §1.5: also the correct answer for a cross-tenant read, which RLS makes invisible. */
export function notFound(resource: string, id?: string): AppError {
  return new AppError('not_found', `${resource} not found`, {
    context: id === undefined ? { resource } : { resource, id },
  });
}

export function alreadyExists(resource: string, context?: LogFields): AppError {
  return new AppError('already_exists', `${resource} already exists`, {
    context: { resource, ...context },
  });
}

/** Mirrors `tg_version_guard()` (DB §3.1). */
export function illegalTransition(from: string, to: string): AppError {
  return new AppError('illegal_transition', `cannot transition from ${from} to ${to}`, {
    context: { from, to },
  });
}

export function frozenVersion(surveyVersionId: string): AppError {
  return new AppError('frozen_version', 'this survey version is frozen; clone a new draft to edit', {
    context: { survey_version_id: surveyVersionId },
  });
}

export function revisionConflict(expected: string, actual: string): AppError {
  return new AppError('revision_conflict', 'the resource was modified by someone else', {
    context: { expected_revision: expected, actual_revision: actual },
  });
}

export function validationFailed(details: readonly ErrorDetail[]): AppError {
  const n = details.length;
  return new AppError('validation_failed', `${n} field${n === 1 ? '' : 's'} failed validation`, {
    details,
  });
}

/** API §1.5: `details[]` carries the logic engine's own diagnostic codes verbatim (D §3.5). */
export function compileErrors(details: readonly ErrorDetail[]): AppError {
  const errors = details.filter((d) => d.severity !== 'warning').length;
  return new AppError('compile_errors', `compilation failed with ${errors} error(s)`, { details });
}

export function idempotencyKeyReuse(key: string): AppError {
  return new AppError(
    'idempotency_key_reuse',
    'this idempotency key was used with a different request body',
    // The key itself is allowlisted for logging (see redact.ts) — it is a client-chosen
    // correlation token, not a credential.
    { context: { idempotency_key: key } },
  );
}

export function preconditionRequired(header = 'If-Match'): AppError {
  return new AppError('precondition_required', `${header} is required for this mutation`, {
    context: { header },
  });
}

export function rateLimited(retryAfterS: number, context?: LogFields): AppError {
  return new AppError('rate_limited', 'rate limit exceeded', {
    retryAfterS,
    context: { ...context },
  });
}

/** security §12.2 load shedding. Always with a `Retry-After`. */
export function unavailable(retryAfterS = 5, context?: LogFields): AppError {
  return new AppError('unavailable', 'service temporarily unavailable', {
    retryAfterS,
    context: { ...context },
  });
}

export function stepUpRequired(methods: readonly string[] = ['totp', 'webauthn']): AppError {
  return new AppError('step_up_required', 'step-up authentication required', {
    details: methods.map((m) => ({ path: null, code: 'method_available', message: m })),
    context: { methods },
  });
}

export function entitlementRequired(featureKey: string): AppError {
  return new AppError('entitlement_required', `your plan does not include ${featureKey}`, {
    details: [{ path: null, code: 'feature_key', message: featureKey }],
    context: { feature_key: featureKey },
  });
}

export function internalError(message: string, options: AppErrorOptions = {}): AppError {
  return new AppError('internal_error', message, options);
}
