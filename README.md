# ResScript

An enterprise survey programming and execution platform. A professional IDE for survey
programming, not a form builder.

The architecture is designed before the code, and the design is the authority: see the
`architecture/` docs in the ResScript project (`00-decisions-adr.md` first). Every
non-obvious choice in this repository cites the ADR or deliverable section it comes from.

**Status: Milestone 0 and milestones P1-01 … P1-04, P1-06, P1-07 of Phase 1.** Nothing is
deployed. What exists is the foundation, the tenancy layer, the canonical survey model, the
content model, the question-plugin contract, the logic engine and the ResScript DSL with its
code editor — plus the CI guard rails that protect the decisions the rest of Phase 1 depends on.

`pnpm verify` is green: 2,195 unit tests, 597 pgTAP assertions across 8 migrations, 6 import-graph
negative controls and 11 migration-linter fixtures all rejecting as designed.

**Read the self-test output, not just the exit code.** `pnpm lint:graph:test` must say
`6 rule(s), all fired as expected`. If it reports fewer rules firing on a checkout whose code is
unchanged, suspect the install layout before the rules: this repository's `.npmrc` pins
`node-linker=isolated` precisely because a hoisted or partially-npm-installed `node_modules`
changes what resolves from where, and bug #5 below is that failure twice over. Delete
`node_modules`, delete any stray lockfile or `node_modules` in a *parent* directory, and
`pnpm install` again before debugging the config.

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
  logic/          AST, three-valued semantics, type checker, evaluator       [P1-06 — built]
  logic-parity/   differential test: Node vs QuickJS-WASM, same verdicts     [P1-06 — built]
  question-kit/   the QuestionTypePlugin contract, registry, test kit        [P1-04 — built]
  rescript-dsl/   lexer, parser, resolver, pretty-printer                    [P1-07 — built]
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
| Every `AST_KINDS` entry has a parser production **and** a printer | D §7.2's three-way closure. ADR-003's round trip holds only while the language is closed; a kind with no printer is a rule the code pane silently deletes. The renderer leg lands with P1-12. | `packages/rescript-dsl` closure test (58 kinds × 2 legs) |
| The Monarch keyword list is exactly the lexer's | UI §7.4: colouring is never authority, but a keyword nobody coloured looks like a typo to the author. Derived from `@resscript/rescript-dsl`, not retyped, and negative-controlled. | `apps/studio` keyword-parity test |
| The parser never throws, on any input | D §6.4 P8. Monaco calls it on every keystroke, forever, on syntactically invalid text. A parser that throws is a broken editor, not a failed parse. | P8 property test under single-character mutation |

---

## Five bugs the tests caught, worth knowing about

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

**5. Guard rails that were a function of install history.** The same commit produced
`6 rule(s), all fired as expected` on one machine and `2 failure(s)` on another. Cause:
`options.exclude` listed `node_modules`, which *deletes* a dependency from the graph rather
than merely declining to follow it. So `logic-is-dependency-free` and `runtime-no-supabase`
silently depended on `fast-check` and `@supabase/supabase-js` **not being installed** — the
import resolved under `node_modules`, the dependency vanished, and the rule reported nothing.
An accidental `npm install` (npm hoists every transitive package to the root, where pnpm's
per-package layout would not have made `fast-check` reachable from `packages/logic`) was
enough to disable two ADR guard rails without a single line of the config changing. This is
bug #1 a second time, in a new disguise; `exclude` no longer mentions `node_modules`, and
`doNotFollow` — which keeps the dependency in the graph — does the work it always should have.
Verified by running the negative-control suite under a deliberately flattened `node_modules`.

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
- The static-analysis suite from D §8 (forward-reference dominance, unreachable content, the
  abstract-domain solver, quota analyses) is P1-08, not P1-06: it needs `graph.json`, which the
  compiler owns. The diagnostic codes are in the catalogue; only `W021` and a solver-free subset
  of `W030` are implemented.
- No browser leg of the logic parity test — Playwright browsers are not installed here, and a
  silently-skipped test protects nothing. QuickJS-WASM (a from-scratch interpreter) is the more
  valuable of the two legs and is wired; the browser leg is cheap to add onto P1-01's harness.
- `ConfigMigration` in question-kit is type-only. No checker is implemented because none of the
  three shipped plugins has a migration, and an unexercised code path claiming to enforce
  F §5.1 is worse than an honest gap. P1-05.

## Open decisions someone must make

Surfaced by P1-03/P1-04/P1-06 and *not* resolvable inside a milestone, because each is a
cross-document conflict where both sides are defensible. Recorded here rather than settled
quietly in code.

- **`Q5r3_band` is unnameable.** Schema §4's `VariablePart` has `{kind:'suffix'}` producing
  `{ref}_{suffix}`, so a companion variable inside a cell scope would have to be `Q5_r3_band` —
  which is not the cell's namespace. Consequence: **composition and companion variables are
  mutually exclusive**, and `nps` therefore ships `composable: false`. Fixing it properly needs
  a composite (row + suffix) part in schema §4.
- **`enumDomain[].code` collides with schema's numeric `EnumDomainEntry.code`.** A
  `value_override` legitimately produces a string code, which cannot be stored. Currently
  reported as `enum_code_not_numeric` rather than coerced (`Number('BRAND_C')` is `NaN`;
  `Number('07')` is `7`). Either schema's domain widens to `number | string` or `value_override`
  is barred from enum domains — as it stands this is publish-blocking for legacy tracker layouts.
- **D §5.3's propagation algorithm contradicts its own performance claim.** It seeds `triggers[v]`
  — defined in §5.2 as the full transitive closure — then claims "propagation stops at the first
  frontier … typical measured frontier 3–12 cells". Both cannot hold. Implemented by seeding the
  changed variable's own cell; measured 2 cells touched on a pruned change instead of the whole
  downstream closure.
- **F §8 contradicts itself on checkbox groups**: one tab stop with a roving tabindex, *and* the
  APG checkbox pattern, which puts every checkbox in the tab order. The roving tabindex is
  implemented (right call for a 200-item list) but an a11y reviewer should sign off before an
  external audit.
- **`visible` base semantics are underspecified.** D §4.6 says "AND(all show-rule verdicts
  default-true)" without saying what happens to a node that *has* a show rule. Read literally,
  `IF x THEN SHOW Q12` shows Q12 unconditionally and a show rule can never hide anything.
  Implemented as: a `show` rule flips the base to hidden unless the schema says otherwise.
- **Division by zero is unspecified.** D §2.2 forbids NaN/Inf in a `VarState`; §2.5 is silent on
  `SPEND / TRIPS` with `TRIPS = 0`, which is respondent-reachable. Chose `null` — throwing would
  take a live survey down over ordinary missing data.
- **`app.ref`'s pattern rejects the numeric option refs in Deliverable C §5.1's example**
  (`"ref": "1"`). The DDL is right and the doc example is wrong; worth correcting the doc.

P1-07 added twenty-one more, listed in full in `packages/rescript-dsl/README.md` and at each
implementation site. The ones that block later milestones or change a stored contract:

- **The DSL has three comment markers because the docs specify two different ones.** D §6.2
  declares `--` and `/* */`; UI §7.4 registers `lineComment: '#'`. All three lex and the author's
  marker is preserved verbatim, because rewriting it would break T2. Honouring only one breaks
  either `⌘/` in the studio or every example in D §6.3. Someone should pick.
- **T2 contradicts itself on parentheses.** It permits the printer to drop redundant parentheses
  *and* requires `paren_hints` to preserve the ones the author wrote. Author parens win, so P3
  (source normalization) deliberately does not re-parenthesize.
- **`FLAG <ident>` has no effect kind.** D §6.3 uses it; D §4.2's `Effect` union has no `flag`.
  Parsed as a writable boolean variable; the compiler must desugar it to `set_variable = TRUE`
  or the union must grow an arm.
- **`on_unknown` has no counterpart in `packages/schema`'s `LogicRule`.** So `IF … ON UNKNOWN
  SHOW` parses, prints and round-trips in the DSL but cannot be persisted. Migration 0008
  deliberately did *not* add a column nothing writes; whichever half lands first should name the
  other. **Publish-blocking for any survey using the construct.**
- **Deliverable C §7's `{type:'survey'}` rule target cannot be stored under B §4.4's
  `rules_one_target` CHECK**, which requires exactly one of three ids to be non-NULL — and a
  survey-scoped `TERMINATE` has none. Migration 0008 resolves it with `content.rule_target_kind`
  and three biconditionals, which also pins which id belongs to which kind. B §4.4's CHECK as
  written rejects the first screener rule anyone writes.
- **Rule source text is not stored, by decision.** `trivia` is a column (D §6.4: trivia rides on
  the statement, not inside the expression tree) and the text is recovered by `print(ast, trivia)`.
  A stored source string embeds `ref`s while the AST embeds ids, so it and C §3's rename guarantee
  cannot both hold.
- **Enum domain identity has no column.** `content.variables.enum_domain` is a per-variable copy,
  so the resolver synthesizes a nominal domain id per emitting question. Two questions built from
  one shared option template therefore get two domains, and a legitimate cross-question mask
  reports `LGC-T021`. Not papered over with a codes-match heuristic, which would admit exactly the
  comparison the check exists to reject.
- **`EnumDomain.ordinal` still has no source** (D §11 note 2), so `Q9 > 3` on a Likert scale is
  `LGC-T009` until a plugin declares ordinality. Safe direction, real false positive.
- **Nothing mounts the code pane yet.** The editor, its adapters and both `/v1/dsl/*` routes are
  built and tested; the version-editor shell route that would host them is P1-12. Flagged rather
  than wired to fake data.
