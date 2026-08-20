/**
 * Request correlation.
 *
 * M0.4's acceptance criterion is: "a `request_id` from the studio HTTP log can be pasted into
 * the trace viewer to retrieve the full studio → queue → worker span tree". That requires two
 * distinct identifiers travelling together, and conflating them is the usual mistake:
 *
 *  - `request_id` (`req_<ULID>`) is the CUSTOMER-FACING handle. It appears in the API error
 *    envelope (API §1.5), in `app.audit_log.request_id` (DB §10), and in every log line. A
 *    customer quotes it in a support ticket. Its format is fixed by the database.
 *  - `trace_id` (32 hex chars) is the W3C trace-context handle. It is what a trace backend
 *    indexes on, and it must survive an inbound `traceparent` from a caller we do not control.
 *
 * So we propagate both: `x-request-id` for the former, `traceparent`/`tracestate` for the
 * latter, and we log them side by side so either one finds the other.
 */

import { isValidSpanId, isValidTraceId, newSpanId, newTraceId, prefixedId } from './ids.js';

/**
 * A header bag that both `node:http` and the Fetch/Next.js world can produce.
 *
 * `node:http`'s `IncomingHttpHeaders` is `Record<string, string | string[] | undefined>`;
 * Next.js `headers()` and `Request.headers` are a `Headers` instance. Accepting the plain
 * record plus a `get()`-shaped duck type means neither caller needs an adapter, which matters
 * because the alternative (each app writing its own) is how the two ends of a propagation
 * chain drift apart.
 */
export type HeaderBag =
  | Record<string, string | string[] | undefined>
  | { get(name: string): string | null };

const REQUEST_ID_PREFIX = 'req_';

/** Bound on an attacker-supplied header we are about to write into logs and audit rows. */
const MAX_REQUEST_ID_LENGTH = 128;

/**
 * `x-request-id` is client-controlled. Accepting it verbatim would let a caller inject
 * newlines into a JSON-lines log stream (forging log entries) or a 10 MB string into every
 * audit row. So: printable ASCII, no whitespace, bounded length, or we mint our own.
 */
const SAFE_REQUEST_ID = /^[\x21-\x7e]{1,128}$/;

function hasGet(bag: HeaderBag): bag is { get(name: string): string | null } {
  return typeof (bag as { get?: unknown }).get === 'function';
}

/** Case-insensitive single-value header read. Returns the first value of a repeated header. */
export function headerValue(bag: HeaderBag | undefined, name: string): string | undefined {
  if (bag === undefined) return undefined;
  const lower = name.toLowerCase();
  if (hasGet(bag)) {
    const v = bag.get(lower);
    return v === null ? undefined : v;
  }
  const record = bag;
  const direct = record[lower];
  const raw =
    direct !== undefined
      ? direct
      : // node:http lowercases incoming header names, but a hand-built object (a test, an
        // internal RPC) may not, so fall back to a scan rather than silently losing the id.
        Object.entries(record).find(([k]) => k.toLowerCase() === lower)?.[1];
  if (raw === undefined) return undefined;
  if (Array.isArray(raw)) return raw[0];
  return raw;
}

export interface TraceParent {
  readonly version: string;
  readonly traceId: string;
  readonly spanId: string;
  readonly traceFlags: number;
}

/**
 * Parse a W3C `traceparent`: `00-<32 hex trace-id>-<16 hex parent-id>-<2 hex flags>`.
 *
 * Per the spec we accept an unknown future version with >4 fields (forward compatibility) but
 * reject version `ff`, malformed hex, and the all-zero ids. Returning `undefined` rather than
 * throwing is deliberate: a malformed inbound header must start a new trace, never 500 a
 * respondent page.
 */
export function parseTraceparent(value: string | undefined): TraceParent | undefined {
  if (value === undefined) return undefined;
  const parts = value.trim().split('-');
  if (parts.length < 4) return undefined;
  const [version, traceId, spanId, flags] = parts as [string, string, string, string, ...string[]];
  if (!/^[0-9a-f]{2}$/.test(version) || version === 'ff') return undefined;
  if (version === '00' && parts.length !== 4) return undefined;
  if (!isValidTraceId(traceId)) return undefined;
  if (!isValidSpanId(spanId)) return undefined;
  if (!/^[0-9a-f]{2}$/.test(flags)) return undefined;
  return { version: '00', traceId, spanId, traceFlags: Number.parseInt(flags, 16) };
}

/** Render a `traceparent` for an outbound call. Always version `00`. */
export function formatTraceparent(traceId: string, spanId: string, traceFlags = 1): string {
  const flags = (traceFlags & 0xff).toString(16).padStart(2, '0');
  return `00-${traceId}-${spanId}-${flags}`;
}

export interface Correlation {
  /** `req_<ULID>`, or the caller's own `x-request-id` when it is safe to echo. */
  readonly requestId: string;
  readonly traceId: string;
  /** The inbound span this request is a child of, when the caller sent one. */
  readonly parentSpanId: string | undefined;
  readonly traceFlags: number;
  /** True when the ids came from the caller rather than being minted here. */
  readonly inherited: boolean;
  /** Opaque vendor state to forward untouched (W3C requires pass-through). */
  readonly traceState: string | undefined;
}

/**
 * Derive the full correlation set from inbound headers, generating whatever is missing.
 *
 * Precedence for `request_id`:
 *   1. a safe `x-request-id` — an operator or an internal caller set it on purpose;
 *   2. otherwise a fresh `req_<ULID>`.
 *
 * WHY we do NOT derive `request_id` from the inbound `trace_id`: `app.audit_log.request_id`
 * is an `app.ulid`-shaped value (DB §10). Stuffing a 32-hex trace id into it would either
 * violate the domain or force a second format that the studio's "paste a request id" search
 * box has to sniff. The trace linkage is carried by `trace_id` on the same log line instead,
 * which is what the trace viewer indexes anyway.
 */
export function correlationFrom(headers: HeaderBag | undefined): Correlation {
  const inboundRequestId = headerValue(headers, 'x-request-id');
  const requestId =
    inboundRequestId !== undefined &&
    inboundRequestId.length <= MAX_REQUEST_ID_LENGTH &&
    SAFE_REQUEST_ID.test(inboundRequestId)
      ? inboundRequestId
      : prefixedId('req');

  const parent = parseTraceparent(headerValue(headers, 'traceparent'));
  const traceState = headerValue(headers, 'tracestate');

  if (parent !== undefined) {
    return {
      requestId,
      traceId: parent.traceId,
      parentSpanId: parent.spanId,
      traceFlags: parent.traceFlags,
      inherited: true,
      traceState,
    };
  }

  return {
    requestId,
    traceId: newTraceId(),
    parentSpanId: undefined,
    // Sampled by default. Head-based sampling is a deployment concern (M0.4's dashboards),
    // and defaulting to unsampled here would mean the first trace anyone looks for is missing.
    traceFlags: 1,
    inherited: false,
    traceState,
  };
}

/**
 * The narrow, common case: "give me a request id for this request."
 *
 * Kept as its own export because `apps/runtime`'s hot path only needs the id, and paying for
 * traceparent parsing on a health check is pointless.
 */
export function requestIdFrom(headers: HeaderBag | undefined): string {
  const inbound = headerValue(headers, 'x-request-id');
  if (
    inbound !== undefined &&
    inbound.length <= MAX_REQUEST_ID_LENGTH &&
    SAFE_REQUEST_ID.test(inbound)
  ) {
    return inbound;
  }
  return prefixedId('req');
}

/** True for ids this process would have minted. Used by the studio's request-id search box. */
export function isRequestId(v: string): boolean {
  return v.startsWith(REQUEST_ID_PREFIX) && /^req_[0-9A-HJKMNP-TV-Z]{26}$/.test(v);
}

/**
 * Headers to attach to an outbound call so the far side joins this trace.
 *
 * This is the function that makes studio → queue → worker → runtime one span tree. The queue
 * hop is not HTTP, so `apps/worker` reads the same three keys out of `ops.jobs.payload`
 * instead — same names, same parser, one propagation format for the whole system.
 */
export function outboundHeaders(args: {
  requestId: string;
  traceId: string;
  spanId: string;
  traceFlags?: number;
  traceState?: string | undefined;
}): Record<string, string> {
  const out: Record<string, string> = {
    'x-request-id': args.requestId,
    traceparent: formatTraceparent(args.traceId, args.spanId, args.traceFlags ?? 1),
  };
  if (args.traceState !== undefined && args.traceState !== '') out['tracestate'] = args.traceState;
  return out;
}
