/**
 * The typed fetch wrapper.
 *
 * One place that knows the error envelope, so a component never parses `{error:{code}}` by
 * hand. `ApiError` carries `code` (the contract) and `details` (field-level, keyed by a dotted
 * path into the request body) — `message` is explicitly not a contract, per API §1.5.
 */

export interface ApiErrorDetail {
  readonly path: string | null;
  readonly code: string;
  readonly message: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: readonly ApiErrorDetail[] = [],
    readonly requestId: string | null = null,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** The message to show next to a specific form field, if any. */
  detailFor(path: string): string | undefined {
    return this.details.find((d) => d.path === path)?.message;
  }
}

export interface PageEnvelope<T> {
  readonly data: readonly T[];
  readonly page: { readonly next_cursor: string | null; readonly has_more: boolean; readonly limit: number };
}

export interface ApiRequestOptions {
  readonly method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  readonly body?: unknown;
  readonly idempotencyKey?: string;
  /** Sent as `If-Match`; required by every version-scoped mutation (API §1.7). */
  readonly ifMatch?: string;
  readonly signal?: AbortSignal;
}

export interface ApiResponse<T> {
  readonly data: T;
  /** Present on version reads; the client must echo it back as `If-Match` on the next write. */
  readonly etag: string | null;
}

export async function apiFetch<T>(path: string, options: ApiRequestOptions = {}): Promise<ApiResponse<T>> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.idempotencyKey !== undefined) headers['Idempotency-Key'] = options.idempotencyKey;
  if (options.ifMatch !== undefined) headers['If-Match'] = options.ifMatch;

  const response = await fetch('/api/v1' + path, {
    method: options.method ?? 'GET',
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    // The control plane is never cached by an intermediary.
    cache: 'no-store',
  });

  const etag = response.headers.get('etag');
  if (response.status === 204) {
    return { data: undefined as T, etag };
  }
  const text = await response.text();
  const payload: unknown = text === '' ? null : JSON.parse(text);
  if (!response.ok) {
    const envelope = payload as
      | { error?: { code?: string; message?: string; details?: ApiErrorDetail[]; request_id?: string | null } }
      | null;
    throw new ApiError(
      response.status,
      envelope?.error?.code ?? 'internal_error',
      envelope?.error?.message ?? 'request failed',
      envelope?.error?.details ?? [],
      envelope?.error?.request_id ?? null,
    );
  }
  return { data: payload as T, etag };
}

/** `crypto.randomUUID` is available in every runtime this app targets. */
export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}
