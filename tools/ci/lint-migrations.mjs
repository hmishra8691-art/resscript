#!/usr/bin/env node
// Static lint over db/migrations. Deliverable B §14 and roadmap M0.2's acceptance criteria.
//
// M0.2 requires CI to fail WITH A NAMED ERROR, naming the offending object, for each of:
//   * a migration directory with no test.sql
//   * a test.sql with zero assertions
//   * a new table in app/content/billing/export without ENABLE **and** FORCE RLS
//   * a new content table without the tg_draft_only trigger
//   * a migration containing ALTER TABLE ... RENAME
//   * a column added with a volatile default
// Plus two the design documents demand and M0.2 lists elsewhere: an in-place type change
// (B §14) and app.has_role() appearing in a policy that governs one of Deliverable K §1's
// two non-nesting capabilities ("CI greps for it").
//
// Why static SQL analysis rather than only catalog assertions: ops.tables_without_rls()
// catches a missing policy after the migration has run, which is the right net, but it
// cannot name the FILE and it cannot run in a pull request that nobody applied to a
// database. Both layers exist on purpose. This one is the fast one.
//
// Exactly one rule can be waived, in writing, by a `-- lint:exempt <CODE> <object> <reason>`
// directive in up.sql: CONTENT_TABLE_WITHOUT_DRAFT_TRIGGER, whose database-side counterpart
// ops.rls_exemptions.exempt_draft_trigger has existed since migration 0001. See
// STATIC_EXEMPTIBLE below and db/README.md.
//
// Usage
//   node tools/ci/lint-migrations.mjs              lint real migrations, then self-test
//   node tools/ci/lint-migrations.mjs --only-real  lint real migrations only
//   node tools/ci/lint-migrations.mjs --self-test  fixture self-test only
// Exit code is non-zero on any violation.

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const MIGRATIONS_DIR = path.join(REPO_ROOT, 'db', 'migrations');
const FIXTURES_DIR = path.join(MIGRATIONS_DIR, '__lintfixtures__');

// Deliverable B §12: these four schemas are where RLS is not optional.
const RLS_SCHEMAS = ['app', 'content', 'billing', 'export'];

// Deliverable K §1's two capabilities that must never be checked by rank.
const NON_NESTING_CAPABILITIES = ['pii_access', 'custom_code'];

// Expressions that must not appear as the DEFAULT of an ADDED column.
//
// Two distinct reasons, both worth the rejection:
//   * genuinely VOLATILE (random, gen_random_uuid, clock_timestamp, nextval) — Postgres
//     cannot use the fast non-rewriting path, so the ALTER rewrites the whole table while
//     holding ACCESS EXCLUSIVE. On a large table that is an outage.
//   * merely STABLE but semantically wrong (now(), CURRENT_TIMESTAMP, current_date) — the
//     rewrite is avoided, but every pre-existing row is stamped with the deployment time,
//     which is a fabricated fact that no later migration can undo.
// Either way: add the column NULLable, backfill in batches through ops.jobs, then set the
// default. That is B §14's expand/backfill/contract, and the reason it is a lint rule
// rather than a code-review habit is that the failure only shows up under production data
// volume.
const VOLATILE_DEFAULTS = [
  'random(',
  'gen_random_uuid(',
  'gen_random_bytes(',
  'uuid_generate_v1(',
  'uuid_generate_v4(',
  'clock_timestamp(',
  'statement_timestamp(',
  'timeofday(',
  'nextval(',
  'currval(',
  'lastval(',
  'now(',
  'app.gen_ulid(',
  'current_timestamp',
  'current_date',
  'current_time',
  'localtimestamp',
  'localtime',
];

// Rules a migration may opt out of, in writing, in up.sql. Exactly one, and the reason it
// exists is that the DATABASE half of this net already has the concept: migration 0001
// created ops.rls_exemptions with a separate `exempt_draft_trigger` flag, and its comment
// names content.reserved_variable_names (Deliverable K §6's global reserved namespace) as the
// case — a table in schema `content` with no survey_version_id, so content.tg_draft_only has
// nothing to read and would raise feature_not_supported on every write.
// ops.content_tables_without_draft_trigger() reads that row and is satisfied; this linter
// cannot, because it runs before any database exists. Without a static equivalent the two
// halves of the same net disagree, and the only ways out are worse: put the table in another
// schema (contradicting B §4.3), or attach a trigger that can only ever raise.
//
// TABLE_WITHOUT_FORCED_RLS is deliberately NOT exemptible here even though
// ops.rls_exemptions has an `exempt_rls` axis too. Its only two rows are the pre-seeded
// global billing tables, which do not exist yet; when they arrive, that CI failure is a
// conversation worth having in review rather than one a directive can end. Everything else —
// renames, in-place type changes, volatile defaults, has_role() in a capability policy — has
// no legitimate exception at all, so a directive naming one is ignored.
const STATIC_EXEMPTIBLE = new Set(['CONTENT_TABLE_WITHOUT_DRAFT_TRIGGER']);

// `-- lint:exempt <CODE> <schema.object> <reason...>`, where the reason may continue on the
// following comment lines. The 12-character minimum mirrors
// ops.rls_exemptions.rls_exemptions_reason_nonempty, so an exemption is a code-review
// conversation in both halves rather than a one-word commit.
//
// Parsed from the RAW sql, before scrub() blanks comments — this is the one rule input that
// lives in a comment. A directive that names an unexemptible code, or carries no reason,
// is IGNORED rather than reported: the original rule then fires and names the object, which
// fails closed and needs no second error code to explain itself.
const EXEMPT_RE =
  /^[ \t]*--[ \t]*lint:exempt[ \t]+([A-Z_]+)[ \t]+([a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*)[ \t]*(.*)$/i;

export function parseExemptions(sql) {
  const out = new Map();
  const lines = sql.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const m = EXEMPT_RE.exec(lines[i]);
    if (!m) continue;
    const [, code, object] = m;
    let reason = m[3] || '';
    // Continuation: subsequent comment lines that are not themselves a directive.
    for (let j = i + 1; j < lines.length; j += 1) {
      const cont = /^[ \t]*--[ \t]*(.*)$/.exec(lines[j]);
      if (!cont || EXEMPT_RE.test(lines[j])) break;
      reason += ` ${cont[1]}`;
    }
    if (!STATIC_EXEMPTIBLE.has(code.toUpperCase())) continue;
    if (reason.trim().length < 12) continue;
    const key = `${code.toUpperCase()} ${object.toLowerCase()}`;
    out.set(key, reason.trim());
  }
  return out;
}

// pgTAP assertion functions. A test.sql containing none of these (and no plain-SQL
// RAISE EXCEPTION guard) is not a test.
const ASSERTION_FUNCTIONS = [
  'ok', 'is', 'isnt', 'matches', 'imatches', 'doesnt_match', 'alike', 'cmp_ok',
  'is_empty', 'isnt_empty', 'results_eq', 'results_ne', 'set_eq', 'set_ne', 'bag_eq',
  'row_eq', 'throws_ok', 'throws_like', 'lives_ok', 'performs_ok',
  'has_table', 'hasnt_table', 'has_column', 'hasnt_column', 'has_index', 'hasnt_index',
  'has_function', 'hasnt_function', 'has_schema', 'hasnt_schema', 'has_type', 'has_domain',
  'has_enum', 'enum_has_labels', 'has_trigger', 'has_role', 'has_view', 'has_materialized_view',
  'col_is_pk', 'col_is_unique', 'col_not_null', 'col_has_default', 'col_default_is',
  'fk_ok', 'policies_are', 'policy_cmd_is', 'policy_roles_are', 'table_privs_are',
  'function_privs_are', 'schema_privs_are', 'db_privs_are', 'is_definer', 'volatility_is',
  'function_returns', 'index_is_unique', 'index_is_primary', 'is_partitioned',
  'columns_are', 'tables_are', 'functions_are', 'indexes_are', 'triggers_are',
  'roles_are', 'schemas_are', 'types_are', 'domains_are',
];

// ---------------------------------------------------------------------------
// SQL scrubbing
// ---------------------------------------------------------------------------

// Replace a span with spaces, preserving newlines so reported line numbers stay honest.
function blank(text) {
  return text.replace(/[^\n]/g, ' ');
}

// Two scrub levels, because two of the rules need opposite things:
//   * structural rules (CREATE TABLE, ALTER TABLE, DEFAULT ...) must NOT see string
//     literals, or a COMMENT ON that quotes "ALTER TABLE ... RENAME" while explaining why
//     renames are banned would be reported as a rename. This codebase does exactly that.
//   * the capability-policy rule MUST see string literals, because the capability it is
//     looking for is spelled 'pii_access' inside the policy predicate.
// Comments are stripped for both. Dollar-quoted bodies are stripped for both: a function
// body is not DDL, and `EXECUTE format('ALTER TABLE %I ...')` inside one is legitimate.
function scrub(sql, { keepStrings }) {
  let out = '';
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const two = sql.slice(i, i + 2);
    if (two === '--') {
      const end = sql.indexOf('\n', i);
      const stop = end === -1 ? n : end;
      out += blank(sql.slice(i, stop));
      i = stop;
      continue;
    }
    if (two === '/*') {
      // Postgres block comments nest.
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        if (sql.slice(j, j + 2) === '/*') { depth += 1; j += 2; }
        else if (sql.slice(j, j + 2) === '*/') { depth -= 1; j += 2; }
        else j += 1;
      }
      out += blank(sql.slice(i, j));
      i = j;
      continue;
    }
    if (sql[i] === "'") {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === "'" && sql[j + 1] === "'") { j += 2; continue; }
        if (sql[j] === "'") { j += 1; break; }
        j += 1;
      }
      out += keepStrings ? sql.slice(i, j) : blank(sql.slice(i, j));
      i = j;
      continue;
    }
    if (sql[i] === '"') {
      // Quoted identifiers are identifiers; always keep them.
      let j = i + 1;
      while (j < n && sql[j] !== '"') j += 1;
      j += 1;
      out += sql.slice(i, j);
      i = j;
      continue;
    }
    const dollar = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
    if (dollar) {
      const tag = dollar[0];
      const close = sql.indexOf(tag, i + tag.length);
      const j = close === -1 ? n : close + tag.length;
      out += blank(sql.slice(i, j));
      i = j;
      continue;
    }
    out += sql[i];
    i += 1;
  }
  return out;
}

// Split scrubbed SQL into statements, so a rule can be scoped to one statement instead of
// matching across a semicolon. Dollar-quoted bodies are already blanked by scrub(), so a
// naive semicolon split is safe here and nowhere else.
function splitStatements(scrubbed) {
  const out = [];
  // Leading whitespace and blanked-out comment lines are skipped when recording the
  // offset, so a reported line number points at the statement rather than at the blank
  // line after the previous semicolon.
  const push = (from, to) => {
    const raw = scrubbed.slice(from, to);
    if (!raw.trim()) return;
    const lead = raw.length - raw.trimStart().length;
    out.push({ text: raw, offset: from + lead });
  };
  let start = 0;
  for (let i = 0; i < scrubbed.length; i += 1) {
    if (scrubbed[i] === ';') {
      push(start, i);
      start = i + 1;
    }
  }
  push(start, scrubbed.length);
  return out;
}

function lineOf(sql, offset) {
  return sql.slice(0, offset).split('\n').length;
}

// ---------------------------------------------------------------------------
// findings
// ---------------------------------------------------------------------------

class Finding {
  constructor(code, object, file, line, message) {
    this.code = code;
    this.object = object;
    this.file = file;
    this.line = line;
    this.message = message;
  }
  toString() {
    const where = this.line ? `${this.file}:${this.line}` : this.file;
    return `${this.code}: ${this.object}\n    ${where}\n    ${this.message}`;
  }
}

// ---------------------------------------------------------------------------
// rules
// ---------------------------------------------------------------------------

export function lintMigrationDir(dir, { repoRoot = REPO_ROOT } = {}) {
  const findings = [];
  const name = path.basename(dir);
  const rel = (p) => path.relative(repoRoot, p) || p;

  const upPath = path.join(dir, 'up.sql');
  const testPath = path.join(dir, 'test.sql');

  if (!existsSync(upPath)) {
    findings.push(new Finding('MISSING_UP_SQL', name, rel(dir), null,
      'Every migration directory must contain up.sql. Forward-only means up.sql is the ' +
      'only script there is (B §14).'));
    return findings;
  }

  const sql = readFileSync(upPath, 'utf8');
  const exemptions = parseExemptions(sql);
  const code = scrub(sql, { keepStrings: false });
  const withStrings = scrub(sql, { keepStrings: true });
  const statements = splitStatements(code);
  const stringStatements = splitStatements(withStrings);

  // --- test.sql presence and non-emptiness ---------------------------------
  if (!existsSync(testPath)) {
    findings.push(new Finding('MISSING_TEST_SQL', name, rel(dir), null,
      'Every migration directory must contain test.sql (B §14, ADR-009). The cross-tenant ' +
      'isolation assertions run on every migration, so "a new table without RLS cannot ' +
      'merge" — a migration with no test is a migration that opted out of that.'));
  } else {
    const testSql = readFileSync(testPath, 'utf8');
    const testCode = scrub(testSql, { keepStrings: true });
    const assertionRe = new RegExp(
      `\\b(?:${ASSERTION_FUNCTIONS.join('|')})\\s*\\(`, 'gi');
    const assertions = (testCode.match(assertionRe) || []).length;
    // A plain-SQL guard block is an acceptable substitute where pgTAP is unavailable.
    const raises = (testCode.match(/\bRAISE\s+EXCEPTION\b/gi) || []).length;
    if (assertions + raises === 0) {
      findings.push(new Finding('EMPTY_TEST_SQL', `${name}/test.sql`, rel(testPath), null,
        'test.sql contains zero assertions. A file that asserts nothing passes forever ' +
        'and tells you nothing; it is worse than no file, because it looks like coverage.'));
    }
  }

  // --- timeout header ------------------------------------------------------
  const headerWindow = code.split('\n').slice(0, 60).join('\n');
  const hasLockTimeout = /\bSET\s+lock_timeout\s*=/i.test(headerWindow);
  const hasStatementTimeout = /\bSET\s+statement_timeout\s*=/i.test(headerWindow);
  if (!hasLockTimeout || !hasStatementTimeout) {
    const missing = [
      hasLockTimeout ? null : 'lock_timeout',
      hasStatementTimeout ? null : 'statement_timeout',
    ].filter(Boolean).join(' and ');
    findings.push(new Finding('MISSING_TIMEOUT_HEADER', `${name}/up.sql`, rel(upPath), 1,
      `up.sql does not set ${missing} in its first 60 lines (B §14). An ALTER TABLE ` +
      'waiting behind a long read drags an ACCESS EXCLUSIVE lock queue with it and stalls ' +
      'the runtime; failing fast and retrying is strictly better than blocking.'));
  }

  // --- new tables in the RLS-enforced schemas ------------------------------
  const createdTables = [];
  const createTableRe = new RegExp(
    `\\bCREATE\\s+(?:UNLOGGED\\s+)?TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?` +
    `(${RLS_SCHEMAS.join('|')})\\s*\\.\\s*("?[A-Za-z_][A-Za-z0-9_$]*"?)`,
    'gi');
  for (const m of code.matchAll(createTableRe)) {
    createdTables.push({
      schema: m[1].toLowerCase(),
      table: m[2].replace(/"/g, '').toLowerCase(),
      line: lineOf(code, m.index),
    });
  }

  const rlsEnabled = new Set();
  const rlsForced = new Set();
  const alterRlsRe = new RegExp(
    `\\bALTER\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?(?:ONLY\\s+)?` +
    `(${RLS_SCHEMAS.join('|')})\\s*\\.\\s*("?[A-Za-z_][A-Za-z0-9_$]*"?)\\s+` +
    `(ENABLE|FORCE)\\s+ROW\\s+LEVEL\\s+SECURITY`,
    'gi');
  for (const m of code.matchAll(alterRlsRe)) {
    const key = `${m[1].toLowerCase()}.${m[2].replace(/"/g, '').toLowerCase()}`;
    (m[3].toUpperCase() === 'ENABLE' ? rlsEnabled : rlsForced).add(key);
  }

  const draftTriggered = new Set();
  const draftTriggerRe =
    /\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:CONSTRAINT\s+)?TRIGGER\s+[\s\S]*?\bON\s+content\s*\.\s*("?[A-Za-z_][A-Za-z0-9_$]*"?)[\s\S]*?\bEXECUTE\s+(?:FUNCTION|PROCEDURE)\s+content\s*\.\s*tg_draft_only\b/gi;
  for (const stmt of statements) {
    for (const m of stmt.text.matchAll(draftTriggerRe)) {
      draftTriggered.add(`content.${m[1].replace(/"/g, '').toLowerCase()}`);
    }
  }

  for (const t of createdTables) {
    const key = `${t.schema}.${t.table}`;
    const missing = [];
    if (!rlsEnabled.has(key)) missing.push('ENABLE ROW LEVEL SECURITY');
    if (!rlsForced.has(key)) missing.push('FORCE ROW LEVEL SECURITY');
    if (missing.length) {
      findings.push(new Finding('TABLE_WITHOUT_FORCED_RLS', key, rel(upPath), t.line,
        `${key} is created in schema ${t.schema} but the migration never issues ` +
        `${missing.join(' and ')} for it (ADR-009, B §12). ENABLE without FORCE is not ` +
        'enough: without FORCE the table owner — which every migration runs as — is exempt ' +
        'from its own policies, so the isolation suite passes while production leaks.'));
    }
    if (t.schema === 'content' && !draftTriggered.has(key)
        && !exemptions.has(`CONTENT_TABLE_WITHOUT_DRAFT_TRIGGER ${key}`)) {
      findings.push(new Finding('CONTENT_TABLE_WITHOUT_DRAFT_TRIGGER', key, rel(upPath), t.line,
        `${key} is created in schema content but no trigger on it executes ` +
        'content.tg_draft_only() (ADR-002, B §12.1). Content rows are scoped to a ' +
        'survey_version_id, and a content table without that trigger is a table through ' +
        'which a published survey can be edited under live respondents.'));
    }
  }

  // --- in-place renames ----------------------------------------------------
  for (const stmt of statements) {
    if (!/^\s*ALTER\s+TABLE\b/i.test(stmt.text)) continue;

    if (/\bRENAME\b/i.test(stmt.text)) {
      const obj = /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?([A-Za-z_"][\w".$]*)/i
        .exec(stmt.text);
      findings.push(new Finding('IN_PLACE_RENAME', obj ? obj[1] : 'unknown table',
        rel(upPath), lineOf(code, stmt.offset),
        'ALTER TABLE ... RENAME is banned (B §14). A rename is instantaneous in the ' +
        'database and catastrophic in the deploy: the previous application version is ' +
        'still running and still writing the old name, so the rename window is an outage. ' +
        'Use expand/contract — add the new column, dual-write, backfill, drop the old one ' +
        'in a later release.'));
    }

    if (/\bALTER\s+(?:COLUMN\s+)?"?[A-Za-z_][\w$]*"?\s+(?:SET\s+DATA\s+)?TYPE\b/i
        .test(stmt.text)) {
      const obj = /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?([A-Za-z_"][\w".$]*)/i
        .exec(stmt.text);
      const col = /\bALTER\s+(?:COLUMN\s+)?("?[A-Za-z_][\w$]*"?)\s+(?:SET\s+DATA\s+)?TYPE\b/i
        .exec(stmt.text);
      findings.push(new Finding('IN_PLACE_TYPE_CHANGE',
        `${obj ? obj[1] : 'unknown table'}.${col ? col[1] : '?'}`,
        rel(upPath), lineOf(code, stmt.offset),
        'ALTER COLUMN ... TYPE is banned (B §14). It rewrites the table under an ACCESS ' +
        'EXCLUSIVE lock and it changes the shape the running application already ' +
        'serializes against. Expand/contract instead.'));
    }

    // --- volatile default on an added column -------------------------------
    if (/\bADD\s+(?:COLUMN\s+)?/i.test(stmt.text) && /\bDEFAULT\b/i.test(stmt.text)) {
      const lowered = stmt.text.toLowerCase();
      const defaultIdx = lowered.indexOf('default');
      const tail = lowered.slice(defaultIdx);
      const hit = VOLATILE_DEFAULTS.find((v) => tail.includes(v));
      if (hit) {
        const obj = /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?([A-Za-z_"][\w".$]*)/i
          .exec(stmt.text);
        const col = /\bADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?("?[A-Za-z_][\w$]*"?)/i
          .exec(stmt.text);
        findings.push(new Finding('VOLATILE_DEFAULT',
          `${obj ? obj[1] : 'unknown table'}.${col ? col[1] : '?'} DEFAULT ${hit.replace(/\($/, '()')}`,
          rel(upPath), lineOf(code, stmt.offset),
          `ADD COLUMN with DEFAULT ${hit.replace(/\($/, '()')} is banned (B §14). A truly ` +
          'volatile default forces a full table rewrite under ACCESS EXCLUSIVE; a ' +
          'timestamp default stamps every pre-existing row with the deployment time, ' +
          'which is a fabricated fact. Add the column NULLable, backfill in batches ' +
          'through ops.jobs, then set the default.'));
      }
    }
  }

  // --- Deliverable K §1: has_role() must not govern a non-nesting capability ---
  // Scoped to CREATE POLICY statements only, from the string-preserving scrub: the
  // capability is spelled as a literal inside the predicate, while the COMMENT ON POLICY
  // that explains the rule legitimately mentions both names and is a different statement.
  const capRe = new RegExp(`(${NON_NESTING_CAPABILITIES.join('|')})`, 'i');
  for (const stmt of stringStatements) {
    if (!/^\s*CREATE\s+POLICY\b/i.test(stmt.text)) continue;
    const capHit = capRe.exec(stmt.text);
    if (!capHit) continue;
    if (!/\bhas_role\s*\(/i.test(stmt.text)) continue;
    const nameMatch = /CREATE\s+POLICY\s+("?[A-Za-z_][\w$]*"?)\s+ON\s+([A-Za-z_"][\w".$]*)/i
      .exec(stmt.text);
    findings.push(new Finding('HAS_ROLE_IN_CAPABILITY_POLICY',
      nameMatch ? `${nameMatch[2]}.${nameMatch[1]}` : 'unnamed policy',
      rel(upPath), lineOf(withStrings, stmt.offset),
      `this policy governs '${capHit[1]}' and calls app.has_role(). Deliverable K §1: ` +
      '"has_role() is forbidden from appearing in a policy that governs either. CI greps ' +
      `for it." ${capHit[1] === 'pii_access'
        ? 'A Project Manager (rank 50) outranks an Analyst (30) and must NOT thereby ' +
          'acquire PII access.'
        : 'An Admin (rank 60) outranks a Programmer (40) and must NOT thereby acquire the ' +
          'right to author custom JS.'} ` +
      'Use app.has_capability() and an explicit grant in app.capability_grants.'));
  }

  return findings;
}

// ---------------------------------------------------------------------------
// drivers
// ---------------------------------------------------------------------------

const MIGRATION_DIR_RE = /^\d{4}_[a-z0-9]+(?:_[a-z0-9]+)*$/;

function realMigrationDirs() {
  if (!existsSync(MIGRATIONS_DIR)) {
    throw new Error(`migrations directory not found: ${MIGRATIONS_DIR}`);
  }
  return readdirSync(MIGRATIONS_DIR)
    .sort()
    .map((e) => path.join(MIGRATIONS_DIR, e))
    .filter((p) => statSync(p).isDirectory())
    // __lintfixtures__ is deliberately broken SQL. It is excluded here and in
    // tools/migrate/cli.mjs, which only recognises NNNN_name directories, so the fixtures
    // can never be applied to a database.
    .filter((p) => MIGRATION_DIR_RE.test(path.basename(p)));
}

function lintReal() {
  const dirs = realMigrationDirs();
  if (dirs.length === 0) throw new Error('no migration directories found');
  const findings = dirs.flatMap((d) => lintMigrationDir(d));
  console.log(`lint-migrations: checked ${dirs.length} migration(s)`);
  for (const f of findings) console.error(`\n${f}`);
  if (findings.length) {
    console.error(`\n${findings.length} violation(s) in db/migrations`);
    return 1;
  }
  console.log('lint-migrations: clean');
  return 0;
}

// Each fixture carries an expect.json naming the code it must produce, so adding a rule
// means adding a fixture and the self-test needs no editing. A rule with no fixture is a
// rule nobody has ever seen fire.
function selfTest() {
  if (!existsSync(FIXTURES_DIR)) {
    console.error(`SELF_TEST_FAILED: fixtures directory missing: ${FIXTURES_DIR}`);
    return 1;
  }
  const fixtures = readdirSync(FIXTURES_DIR)
    .sort()
    .map((e) => path.join(FIXTURES_DIR, e))
    .filter((p) => statSync(p).isDirectory());
  if (fixtures.length === 0) {
    console.error('SELF_TEST_FAILED: no fixtures found');
    return 1;
  }

  let failed = 0;
  const seenCodes = new Set();
  for (const dir of fixtures) {
    const name = path.basename(dir);
    const expectPath = path.join(dir, 'expect.json');
    if (!existsSync(expectPath)) {
      console.error(`SELF_TEST_FAILED: ${name} has no expect.json`);
      failed += 1;
      continue;
    }
    const expected = JSON.parse(readFileSync(expectPath, 'utf8'));
    const findings = lintMigrationDir(dir, { repoRoot: REPO_ROOT });
    const codes = findings.map((f) => f.code).sort();
    const want = [...expected.codes].sort();
    const objects = findings.map((f) => f.object);

    const codesMatch = JSON.stringify(codes) === JSON.stringify(want);
    // "Each failure names the offending object" is an explicit M0.2 acceptance criterion,
    // so the self-test checks the object string too, not just the code.
    const objectMatch =
      !expected.object || objects.some((o) => o.includes(expected.object));

    if (codesMatch && objectMatch) {
      console.log(`  ok   ${name} -> ${codes.join(', ')}` +
        (expected.object ? ` (names ${expected.object})` : ''));
      codes.forEach((c) => seenCodes.add(c));
    } else {
      failed += 1;
      console.error(`  FAIL ${name}`);
      console.error(`       expected codes ${JSON.stringify(want)}, got ${JSON.stringify(codes)}`);
      if (expected.object) {
        console.error(`       expected an object naming "${expected.object}", got ${JSON.stringify(objects)}`);
      }
      for (const f of findings) console.error(`       - ${f.code}: ${f.object}`);
    }
  }

  // Every rule the linter implements must have a fixture proving it fires.
  const implemented = [
    'MISSING_TEST_SQL', 'EMPTY_TEST_SQL', 'TABLE_WITHOUT_FORCED_RLS',
    'CONTENT_TABLE_WITHOUT_DRAFT_TRIGGER', 'IN_PLACE_RENAME', 'IN_PLACE_TYPE_CHANGE',
    'VOLATILE_DEFAULT', 'HAS_ROLE_IN_CAPABILITY_POLICY', 'MISSING_TIMEOUT_HEADER',
    'MISSING_UP_SQL',
  ];
  const uncovered = implemented.filter((r) => !seenCodes.has(r));
  if (uncovered.length) {
    console.error(`SELF_TEST_FAILED: no fixture exercises ${uncovered.join(', ')}`);
    failed += 1;
  }

  if (failed) {
    console.error(`\nlint self-test: ${failed} failure(s)`);
    return 1;
  }
  console.log(`lint self-test: ${fixtures.length} fixture(s), all rejected as expected`);
  return 0;
}

function main(argv) {
  const onlyReal = argv.includes('--only-real');
  const onlySelf = argv.includes('--self-test');
  let code = 0;
  if (!onlySelf) code |= lintReal();
  if (!onlyReal) code |= selfTest();
  return code ? 1 : 0;
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (err) {
    console.error(`lint-migrations: ${err.message}`);
    process.exit(1);
  }
}
