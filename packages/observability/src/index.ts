/**
 * `@resscript/observability` — the browser-safe surface.
 *
 * ZERO runtime dependencies, by ADR-010 and because `apps/runtime` imports this on the
 * respondent critical path (arch §3.3, §8). Nothing re-exported here may import a Node builtin:
 * `apps/studio` pulls this into client bundles and `packages/logic` must survive QuickJS-WASM.
 * The `node:async_hooks`-backed context lives behind `@resscript/observability/node`.
 *
 * If you are adding an export here, the test to apply is: would this still work in a browser?
 * If not, it belongs in `./node`.
 */

// --- Structured logging (M0.4: JSON logs with a propagated request_id) ---
export {
  createCapturingLogger,
  createLogger,
  isLogLevel,
  LOG_LEVELS,
  nullLogger,
  type CapturedLogger,
  type LogFields,
  type Logger,
  type LoggerOptions,
  type LogLevel,
  type LogSink,
} from './logger.js';

// --- Redaction (security §8.1: PII values are never logged) ---
export {
  createRedactionPolicy,
  DEFAULT_ALLOW_KEYS,
  DEFAULT_DENY_PATTERNS,
  DEFAULT_REDACTION_POLICY,
  isDeniedKey,
  isTainted,
  redact,
  REDACTED,
  tainted,
  type RedactionPolicy,
  type Tainted,
} from './redact.js';

// --- Request correlation ---
export {
  correlationFrom,
  formatTraceparent,
  headerValue,
  isRequestId,
  outboundHeaders,
  parseTraceparent,
  requestIdFrom,
  type Correlation,
  type HeaderBag,
  type TraceParent,
} from './request-id.js';

// The ambient-context READERS are safe everywhere (they no-op without a provider); only the
// AsyncLocalStorage-backed WRITER is Node-only.
export {
  ambientContext,
  resetContextProvider,
  setContextProvider,
  type ContextProvider,
  type CorrelationContext,
} from './ambient.js';

// --- Tracing ---
export {
  ConsoleSpanExporter,
  getSpanExporter,
  inSpan,
  InMemorySpanExporter,
  NoopSpanExporter,
  setSpanExporter,
  setTracerService,
  startSpan,
  type Attributes,
  type AttributeValue,
  type ParentRef,
  type ReadableSpan,
  type Span,
  type SpanContext,
  type SpanEvent,
  type SpanExporter,
  type SpanKind,
  type SpanStatus,
  type SpanStatusCode,
  type StartSpanOptions,
} from './trace.js';

// --- Metrics (M0.4: the fixed vocabulary) ---
export {
  createMetrics,
  describeSample,
  getMetricSink,
  InMemorySink,
  LogMetricSink,
  METRICS,
  metrics,
  MultiSink,
  NoopSink,
  setMetricSink,
  type CounterName,
  type GaugeName,
  type HistogramName,
  type LabelsOf,
  type MetricDefinition,
  type MetricKind,
  type MetricName,
  type MetricNameOfKind,
  type Metrics,
  type MetricRegistry,
  type MetricSample,
  type MetricSink,
} from './metrics.js';

// --- Errors (API §1.5's envelope) ---
export {
  alreadyExists,
  AppError,
  compileErrors,
  DOCS_BASE_URL,
  entitlementRequired,
  forbidden,
  frozenVersion,
  idempotencyKeyReuse,
  illegalTransition,
  internalError,
  isRetryableCode,
  malformedRequest,
  notFound,
  preconditionRequired,
  rateLimited,
  revisionConflict,
  statusForCode,
  stepUpRequired,
  unauthenticated,
  unavailable,
  validationFailed,
  type AppErrorOptions,
  type ErrorCode,
  type ErrorDetail,
  type ErrorEnvelope,
} from './errors.js';

// --- Ids ---
export {
  isValidSpanId,
  isValidTraceId,
  newSpanId,
  newTraceId,
  prefixedId,
  ulid,
} from './ids.js';
