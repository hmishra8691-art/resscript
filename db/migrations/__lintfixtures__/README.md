# `__lintfixtures__` — deliberately broken migrations

Every file under this directory is **wrong on purpose**. None of it is ever applied to a
database.

## Why it exists

`tools/ci/lint-migrations.mjs` enforces Deliverable B §14 and roadmap M0.2's acceptance
criteria. A lint rule with no fixture is a rule nobody has ever seen fire — it can be
silently broken by a refactor of the scrubber or a regex, and the failure mode is that CI
goes quiet rather than loud. So each rule owns a fixture here, and the linter's
`--self-test` mode asserts that linting that fixture produces **exactly** the expected
error code, and that the message **names the offending object** (an explicit M0.2
requirement: "each failure names the offending object").

## Why it cannot be applied

Two independent guards, because being wrong about this means running broken DDL:

1. `tools/migrate/cli.mjs` only recognises directories matching `NNNN_snake_case`.
   `__lintfixtures__` does not match, and neither do the fixture subdirectories inside it.
2. `tools/ci/lint-migrations.mjs` filters real migrations through the same pattern, so the
   fixtures are never reported as violations of the real tree.

## The fixtures

| Directory | Rule it proves | The defect it stands in for |
|---|---|---|
| `no_up_sql` | `MISSING_UP_SQL` | Forward-only means `up.sql` is the only script there is. |
| `no_test_sql` | `MISSING_TEST_SQL` | A migration that opted out of ADR-009's cross-tenant assertions. |
| `empty_test_sql` | `EMPTY_TEST_SQL` | A file that reads as coverage and asserts nothing. |
| `missing_timeout_header` | `MISSING_TIMEOUT_HEADER` | DDL that can queue behind a long read and stall the runtime. |
| `table_without_rls` | `TABLE_WITHOUT_FORCED_RLS` | A new tenant table with no RLS at all: a cross-tenant read. |
| `table_enabled_but_not_forced` | `TABLE_WITHOUT_FORCED_RLS` | The subtler half — `ENABLE` without `FORCE` leaves the table owner exempt from its own policies, so the isolation suite passes while production leaks. |
| `content_table_without_draft_trigger` | `CONTENT_TABLE_WITHOUT_DRAFT_TRIGGER` | A `content` table through which a published survey can be edited under live respondents (ADR-002). |
| `in_place_rename` | `IN_PLACE_RENAME` | Instantaneous in the database, an outage in the deploy: the previous app version is still writing the old name. |
| `in_place_type_change` | `IN_PLACE_TYPE_CHANGE` | Full rewrite under `ACCESS EXCLUSIVE`, and a shape change under a running serializer. |
| `volatile_default` | `VOLATILE_DEFAULT` | `ADD COLUMN … DEFAULT gen_random_uuid()` rewrites the whole table. |
| `has_role_in_capability_policy` | `HAS_ROLE_IN_CAPABILITY_POLICY` | Deliverable K §1's live defect: PII-in-exports checked by rank, so every Project Manager (rank 50) silently outranks the Analyst floor (30) and acquires access to open-ended verbatims. |

## Adding a fixture

1. Create `__lintfixtures__/<name>/up.sql` containing the single violation and nothing else
   that would trip another rule (in practice: keep the timeout header, and add a
   `test.sql` with one `ok(true, …)`).
2. Add `expect.json`:

```json
{
  "codes": ["THE_ERROR_CODE"],
  "object": "schema.table_or_other_named_object",
  "why": "one sentence on the production failure this rule prevents"
}
```

3. Add the rule's code to the `implemented` list in `tools/ci/lint-migrations.mjs`. The
   self-test fails if any listed rule has no fixture, so the two cannot drift apart.
