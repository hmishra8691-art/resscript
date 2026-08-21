/**
 * The debounced compile loop — 09-ui §7.4's "Diagnostics — the debounced compile loop".
 *
 * ```
 * keystroke ─ 150 ms debounce ─► compile(source) ─► { program, diagnostics } ─► markers · builder · Problems
 * ```
 *
 * Two properties from that section, and they are the whole reason this is a module rather than a
 * `useEffect`:
 *
 *  1. **150 ms debounce.** Keystrokes coalesce; the compile runs once per pause.
 *  2. **A newer source supersedes an in-flight compile.** §7.4 phrases it as "the worker cancels
 *     an in-flight compile when a newer source arrives". Cancellation is not observable to this
 *     side of the boundary, so what is enforced here is the property that actually matters: a
 *     result computed from stale text is **never delivered**. Out-of-order delivery is how an
 *     editor ends up showing a squiggle for a character the author already deleted.
 *
 * ## Why `compile` is injected, and why the default is in-process
 *
 * §7.4 puts the compile in a Web Worker. `Compiler` is therefore async-shaped and the loop makes
 * no assumption about where the work happens — a worker transport is a different `Compiler`, not a
 * different loop, and the supersede test below is exactly the test a worker needs to pass.
 *
 * What ships in this milestone is the in-process compiler, deliberately: `parse` on a 20-line rule
 * is a fraction of the 40 ms budget §12 sets for the whole loop, and a worker needs a registry
 * transfer protocol (`LogicRegistryInput` clones, a `NodeIndex` of closures does not) that P1-08's
 * compiler and P1-12's builder will both want to define. Building it now would mean building it
 * twice. Recorded as a deviation from §7.4 rather than left as a silent gap.
 */

import type { ParseResult } from '@resscript/rescript-dsl';
import { parse, type DslRegistry } from '@resscript/rescript-dsl';

export type Compiler = (source: string) => ParseResult | Promise<ParseResult>;

export interface DiagnosticsLoop {
  /** Called on every keystroke. Restarts the debounce window. */
  push(source: string): void;
  /** Compile the pending source now — blur, ⌘Enter, route change (§5.2's flush points). */
  flush(): void;
  /** Drop the pending timer and stop delivering results. Idempotent. */
  dispose(): void;
}

export interface DiagnosticsLoopOptions {
  readonly compile: Compiler;
  /** Delivered only for the newest source. */
  readonly onResult: (result: ParseResult, source: string) => void;
  /** §7.4 and §12: 150 ms. */
  readonly debounceMs?: number;
  /** Injected so a test can drive it with fake timers without owning the global. */
  readonly schedule?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  readonly cancel?: (handle: ReturnType<typeof setTimeout>) => void;
}

export function createInProcessCompiler(registry: DslRegistry): Compiler {
  return (source: string): ParseResult => parse(source, registry);
}

export function createDiagnosticsLoop(options: DiagnosticsLoopOptions): DiagnosticsLoop {
  const debounceMs = options.debounceMs ?? 150;
  const schedule = options.schedule ?? ((fn, ms) => setTimeout(fn, ms));
  const cancel = options.cancel ?? ((handle) => clearTimeout(handle));

  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: string | undefined;
  let disposed = false;
  /** Monotonic; a result whose sequence is not the latest issued is stale and dropped. */
  let issued = 0;

  const run = (): void => {
    timer = undefined;
    if (disposed || pending === undefined) return;
    const source = pending;
    pending = undefined;
    issued += 1;
    const sequence = issued;
    void Promise.resolve(options.compile(source)).then((result) => {
      // The supersede check. Not "cancel the work" — that is the transport's business — but
      // "never render a stale answer", which is the property the author can actually see.
      if (disposed || sequence !== issued) return;
      options.onResult(result, source);
    });
  };

  return {
    push(source: string): void {
      if (disposed) return;
      pending = source;
      if (timer !== undefined) cancel(timer);
      timer = schedule(run, debounceMs);
    },
    flush(): void {
      if (disposed) return;
      if (timer !== undefined) {
        cancel(timer);
        timer = undefined;
      }
      run();
    },
    dispose(): void {
      disposed = true;
      if (timer !== undefined) {
        cancel(timer);
        timer = undefined;
      }
    },
  };
}
