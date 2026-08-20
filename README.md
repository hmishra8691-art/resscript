# ResScript

An enterprise survey programming and execution platform. A professional IDE for survey
programming, not a form builder.

The architecture is designed before the code, and the design is the authority: see the
`architecture/` docs in the ResScript project (`00-decisions-adr.md` first). Every
non-obvious choice in this repository cites the ADR or deliverable section it comes from.

**Status: Milestone 0 and milestones P1-01 / P1-02 of Phase 1.** Nothing is deployed. What
exists is the foundation, the tenancy layer, and the canonical survey model — plus the CI
guard rails that protect the decisions the rest of Phase 1 depends on.

---

## Quick start

```bash
pnpm install

# Postgres 16 with pgTAP. Any 16.x with the pgtap extension available.
docker run -d --name rspg -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:16
export DATABASE_URL=postgres://postgres:postgres@localhost:5432/resscript

pnpm db:reset && pnpm db:up && pnpm db:test   # migrations + the pgTAP suite
pnpm verify                                    # graph rules, migration lint, typecheck, tests
```

`pnpm verify` is what CI runs. If it is green, the guard rails below hold.

---

## Layout

```
packages/
  schema/         canonical survey model, variable derivation, JSON Schema   [P1-02 — built]
  observability/  logging, tracing, metrics facade, error envelope           [M0.4  — built]
  logic/          AST, three-valued semantics, type checker, evaluator       [P1-06]
  rescript-dsl/   lexer, parser, resolver, pretty-printer                    [P1-07]
  question-kit/   the QuestionTypePlugin contract, registry, test kit        [P1-04]
  compiler/       authoring model -> immutable artifact + the static gate    [P1-08]
  runtime-core/   page state machine, seeded PRNG, piping, validation        [P1-09]
  design/         MaxDiff and conjoint design generation                     [P4-01]
apps/
  studio/         Next.js control plane: auth, orgs, projects, surveys       [P1-01 — built]
  runtime/        respondent-facing data plane (health/ready only so far)    [P1-09]
  worker/         queue consumer harness, job lifecycle, progress            [M0.4  — built]
db/migrations/    forward-only SQL + a pgTAP test.sql per migration
tools/migrate/    the migration CLI
tools/ci/         the migration linter and the graph-rule self-test
```

Unbuilt packages carry a placeholder `index.ts` naming the milestone that fills them, because
`tsc -b` treats a composite project with no input files as an error and would break the whole
workspace build.

---

## The guard rails, and why each one exists

These are the point of Milestone 0. Each protects a decision that is cheap to enforce now and
ruinously expensive to retrofit. Each is verified by a **deliberate violation** that must
fail — a rule that never fires satisfies the linter perfectly while protecting nothing.

| Guard | Protects | Verified by |
|---|---|---|
| `packages/logic` has zero dependencies and no Node builtins | ADR-004: the identical evaluator must run in Node, a browser, a worker and QuickJS-WASM. Divergence here means a survey behaves differently in preview than in field. | `pnpm lint:graph:test` |
| `apps/runtime` cannot link a Supabase client or import `apps/studio` | ADR-001: the data plane must not reach an authoring table. This is the boundary that keeps fieldwork alive during a control-plane outage. | `pnpm lint:graph:test` |
| `packages/schema` cannot depend on `question-kit` | ADR-010: the canonical model and the plugin contract must be versionable independently. | `pnpm lint:graph:test` |
| No table in `app`/`content`/`billing`/`export` without `ENABLE` **and** `FORCE ROW LEVEL SECURITY` | ADR-009: tenant isolation is not something you assert once in a design doc. | `pnpm lint:migrations` (11 fixtures) |
| No `ALTER TABLE ... RENAME`, no volatile defaults, no migration without assertions | Expand/contract only, so migrations can apply before the code that uses them. | `pnpm lint:migrations` |
| No function executable by `PUBLIC` | Migration 0006. `ALTER DEFAULT PRIVILEGES ... REVOKE ALL ON FUNCTIONS FROM PUBLIC` is a **no-op on PG16** — new functions keep `proacl = NULL`, whose default for a function is `EXECUTE TO PUBLIC`. 17 functions were world-executable, two of them `SECURITY DEFINER` writers that bypass RLS. | `ops.functions_executable_by_public()`, asserted empty |
| Cross-tenant reads return **zero rows**, not an error | ADR-009. Forging `active_org_id` in a JWT must yield nothing. | the pgTAP suite |
| No `Math.random` in the runtime | ADR-006: every random decision is `f(seed, salt)`, so a session can be replayed exactly for QA. | ESLint rule (lands with P1-09) |

---

## Four bugs the tests caught, worth knowing about

Recorded because each is a class of mistake that will recur, and because they are the
argument for why the guard rails above are not ceremony.

**1. A rule that protected nothing.** `runtime-no-supabase` matched `node_modules/@supabase`.
But `@supabase/supabase-js` is not a dependency of `apps/runtime` — that is the entire point —
so the import does not resolve and never has a path under `node_modules`. A deliberate
violation passed CI. Rules matched on resolved paths are blind to exactly the dependency they
forbid. Fixed by matching the bare specifier, and by `no-unresolvable` as a general net.

**2. A stolen job claim.** `complete_job` guarded on `status = 'running'` alone. Worker A
claims, stalls, the sweeper requeues, worker B claims — and A wakes up and completes the job
with a stale result, because the guard passes while B is running it. The job reports success
with output from an aborted attempt. Nothing in the status alone can detect this. Migration
0005 scopes every transition to `locked_by`, and 0005's test asserts it: reverting the guard
fails six assertions.

**3. Contract tests that agreed with the bug.** `PgJobStore`'s SQL was pinned by 24 tests
against a recording client, all green, while every real call failed with `malformed array
literal` — the bind order was transposed relative to the function's declaration. A recording
client proves the code is self-consistent; it cannot prove it agrees with the database. The
integration tests that would have caught it were **skipping**, because `DATABASE_URL` was
unset. CI now runs a live Postgres and fails if those tests skip.

**4. Test isolation masquerading as a logic bug.** `ops.claim_job` hands out the oldest due
job of a kind. Integration tests sharing the kind `noop` got each other's rows, and the
failure read as a bug in claim ordering. Every test now uses a unique kind.

---

## Conventions

- **TypeScript is strict**, including `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`
  and `verbatimModuleSyntax`. Fix the code, not the config.
- **Comments explain the *why*.** This codebase is the design in executable form; a reader
  should be able to reconstruct the reasoning without the docs.
- **Exhaustive `switch` with a `never` guard** over `default`, so adding a node kind is a
  compile error everywhere it matters rather than silent fallthrough.
- **Migrations are forward-only**, one directory per migration, `up.sql` + `test.sql`. A
  later migration that changes an earlier one's objects must update the earlier `test.sql` —
  see `db/README.md`, which states the convention and its two corollaries.
- **Roles, dispositions, statuses and the survey-token alphabet come from one place**
  (`packages/schema/src/registries.ts`, mirrored into SQL). Deliverable K exists because
  three of those were independently defined in two documents and disagreed — including a role
  ordering that would have let external client Reviewers export open-ends.

---

## What is deliberately stubbed

- `apps/runtime` serves `/health` and `/ready` only. The artifact loader, state machine and
  submit path are P1-09 and P1-10.
- `runtime.resolve_token` and `runtime.load_session` return nothing — placeholders so
  ADR-009's grant shape is testable before the runtime exists.
- Idempotency keys in studio are process-local. Correct on one instance, insufficient for a
  fleet; one class to swap when `app.idempotency_keys` lands.
- The queue is plain SQL with `FOR UPDATE SKIP LOCKED`, not pgmq. `queue_msg_id` is retained
  so adopting pgmq is a code change, not a migration.
- Deploy steps in `.github/workflows/ci.yml` are `TODO(M0.3)` — the release *ordering* is
  wired and enforced, the hosting provider is not.
- No `content.*` tables yet (P1-03). The `tg_draft_only` trigger and both catalog assertions
  already exist, so P1-03 cannot forget them.

## Known gaps to close in P1-03

- `content.variables` must ship the `vars_derived_expr` carve-out:
  `CHECK (kind <> 'derived' OR expression IS NOT NULL OR source IS NOT NULL)`. Deliverable B's
  stricter form is unsatisfiable for *structurally* derived variables — a multi-select's
  `set<enum>` view and an NPS band are derived but have no authorable expression. Recorded in
  migration 0005 as a comment, which enforces nothing; the first multi-select save will fail
  without it.
- `app.ref`'s pattern rejects the numeric option refs used in Deliverable C §5.1's example
  (`"ref": "1"`). The DDL is right and the doc example is wrong; worth correcting the doc.
