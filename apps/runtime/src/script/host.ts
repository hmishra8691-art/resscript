/**
 * The QuickJS-WASM script host — E §13.
 *
 * Customer `runs_on: 'server'` scripts execute here and nowhere else. The design constraints,
 * in the order they shaped this file:
 *
 * **The API surface is closed** (E §13.1: "this is ALL of it"). The interpreter starts with an
 * empty global and receives exactly one host function, `__host(op, argsJson)`; the `survey`
 * object the script sees is built by a fixed prelude that forwards to it. Anything not routed
 * through `__host` does not exist inside the sandbox — no Date, no Math.random, no fetch, no
 * eval-time surprises from a rich global. The prelude approach also keeps the marshalling
 * surface to one JSON string in, one JSON string out, which is the difference between one
 * disposal-safe bridge and thirty leak opportunities.
 *
 * **Budgets are enforced by the engine, not by hope** (E §13.2). Memory via
 * `setMemoryLimit`, stack via `setMaxStackSize`, runaway loops via the interrupt handler —
 * QuickJS invokes it periodically during execution, so a `while(true)` is a clean
 * `instruction_limit` at a bounded cost, which is the reason ADR-005 chose QuickJS over a V8
 * isolate. The wall clock is checked in the same handler. Host-side counters cap `setValue`
 * (100) and log volume (200 entries / 64 KB).
 *
 * **Writes are copy-on-write and all-or-nothing** (E §13.3). `setValue` accumulates into an
 * overlay that the CALLER merges only when the result is `ok`. A script that dies halfway
 * through setting three variables has set none of them. And the context is discarded after
 * every run, success or failure — a context that hit a limit is in an unknown state, and
 * pooling it is how one customer's script leaks into another's execution.
 *
 * **Determinism is inherited, not re-invented** (ADR-006). `context.random(salt)` derives
 * from the session seed through the same counter PRNG as randomization, with a per-salt call
 * counter, so a replayed session sees identical values in identical order. There is no other
 * randomness and no real clock inside the sandbox; `context.server_time_ms` is the injected
 * evaluation clock (D §2.6).
 *
 * Deliberately deferred, recorded here so the gap is visible: `survey.http` requires the
 * allowlisted egress proxy (security §5.3), which does not exist yet — the op is wired to an
 * injectable performer and DENIES by default, so a script calling it today gets the
 * `http_denied` error E §13.3 names rather than an undefined function. `survey.secret` is the
 * same shape: injectable lookup, absent by default.
 */

import { getQuickJS, type QuickJSWASMModule } from 'quickjs-emscripten';
import { deriveKey, randomAt } from '@resscript/runtime-core';

/* ------------------------------------------------------------------ *
 * Types
 * ------------------------------------------------------------------ */

export interface ScriptBudgets {
  readonly wall_ms: number;
  /** Interrupt-handler invocations, each ~10k QuickJS ops. 500 ≈ E §13.2's 5M instructions. */
  readonly max_interrupts: number;
  readonly memory_bytes: number;
  readonly stack_bytes: number;
  readonly max_set_value: number;
  readonly max_log_entries: number;
  readonly max_log_bytes: number;
  readonly max_http_calls: number;
}

export const DEFAULT_BUDGETS: ScriptBudgets = {
  wall_ms: 250,
  max_interrupts: 500,
  memory_bytes: 16 * 1024 * 1024,
  stack_bytes: 512 * 1024,
  max_set_value: 100,
  max_log_entries: 200,
  max_log_bytes: 64 * 1024,
  max_http_calls: 2,
};

export interface ScriptContext {
  readonly session_id: string;
  readonly survey_version: string;
  readonly language: string;
  readonly device: 'desktop' | 'tablet' | 'mobile';
  readonly country: string;
  readonly page_id: string | null;
  readonly hook: string;
  readonly is_test: boolean;
  readonly server_time_ms: number;
}

export interface RunScriptInput {
  readonly source: string;
  readonly assetRef: string;
  readonly seed: string;
  readonly context: ScriptContext;
  /** Read a variable's current value by REF. `undefined` = not a variable at all. */
  readonly getValue: (ref: string) => unknown;
  /** 'hidden' | 'derived' | 'response' | … — what `setValue` gates on. */
  readonly varKind: (ref: string) => string | undefined;
  readonly wasShown: (ref: string) => boolean;
  readonly budgets?: Partial<ScriptBudgets>;
  /** The allowlisted proxy, when it exists. Absent = every `survey.http` call is denied. */
  readonly http?: (req: {
    method: string; url: string; headers?: Record<string, string>; body?: string;
  }) => { status: number; headers: Record<string, string>; body: string };
  /** Org secret lookup. Absent = every `survey.secret` call throws inside the sandbox. */
  readonly secret?: (name: string) => string | null;
}

export interface ScriptLogEntry {
  readonly level: string;
  readonly msg: string;
  readonly data?: unknown;
}

export type ScriptResult =
  | {
      readonly ok: true;
      /** The copy-on-write overlay: REF → value, committed by the caller (E §13.3 step 2). */
      readonly writes: Record<string, unknown>;
      readonly flags: readonly string[];
      readonly terminate: { disposition: string; custom_key: string | null } | null;
      readonly reject: string | null;
      readonly logs: readonly ScriptLogEntry[];
      readonly wall_ms: number;
      readonly interrupts: number;
    }
  | {
      readonly ok: false;
      readonly reason: 'timeout' | 'instruction_limit' | 'oom' | 'throw' | 'http_denied' | 'parse';
      readonly error: string;
      readonly logs: readonly ScriptLogEntry[];
      readonly wall_ms: number;
      readonly interrupts: number;
    };

/* ------------------------------------------------------------------ *
 * The prelude
 * ------------------------------------------------------------------ */

/**
 * Runs before the customer script, in the same context. It builds the E §13.1 `survey` object
 * over `__host` and then REMOVES `__host` from the global, so the script cannot call the raw
 * bridge with ops the prelude does not expose. Frozen, because a script that can replace
 * `survey.setValue` with its own function is a script auditing tool that lies.
 */
const PRELUDE = `
const __h = globalThis.__host;
delete globalThis.__host;
const __call = (op, args) => {
  const r = JSON.parse(__h(op, JSON.stringify(args ?? {})));
  if (r.e) throw new Error(r.e);
  return r.v;
};
globalThis.survey = Object.freeze({
  getValue: (ref) => __call('getValue', { ref }),
  setValue: (ref, value) => { __call('setValue', { ref, value }); },
  getValues: (refs) => __call('getValues', { refs }),
  isAnswered: (ref) => __call('isAnswered', { ref }),
  wasShown: (ref) => __call('wasShown', { ref }),
  context: Object.freeze({ ...__call('context', {}), random: (salt) => __call('random', { salt }) }),
  log: (level, msg, data) => { __call('log', { level, msg, data }); },
  flag: (key) => { __call('flag', { key }); },
  terminate: (disposition, custom_key) => { __call('terminate', { disposition, custom_key }); },
  reject: (message_key) => { __call('reject', { message_key }); },
  http: (req) => __call('http', { req }),
  secret: (name) => __call('secret', { name }),
});
`;

/* ------------------------------------------------------------------ *
 * The host
 * ------------------------------------------------------------------ */

export interface ScriptHost {
  run(input: RunScriptInput): Promise<ScriptResult>;
}

/** One WASM module per process; one fresh runtime+context per run (E §13.3 step 1). */
export function createScriptHost(): ScriptHost {
  let modulePromise: Promise<QuickJSWASMModule> | null = null;
  const loadModule = () => (modulePromise ??= getQuickJS());

  return {
    async run(input: RunScriptInput): Promise<ScriptResult> {
      const QuickJS = await loadModule();
      const budgets: ScriptBudgets = { ...DEFAULT_BUDGETS, ...(input.budgets ?? {}) };

      const startedAt = Date.now();
      const deadline = startedAt + budgets.wall_ms;
      let interrupts = 0;
      let timedOut = false;
      let instructionLimited = false;

      const writes: Record<string, unknown> = {};
      const flags: string[] = [];
      const logs: ScriptLogEntry[] = [];
      let logBytes = 0;
      let logTruncated = false;
      let setValueCalls = 0;
      let httpCalls = 0;
      let terminate: { disposition: string; custom_key: string | null } | null = null;
      let reject: string | null = null;

      /** The value read through the overlay, so a script reads its own writes back. */
      const read = (ref: string): unknown =>
        ref in writes ? writes[ref] : input.getValue(ref);

      const randomCounters = new Map<string, number>();

      // op → result value, or a thrown Error that surfaces inside the sandbox.
      const ops: Record<string, (a: Record<string, unknown>) => unknown> = {
        getValue: a => read(String(a['ref'])) ?? null,
        getValues: a => {
          const refs = Array.isArray(a['refs']) ? (a['refs'] as unknown[]).map(String) : [];
          return Object.fromEntries(refs.map(r => [r, read(r) ?? null]));
        },
        isAnswered: a => {
          const v = read(String(a['ref']));
          return v !== null && v !== undefined;
        },
        wasShown: a => input.wasShown(String(a['ref'])),
        setValue: a => {
          const ref = String(a['ref']);
          const kind = input.varKind(ref);
          if (kind === undefined) throw new Error(`setValue: unknown variable "${ref}"`);
          // E §13.1: only hidden and derived. A script writing a response variable would
          // fabricate respondent data; a system variable would corrupt provenance.
          if (kind !== 'hidden' && kind !== 'derived') {
            throw new Error(`setValue: "${ref}" is a ${kind} variable; only hidden and derived are writable`);
          }
          setValueCalls += 1;
          if (setValueCalls > budgets.max_set_value) {
            throw new Error(`setValue: budget of ${budgets.max_set_value} calls exceeded`);
          }
          writes[ref] = a['value'] ?? null;
          return null;
        },
        context: () => ({ ...input.context }),
        random: a => {
          const salt = String(a['salt']);
          // Per-salt counter, so two calls with one salt differ but a replay reproduces both.
          const i = randomCounters.get(salt) ?? 0;
          randomCounters.set(salt, i + 1);
          return randomAt(deriveKey(input.seed, `script:${input.assetRef}:${salt}`), i);
        },
        log: a => {
          if (logs.length >= budgets.max_log_entries || logBytes >= budgets.max_log_bytes) {
            if (!logTruncated) {
              logTruncated = true;
              logs.push({ level: 'warn', msg: '[log budget exceeded; further entries dropped]' });
            }
            return null;
          }
          const entry: ScriptLogEntry = {
            level: String(a['level'] ?? 'info'),
            msg: String(a['msg'] ?? ''),
            ...(a['data'] !== undefined ? { data: a['data'] } : {}),
          };
          logBytes += entry.msg.length + JSON.stringify(entry.data ?? null).length;
          logs.push(entry);
          return null;
        },
        flag: a => {
          const key = String(a['key']);
          if (!flags.includes(key)) flags.push(key);
          return null;
        },
        terminate: a => {
          terminate ??= {
            disposition: String(a['disposition']),
            custom_key: a['custom_key'] === undefined || a['custom_key'] === null
              ? null : String(a['custom_key']),
          };
          return null;
        },
        reject: a => {
          reject ??= String(a['message_key']);
          return null;
        },
        http: a => {
          httpCalls += 1;
          if (httpCalls > budgets.max_http_calls) {
            throw new Error(`http: budget of ${budgets.max_http_calls} calls exceeded`);
          }
          if (!input.http) {
            // The named failure from E §13.3 — the proxy does not exist yet, and pretending
            // otherwise would be a fetch with server privileges.
            throw new Error('http_denied: no allowlisted egress proxy is configured');
          }
          return input.http(a['req'] as never);
        },
        secret: a => {
          const name = String(a['name']);
          const value = input.secret?.(name) ?? null;
          if (value === null) throw new Error(`secret: "${name}" is not available`);
          return value;
        },
      };

      const runtime = QuickJS.newRuntime();
      try {
        runtime.setMemoryLimit(budgets.memory_bytes);
        runtime.setMaxStackSize(budgets.stack_bytes);
        runtime.setInterruptHandler(() => {
          interrupts += 1;
          if (Date.now() > deadline) {
            timedOut = true;
            return true;
          }
          if (interrupts > budgets.max_interrupts) {
            instructionLimited = true;
            return true;
          }
          return false;
        });

        const vm = runtime.newContext();
        try {
          const hostFn = vm.newFunction('__host', (opHandle, argsHandle) => {
            const op = vm.getString(opHandle);
            const argsJson = vm.getString(argsHandle);
            let payload: string;
            try {
              const handler = ops[op];
              if (!handler) throw new Error(`unknown host op "${op}"`);
              payload = JSON.stringify({ v: handler(JSON.parse(argsJson) as never) ?? null });
            } catch (err) {
              payload = JSON.stringify({ e: err instanceof Error ? err.message : String(err) });
            }
            return vm.newString(payload);
          });
          vm.setProp(vm.global, '__host', hostFn);
          hostFn.dispose();

          const preludeResult = vm.evalCode(PRELUDE);
          if (preludeResult.error) {
            const msg = String(vm.dump(preludeResult.error));
            preludeResult.error.dispose();
            return {
              ok: false, reason: 'throw', error: `prelude: ${msg}`, logs,
              wall_ms: Date.now() - startedAt, interrupts,
            };
          }
          preludeResult.value.dispose();

          const result = vm.evalCode(input.source, `${input.assetRef}.js`);
          const wallMs = Date.now() - startedAt;

          if (result.error) {
            const dumped = vm.dump(result.error) as unknown;
            result.error.dispose();
            const message =
              typeof dumped === 'object' && dumped !== null && 'message' in dumped
                ? String((dumped as { message: unknown }).message)
                : String(dumped);
            const reason = timedOut
              ? ('timeout' as const)
              : instructionLimited
                ? ('instruction_limit' as const)
                : /out of memory/i.test(message)
                  ? ('oom' as const)
                  : message.startsWith('http_denied')
                    ? ('http_denied' as const)
                    : ('throw' as const);
            return { ok: false, reason, error: message, logs, wall_ms: wallMs, interrupts };
          }
          result.value.dispose();

          return {
            ok: true, writes, flags, terminate, reject, logs,
            wall_ms: wallMs, interrupts,
          };
        } finally {
          vm.dispose();
        }
      } finally {
        // E §13.3 step 1: the context is discarded, never reused.
        runtime.dispose();
      }
    },
  };
}
