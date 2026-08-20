#!/usr/bin/env node
// ResScript migration CLI.
//
// Why this exists rather than the Supabase CLI: Deliverable B §14 makes migrations
// forward-only with a `test.sql` per directory, and ADR-009 makes the cross-tenant
// pgTAP suite a gate on every migration. Both are properties of *our* convention, not
// of any vendor tool, and CI has to be able to run them before a single line of
// TypeScript compiles. So: plain Node ESM, one dependency (`pg`), no build step.
//
// Commands
//   status            list migrations, applied/pending, checksum drift
//   up                apply pending migrations in order, inside a transaction each
//   reset             drop and recreate the target database
//   test [filter]     run every test.sql (pgTAP) and report pass/fail per file
//
// Configuration: DATABASE_URL (default postgres://postgres:postgres@localhost:5432/resscript)

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg from 'pg';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const MIGRATIONS_DIR = path.join(REPO_ROOT, 'db', 'migrations');

// A migration directory is exactly NNNN_snake_case. Anything else in db/migrations —
// notably `__lintfixtures__`, which contains deliberately broken SQL — is invisible to
// this CLI. That exclusion is a correctness requirement, not tidiness: the fixtures
// must never be applied to a database.
const MIGRATION_DIR_RE = /^(\d{4})_([a-z0-9]+(?:_[a-z0-9]+)*)$/;

const DEFAULT_URL = 'postgres://postgres:postgres@localhost:5432/resscript';

// ---------------------------------------------------------------------------
// terminal helpers
// ---------------------------------------------------------------------------
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = {
  red: (s) => (useColor ? `\u001b[31m${s}\u001b[0m` : s),
  green: (s) => (useColor ? `\u001b[32m${s}\u001b[0m` : s),
  yellow: (s) => (useColor ? `\u001b[33m${s}\u001b[0m` : s),
  dim: (s) => (useColor ? `\u001b[2m${s}\u001b[0m` : s),
  bold: (s) => (useColor ? `\u001b[1m${s}\u001b[0m` : s),
};

class CliError extends Error {}

function die(message) {
  throw new CliError(message);
}

// ---------------------------------------------------------------------------
// migration discovery
// ---------------------------------------------------------------------------

export function listMigrations(dir = MIGRATIONS_DIR) {
  if (!existsSync(dir)) die(`migrations directory not found: ${dir}`);
  const out = [];
  const seen = new Map();
  for (const entry of readdirSync(dir).sort()) {
    const full = path.join(dir, entry);
    if (!statSync(full).isDirectory()) continue;
    const m = MIGRATION_DIR_RE.exec(entry);
    if (!m) continue; // __lintfixtures__ and friends
    const [, seq] = m;
    if (seen.has(seq)) {
      die(`duplicate migration sequence ${seq}: ${seen.get(seq)} and ${entry}`);
    }
    seen.set(seq, entry);
    const upPath = path.join(full, 'up.sql');
    if (!existsSync(upPath)) die(`migration ${entry} has no up.sql`);
    const testPath = path.join(full, 'test.sql');
    const sql = readFileSync(upPath, 'utf8');
    out.push({
      name: entry,
      seq,
      dir: full,
      upPath,
      testPath: existsSync(testPath) ? testPath : null,
      sql,
      checksum: sha256(sql),
      // CREATE INDEX CONCURRENTLY cannot run inside a transaction block (Deliverable
      // B §14). Such a migration opts out explicitly and is therefore not atomic —
      // which is why the convention is one statement per such migration.
      noTransaction: /^\s*--\s*migrate:no-transaction\s*$/im.test(sql),
    });
  }
  if (out.length === 0) die(`no migrations found in ${dir}`);
  return out;
}

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// connection
// ---------------------------------------------------------------------------

function databaseUrl() {
  return process.env.DATABASE_URL || DEFAULT_URL;
}

async function connect(url = databaseUrl()) {
  const client = new pg.Client({ connectionString: url });
  try {
    await client.connect();
  } catch (err) {
    die(
      `cannot connect to ${redact(url)}: ${err.message}\n` +
        `  hint: is PostgreSQL running, and has \`cli.mjs reset\` been run to create the database?`,
    );
  }
  return client;
}

function redact(url) {
  return url.replace(/\/\/([^:/@]+):[^@]*@/, '//$1:***@');
}

// ---------------------------------------------------------------------------
// bookkeeping
// ---------------------------------------------------------------------------

// ops.schema_migrations is created by migration 0001 — it cannot exist before the
// first migration runs, so a missing table means "nothing applied yet", not an error.
async function appliedMigrations(client) {
  const { rows } = await client.query(`
    SELECT to_regclass('ops.schema_migrations') IS NOT NULL AS present
  `);
  if (!rows[0].present) return new Map();
  const res = await client.query(
    `SELECT name, checksum, applied_at FROM ops.schema_migrations ORDER BY name`,
  );
  return new Map(res.rows.map((r) => [r.name, r]));
}

// ---------------------------------------------------------------------------
// up
// ---------------------------------------------------------------------------

async function cmdUp() {
  const migrations = listMigrations();
  const client = await connect();
  try {
    const applied = await appliedMigrations(client);

    // A migration whose file changed after it was applied is a hard error. The
    // recorded sha256 is the only thing standing between "forward-only" and
    // "somebody edited 0002 and now dev and prod disagree about the schema".
    for (const m of migrations) {
      const row = applied.get(m.name);
      if (row && row.checksum !== m.checksum) {
        die(
          `checksum mismatch for applied migration ${m.name}\n` +
            `  recorded: ${row.checksum}\n` +
            `  on disk:  ${m.checksum}\n` +
            `  Migrations are immutable once applied (Deliverable B §14, forward-only).\n` +
            `  Write a new migration; do not edit ${path.relative(REPO_ROOT, m.upPath)}.`,
        );
      }
    }

    // An applied migration that has vanished from the tree is equally a divergence.
    const onDisk = new Set(migrations.map((m) => m.name));
    for (const name of applied.keys()) {
      if (!onDisk.has(name)) {
        die(`migration ${name} is recorded as applied but is missing from ${MIGRATIONS_DIR}`);
      }
    }

    const pending = migrations.filter((m) => !applied.has(m.name));
    if (pending.length === 0) {
      console.log(c.green('up to date') + c.dim(` (${migrations.length} migrations applied)`));
      return 0;
    }

    for (const m of pending) {
      const started = Date.now();
      process.stdout.write(`applying ${c.bold(m.name)} ... `);
      const atomic = !m.noTransaction;
      try {
        if (atomic) await client.query('BEGIN');
        await client.query(m.sql);
        await client.query(
          `INSERT INTO ops.schema_migrations (name, checksum, duration_ms, applied_by)
           VALUES ($1, $2, $3, current_user)`,
          [m.name, m.checksum, Date.now() - started],
        );
        if (atomic) await client.query('COMMIT');
      } catch (err) {
        if (atomic) {
          try {
            await client.query('ROLLBACK');
          } catch {
            /* connection may already be unusable */
          }
        }
        console.log(c.red('FAILED'));
        die(formatPgError(m.upPath, m.sql, err));
      }
      console.log(c.green('ok') + c.dim(` ${Date.now() - started}ms`));
    }
    console.log(c.green(`applied ${pending.length} migration(s)`));
    return 0;
  } finally {
    await client.end();
  }
}

// Turn a bare "syntax error at or near ..." into something with a line number in it.
function formatPgError(file, sql, err) {
  let where = '';
  if (err.position) {
    const upto = sql.slice(0, Number(err.position));
    const line = upto.split('\n').length;
    const col = upto.length - upto.lastIndexOf('\n');
    where = `${path.relative(REPO_ROOT, file)}:${line}:${col}`;
  } else {
    where = path.relative(REPO_ROOT, file);
  }
  const bits = [`${where}: ${err.message}`];
  if (err.code) bits.push(`  SQLSTATE ${err.code}`);
  if (err.detail) bits.push(`  DETAIL: ${err.detail}`);
  if (err.hint) bits.push(`  HINT: ${err.hint}`);
  if (err.where) bits.push(`  CONTEXT: ${err.where}`);
  return bits.join('\n');
}

// ---------------------------------------------------------------------------
// reset
// ---------------------------------------------------------------------------

async function cmdReset() {
  const url = new URL(databaseUrl());
  const dbName = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!dbName) die('DATABASE_URL has no database name');
  if (/^(postgres|template0|template1)$/.test(dbName)) {
    die(`refusing to reset the maintenance database "${dbName}"`);
  }
  if (process.env.RESSCRIPT_ENV === 'prod' && !process.env.I_REALLY_MEAN_IT) {
    die('refusing to reset with RESSCRIPT_ENV=prod');
  }

  const adminUrl = new URL(url.toString());
  adminUrl.pathname = '/postgres';
  const client = await connect(adminUrl.toString());
  try {
    process.stdout.write(`dropping database ${c.bold(dbName)} ... `);
    await client.query(`DROP DATABASE IF EXISTS ${quoteIdent(dbName)} WITH (FORCE)`);
    console.log(c.green('ok'));
    process.stdout.write(`creating database ${c.bold(dbName)} ... `);
    await client.query(`CREATE DATABASE ${quoteIdent(dbName)}`);
    console.log(c.green('ok'));
  } finally {
    await client.end();
  }

  // Roles are cluster-global, so a database drop leaves `authoring`,
  // `runtime_writer`, `analytics_reader` and `runtime_rpc_owner` behind. Migration
  // 0001 creates them idempotently for exactly this reason; nothing to do here.
  console.log(c.dim('note: cluster roles survive reset; migration 0001 is idempotent about them'));
  return 0;
}

function quoteIdent(name) {
  return `"${name.replace(/"/g, '""')}"`;
}

// ---------------------------------------------------------------------------
// test
// ---------------------------------------------------------------------------

async function cmdTest(filter) {
  const migrations = listMigrations().filter((m) => !filter || m.name.includes(filter));
  if (migrations.length === 0) die(`no migrations matched filter "${filter}"`);

  const client = await connect();
  let totalOk = 0;
  let totalNotOk = 0;
  const failedFiles = [];
  try {
    // pgTAP is a *test-only* dependency: it is installed here by the runner rather
    // than by a migration, so production databases never carry it.
    try {
      await client.query('CREATE EXTENSION IF NOT EXISTS pgtap');
    } catch (err) {
      die(
        `cannot install the pgtap extension: ${err.message}\n` +
          `  hint: apt-get install -y postgresql-16-pgtap (see db/README.md)`,
      );
    }

    for (const m of migrations) {
      if (!m.testPath) {
        // The linter is what makes this impossible to merge; the runner still
        // refuses to pretend the migration was tested.
        console.log(`${c.bold(m.name)} ${c.red('NO test.sql')}`);
        failedFiles.push(m.name);
        continue;
      }
      const sql = readFileSync(m.testPath, 'utf8');
      const result = await runTapFile(client, sql);
      totalOk += result.ok;
      totalNotOk += result.notOk;
      // A plan mismatch means assertions were added or removed without updating plan(N),
      // which is also how a file that silently stopped running looks. Treat it as a
      // failure rather than a note, or the plan stops meaning anything.
      const planned = result.planned;
      const ran = result.ok + result.notOk;
      const planMismatch = planned !== null && planned !== ran;
      if (planMismatch) {
        result.diagnostics.push(`planned ${planned} assertions but ran ${ran}`);
      }
      const status =
        result.notOk === 0 && !result.error && result.ok > 0 && !planMismatch
          ? c.green('PASS')
          : c.red('FAIL');
      console.log(
        `${status} ${c.bold(m.name)} ${c.dim(`(${result.ok} passed, ${result.notOk} failed)`)}`,
      );
      for (const line of result.diagnostics) console.log(c.dim(`      ${line}`));
      if (result.error) {
        console.log(c.red(`      ${formatPgError(m.testPath, sql, result.error)}`));
      }
      if (result.notOk > 0 || result.error || result.ok === 0 || planMismatch) {
        failedFiles.push(m.name);
      }
    }
  } finally {
    await client.end();
  }

  console.log('');
  console.log(
    `${failedFiles.length === 0 ? c.green('ALL GREEN') : c.red('FAILURES')}: ` +
      `${totalOk} assertions passed, ${totalNotOk} failed, across ${migrations.length} file(s)`,
  );
  if (failedFiles.length > 0) {
    console.log(c.red(`failing files: ${failedFiles.join(', ')}`));
    return 1;
  }
  return 0;
}

// Each test.sql wraps itself in BEGIN … ROLLBACK and emits TAP on stdout-shaped
// result rows. We parse TAP in-process rather than shelling out to pg_prove so the
// only runtime requirement in CI is Node plus a database.
async function runTapFile(client, sql) {
  const out = { ok: 0, notOk: 0, planned: null, diagnostics: [], error: null };
  let results;
  try {
    results = await client.query(sql);
  } catch (err) {
    // An uncaught exception aborts the whole multi-statement query, so any TAP the file
    // had already emitted is lost with it. That is why test files are written so their
    // failure mode is `not ok` (throws_ok, lives_ok) rather than a raised exception.
    out.error = err;
    // The test file's own ROLLBACK never ran; put the session back in a usable state.
    try {
      await client.query('ROLLBACK');
    } catch {
      /* ignore */
    }
    return out;
  }
  const sets = Array.isArray(results) ? results : [results];
  for (const set of sets) {
    for (const row of set.rows || []) {
      for (const value of Object.values(row)) {
        if (typeof value !== 'string') continue;
        for (const rawLine of value.split('\n')) {
          const line = rawLine.trimEnd();
          const plan = /^1\.\.(\d+)$/.exec(line);
          if (plan) {
            out.planned = Number(plan[1]);
          } else if (/^not ok\b/.test(line)) {
            out.notOk += 1;
            out.diagnostics.push(line);
          } else if (/^ok\b/.test(line)) {
            out.ok += 1;
          } else if (/^#/.test(line)) {
            // pgTAP puts failure detail in comments; surface only the ones that indicate
            // a problem so PASS output stays quiet. Plan mismatches are detected from the
            // 1..N line instead, because pgTAP only comments on them at finish().
            if (/failed/i.test(line)) out.diagnostics.push(line);
          } else if (/^\s+#/.test(rawLine)) {
            out.diagnostics.push(rawLine.trim());
          }
        }
      }
    }
  }
  // A file that produced no assertions is a failure, not a pass — see cmdTest.
  try {
    await client.query('ROLLBACK');
  } catch {
    /* the file's own ROLLBACK already ran; this is a no-op warning */
  }
  return out;
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

async function cmdStatus() {
  const migrations = listMigrations();
  const client = await connect();
  try {
    const applied = await appliedMigrations(client);
    console.log(c.dim(`database: ${redact(databaseUrl())}`));
    let drift = 0;
    for (const m of migrations) {
      const row = applied.get(m.name);
      if (!row) {
        console.log(`  ${c.yellow('pending')}  ${m.name}${m.testPath ? '' : c.red('  (no test.sql)')}`);
      } else if (row.checksum !== m.checksum) {
        drift += 1;
        console.log(`  ${c.red('CHANGED')}  ${m.name}  ${c.dim('checksum differs from applied')}`);
      } else {
        console.log(
          `  ${c.green('applied')}  ${m.name}  ${c.dim(new Date(row.applied_at).toISOString())}`,
        );
      }
    }
    const pending = migrations.filter((m) => !applied.has(m.name)).length;
    console.log(
      `${migrations.length} migration(s): ${migrations.length - pending} applied, ${pending} pending` +
        (drift ? c.red(`, ${drift} CHANGED`) : ''),
    );
    return drift > 0 ? 1 : 0;
  } finally {
    await client.end();
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

const USAGE = `resscript migrate — forward-only SQL migrations (Deliverable B §14)

usage: node tools/migrate/cli.mjs <command> [args]

  up               apply every pending migration, in order
  status           show applied/pending/changed per migration
  reset            drop and recreate the database named in DATABASE_URL
  test [filter]    run every db/migrations/*/test.sql through pgTAP

env:
  DATABASE_URL     default ${DEFAULT_URL}
`;

async function main(argv) {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case 'up':
      return cmdUp();
    case 'reset':
      return cmdReset();
    case 'test':
      return cmdTest(rest[0]);
    case 'status':
      return cmdStatus();
    case undefined:
    case '-h':
    case '--help':
    case 'help':
      process.stdout.write(USAGE);
      return cmd === undefined ? 1 : 0;
    default:
      process.stderr.write(`unknown command "${cmd}"\n\n${USAGE}`);
      return 1;
  }
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      if (err instanceof CliError) {
        process.stderr.write(`${c.red('error')}: ${err.message}\n`);
      } else {
        process.stderr.write(`${c.red('error')}: ${err.stack || err.message}\n`);
      }
      process.exit(1);
    });
}
