# ResScript database

Milestone M0.2 (migration tooling and the RLS test harness), the database half of
P1-01 (tenancy and the isolation guarantee), and the database half of P1-03 (the
version-scoped content model and the survey tree).

Authoritative design, in precedence order: **Deliverable K** (`11-canonical-registries.md`)
beats everything; then the ADRs (`00-decisions-adr.md`, especially ADR-002 immutability and
ADR-009 multi-tenancy); then Deliverable B (`02-database-schema.md`). Every SQL object here
carries a `COMMENT ON` explaining *why* it exists and citing the section it comes from — the
database is the design's executable form, so `\d+` and `obj_description()` are documentation
and are expected to stay that way.

---

## Running it

```bash
# 1. A PostgreSQL 16 with pgTAP available.
docker run -d --name rspg -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:16
#   ...or, on a Debian/Ubuntu box:
apt-get install -y postgresql-16 postgresql-16-pgtap && pg_ctlcluster 16 main start

# 2. Point at it.
export DATABASE_URL=postgres://postgres:postgres@localhost:5432/resscript

# 3. Go.
node tools/migrate/cli.mjs reset     # drop + recreate the database named in DATABASE_URL
node tools/migrate/cli.mjs up        # apply every pending migration, in order
node tools/migrate/cli.mjs test      # run every test.sql through pgTAP
node tools/migrate/cli.mjs status    # applied / pending / checksum drift
node tools/ci/lint-migrations.mjs    # static lint + fixture self-test
```

Also wired up as `pnpm db:reset`, `pnpm db:up`, `pnpm db:test`, `pnpm lint:migrations`.

`DATABASE_URL` defaults to `postgres://postgres:postgres@localhost:5432/resscript`.

### What the runner needs

- **Superuser or `BYPASSRLS`.** The RLS helpers (`app.has_role`, `app.can_see_project`,
  `app.can_see_survey`, `app.has_capability`) are `SECURITY DEFINER` for the reason
  Deliverable B §1.1 gives: `app.org_members` has RLS, and a policy on `org_members` that
  read `org_members` through the policy layer would recurse. Definer breaks the cycle only
  if the definer is not itself subject to those policies. On Supabase the `postgres` role
  has `BYPASSRLS`; migration 0004 emits a loud `WARNING` if the runner has neither that nor
  superuser, because the failure mode (`has_role()` always false, so nobody sees anything)
  is safe but baffling.
- **The same role every time.** 0001 issues `ALTER DEFAULT PRIVILEGES … IN SCHEMA app,
  content GRANT … TO authoring`, which applies to objects created by the *current* role.
  Running migrations as two different roles produces two different privilege sets.
- **pgTAP is a test-only dependency.** It is installed by `cli.mjs test`
  (`CREATE EXTENSION IF NOT EXISTS pgtap`), never by a migration, so production databases
  never carry it. `pgtap` lives in schema `public`, which 0001 hardens with
  `REVOKE ALL ON SCHEMA public FROM PUBLIC`; the P1-01 suite grants `USAGE ON SCHEMA public`
  to the application roles *inside its own transaction*, which is rolled back, so the
  hardening is never actually relaxed.

### `PUBLIC EXECUTE` is not closed by default privileges

A trap worth knowing before you write your first `CREATE FUNCTION` here.

```sql
-- This statement is a NO-OP. It stores nothing and protects nothing.
ALTER DEFAULT PRIVILEGES IN SCHEMA app, ops REVOKE ALL ON FUNCTIONS FROM PUBLIC;
```

On PostgreSQL 16 it writes no `pg_default_acl` row, and a function created afterwards still
has `proacl = NULL` — which is the *built-in* default, and for a function the built-in
default is `EXECUTE TO PUBLIC`. Creating a default-ACL row first with a `GRANT` and then
revoking `PUBLIC` from it does not help either: the stored default is not applied to new
functions. Migration 0001 contains that line and it did nothing; `0006_revoke_public_execute`
is the cleanup, and it explains the whole discovery in its header.

So: **every function needs an explicit `REVOKE EXECUTE … FROM PUBLIC`, followed by a `GRANT`
to the named role that needs it.** The pattern, which every function in these migrations
follows:

```sql
CREATE FUNCTION app.thing(...) RETURNS ... ;
COMMENT ON FUNCTION app.thing(...) IS 'why it exists, citing the deliverable section';
REVOKE EXECUTE ON FUNCTION app.thing(...) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION app.thing(...) TO authoring;   -- only the roles that need it
```

`ops.functions_executable_by_public()` is the standing guard, asserted empty the same way
`ops.tables_without_rls()` is. It has **no exemption table**: unlike RLS, where
`billing.plans` is genuinely global, nothing in these six schemas should ever be callable by
`PUBLIC`. Two things to remember when it fires:

- **A trigger function may be revoked freely.** PostgreSQL checks `EXECUTE` on a trigger
  function at `CREATE TRIGGER` time, not when the trigger fires.
- **A function used in a column `DEFAULT` may not.** A default expression is evaluated with
  the *inserting* user's privileges, so `app.gen_ulid` is granted to `authoring` — it is the
  `DEFAULT` on eight primary keys. Get this wrong and every write fails with
  `42501 permission denied for function gen_ulid`, which is indistinguishable at a glance
  from `42501 new row violates row-level security policy`: the suite's RLS assertions stay
  green while nothing can be written.

### Optional extensions, and the fallbacks

| Extension | Required? | What happens without it |
|---|---|---|
| `pgcrypto`, `citext`, `pg_trgm` | **yes** | 0001 fails. `gen_random_bytes` (ULIDs, invitation hashes), case-insensitive invite emails, `gin_trgm_ops` on `audit_log.action`. |
| `pgtap` | for `test` only | `cli.mjs test` fails with an install hint. Migrations themselves are unaffected. |
| `pg_cron` | no | 0001 registers the `ops.ensure_event_partitions(3)` schedule only if `pg_cron` is installed, and otherwise emits a `NOTICE`. See **Partition maintenance** below. |
| `pgmq` | no | Never used. See **Replacing the queue with pgmq** below. |

---

## Migration convention

```
db/migrations/
  NNNN_snake_case_name/
    up.sql       # the migration. starts with the lock_timeout / statement_timeout header
    test.sql     # pgTAP, one transaction, BEGIN … plan(N) … finish() … ROLLBACK
  __lintfixtures__/   # deliberately broken; never applied. See its own README.
```

- **Directory name is `NNNN_snake_case`.** `tools/migrate/cli.mjs` recognises nothing else,
  which is what keeps `__lintfixtures__` unappliable.
- **`up.sql` opens with the timeout header.** Deliverable B §14: an `ALTER TABLE` waiting
  behind a long read drags an `ACCESS EXCLUSIVE` lock queue with it and stalls the runtime;
  failing fast and retrying is strictly better than blocking. The linter enforces the
  header's presence.
- **Each migration is applied in one transaction** and recorded in `ops.schema_migrations`
  with `sha256(up.sql)`. Editing an already-applied migration is a **hard error** on the
  next `up`, naming the file. That checksum is the only mechanical difference between
  "forward-only" and "somebody edited 0002 and now staging and production disagree about
  the schema".
- **`up` is idempotent.** Running it twice applies nothing the second time.
- **Opting out of the transaction:** put `-- migrate:no-transaction` on its own line.
  `CREATE INDEX CONCURRENTLY` cannot run inside a transaction block, and such a migration
  is not atomic — so it should contain exactly that one statement.
- **`test.sql` runs against a freshly migrated database** and rolls itself back, so the
  suite is repeatable without a reset. A file that produces zero assertions, or whose
  `plan(N)` disagrees with the number of assertions that ran, is reported as a failure.
  An *uncaught exception* aborts the whole file and loses the TAP it had already emitted,
  which is why the suites express expected failures as `throws_ok` / `lives_ok` rather than
  letting statements raise.

### When a later migration changes an earlier migration's objects

**Every `test.sql` runs against the fully migrated database.** A test file is therefore an
assertion about the *current* schema, not a historical snapshot of the schema as it was when
that migration was written. This is deliberate — the whole value of the catalog assertions
is that migration 0001's `tables_without_rls()` check fails when migration 0147 adds an
unprotected table — but it has a consequence people trip over: **a later migration that
re-signs or redefines an earlier migration's objects invalidates the earlier tests, and
those tests must be maintained.**

That is not a flaw to be engineered away. The alternative — running each `test.sql` against
a database migrated only up to that point — would mean the isolation and catalog assertions
only ever check the world as it was, which is exactly the failure mode ADR-009 warns about
("tenant isolation is not a thing you assert once in a design doc").

The convention, and it is a hard rule:

| Assertion | Lives with |
|---|---|
| **Behavioural** — what the object *does* | the migration that introduced the behaviour, rewritten against the current signature |
| **Signature shape** — `has_function`, argument lists, `hasnt_function` for removed overloads, ACLs named per signature | whichever migration **currently defines** that signature |
| **Structural / catalog** — `tables_without_rls()`, `content_tables_without_draft_trigger()`, `functions_executable_by_public()`, "every definer pins `search_path`" | **every** migration's `test.sql` |

Two corollaries worth stating, because both were learned by getting them wrong:

1. **Move signature assertions, do not duplicate them.** When 0005 re-signed the job RPCs,
   0003's `has_function`-style assertions moved to 0005 and 0003 kept only the behaviour
   (idempotent enqueue, claim/heartbeat/complete, retry with backoff, the stalled sweeper) —
   rewritten to call the new signatures. Two files asserting the same signature means one of
   them is stale the next time it changes, and you will not know which.
2. **Prefer signature-free phrasing for privilege and reachability claims.** 0003 used to
   assert `has_function_privilege('authoring', 'ops.enqueue_job(…,integer,uuid)', 'EXECUTE')
   = false`. Re-signing the function silently changed what that line tested. Phrased over
   `pg_proc` instead — "`authoring` holds EXECUTE on **no** function in schema `ops`" — it
   keeps meaning the same thing forever, and it caught a real hole the moment it was
   rewritten (see `0006_revoke_public_execute`).

### Forward-only, and why there are no `down` scripts

Deliverable B §14, verbatim in intent: **a down migration is a script that is never tested
against production-shaped data and gets run for the first time during an incident.** It is
the least-tested code in the repository, invoked in the worst circumstances, against a
schema that has since drifted. Worse, most interesting migrations are not reversible at
all — a `DROP COLUMN` cannot be undone by re-adding the column, because the data is gone,
and a "down" that silently recreates an empty column is more dangerous than no down at all.

Reversal is therefore a **forward** migration plus expand/contract discipline:

1. **Expand** — nullable column, new table, `CREATE INDEX CONCURRENTLY`. Deployable alone.
2. **Backfill** — batched and resumable, tracked in `ops.jobs`, never inside the migration
   transaction.
3. **Dual-write** — the application writes both shapes.
4. **Contract** — drop the old shape in a later release, once the previous application
   version is gone.

Release ordering is migration-first, then application; the app must tolerate the
pre-migration schema for the rollout window, which is exactly what the expand step
guarantees. Rolling *back* the application is then always safe, which is the property you
actually want at 03:00 — not the ability to run untested reverse DDL.

The same reasoning is why `ALTER TABLE … RENAME` and `ALTER COLUMN … TYPE` are lint errors
rather than style preferences: both are instantaneous in the database and catastrophic in
the deploy, because the previous application version is still running.

### Two different version numbers

`app.survey_versions.schema_version` is the shape of the **survey document** (03 §18),
migrated in TypeScript, applied when a survey is loaded, scoped to one survey version's
rows. The `NNNN` in this directory is the shape of the **database**, applied once at deploy,
scoped to every row in the cluster. Deliverable B §14.1 is emphatic that conflating them is
a specific and expensive confusion. The overwhelmingly common case is a `schema_version`
bump with no SQL migration at all, because the change is inside a JSONB payload.

---

## The three database roles (ADR-009)

Three roles, three connection configurations, and discipline about which code uses which.
The point of the split is that the riskiest query surface in the system has no ability to
read tenant data *at all*.

| Role | Used by | May do | May **not** do |
|---|---|---|---|
| `authoring` | studio / control plane; Supabase's `authenticated` maps here | `USAGE` on `app`, `content`, `billing`; `SELECT/INSERT/UPDATE/DELETE` on `app` and `content` tables — **every row decision made by RLS**; `SELECT` on `billing`; `EXECUTE` on the named helpers, `app.create_organization`, `app.get_job` and `app.resolve_invitation` | reach `ops` or `runtime`; write `app.audit_log` (no INSERT policy *and* the privilege is revoked); execute the runtime RPCs |
| `runtime_writer` | the respondent-facing runtime (data plane) | `EXECUTE` on a handful of named `SECURITY DEFINER` RPCs in `runtime` — currently `runtime.resolve_token(text)` and `runtime.load_session(app.ulid)` | **hold any table privilege anywhere.** No `SELECT` on `app.*` or `content.*`; no `USAGE` on `content` at all. `USAGE` on `app` is granted for type visibility only (the `app.ulid` / `app.sha256` domains in the RPC signatures) |
| `analytics_reader` | export / BI readers | `USAGE` on `export`; `SELECT` on the generated per-version flat tables (B §11), which are themselves RLS-forced | read `app` or `content`; write anything |

Plus two owners, which nothing ever connects as: `runtime_rpc_owner` owns schema `runtime`
and the definer RPCs (so "definer" means *that role*, not "superuser"), and
`analytics_owner` owns schema `export` so default privileges for `analytics_reader` attach
to a single role.

**Why `runtime_writer` has no `SELECT` on tenant data.** It is the only component exposed to
millions of anonymous users, it interpolates respondent-supplied URL parameters, and it is
deployed to edge regions where its credential is furthest from our control. If that
credential carried `SELECT` on `content.nodes` or `app.respondents`, one injection or one
leaked environment variable would be a full cross-tenant read. Instead its entire capability
surface is a short list of function signatures — and **no RPC takes an `org_id` argument**,
so a cross-tenant request is not merely unauthorized, it is unphraseable. `0004`'s
`test.sql` asserts all of this from the catalog (`aclexplode` over `pg_class`), so it keeps
holding for tables that do not exist yet.

Roles are **cluster-global** and survive `cli.mjs reset`; 0001 creates them idempotently.

### `has_role()` is not the authorization model

`app.role_rank()` implements Deliverable K §1's eight ranks
(owner 70, admin 60, project_manager 50, programmer 40, analyst 30, reviewer 20, viewer 10,
client 5), and `app.has_role(min)` is safe **only for capabilities that genuinely nest**.
Two do not:

- **PII in exports** — a Project Manager (50) outranks an Analyst (30) and must not thereby
  acquire access to open-ended verbatims.
- **Custom code authoring** — an Admin (60) outranks a Programmer (40) and still cannot
  author custom JS, because the threat model treats custom code as a distinct privilege
  rather than a seniority reward.

Both live in `app.capability_grants` and are checked by `app.has_capability(text, project)`,
which **contains no `has_role()` call at all** and additionally requires the org-level
`pii_exports_enabled` setting for `pii_access`. K §1 says "`has_role()` is forbidden from
appearing in a policy that governs either. CI greps for it." That grep exists twice: the
linter's `HAS_ROLE_IN_CAPABILITY_POLICY` rule (static, per file) and a `pg_policies`
assertion in `0004/test.sql` (dynamic, over every policy in the live database, including
ones written years from now).

---

## What is in each migration

| Migration | Contents |
|---|---|
| `0001_bootstrap` | `REVOKE ALL ON SCHEMA public FROM PUBLIC`; schemas `app`/`content`/`runtime`/`export`/`billing`/`ops`; the Supabase-compatible `auth` shim; the four roles with default privileges revoked; domains `app.ulid`, `app.ref`, `app.sha256`, `content.sort_key`, `runtime.survey_token`; `app.gen_ulid`, `app.tg_touch_updated_at`, `app.jwt_claims`, `app.current_user_id`, `app.current_org`; `ops.schema_migrations`; `ops.rls_exemptions`; `ops.tables_without_rls()`; `ops.content_tables_without_draft_trigger()`; `content.tg_draft_only()`; `content.frac_key_at()` ×2 and `content.rebalance_siblings()`; `ops.ensure_event_partitions()` and its `pg_cron` schedule. |
| `0002_registry_types` | Deliverable K's four registries: `app.org_role` + `app.role_rank()`, `runtime.disposition` (+ terminal / redirect / quota predicates), `app.version_status`, `app.compile_state`. Every type's comment names K as the source of truth and records the conflict it resolved. |
| `0003_jobs_queue` | `ops.jobs` per B §10.1 with `jobs_stalled_idx`, plus `enqueue_job` (idempotency-key aware), `claim_job` (`FOR UPDATE SKIP LOCKED`), `heartbeat_job`, `complete_job`, `fail_job` (exponential backoff, capped), `requeue_stalled_jobs`. |
| `0004_tenancy` | P1-01: `app.organizations`, `app.org_members` (+ the deferred "at least one owner" constraint trigger), `app.invitations` (hashed tokens), `app.projects`, `app.surveys`, `app.survey_versions` (separate `status` / `compile_state`, three lifecycle partial unique indexes, `tg_version_guard`), `app.capability_grants`, `app.audit_log` partitioned monthly; RLS helpers `has_role` / `can_see_project` / `can_see_survey` / `has_capability`; per-command RLS policies on all eight tables; the runtime RPC placeholders and their grants; `ops.test_seed_two_orgs()`. |
| `0005_job_ownership_and_readers` | Integration fixes found by wiring `apps/worker` and `apps/studio`: the job transitions (`heartbeat_job`, `complete_job`, `fail_job`) become **worker-scoped**, compare-and-setting on `locked_by` so a stalled worker cannot complete a reassigned job; `claim_job` now **requires** a worker identity; `enqueue_job` returns `(id, created)` and takes `p_delay_ms`; `fail_job` gains `p_retry_after_ms`; `app.get_job(app.ulid)` gives the studio a tenant-scoped, payload-free read of `ops.jobs`; `app.resolve_invitation(bytea)` resolves an invitation by token hash for a caller who is not yet a member. |
| `0006_revoke_public_execute` | `ops.functions_executable_by_public()` — the third catalog assertion — plus a catalog-driven sweep revoking `PUBLIC EXECUTE` across all six schemas, and the one re-grant that needs (`app.gen_ulid` to `authoring`, because it is a column `DEFAULT`). See "`PUBLIC EXECUTE` is not closed by default privileges" above. |
| `0007_content_model` | P1-03, the version-scoped authoring model: `content.nodes` (one table, `node_kind` discriminator, kind-shape CHECK, the partial `ref` index), `content.question_items`, `content.question_cells`, `content.variables` (incl. `variables_export_col_key` and the `vars_derived_expr` **carve-out**), `content.languages`, `content.i18n_strings`, `content.reserved_variable_names` + the trigger B §4.3 asks for; the `content.questions`/`pages`/`blocks` views (`security_invoker = true`); `app.can_see_version` / `app.version_is_draft` and 24 per-command RLS policies; `content.next_sort_key`, `move_node`, `next_item_sort_key`, `move_question_item`, `rebalance_items`, `tree_rows` (one recursive CTE), `clone_version` (copy-on-write, **no reference remapping**); a **redefinition of `content.rebalance_siblings`**, whose 0001 body could never run; and `ops.test_seed_content()`. |

### Deviations from Deliverable B, and why

- **`app.org_role` is K's eight roles with K's ordering**, not B §1's six with reviewer
  above analyst. K wins by rule, and the specific defect matters: B's own generated policy
  tests `has_role('analyst')`, so B's ordering would let a Reviewer — typically an external
  client contact — export response data including open-ends.
- **`app.compile_state` is K's `none / compiling / compiled / failed`**, not B §3's
  `none / queued / compiling / succeeded / failed`. Queue depth is a property of `ops.jobs`,
  not of the version.
- **`runtime.survey_token` is K §5's 26-char lowercase base-36**, not B §3.2's
  `^[0-9A-Za-z]{22}$`. The token lives in a hostname label and DNS is case-insensitive.
- **`app.org_members.project_ids` is `app.ulid[]`, not `uuid[]`.** `app.projects.id` is
  `app.ulid`; a `uuid[]` here could not be compared to it and would defeat the composite-FK
  pattern that keeps the denormalized `org_id` honest. Correspondingly the helper is
  `app.can_see_project(app.ulid)`.
- **`content.rebalance_siblings(p_version, p_parent)` takes the version as well as the
  parent.** Content rows are scoped to a `survey_version_id`, never a `survey_id` (B §0
  ground rule 3); rebalancing by parent alone would rewrite a *frozen* version's sort keys.
- **`ops.rls_exemptions.table_name` holds a qualified `schema.table`.** B §12.1's sketch
  compares bare `relname`, which would let an exemption for `billing.plans` silently exempt
  an `app.plans` added three years later.
- **`app.audit_log` partitions get their own `ENABLE` + `FORCE ROW LEVEL SECURITY`.**
  Policies are not inherited by partitions for direct access, so an unprotected partition is
  a way to read another tenant's audit trail by naming the child table.
- **`content.variables.vars_derived_expr` is the carve-out, not B §4.3's biconditional.**
  B specifies `CHECK ((kind = 'derived') = (expression IS NOT NULL))`, which is
  *unsatisfiable* for **structurally** derived variables: a multi-select's `set<enum>` view
  over its boolean fan-out and an NPS band are derived but have no authorable expression —
  the logic AST has no operator that collects the true members of a fan-out, so the compiler
  synthesizes them. An expression is therefore required only for **authored** derived
  variables, identified by the absence of a source, exactly as `packages/schema` relaxed its
  equivalent rule (SCH-1015). The other direction still holds unconditionally
  (`vars_expr_only_derived`). Without this the *first multi-select save* fails; 0005 §4
  recorded it as a forward note and 0007's `test.sql` inserts the structural case, so
  narrowing the constraint again fails CI rather than production.
- **`content.nodes.nodes_sibling_order_key` is `NULLS NOT DISTINCT`.** `parent_id` is NULL
  for root blocks, so B §4.6's plain `UNIQUE` left root ordering as the one sibling set whose
  order was not total. Every reader queries the set as
  `parent_id IS NOT DISTINCT FROM $1`, so treating NULL as a value matches how it is read.
- **No content `id` column has a `DEFAULT`.** Ids are minted in TypeScript and are stable
  across versions *and* across a variable recompute (P1-02's `variableSignature`), and a
  clone reuses the source id verbatim; a server-side default would quietly replace a stable
  id with a fresh one, and one default could not be right for `question_items` anyway,
  because the prefix differs for options, rows and columns.
- **`content.rebalance_siblings` is redefined in 0007.** 0001's body combined `FOR UPDATE`
  with `row_number()` in one query, which PostgreSQL rejects at execution time, so the
  function raised `feature_not_supported` for every caller that got past its
  `to_regclass` guard — i.e. every caller from P1-03 onward. The sibling set is now locked by
  a separate statement, in `id` order. The two tests this invalidated (0001's
  "raises `undefined_table`" and 0006's "`authoring` cannot execute it") are maintained in
  0001's and 0006's `test.sql`, per the rule above.

### What is stubbed

- `runtime.resolve_token(text)` and `runtime.load_session(app.ulid)` are **placeholders that
  return nothing**. (`app.get_job` and `app.resolve_invitation`, added in 0005, are *not*
  stubs — they are fully implemented and tested.) They exist so ADR-009's grant shape is testable now rather than after
  P1-08. B §2's other four RPCs (`resolve_invite_token`, `start_session`, `submit_page`,
  `flush_quota_counters`) are not created at all — a grant with no consumer is a hole waiting
  for one.
- `content.rebalance_siblings()` was declared in 0001, before `content.nodes` existed, so the
  ordering contract had exactly one implementation from the start. **0007 redefines it** and
  it is live from there on; see the deviation note above for why the original body could
  never have run.
- No `runtime.*` or `export.*` tables exist yet, and no `billing` tables. The
  two `ops.rls_exemptions` rows for `billing.plans` / `billing.plan_features` are pre-seeded
  per B §12.1 and are inert until those tables appear. The `content.*` tables that P1-03 owns
  exist as of 0007; `logic_rules` (P1-06), `flow_nodes` (P2), the `quota_*` set (P1-12),
  `vendors`, `redirects`, `designs`, `code_assets` and `version_theme` arrive with the
  milestones that use them, each with its own RLS block and draft trigger.
- The Deliverable K generator (`packages/schema/src/registries.ts` →
  `generated/registries.sql`) lands in P1-02. Until then `0002_registry_types/up.sql`
  *is* the generated output and must stay byte-compatible with `registries.ts` when it
  appears.
- The `auth` schema is a **shim**: `auth.users(id, email, created_at)` and `auth.uid()`, both
  created only when absent, so the same migrations run on Supabase (where the platform owns
  them) and on a bare PostgreSQL. Nothing in this codebase's policies calls `auth.uid()`;
  they call `app.current_user_id()`, which behaves identically either way.

### Partition maintenance

`ops.ensure_event_partitions(months_ahead)` idempotently premakes monthly partitions for
`app.audit_log` and — once P1-08 creates it — `runtime.response_events` with its 8-way hash
sub-partitions (B §8.1: time on top so retention and archival are `DETACH PARTITION`, hash
on version underneath for export locality). It **skips any parent that does not exist yet**,
so it is callable from 0001 onward.

It is never called lazily at insert time: a respondent's submit must not depend on DDL
succeeding. 0001 registers `cron.schedule('ensure-event-partitions', '0 3 1,15 * *', …)`
**only if `pg_cron` is installed**. Without `pg_cron`, run
`SELECT ops.ensure_event_partitions(3);` twice a month from an external scheduler; three
months of headroom means a missed run is not an incident.

### Replacing the queue with pgmq

Deliverable B §10.1 says the queue is pgmq and `ops.jobs` is the durable, user-visible
record. This implementation puts both in `ops.jobs`, on plain SQL with
`FOR UPDATE SKIP LOCKED`. Three reasons:

1. pgmq is not installable in every environment these migrations must run in (CI
   containers, a developer's local Postgres, a customer's self-hosted cluster). A migration
   suite that cannot run without a third-party extension cannot gate CI — and gating CI is
   the entire point of M0.2.
2. A separate queue and a separate visible record are two rows in two systems that can
   disagree. One row cannot disagree with itself.
3. `SKIP LOCKED` buys the only property pgmq needs to provide at this scale: concurrent
   consumers that do not block each other. Compile/export/projection rates are jobs per
   minute, not per millisecond.

`ops.jobs.queue_msg_id` is kept, nullable and unused, so adopting pgmq later is a code
change and **not a schema migration**: enqueue writes to pgmq and stores the handle,
`claim_job` reads from pgmq instead of the partial index, and every other function is
unchanged.

---

## Adding a table without failing the linter

`tools/ci/lint-migrations.mjs` enforces ten rules and each names the offending object.
For a new table in `app`, `content`, `billing` or `export`, the checklist is:

```sql
-- 0005_widgets/up.sql
SET lock_timeout = '3s';          -- (1) the header, or MISSING_TIMEOUT_HEADER
SET statement_timeout = '120s';

CREATE TABLE app.widgets (
  id         app.ulid PRIMARY KEY DEFAULT app.gen_ulid('wdg'),
  org_id     app.ulid NOT NULL,                       -- (2) ADR-009: org_id on every row
  project_id app.ulid NOT NULL,
  name       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- (3) the composite FK is what keeps the denormalized org_id honest
  FOREIGN KEY (org_id, project_id) REFERENCES app.projects (org_id, id),
  UNIQUE (org_id, id)             -- (4) if anything will reference this row compositely
);
COMMENT ON TABLE app.widgets IS 'why this table exists, citing the deliverable section';

-- (5) BOTH of these, or TABLE_WITHOUT_FORCED_RLS. ENABLE alone leaves the owner exempt.
ALTER TABLE app.widgets ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.widgets FORCE  ROW LEVEL SECURITY;

-- (6) one policy per command, never FOR ALL, and WITH CHECK on every write
CREATE POLICY widgets_select ON app.widgets FOR SELECT TO authoring
USING (org_id = app.current_org() AND app.has_role('client')
       AND app.can_see_project(project_id));
CREATE POLICY widgets_insert ON app.widgets FOR INSERT TO authoring
WITH CHECK (org_id = app.current_org() AND app.has_role('programmer')
            AND app.can_see_project(project_id));
CREATE POLICY widgets_update ON app.widgets FOR UPDATE TO authoring
USING      (org_id = app.current_org() AND app.has_role('programmer'))
WITH CHECK (org_id = app.current_org() AND app.has_role('programmer'));
CREATE POLICY widgets_delete ON app.widgets FOR DELETE TO authoring
USING (org_id = app.current_org() AND app.has_role('admin'));

-- (7) new tables need an explicit GRANT: ALTER DEFAULT PRIVILEGES covers the migration
--     runner's future objects, but be explicit rather than relying on it.
GRANT SELECT, INSERT, UPDATE, DELETE ON app.widgets TO authoring;

CREATE TRIGGER widgets_touch BEFORE UPDATE ON app.widgets
  FOR EACH ROW EXECUTE FUNCTION app.tg_touch_updated_at();
```

If the migration also adds a **function**, remember (8) `REVOKE EXECUTE … FROM PUBLIC` then
`GRANT` to the named role — default privileges do not do this for you, and
`ops.functions_executable_by_public()` will name your function if you forget.

For a table in **`content`**, add the immutability trigger too, or
`CONTENT_TABLE_WITHOUT_DRAFT_TRIGGER` fires:

```sql
CREATE TRIGGER widgets_draft_only
  BEFORE INSERT OR UPDATE OR DELETE ON content.widgets
  FOR EACH ROW EXECUTE FUNCTION content.tg_draft_only();
```

…and scope the row to `survey_version_id`, not `survey_id` (B §0 ground rule 3).

Then `db/migrations/0005_widgets/test.sql`:

```sql
BEGIN;
SELECT plan(5);
SELECT set_config('rs.ids', ops.test_seed_two_orgs()::text, true);
SELECT has_table('app', 'widgets', 'app.widgets exists');
-- the three catalog assertions, on every migration, forever
SELECT is_empty($$ SELECT ops.tables_without_rls() $$, 'RLS forced everywhere');
SELECT is_empty($$ SELECT ops.content_tables_without_draft_trigger() $$, 'draft trigger everywhere');
SELECT is_empty($$ SELECT ops.functions_executable_by_public() $$, 'nothing PUBLIC-executable');
-- and at least one cross-tenant assertion for the new table
SELECT is_empty($$ SELECT 1 FROM app.widgets WHERE org_id <> app.current_org() $$,
  'no cross-tenant read of app.widgets');
SELECT * FROM finish();
ROLLBACK;
```

### Things the linter will reject

| Code | Trigger |
|---|---|
| `MISSING_UP_SQL` | a migration directory with no `up.sql` |
| `MISSING_TEST_SQL` | a migration directory with no `test.sql` |
| `EMPTY_TEST_SQL` | a `test.sql` with zero assertions |
| `MISSING_TIMEOUT_HEADER` | `up.sql` without `SET lock_timeout` / `SET statement_timeout` |
| `TABLE_WITHOUT_FORCED_RLS` | a new table in `app`/`content`/`billing`/`export` missing `ENABLE` **or** `FORCE ROW LEVEL SECURITY` |
| `CONTENT_TABLE_WITHOUT_DRAFT_TRIGGER` | a new `content` table with no `content.tg_draft_only` trigger |
| `IN_PLACE_RENAME` | `ALTER TABLE … RENAME` |
| `IN_PLACE_TYPE_CHANGE` | `ALTER TABLE … ALTER COLUMN … TYPE` |
| `VOLATILE_DEFAULT` | `ADD COLUMN … DEFAULT` with `random()`, `gen_random_uuid()`, `clock_timestamp()`, `nextval()`, `now()`, `CURRENT_TIMESTAMP`, … |
| `HAS_ROLE_IN_CAPABILITY_POLICY` | a policy that mentions `pii_access` or `custom_code` and calls `app.has_role()` |

### The one rule that can be exempted in writing

`ops.rls_exemptions` has always had two axes, and `exempt_draft_trigger` exists for exactly
one table: `content.reserved_variable_names`, Deliverable K §6's global reserved namespace. It
lives in schema `content` and has no `survey_version_id`, so `content.tg_draft_only` has
nothing to read and would raise `feature_not_supported` on every write.
`ops.content_tables_without_draft_trigger()` reads that row and is satisfied — but the linter
runs before any database exists and cannot. So the exemption is restated in a form static
analysis can see, in `up.sql`:

```sql
-- lint:exempt CONTENT_TABLE_WITHOUT_DRAFT_TRIGGER content.reserved_variable_names
--   Deliverable K §6 global reference data: no survey_version_id for tg_draft_only to read.
--   Matched by the ops.rls_exemptions row below, which exempts the trigger and NOT RLS.
```

The rule code and the qualified object are both required, and so is a reason of at least 12
characters — the same minimum `ops.rls_exemptions.reason` carries, so an exemption is a
code-review conversation in both halves of the net. A directive that names any **other** rule,
or carries no reason, is ignored and the original rule fires: `CONTENT_TABLE_WITHOUT_DRAFT_TRIGGER`
is the only exemptible code. `TABLE_WITHOUT_FORCED_RLS` deliberately is not, even though
`ops.rls_exemptions.exempt_rls` exists — its only two rows are the global `billing` tables,
which do not exist yet, and when they arrive that CI failure is a conversation worth having in
review rather than one a comment can end.

Note the linter is static and per-file; the *catalog* assertions in `test.sql`
(`tables_without_rls`, `content_tables_without_draft_trigger`,
`functions_executable_by_public`) are the runtime half of the same net. The linter names the
file and runs before any database exists; the assertions catch what static analysis cannot
see — a table created inside a `DO` block, a privilege granted three migrations later, a
`PUBLIC EXECUTE` that no statement in any migration ever granted.

The linter strips comments and dollar-quoted function bodies before matching, so prose about
banned constructs (this file's neighbours are full of it) does not trip a rule, and
`EXECUTE format('ALTER TABLE %I …')` inside a maintenance function is not DDL. String
literals are stripped for the structural rules and preserved for the capability rule, which
needs to see `'pii_access'`.

`node tools/ci/lint-migrations.mjs` lints the real tree **and** self-tests against
`db/migrations/__lintfixtures__/`, which contains one deliberately-broken migration per
rule with an `expect.json` naming the code and the object it must name. A rule with no
fixture fails the self-test — see that directory's README.

### Adding an RLS exemption

Rarely correct, and never silent:

```sql
INSERT INTO ops.rls_exemptions (table_name, reason, exempt_rls) VALUES
  ('billing.plans',
   'Global plan catalogue, identical for every tenant and readable by all of them; there '
   'is no org_id to filter on. B §12.1.', true);
```

`reason` is `NOT NULL` with a minimum length, and `table_name` must be schema-qualified, so
an exemption is a code-review conversation rather than a one-word commit.
`exempt_draft_trigger` is a separate flag: `content.reserved_variable_names` (P1-03) is
global reference data that needs no draft trigger but still needs RLS.
