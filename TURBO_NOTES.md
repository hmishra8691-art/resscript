# turbo.json notes

turbo.json rejects unknown keys, so this cannot live as a comment in the file itself.

## `tasks.test.env: ["DATABASE_URL"]`

Turbo does not pass an environment variable to a task unless the task declares it. Without
this line, `pnpm verify` reported `102 passed | 5 skipped` with a live Postgres sitting right
there: the worker's `PgJobStore` integration tests skip themselves when `DATABASE_URL` is
unset, and Turbo had stripped it.

That mattered concretely. Those five tests are the only thing that proves `PgJobStore`'s SQL
agrees with the actual function signatures in `db/migrations`. While they were skipping, 24
contract tests against a recording client were green and every real call failed with
`malformed array literal` — the bind order was transposed. A skipped test is a test that
cannot fail.

Declaring it also puts it in the cache key, which is correct: a cached result from a run with
no database must not be reused for a run that has one.

## `globalEnv`

`NODE_ENV` and `CI` change behaviour in nearly every task, so they belong in the global key
rather than being repeated per task.
