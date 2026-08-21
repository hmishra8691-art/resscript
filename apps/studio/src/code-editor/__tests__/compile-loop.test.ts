/**
 * The debounced compile loop (§7.4). Two properties: keystrokes coalesce into one compile, and a
 * result computed from stale text is never delivered.
 *
 * The second one is the reason this is tested with an *async* compiler even though the shipped
 * default is synchronous: §7.4 puts the compile in a worker, and the day it moves there this is
 * the test that says the loop is ready.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ParseResult } from '@resscript/rescript-dsl';
import { createDiagnosticsLoop, createInProcessCompiler } from '@/code-editor/compile-loop';
import { fixtureRegistry } from '@/test/dsl-fixture';

/** A stand-in `ParseResult`; the loop never inspects it. */
const resultFor = (source: string): ParseResult =>
  ({ program: { statements: [] }, diagnostics: [], source_map: [], ok: true, source } as unknown as ParseResult);

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('createDiagnosticsLoop', () => {
  it('compiles once for a burst of keystrokes, 150 ms after the last one', () => {
    const compile = vi.fn((source: string) => resultFor(source));
    const onResult = vi.fn();
    const loop = createDiagnosticsLoop({ compile, onResult });

    for (const source of ['I', 'IF', 'IF ', 'IF S1']) loop.push(source);
    vi.advanceTimersByTime(149);
    expect(compile).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(compile).toHaveBeenCalledTimes(1);
    expect(compile).toHaveBeenCalledWith('IF S1');
    loop.dispose();
  });

  it('flush() compiles immediately — the blur / ⌘Enter path (§5.2)', () => {
    const compile = vi.fn((source: string) => resultFor(source));
    const onResult = vi.fn();
    const loop = createDiagnosticsLoop({ compile, onResult });
    loop.push('IF S1 = 1');
    loop.flush();
    expect(compile).toHaveBeenCalledTimes(1);
    // The pending timer was cancelled, not merely ignored: no second compile arrives.
    vi.advanceTimersByTime(500);
    expect(compile).toHaveBeenCalledTimes(1);
    loop.dispose();
  });

  it('never delivers a result computed from superseded text', async () => {
    const resolvers: (() => void)[] = [];
    const compile = vi.fn(
      (source: string) =>
        new Promise<ParseResult>((resolve) => {
          resolvers.push(() => {
            resolve(resultFor(source));
          });
        }),
    );
    const delivered: string[] = [];
    const loop = createDiagnosticsLoop({
      compile,
      onResult: (_result, source) => delivered.push(source),
    });

    loop.push('first');
    vi.advanceTimersByTime(150); // compile #1 is in flight
    loop.push('second');
    vi.advanceTimersByTime(150); // compile #2 is in flight
    expect(compile).toHaveBeenCalledTimes(2);

    // The slow one lands last — the out-of-order case a worker makes real.
    resolvers[1]?.();
    resolvers[0]?.();
    await vi.runAllTicks();
    await Promise.resolve();

    expect(delivered).toEqual(['second']);
    loop.dispose();
  });

  it('delivers nothing after dispose', async () => {
    const onResult = vi.fn();
    const loop = createDiagnosticsLoop({ compile: (source) => resultFor(source), onResult });
    loop.push('IF S1 = 1');
    loop.dispose();
    vi.advanceTimersByTime(1000);
    await Promise.resolve();
    expect(onResult).not.toHaveBeenCalled();
  });
});

describe('createInProcessCompiler', () => {
  it('is the real parser: diagnostics come back positioned', async () => {
    const compile = createInProcessCompiler(fixtureRegistry());
    const result = await compile('IF NOPE = 1 THEN SHOW Q12\n');
    expect(result.ok).toBe(false);
    expect(result.diagnostics[0]?.span?.start).toBe(3);
  });
});
