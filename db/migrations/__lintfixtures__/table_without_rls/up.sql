-- DELIBERATELY BAD. See db/migrations/__lintfixtures__/README.md.
SET lock_timeout = '3s';
SET statement_timeout = '60s';

-- No ENABLE, no FORCE. ops.tables_without_rls() would also catch this, but only
-- after somebody applied it to a database.
CREATE TABLE app.fixture_leaky (
  id     app.ulid PRIMARY KEY,
  org_id app.ulid NOT NULL,
  name   text NOT NULL
);
