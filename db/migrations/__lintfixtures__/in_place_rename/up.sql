-- DELIBERATELY BAD. See db/migrations/__lintfixtures__/README.md.
SET lock_timeout = '3s';
SET statement_timeout = '60s';

-- Instantaneous in the database, an outage in the deploy: the previous application
-- version is still running and still writing the old name.
ALTER TABLE app.projects RENAME COLUMN client_name TO customer_name;
