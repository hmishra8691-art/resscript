/**
 * Cross-engine determinism — ADR-006's load-bearing claim, finally executed.
 *
 * The PRNG's golden values are pinned in `runtime-core/src/prng.test.ts`, which proves the
 * NODE build; ADR-006's actual promise is byte-identical output across "the Node build, the
 * browser build, and the QuickJS build", and E §8.1 records that this exact check "has caught
 * a real class of bug: `Math.imul` and `>>> 0` semantics differing under a bundler's numeric
 * optimizations." So the artifact under test here is not the TypeScript source — it is the
 * BUNDLE: `prng.ts` run through esbuild with the same settings as the respondent bundle
 * (`scripts/build-client.mjs`: es2018, minified, IIFE), because that is the code path where a
 * bundler's optimization can rewrite an integer multiply.
 *
 * One bundle, three engines, one probe: V8-in-Node (`node:vm`), QuickJS-WASM (the same
 * engine that runs customer scripts), and real Chromium over the DevTools protocol
 * (`playwright-core` + the preinstalled browser). Every engine must produce the SAME JSON,
 * and that JSON must equal the pinned goldens — agreement between three engines that are all
 * wrong together is caught by the pin, and a pin that drifted from the sources is caught by
 * the agreement.
 */

import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { buildSync } from 'esbuild';
import { getQuickJS } from 'quickjs-emscripten';
import { describe, expect, it } from 'vitest';

/** The preinstalled browser, whatever revision the image carries — never a pinned build id. */
function findChromium(): string | null {
  try {
    const dir = readdirSync('/opt/pw-browsers').find((name) => /^chromium-\d+$/.test(name));
    return dir ? join('/opt/pw-browsers', dir, 'chrome-linux', 'chrome') : null;
  } catch {
    return null;
  }
}
const CHROME = findChromium();

/** The probe: the same draws the golden-value test pins, computed inside the engine. */
const PROBE = `
(() => {
  const key = __prng.deriveKey('a3f9c1d2e4b6a8f0c2d4e6b8a0f2c4d6', 'grp:brands');
  return JSON.stringify({
    key,
    draws: [__prng.randomAt(key, 0).toFixed(12), __prng.randomAt(key, 1).toFixed(12)],
    permuted: __prng.permute([1, 2, 3, 4, 5], key),
    hash: __prng.hashString('qst_1|shown|options:1,2,3'),
  });
})()
`;

/** What every engine must say — the same numbers prng.test.ts pins for Node. */
const GOLDEN = JSON.stringify({
  key: [3202913946, 858028841, 1755935121, 622009621],
  draws: ['0.497427803464', '0.484208893264'],
  permuted: [5, 4, 2, 1, 3],
  hash: '08857af2c8d553a3b9019e1178c1120b',
});

/** prng.ts through the CLIENT bundle's own esbuild settings, exposing globalThis.__prng. */
function bundledPrng(): string {
  const entry = join(__dirname, '..', '..', '..', 'packages', 'runtime-core', 'src', 'prng.ts');
  const wrapper = `
    import { deriveKey, randomAt, permute, hashString } from ${JSON.stringify(entry)};
    globalThis.__prng = { deriveKey, randomAt, permute, hashString };
  `;
  const out = buildSync({
    stdin: { contents: wrapper, resolveDir: __dirname, loader: 'ts' },
    bundle: true,
    minify: true, // the setting most likely to rewrite numeric expressions — deliberately on
    format: 'iife',
    target: 'es2018',
    write: false,
  });
  return out.outputFiles[0]?.text ?? '';
}

describe('one bundle, three engines, one answer (ADR-006)', () => {
  const bundle = bundledPrng();

  it('V8 (node:vm) matches the pinned goldens', () => {
    // An empty sandbox: the vm context supplies its own globalThis, and shadowing it with a
    // property (the first draft did) breaks the bundle's globalThis.__prng assignment.
    const result = runInNewContext(`${bundle};\n${PROBE}`, {}) as string;
    expect(result).toBe(GOLDEN);
  });

  it('QuickJS-WASM matches — the engine customer scripts run under', async () => {
    const QuickJS = await getQuickJS();
    const vm = QuickJS.newContext();
    try {
      const evaluated = vm.evalCode(`${bundle};\n${PROBE}`);
      if (evaluated.error) {
        const message = vm.dump(evaluated.error) as unknown;
        evaluated.error.dispose();
        throw new Error(`QuickJS failed: ${JSON.stringify(message)}`);
      }
      const result = vm.dump(evaluated.value) as string;
      evaluated.value.dispose();
      expect(result).toBe(GOLDEN);
    } finally {
      vm.dispose();
    }
  });

  it('real Chromium matches — the engine respondents run under', async () => {
    // Skip loudly rather than pass vacuously when the preinstalled browser is absent (a
    // laptop checkout, a stripped CI image): a determinism check that silently "passed"
    // without running is how a divergent browser build ships.
    if (CHROME === null) {
      console.error('determinism.crossengine: NO CHROMIUM under /opt/pw-browsers — browser leg did not run');
      return;
    }
    const { chromium } = await import('playwright-core');
    const browser = await chromium.launch({ executablePath: CHROME });
    try {
      const page = await browser.newPage();
      const result = await page.evaluate(
        ([code, probe]) => {
          // eslint-disable-next-line no-eval -- executing the bundle under test IS the test
          eval(code as string);
          // eslint-disable-next-line no-eval
          return eval(probe as string) as string;
        },
        [bundle, PROBE],
      );
      expect(result).toBe(GOLDEN);
    } finally {
      await browser.close();
    }
  }, 60_000);
});
