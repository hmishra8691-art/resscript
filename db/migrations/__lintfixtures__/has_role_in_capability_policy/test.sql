-- A passing stand-in so the fixture exercises exactly one rule.
BEGIN;
SELECT plan(1);
SELECT ok(true, 'placeholder assertion');
SELECT * FROM finish();
ROLLBACK;
