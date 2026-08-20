-- DELIBERATELY BAD. See db/migrations/__lintfixtures__/README.md.
SET lock_timeout = '3s';
SET statement_timeout = '60s';

CREATE TABLE content.fixture_nodes (
  id                app.ulid PRIMARY KEY,
  org_id            app.ulid NOT NULL,
  survey_version_id app.ulid NOT NULL,
  label             text
);
ALTER TABLE content.fixture_nodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE content.fixture_nodes FORCE  ROW LEVEL SECURITY;
-- RLS is correct and the ADR-002 immutability trigger is missing, so a published survey
-- is editable under live respondents through this table.
