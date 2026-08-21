#!/usr/bin/env node
/**
 * Packaging lint: can the apps that run as plain node processes actually start?
 *
 * WHY THIS EXISTS. Every workspace package used to export only `./src/index.ts`, so
 * `node apps/runtime/dist/server.js` resolved `@resscript/observability` to a TypeScript file that
 * imports `./logger.js` — a specifier only tsc-emitted output or a bundler resolves. Both
 * `apps/runtime` and `apps/worker` failed with ERR_MODULE_NOT_FOUND before serving a single
 * request, and the whole test suite was green the entire time.
 *
 * It was green because nothing in it loads the apps the way production does: vitest transpiles
 * TypeScript, and studio is bundled by Next. **A test suite structurally cannot see a packaging
 * failure**, which is why this check is a lint over the manifests rather than another test.
 *
 * Two things are checked:
 *
 *   1. Every package's `exports` carries a `node` condition pointing at `./dist/...`, with `types`
 *      and `default` on source. Node picks `node`; tsc reads `types` and so needs no build; Vite,
 *      Next and vitest fall through to `default` and keep seeing source.
 *
 *   2. Every app whose `start` script is `node dist/...` really boots — spawned as a child process,
 *      given a moment, and checked for an early exit. This is the assertion that would have caught
 *      the original defect, and it is cheap: a boot is well under a second.
 *
 * Run by `pnpm lint:packaging`, and part of `pnpm verify`.
 */

import { spawn } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const failures = [];
const notes = [];

function fail(where, message) {
  failures.push(`${where}: ${message}`);
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Every immediate child of `dir` that has a package.json. */
async function workspacePackages(dir) {
  const out = [];
  for (const name of await readdir(join(ROOT, dir))) {
    const manifest = join(ROOT, dir, name, 'package.json');
    if (await exists(manifest)) out.push({ dir: join(dir, name), manifest });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 1. Export conditions
 * ------------------------------------------------------------------ */

function checkExports(pkgName, exportsField, where) {
  if (exportsField === undefined) {
    // A package with no `exports` falls back to `main`, which is a different (and older) set of
    // rules. Nothing in this repo does it; flag it rather than silently skipping.
    fail(where, 'has no "exports" field');
    return;
  }
  if (typeof exportsField !== 'object') {
    fail(where, '"exports" must be an object of subpaths');
    return;
  }

  for (const [subpath, entry] of Object.entries(exportsField)) {
    const at = `${where} exports["${subpath}"]`;

    if (typeof entry === 'string') {
      fail(at, `is a bare string ("${entry}"); needs types/node/default conditions`);
      continue;
    }
    if (typeof entry !== 'object' || entry === null) {
      fail(at, 'is neither a string nor a conditions object');
      continue;
    }

    const node = entry.node;
    if (typeof node !== 'string') {
      fail(
        at,
        'has no "node" condition. Without it `node dist/server.js` resolves this package to ' +
          'TypeScript source and fails at runtime, while every test still passes.',
      );
      continue;
    }
    if (!node.startsWith('./dist/') || !node.endsWith('.js')) {
      fail(at, `"node" is "${node}"; must be an emitted ./dist/*.js path`);
    }
    if (typeof entry.default !== 'string') {
      fail(at, 'has no "default" condition for bundlers');
    }
    if (typeof entry.types !== 'string') {
      fail(at, 'has no "types" condition');
    }

    // Condition order is significant: Node walks the object and takes the first match, so a
    // `default` placed before `node` wins and silently reinstates the original defect.
    const keys = Object.keys(entry);
    const iNode = keys.indexOf('node');
    const iDefault = keys.indexOf('default');
    if (iNode !== -1 && iDefault !== -1 && iDefault < iNode) {
      fail(at, '"default" precedes "node"; Node takes the first match, so "node" is unreachable');
    }
  }
}

/* ------------------------------------------------------------------ *
 * 2. The apps boot
 * ------------------------------------------------------------------ */

/**
 * Spawn an app and see whether it survives.
 *
 * A module-resolution failure exits within milliseconds, so a short window separates "cannot
 * start" from "started and is waiting for work" without making the check slow. A server that
 * stays alive is the pass condition; anything that exits non-zero in the window is the failure.
 */
function bootCheck(entry, env, windowMs = 2500) {
  return new Promise(resolvePromise => {
    const child = spawn(process.execPath, [entry], {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderr = '';
    let stdout = '';
    child.stderr.on('data', c => (stderr += c));
    child.stdout.on('data', c => (stdout += c));

    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill('SIGKILL');
      resolvePromise(result);
    };

    const timer = setTimeout(() => finish({ ok: true, stdout, stderr }), windowMs);

    child.on('exit', code => {
      if (code === 0) {
        // A clean immediate exit is not a server. Treated as a failure so a `start` script that
        // silently does nothing cannot pass.
        finish({ ok: false, reason: 'exited 0 without staying up', stdout, stderr });
      } else {
        finish({ ok: false, reason: `exited with code ${code}`, stdout, stderr });
      }
    });

    child.on('error', err => finish({ ok: false, reason: String(err), stdout, stderr }));
  });
}

/** The environment each app needs to boot far enough to prove its imports resolve. */
const BOOT_ENV = {
  '@resscript/runtime': {
    NODE_ENV: 'development',
    LOG_LEVEL: 'error',
    PORT: '0',
    RUNTIME_DOMAIN: 'run.local',
    // A source is required at startup by design — a runtime with nowhere to load artifacts from
    // would look healthy and fail on the first respondent.
    ARTIFACT_DIR: '/tmp/resscript-packaging-lint',
  },
  '@resscript/worker': {
    NODE_ENV: 'development',
    LOG_LEVEL: 'error',
    WORKER_HEALTH_PORT: '0',
  },
};

/* ------------------------------------------------------------------ *
 * Main
 * ------------------------------------------------------------------ */

const packages = await workspacePackages('packages');
const apps = await workspacePackages('apps');

for (const { dir, manifest } of packages) {
  const pkg = await readJson(manifest);
  if (pkg.private === true && pkg.exports === undefined) {
    // Nothing in this repo, but a private package with no exports is not importable and needs no
    // conditions. Skip rather than fail.
    notes.push(`${dir}: no exports field, skipped`);
    continue;
  }
  checkExports(pkg.name, pkg.exports, dir);
}

const boots = [];
for (const { dir, manifest } of apps) {
  const pkg = await readJson(manifest);
  const start = pkg.scripts?.start;
  if (typeof start !== 'string') continue;

  const match = /^node\s+(\S+)$/.exec(start.trim());
  if (!match) {
    notes.push(`${dir}: start script is not a plain node invocation ("${start}"), skipped`);
    continue;
  }

  const entry = join(dir, match[1]);
  if (!(await exists(join(ROOT, entry)))) {
    fail(dir, `start script points at ${match[1]}, which does not exist — run \`pnpm build\` first`);
    continue;
  }
  boots.push({ dir, name: pkg.name, entry });
}

// Sequentially, so a port collision between two apps cannot make this flaky.
for (const { dir, name, entry } of boots) {
  const result = await bootCheck(entry, BOOT_ENV[name] ?? {});
  if (result.ok) {
    console.log(`ok   ${name} -> boots (${entry})`);
  } else {
    const detail = (result.stderr || result.stdout || '').split('\n').slice(0, 6).join('\n      ');
    fail(dir, `\`node ${entry}\` ${result.reason}\n      ${detail}`);
  }
}

for (const note of notes) console.log(`note ${note}`);

if (failures.length > 0) {
  console.error(`\npackaging lint: ${failures.length} failure(s)\n`);
  for (const f of failures) console.error(`  FAIL ${f}`);
  console.error(
    '\nA source-only export or a non-booting app is invisible to the test suite: vitest\n' +
      'transpiles TypeScript and Next bundles it, so neither loads a package the way node does.\n',
  );
  process.exit(1);
}

console.log(
  `\npackaging lint: ${packages.length} package(s) export a node condition, ` +
    `${boots.length} app(s) boot`,
);
