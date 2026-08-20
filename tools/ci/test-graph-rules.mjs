#!/usr/bin/env node
/**
 * Negative controls for the import-graph rules in .dependency-cruiser.cjs.
 *
 * M0.1's acceptance criteria are stated as failures, not successes: "adding an import of
 * @supabase/supabase-js to apps/runtime fails CI with a named rule violation, and adding any
 * dependency to packages/logic fails CI." A rule that never fires satisfies `pnpm lint:graph`
 * perfectly while protecting nothing — and `runtime-no-supabase` was exactly that on its
 * first draft, because it matched `node_modules/@supabase` and an uninstalled package does
 * not resolve to a path under node_modules. The rule passed a deliberate violation.
 *
 * So each rule gets a fixture that must be rejected, BY NAME. This file is the reason the
 * guard rails can be trusted, and it costs one CI step.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(new URL(import.meta.url).pathname), '..', '..');

/** @type {{name: string, file: string, source: string, expect: string}[]} */
const CASES = [
  {
    name: 'the data plane must not link a Supabase client (ADR-001)',
    file: 'apps/runtime/src/__graphfixture.ts',
    source: "import { createClient } from '@supabase/supabase-js';\nexport const x = createClient;\n",
    expect: 'runtime-no-supabase',
  },
  {
    name: 'the data plane must not import the control plane (ADR-001)',
    file: 'apps/runtime/src/__graphfixture.ts',
    source: "import x from '../../studio/src/server/auth.js';\nexport const y = x;\n",
    expect: 'runtime-not-depend-on-studio',
  },
  {
    name: 'packages/logic must stay dependency-free (ADR-004)',
    file: 'packages/logic/src/__graphfixture.ts',
    source: "import fc from 'fast-check';\nexport const x = fc;\n",
    expect: 'logic-is-dependency-free',
  },
  {
    name: 'packages/logic must not use Node builtins — it has to run in QuickJS (ADR-004)',
    file: 'packages/logic/src/__graphfixture.ts',
    source: "import { readFileSync } from 'node:fs';\nexport const x = readFileSync;\n",
    expect: 'logic-no-node-builtins',
  },
  {
    name: 'the canonical model must not depend on the plugin contract (ADR-010)',
    file: 'packages/schema/src/__graphfixture.ts',
    source: "import * as qk from '@resscript/question-kit';\nexport const x = qk;\n",
    expect: 'schema-not-depend-on-question-kit',
  },
  {
    name: 'an unresolvable import is caught generally',
    file: 'packages/schema/src/__graphfixture.ts',
    source: "import x from 'this-package-does-not-exist';\nexport const y = x;\n",
    expect: 'no-unresolvable',
  },
];

function cruise() {
  try {
    execFileSync(
      'node',
      [
        join(ROOT, 'node_modules', 'dependency-cruiser', 'bin', 'dependency-cruise.mjs'),
        '--config',
        join(ROOT, '.dependency-cruiser.cjs'),
        'packages',
        'apps',
      ],
      { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    return { failed: false, output: '' };
  } catch (err) {
    return { failed: true, output: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

let failures = 0;

// Baseline: the real tree must be clean, or every assertion below is meaningless.
const baseline = cruise();
if (baseline.failed) {
  console.error('FAIL baseline: the repository has pre-existing graph violations');
  console.error(baseline.output);
  process.exit(1);
}
console.log('ok   baseline -> the real tree is clean');

for (const c of CASES) {
  const abs = join(ROOT, c.file);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, c.source);
  const { failed, output } = cruise();
  rmSync(abs, { force: true });

  if (!failed) {
    console.error(`FAIL ${c.expect} -> the violation PASSED the linter: ${c.name}`);
    failures += 1;
  } else if (!output.includes(c.expect)) {
    console.error(
      `FAIL ${c.expect} -> rejected, but not by the expected rule: ${c.name}\n${output}`,
    );
    failures += 1;
  } else {
    console.log(`ok   ${c.expect} -> rejected: ${c.name}`);
  }
}

// Leaving a fixture behind would poison every later run, so prove the tree is clean again.
const after = cruise();
if (after.failed) {
  console.error('FAIL cleanup: a fixture was left behind');
  failures += 1;
} else {
  console.log('ok   cleanup -> tree clean again');
}

console.log(
  failures === 0
    ? `graph rule self-test: ${String(CASES.length)} rule(s), all fired as expected`
    : `graph rule self-test: ${String(failures)} failure(s)`,
);
process.exit(failures === 0 ? 0 : 1);
