-- DELIBERATELY BAD. See db/migrations/__lintfixtures__/README.md.
SET lock_timeout = '3s';
SET statement_timeout = '60s';

-- Deliverable K §1's live defect, written out. This policy governs PII in exports and
-- checks it BY RANK. app.role_rank('project_manager') is 50 and app.role_rank('analyst')
-- is 30, so every Project Manager in the org silently acquires PII access to open-ended
-- verbatims — which K §1 says explicitly must not happen: "a Project Manager outranks an
-- Analyst but does not inherit this."
--
-- The correct form is app.has_capability('pii_access', project_id), which reads
-- app.capability_grants and the org-level setting and contains no has_role() call at all.
CREATE TABLE export.fixture_pii_columns (
  id         app.ulid PRIMARY KEY,
  org_id     app.ulid NOT NULL,
  project_id app.ulid,
  capability text NOT NULL
);
ALTER TABLE export.fixture_pii_columns ENABLE ROW LEVEL SECURITY;
ALTER TABLE export.fixture_pii_columns FORCE  ROW LEVEL SECURITY;

CREATE POLICY fixture_pii_read ON export.fixture_pii_columns FOR SELECT TO authoring
USING (org_id = app.current_org()
       AND capability = 'pii_access'
       AND app.has_role('analyst'));
