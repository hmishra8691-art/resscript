/**
 * The QuickJS-WASM side of the parity harness.
 *
 * ADR-005 lets server-side hooks call the engine from inside a QuickJS-WASM interpreter, and
 * ADR-004 requires the verdict to be identical there. QuickJS is a genuinely different JavaScript
 * implementation — different number formatting, different `Intl`, no V8 optimizations, a tiny heap —
 * so it is the environment most likely to expose an accidental dependency on engine behaviour. That
 * makes it the highest-value target of the three ADR-004 names, and the reason this harness exists.
 *
 * The engine is loaded as **ES modules from its own build output**, not bundled: `packages/logic`
 * has zero dependencies and imports only relative paths with explicit `.js` extensions (ADR-010),
 * which means `tsc`'s output is loadable by a bare module loader with no bundler in the picture. If
 * that ever stops being true — a dependency, a bare specifier, a Node builtin — this harness breaks
 * loudly, which is exactly the alarm ADR-010's constraint deserves.
 *
 * This file is the only one in the package that touches Node builtins. `scenario.ts` deliberately
 * does not, because it has to run on both sides.
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getQuickJS } from 'quickjs-emscripten';

const HERE = dirname(fileURLToPath(import.meta.url));
/** `src/` when running under vitest's transform, `dist/` when running compiled. */
const PACKAGE_ROOT = resolve(HERE, '..');
const LOGIC_DIST = resolve(PACKAGE_ROOT, '..', 'logic', 'dist');
const PARITY_DIST = resolve(PACKAGE_ROOT, 'dist');

const LOGIC_PREFIX = 'logic/';
const PARITY_PREFIX = 'parity/';

export class BuildMissingError extends Error {
  constructor(what: string, command: string) {
    super(
      `${what} is not built, so the QuickJS parity test cannot load the engine.\n` +
        `Run: ${command}\n` +
        'In CI this is guaranteed by turbo: the `test` task dependsOn `^build`.',
    );
  }
}

function readModule(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    if (path.startsWith(LOGIC_DIST)) {
      throw new BuildMissingError('@resscript/logic', 'pnpm --filter @resscript/logic build');
    }
    throw new BuildMissingError('@resscript/logic-parity', 'pnpm --filter @resscript/logic-parity build');
  }
}

/**
 * Resolve a module specifier the way an ES module host would.
 *
 * QuickJS's default normalizer concatenates paths, which would turn `./ast.js` imported from
 * `@resscript/logic` into `@resscript/ast.js`. Naming the two trees `logic/…` and `parity/…` keeps
 * relative resolution inside the right one.
 */
function normalize(base: string, name: string): string {
  if (name === '@resscript/logic') return `${LOGIC_PREFIX}index.js`;
  if (!name.startsWith('.')) return name;
  const dir = base.includes('/') ? base.slice(0, base.lastIndexOf('/')) : '';
  const parts = `${dir}/${name}`.split('/');
  const stack: string[] = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') stack.pop();
    else stack.push(part);
  }
  return stack.join('/');
}

function load(moduleName: string): string {
  if (moduleName.startsWith(LOGIC_PREFIX)) {
    return readModule(join(LOGIC_DIST, moduleName.slice(LOGIC_PREFIX.length)));
  }
  if (moduleName.startsWith(PARITY_PREFIX)) {
    return readModule(join(PARITY_DIST, moduleName.slice(PARITY_PREFIX.length)));
  }
  throw new Error(`the parity harness will not load ${JSON.stringify(moduleName)} into QuickJS`);
}

export interface QuickJsRunOptions {
  /** Instruction budget, mirroring the ADR-005 sandbox. A runaway loop is a clean error. */
  readonly interruptAfterCycles?: number;
  readonly memoryLimitBytes?: number;
}

/**
 * Evaluate `source` as an ES module inside QuickJS-WASM and return the string it assigned to
 * `globalThis.__parity_out`.
 *
 * A module's completion value is not observable, so the result travels through a global. The
 * alternative — marshalling a structured value across the WASM boundary — would put the boundary's
 * own coercion inside the comparison, and a string cannot be coerced into agreement.
 */
export async function runInQuickJs(source: string, options: QuickJsRunOptions = {}): Promise<string> {
  const QuickJS = await getQuickJS();
  const runtime = QuickJS.newRuntime();
  try {
    runtime.setModuleLoader(load, normalize);
    runtime.setMemoryLimit(options.memoryLimitBytes ?? 64 * 1024 * 1024);
    if (options.interruptAfterCycles !== undefined) {
      let cycles = 0;
      runtime.setInterruptHandler(() => {
        cycles += 1;
        return cycles > (options.interruptAfterCycles ?? 0);
      });
    }
    const context = runtime.newContext();
    try {
      const result = context.evalCode(source, 'parity/main.js', { type: 'module' });
      if (result.error !== undefined) {
        const detail = context.dump(result.error);
        result.error.dispose();
        throw new Error(`QuickJS threw: ${JSON.stringify(detail)}`);
      }
      result.value.dispose();
      const handle = context.getProp(context.global, '__parity_out');
      try {
        const out = context.getString(handle);
        return out;
      } finally {
        handle.dispose();
      }
    } finally {
      context.dispose();
    }
  } finally {
    runtime.dispose();
  }
}

/** Run `runScenario` from `scenario.ts` inside QuickJS and return its digest. */
export async function runScenarioInQuickJs(seed: number, states: number): Promise<string> {
  return runInQuickJs(
    [
      `import { runScenario } from '${PARITY_PREFIX}scenario.js';`,
      `globalThis.__parity_out = runScenario({ seed: ${String(seed)}, states: ${String(states)} });`,
    ].join('\n'),
  );
}
