#!/usr/bin/env node
/**
 * The Math.random lint — ADR-006's ban, enforced (P1-09's own test line, and a Phase 1 exit
 * criterion: "zero `Math.random` in the runtime").
 *
 * WHY A LINT AND NOT A TEST. A stray `Math.random()` in the respondent path does not fail any
 * behavioural test — it produces plausible orders that simply cannot be replayed, and the first
 * person to notice is whoever investigates "the client says the rotation is wrong" (ADR-006's
 * founding scenario) months after the data shipped. Like the packaging lint, this guards a gap
 * the test suite structurally cannot see.
 *
 * WHAT IS SCANNED. The respondent path: `apps/runtime/src`, `packages/runtime-core/src`,
 * `packages/logic/src` — the code that runs (or is bundled to run) per respondent, where every
 * random decision must derive from the session seed. Deliberately NOT scanned, with reasons:
 *
 *   - `packages/schema/src/ids.ts` — `Math.random` is the injectable DEFAULT for authoring-side
 *     id minting; the runtime mints its own ids from `node:crypto` (`apps/runtime/src/entry.ts`)
 *     and never calls schema's generator.
 *   - `packages/observability` — request-id fallback entropy, control-plane, never a survey
 *     decision.
 *   - test files and fixtures — a test may use randomness to EXERCISE the ban.
 *
 * Comment mentions are fine (half the codebase documents the ban); only a CALL —
 * `Math.random(` — trips it. The negative control below keeps the scanner honest: a lint whose
 * failure path was never seen firing is a lint that may match nothing.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join, relative, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const SCANNED = ['apps/runtime/src', 'packages/runtime-core/src', 'packages/logic/src'];
const CALL = /Math\.random\s*\(/;

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (/\.(ts|tsx|js|mjs)$/.test(entry.name)) yield path;
  }
}

function isExempt(path) {
  return /\.(test|spec)\.(ts|tsx)$/.test(path) || path.includes('__fixtures__');
}

/** Strip comments so a documented ban cannot trip the scanner. Line-based, good enough. */
function codeLines(source) {
  let inBlock = false;
  return source.split('\n').map((line) => {
    let out = '';
    let i = 0;
    while (i < line.length) {
      if (inBlock) {
        const end = line.indexOf('*/', i);
        if (end === -1) return out;
        inBlock = false;
        i = end + 2;
        continue;
      }
      const lineComment = line.indexOf('//', i);
      const blockStart = line.indexOf('/*', i);
      if (blockStart !== -1 && (lineComment === -1 || blockStart < lineComment)) {
        out += line.slice(i, blockStart);
        inBlock = true;
        i = blockStart + 2;
        continue;
      }
      if (lineComment !== -1) {
        out += line.slice(i, lineComment);
        break;
      }
      out += line.slice(i);
      break;
    }
    return out;
  });
}

async function scan(dirs) {
  const hits = [];
  for (const dir of dirs) {
    for await (const path of walk(join(ROOT, dir))) {
      if (isExempt(path)) continue;
      const source = await readFile(path, 'utf8');
      codeLines(source).forEach((line, index) => {
        if (CALL.test(line)) {
          hits.push(`${relative(ROOT, path)}:${index + 1}: ${line.trim()}`);
        }
      });
    }
  }
  return hits;
}

// ---- negative control: the scanner must fire on a violation --------------
const control = codeLines('const x = Math.random(); // banned\n// Math.random() in a comment is fine');
const controlHits = control.filter((line) => CALL.test(line)).length;
if (controlHits !== 1) {
  console.error(`no-random lint: SELF-TEST FAILED (control hits: ${controlHits}, expected 1)`);
  process.exit(1);
}

const hits = await scan(SCANNED);
if (hits.length > 0) {
  console.error(`no-random lint: ${hits.length} Math.random call(s) on the respondent path\n`);
  for (const hit of hits) console.error(`  FAIL ${hit}`);
  console.error(
    '\nEvery random decision on the respondent path must derive from the session seed\n' +
      '(ADR-006). Use deriveKey/randomAt from @resscript/runtime-core.\n',
  );
  process.exit(1);
}

console.log(`no-random lint: ${SCANNED.join(', ')} clean (self-test fired)`);
