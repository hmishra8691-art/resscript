/**
 * ADR-004's central claim, as a differential test:
 *
 *   "One logic engine, shipped as one TypeScript package, executed in both places … Given the same
 *    variable state it returns the same verdict in both environments, or we have a bug we can see."
 *
 * The roadmap's P1-06 test list names three environments — Node, a browser via Playwright, and
 * QuickJS-WASM — over 500 generated states. Two of the three are covered here:
 *
 *  - **Node** runs `runScenario` directly from source.
 *  - **QuickJS-WASM** runs the *same module*, loaded from build output, in a genuinely different
 *    JavaScript implementation. This is the environment ADR-005's server-side hooks use, and the one
 *    most likely to expose an accidental dependency on V8 behaviour.
 *  - **A browser** is not covered: Playwright and its browser binaries are not installed in this
 *    workspace, and a test that silently skips protects nothing. It is the cheapest of the three to
 *    add once the studio's Playwright harness exists (P1-01 has one), and it is the *least* likely
 *    to find anything, because a browser is also V8/JSC/SpiderMonkey-class with the same number
 *    semantics — whereas QuickJS is a from-scratch interpreter. Recorded as a gap rather than
 *    quietly dropped.
 */

import { describe, expect, it } from 'vitest';
import { runScenario } from './scenario.js';
import { runInQuickJs, runScenarioInQuickJs } from './quickjs.js';

const SEED = 0x5eed;
const STATES = 500;

describe('the engine loads and runs inside QuickJS-WASM', () => {
  it('imports @resscript/logic with no bundler, which is what ADR-010s zero-dependency rule buys', async () => {
    const out = await runInQuickJs(
      [
        "import { AST_KINDS, and3, evalStateFree, astBuilder } from '@resscript/logic';",
        'const b = astBuilder(1);',
        'globalThis.__parity_out = JSON.stringify({',
        '  kinds: AST_KINDS.length,',
        "  kleene: and3('F', 'U'),",
        '  folded: evalStateFree(b.and(b.boolLit(true), b.nullLit())),',
        '});',
      ].join('\n'),
    );
    // Asserted against the values Node produces, not against literals, so the two cannot drift.
    expect(JSON.parse(out)).toEqual({ kinds: 58, kleene: 'F', folded: { k: 'null' } });
  }, 30_000);

  it('reports a QuickJS-side throw rather than returning a wrong answer', async () => {
    await expect(runInQuickJs('throw new Error("boom");')).rejects.toThrow(/QuickJS threw/u);
  }, 30_000);
});

describe(`Node and QuickJS agree over ${String(STATES)} generated states`, () => {
  it('produces byte-identical digests', async () => {
    const node = runScenario({ seed: SEED, states: STATES });
    const quickjs = await runScenarioInQuickJs(SEED, STATES);

    if (node !== quickjs) {
      // Report the first differing line rather than a 500-line diff: the useful information is
      // which state diverged, and the state index is in the line.
      const a = node.split('\n');
      const b = quickjs.split('\n');
      const at = a.findIndex((line, i) => line !== b[i]);
      throw new Error(
        `Node and QuickJS diverged at line ${String(at)}:\n` +
          `  node    : ${String(a[at])}\n` +
          `  quickjs : ${String(b[at])}`,
      );
    }
    expect(quickjs).toBe(node);
  }, 120_000);

  it('the comparison is sensitive: a different seed produces a different digest', async () => {
    // Without this, a harness bug that returned a constant on both sides would pass the test above
    // forever. The digest has to be a function of the inputs for the equality to mean anything.
    const a = runScenario({ seed: SEED, states: 10 });
    const b = await runScenarioInQuickJs(SEED + 1, 10);
    expect(b).not.toBe(a);
    // …and the same seed does reproduce, in the other engine as well as in this one.
    expect(await runScenarioInQuickJs(SEED, 10)).toBe(runScenario({ seed: SEED, states: 10 }));
  }, 60_000);

  it('the scenario actually exercises the engine rather than short-circuiting', () => {
    const digest = runScenario({ seed: SEED, states: STATES });
    const lines = digest.split('\n');
    // A digest that was all-null everywhere would compare equal in any two engines and prove
    // nothing. These assertions are the anti-vacuity guard.
    expect(lines).toHaveLength(STATES + 5);
    expect(digest).toContain('terminate(rul_terminate)');
    expect(digest).toContain('"SCREENOUT"');
    expect(digest).toContain('err.short');
    expect(digest.split('"young"').length).toBeGreaterThan(20);
    expect(digest.split('"senior"').length).toBeGreaterThan(5);
    // Both the full and the incremental path must produce identical cell vectors on every state:
    // the client patches and the server re-evaluates, so a dirty-set bug is a divergence too.
    for (const line of lines.slice(5)) {
      const full = /full=(\[.*?\]) incr=/u.exec(line);
      const incr = /incr=(\[.*?\]) term=/u.exec(line);
      expect(full?.[1]).toBe(incr?.[1]);
    }
  });
});
