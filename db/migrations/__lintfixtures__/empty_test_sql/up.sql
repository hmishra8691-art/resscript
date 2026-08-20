-- DELIBERATELY BAD. See db/migrations/__lintfixtures__/README.md.
SET lock_timeout = '3s';
SET statement_timeout = '60s';

CREATE TABLE ops.fixture_gauges (id int PRIMARY KEY);
