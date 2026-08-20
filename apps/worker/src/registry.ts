/**
 * The job-kind → handler registry.
 *
 * The design goal is that `ctx.payload` inside a handler is TYPED — not `JsonObject`, not
 * `any`. `ops.jobs.payload` is `jsonb`, so what comes out of the database is genuinely unknown
 * at compile time; the only honest way to get a type is to make each kind declare a `parse`
 * that turns `JsonObject` into its own payload type, and then infer the handler's parameter
 * from that function's return type. That is what `defineJob` does.
 *
 * The parse step is not ceremony. A job row can be months old (a retried export, a replayed
 * backfill) and written by an older deploy, so its payload may be missing a field the current
 * handler requires. Parsing at the boundary turns that into one clear `malformed_request`
 * failure on the job row instead of a `TypeError` three frames deep with no context.
 *
 * `register` returns a NEW registry whose type includes the added kind, so the payload types
 * accumulate as a builder chain and `registry.kinds()` is a literal union rather than
 * `string[]`.
 */

import type { Logger } from '@resscript/observability';

import type { JobRow } from './job-store.js';
import type { JsonObject, JsonValue } from './json.js';

/**
 * What a handler is given.
 *
 * Narrow on purpose: a handler gets its payload, a way to report progress, a logger already
 * bound to the job, and a cancellation signal. It does not get the store — a handler that can
 * call `complete()` itself can complete a job it no longer owns.
 */
export interface JobContext<P> {
  readonly job: JobRow;
  readonly payload: P;
  /** 1-based; equals `ops.jobs.attempts` for this run. */
  readonly attempt: number;
  readonly maxAttempts: number;
  /** Bound to `job_id`, `kind`, `attempt`, plus the ambient request id. */
  readonly log: Logger;
  /**
   * Aborted on SIGTERM-after-grace-period and when the heartbeat discovers the job was
   * requeued underneath us. A long-running handler (a 200k-row export) should poll this
   * between batches; a short one can ignore it.
   */
  readonly signal: AbortSignal;
  /**
   * Write `{ step, total, message }` to `ops.jobs.progress`.
   *
   * Coalesced: the first step, the last step, and at most one write per heartbeat interval
   * reach the database, so a handler reporting progress 500 times does 500 cheap in-memory
   * writes and a handful of UPDATEs. The studio's job-status component reads these three keys
   * (roadmap M0.4 Frontend).
   */
  progress(step: number, total: number, message?: string): Promise<void>;
}

export type JobHandler<P, R extends JsonValue> = (ctx: JobContext<P>) => Promise<R>;

export interface JobDefinition<P, R extends JsonValue> {
  /** Validate and narrow the raw `jsonb` payload. Throw to fail the job as non-retryable. */
  readonly parse: (raw: JsonObject) => P;
  readonly handle: JobHandler<P, R>;
  /** Overrides `ops.jobs.max_attempts` at enqueue time for this kind. */
  readonly maxAttempts?: number;
  /**
   * Whether an unrecognised throw from `handle` should be retried. Defaults to true: most job
   * failures are transient (a CDN 503, a lock timeout). A handler that knows better throws an
   * `AppError` with an explicit `retryable`, which always wins over this default.
   */
  readonly retryUnknownErrors?: boolean;
}

/** Identity + the definition, type-erased for the consumer loop. */
export interface ErasedJobDefinition {
  readonly kind: string;
  readonly parse: (raw: JsonObject) => unknown;
  readonly handle: (ctx: JobContext<unknown>) => Promise<JsonValue>;
  readonly maxAttempts: number | undefined;
  readonly retryUnknownErrors: boolean;
}

/**
 * Helper that infers `P` from `parse` and `R` from `handle`, so a call site writes no type
 * arguments and still gets a typed `ctx.payload`.
 */
export function defineJob<P, R extends JsonValue>(def: JobDefinition<P, R>): JobDefinition<P, R> {
  return def;
}

/** Maps each registered kind to its parsed payload type. */
export type PayloadMap = Record<string, unknown>;

export class JobRegistry<M extends PayloadMap = Record<never, never>> {
  private constructor(private readonly defs: ReadonlyMap<string, ErasedJobDefinition>) {}

  static create(): JobRegistry {
    return new JobRegistry(new Map());
  }

  /**
   * Add a kind. Returns a registry whose TYPE knows about it, so
   * `JobRegistry.create().register('noop', …).register('compile', …)` produces a
   * `JobRegistry<{ noop: NoopPayload; compile: CompilePayload }>`.
   */
  register<K extends string, P, R extends JsonValue>(
    kind: K,
    def: JobDefinition<P, R>,
  ): JobRegistry<M & Record<K, P>> {
    if (this.defs.has(kind)) {
      // A duplicate registration means two modules disagree about what `kind` does, and the
      // loser would be chosen by import order. Fail at startup instead.
      throw new Error(`job kind already registered: ${kind}`);
    }
    const erased: ErasedJobDefinition = {
      kind,
      parse: def.parse as (raw: JsonObject) => unknown,
      handle: def.handle as unknown as (ctx: JobContext<unknown>) => Promise<JsonValue>,
      maxAttempts: def.maxAttempts,
      retryUnknownErrors: def.retryUnknownErrors ?? true,
    };
    const next = new Map(this.defs);
    next.set(kind, erased);
    return new JobRegistry<M & Record<K, P>>(next);
  }

  /** The kinds this worker will claim. Typed as the literal union of registered kinds. */
  kinds(): (keyof M & string)[] {
    return [...this.defs.keys()] as (keyof M & string)[];
  }

  get(kind: string): ErasedJobDefinition | undefined {
    return this.defs.get(kind);
  }

  has(kind: string): boolean {
    return this.defs.has(kind);
  }

  get size(): number {
    return this.defs.size;
  }
}

/**
 * Payload-parsing helpers.
 *
 * A dozen lines rather than a schema library, because `apps/worker` should not grow an Ajv/Zod
 * dependency for payloads it also writes. When `packages/schema` lands (P1-02) its JSON Schema
 * validators are the right tool for the compile/export payloads, and these helpers stay for the
 * trivial ones.
 */
export const payload = {
  requiredString(raw: JsonObject, key: string): string {
    const v = raw[key];
    if (typeof v !== 'string' || v === '') {
      throw new TypeError(`payload.${key} must be a non-empty string`);
    }
    return v;
  },

  optionalString(raw: JsonObject, key: string): string | undefined {
    const v = raw[key];
    if (v === undefined || v === null) return undefined;
    if (typeof v !== 'string') throw new TypeError(`payload.${key} must be a string`);
    return v;
  },

  optionalInt(raw: JsonObject, key: string, fallback: number): number {
    const v = raw[key];
    if (v === undefined || v === null) return fallback;
    if (typeof v !== 'number' || !Number.isInteger(v)) {
      throw new TypeError(`payload.${key} must be an integer`);
    }
    return v;
  },
} as const;
