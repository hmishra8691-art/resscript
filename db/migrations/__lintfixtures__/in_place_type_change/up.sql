-- DELIBERATELY BAD. See db/migrations/__lintfixtures__/README.md.
SET lock_timeout = '3s';
SET statement_timeout = '60s';

ALTER TABLE app.survey_versions ALTER COLUMN notes TYPE varchar(200);
