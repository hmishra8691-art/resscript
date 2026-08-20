-- DELIBERATELY BAD. See db/migrations/__lintfixtures__/README.md.
SET lock_timeout = '3s';
SET statement_timeout = '60s';

CREATE TABLE billing.fixture_half_locked (
  org_id app.ulid PRIMARY KEY,
  plan   text NOT NULL
);
-- ENABLE without FORCE: the table owner, which every migration runs as, stays exempt
-- from its own policies. The isolation suite passes; production leaks.
ALTER TABLE billing.fixture_half_locked ENABLE ROW LEVEL SECURITY;
