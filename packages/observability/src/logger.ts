/**
 * Structured JSON-lines logging.
 *
 * One line per event, one JSON object per line, written to stdout and collected by the
 * platform. No log files, no rotation, no transports — arch §3 puts three deployables behind
 * a managed runtime, and anything more than "write to stdout" is a thing to operate.
 *
 * Field order in the emitted object is deliberate and stable: `ts`, `level`, `service`, `msg`
 * come first so a human tailing raw output can read it without a pretty-printer, and
 * `request_id`/`trace_id`/`span_id` come next because they are what an investigation pivots on
 * (M0.4: paste a request id into the trace viewer).
 *
 * Every field passes through `redact()` (see redact.ts). That is not a nicety: security §8.1
 * requires that "Values from PII variables are never logged", and a redaction pass bolted on
 * later cannot fix log lines already sitting in an aggregator's retention window.
 */

import { ambientContext, type CorrelationContext } from './ambient.js';
import {
  DEFAULT_REDACTION_POLICY,
  redact,
  type RedactionPolicy,
} from './redact.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type LogFields = Record<string, unknown>;

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

export function isLogLevel(v: string): v is LogLevel {
  return v === 'debug' || v === 'info' || v === 'warn' || v === 'error';
}

/** Where a rendered line goes. Injectable so tests assert on bytes, not on console spies. */
export type LogSink = (line: string) => void;

export interface LoggerOptions {
  /** Deployable name: `studio` | `runtime` | `worker`. Partitions dashboards (M0.4). */
  readonly service: string;
  /** Explicit request id, for hosts without an ambient context (a browser, a bare script). */
  readonly requestId?: string;
  /** Fields merged into every line from this logger. */
  readonly bindings?: LogFields;
  /** Lines below this level are dropped. Defaults to `LOG_LEVEL` env, else `info`. */
  readonly level?: LogLevel;
  readonly sink?: LogSink;
  readonly redaction?: RedactionPolicy;
  /** Injectable clock. Tests need a fixed `ts`; nothing else should pass this. */
  readonly now?: () => Date;
  /**
   * Read the ambient correlation context. Defaults to the provider installed by
   * `@resscript/observability/node`; overridable so a test can pin it without AsyncLocalStorage.
   */
  readonly context?: () => CorrelationContext | undefined;
}

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  /** Emit at a level chosen at runtime (e.g. from a job result). */
  log(level: LogLevel, msg: string, fields?: LogFields): void;
  /** A logger carrying additional permanent fields. Cheap: no I/O, no allocation beyond one object. */
  child(bindings: LogFields): Logger;
  /** The service name, so callers (the worker's job context) can re-derive a sibling logger. */
  readonly service: string;
  readonly level: LogLevel;
}

/**
 * Default sink.
 *
 * `process.stdout.write` rather than `console.log` in Node, because console.log on a pipe can
 * interleave partial writes between processes under load, and because it is measurably cheaper.
 * Falls back to `console.log` in a browser, where the root export must still work.
 */
function defaultSink(line: string): void {
  const proc = (globalThis as { process?: { stdout?: { write?: (s: string) => boolean } } }).process;
  const write = proc?.stdout?.write;
  if (typeof write === 'function' && proc?.stdout !== undefined) {
    write.call(proc.stdout, `${line}\n`);
    return;
  }
  // eslint-disable-next-line no-console -- the browser fallback is the whole point of this branch
  console.log(line);
}

function envLevel(): LogLevel {
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  const raw = proc?.env?.['LOG_LEVEL'];
  if (raw !== undefined && isLogLevel(raw)) return raw;
  return 'info';
}

/**
 * Field names the logger owns. A caller-supplied field with one of these names is renamed to
 * `fields.<name>` rather than silently overwriting the envelope — a handler that logs
 * `{ level: 'high' }` must not be able to make an error line look like a debug line.
 */
const RESERVED = new Set(['ts', 'level', 'service', 'msg']);

interface LoggerState {
  readonly service: string;
  readonly level: LogLevel;
  readonly bindings: LogFields;
  readonly requestId: string | undefined;
  readonly sink: LogSink;
  readonly policy: RedactionPolicy;
  readonly now: () => Date;
  readonly context: () => CorrelationContext | undefined;
}

function emit(state: LoggerState, level: LogLevel, msg: string, fields?: LogFields): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[state.level]) return;

  const ctx = state.context();

  // Envelope first, in the order we want it serialised. JSON.stringify preserves insertion
  // order for string keys, so this is the on-the-wire order.
  const line: Record<string, unknown> = {
    ts: state.now().toISOString(),
    level,
    service: state.service,
    msg,
  };

  const requestId = state.requestId ?? ctx?.requestId;
  if (requestId !== undefined) line['request_id'] = requestId;
  if (ctx?.traceId !== undefined) line['trace_id'] = ctx.traceId;
  if (ctx?.spanId !== undefined) line['span_id'] = ctx.spanId;
  if (ctx?.orgId !== undefined) line['org_id'] = ctx.orgId;

  // Precedence, least specific to most: ambient bindings < logger bindings < call fields.
  // A per-call field should win, because it is the one the author wrote next to the message.
  const merged: LogFields = {
    ...ctx?.bindings,
    ...state.bindings,
    ...fields,
  };

  const nested: LogFields = {};
  for (const key of Object.keys(merged)) {
    if (RESERVED.has(key) || key === 'request_id' || key === 'trace_id' || key === 'span_id') {
      nested[key] = merged[key];
      continue;
    }
    line[key] = merged[key];
  }
  if (Object.keys(nested).length > 0) line['fields'] = nested;

  const safe = redact(line, state.policy) as Record<string, unknown>;
  state.sink(serialise(safe));
}

/**
 * Serialise, and never throw.
 *
 * `redact()` already replaced every non-JSON-safe value, so this should not fail — but a
 * logger that can throw turns an incident into two incidents, so the fallback stays.
 */
function serialise(value: Record<string, unknown>): string {
  try {
    return JSON.stringify(value);
  } catch (err: unknown) {
    return JSON.stringify({
      ts: new Date().toISOString(),
      level: 'error',
      service: String(value['service'] ?? 'unknown'),
      msg: 'log_serialisation_failed',
      original_msg: String(value['msg'] ?? ''),
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

function build(state: LoggerState): Logger {
  return {
    service: state.service,
    level: state.level,
    debug: (msg, fields) => emit(state, 'debug', msg, fields),
    info: (msg, fields) => emit(state, 'info', msg, fields),
    warn: (msg, fields) => emit(state, 'warn', msg, fields),
    error: (msg, fields) => emit(state, 'error', msg, fields),
    log: (level, msg, fields) => emit(state, level, msg, fields),
    child: (bindings) => build({ ...state, bindings: { ...state.bindings, ...bindings } }),
  };
}

export function createLogger(options: LoggerOptions): Logger {
  return build({
    service: options.service,
    level: options.level ?? envLevel(),
    bindings: options.bindings ?? {},
    requestId: options.requestId,
    sink: options.sink ?? defaultSink,
    policy: options.redaction ?? DEFAULT_REDACTION_POLICY,
    now: options.now ?? (() => new Date()),
    context: options.context ?? ambientContext,
  });
}

/** A logger that discards everything. For tests and for the `logic` evaluator's default. */
export function nullLogger(service = 'null'): Logger {
  return createLogger({ service, level: 'error', sink: () => undefined });
}

export interface CapturedLogger {
  readonly logger: Logger;
  /** Parsed lines, in emission order. */
  readonly lines: Record<string, unknown>[];
  /** The raw bytes, for assertions about what actually hit stdout. */
  readonly raw: string[];
  clear(): void;
}

/**
 * A logger that captures instead of writing.
 *
 * Lives in the shipped module rather than a test helper file because `apps/worker` and
 * `apps/studio` tests need it too, and a second copy would drift from the real emit path —
 * which is precisely the path the redaction tests must exercise.
 */
export function createCapturingLogger(
  options: Omit<LoggerOptions, 'sink'> & { readonly sink?: never },
): CapturedLogger {
  const raw: string[] = [];
  const lines: Record<string, unknown>[] = [];
  const { sink: _ignored, ...rest } = options;
  const logger = createLogger({
    ...rest,
    level: rest.level ?? 'debug',
    sink: (line) => {
      raw.push(line);
      lines.push(JSON.parse(line) as Record<string, unknown>);
    },
  });
  return {
    logger,
    lines,
    raw,
    clear: () => {
      raw.length = 0;
      lines.length = 0;
    },
  };
}
