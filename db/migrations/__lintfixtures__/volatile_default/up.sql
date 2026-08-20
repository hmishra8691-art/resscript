-- DELIBERATELY BAD. See db/migrations/__lintfixtures__/README.md.
SET lock_timeout = '3s';
SET statement_timeout = '60s';

ALTER TABLE app.projects ADD COLUMN external_ref uuid NOT NULL DEFAULT gen_random_uuid();
