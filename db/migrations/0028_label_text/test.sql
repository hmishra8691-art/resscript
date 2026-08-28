-- 0028_label_text — tests.
--
-- The behaviours that matter, in order of how badly getting them wrong would hurt:
--
--   1. one call leaves BOTH a key on the row and a string in the base bundle — the pair whose
--      separation is the entire bug;
--   2. editing the label again REUSES the key, because a key that moved would orphan every
--      translation of it;
--   3. a key-shaped value already on the row is reused whoever set it (an API consumer manages its
--      own keys and this function must not renumber them);
--   4. PROSE already on the row — which is what the studio has been writing — is replaced, or the
--      dangling reference survives the fix;
--   5. a version with no base language is refused rather than defaulted to `en`, because
--      defaulting is what made the compiler report a bundle that did not exist;
--   6. a frozen version is still refused, i.e. `tg_draft_only` still applies — the function is
--      SECURITY INVOKER precisely so that stays true.

BEGIN;
SELECT plan(15);

GRANT USAGE ON SCHEMA public TO authoring, runtime_writer, analytics_reader, runtime_rpc_owner;

SELECT set_config('rs.ids', ops.test_seed_content(ops.test_seed_two_orgs())::text, true);
CREATE FUNCTION pg_temp.tid(k text) RETURNS text LANGUAGE sql STABLE AS
$$ SELECT current_setting('rs.ids', true)::jsonb ->> k $$;

-- The content draft from the standard fixture: it has nodes, items and both languages.
CREATE FUNCTION pg_temp.ver() RETURNS app.ulid LANGUAGE sql STABLE AS
$$ SELECT (current_setting('rs.ids', true)::jsonb ->> 'ver_a_content_draft')::app.ulid $$;
CREATE FUNCTION pg_temp.q1() RETURNS app.ulid LANGUAGE sql STABLE AS
$$ SELECT (current_setting('rs.ids', true)::jsonb ->> 'q1_a')::app.ulid $$;
CREATE FUNCTION pg_temp.opt1() RETURNS app.ulid LANGUAGE sql STABLE AS
$$ SELECT (current_setting('rs.ids', true)::jsonb ->> 'opt_a_first')::app.ulid $$;

/* ---------------------------------------------------------------- *
 * Structure
 * ---------------------------------------------------------------- */

SELECT has_function('content', 'set_node_label',
  ARRAY['app.ulid', 'app.ulid', 'text', 'text'], 'content.set_node_label exists');
SELECT has_function('content', 'set_item_label',
  ARRAY['app.ulid', 'app.ulid', 'text'], 'content.set_item_label exists');

SELECT ok(
  NOT (SELECT prosecdef FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'content' AND p.proname = 'set_node_label'),
  'set_node_label is SECURITY INVOKER: the point is atomicity, not privilege, so the caller''s RLS '
  'and content.tg_draft_only must both still apply');

/* ---------------------------------------------------------------- *
 * The pair: a key on the row AND a string in the bundle
 * ---------------------------------------------------------------- */

-- The fixture's key is `q.s1.label`, which IS key-shaped, so it must be reused rather than replaced.
SELECT is(
  content.set_node_label(pg_temp.ver(), pg_temp.q1(), 'label', 'Which is your favourite fruit?'),
  'q.s1.label',
  'a key-shaped existing key is reused, not renumbered — an API consumer owns the keys it set');

SELECT is(
  (SELECT value FROM content.i18n_strings
    WHERE survey_version_id = pg_temp.ver() AND lang = 'en' AND key = 'q.s1.label'),
  'Which is your favourite fruit?',
  'and the base-language string is written in the same call — the pair whose separation was the bug');

SELECT is(
  (SELECT state::text FROM content.i18n_strings
    WHERE survey_version_id = pg_temp.ver() AND lang = 'en' AND key = 'q.s1.label'),
  'reviewed',
  'as `reviewed`: the base text is the source, not a translation, and `translated`/`machine` both '
  'count as incomplete in i18n_incomplete_idx and would block the publish this enables');

-- Editing again must not move the key.
SELECT is(
  content.set_node_label(pg_temp.ver(), pg_temp.q1(), 'label', 'Which fruit do you prefer?'),
  'q.s1.label',
  'a second edit reuses the key — a key that moved would orphan every translation of it');

SELECT is(
  (SELECT value FROM content.i18n_strings
    WHERE survey_version_id = pg_temp.ver() AND lang = 'en' AND key = 'q.s1.label'),
  'Which fruit do you prefer?',
  'and the string is updated in place');

/* ---------------------------------------------------------------- *
 * Prose already on the row is REPLACED
 * ---------------------------------------------------------------- */

-- Exactly what the studio has been storing. Reusing it would keep the dangling reference alive.
UPDATE content.nodes SET label_key = 'Which is your favourite fruit?'
 WHERE survey_version_id = pg_temp.ver() AND id = pg_temp.q1();

SELECT is(
  content.set_node_label(pg_temp.ver(), pg_temp.q1(), 'label', 'Pick one'),
  'label.' || pg_temp.q1(),
  'PROSE in label_key is replaced with a minted key — derived from the id, which is immutable, so '
  'renaming the question later cannot orphan the translations');

SELECT is(
  (SELECT label_key FROM content.nodes
    WHERE survey_version_id = pg_temp.ver() AND id = pg_temp.q1()),
  'label.' || pg_temp.q1(),
  'and the column now points at that key');

/* ---------------------------------------------------------------- *
 * Items
 * ---------------------------------------------------------------- */

/*
 * The limit of a shape check, stated as a test rather than left as a surprise.
 *
 * `"Apple"` is prose the studio stored in a key column — and it is ALSO a perfectly well-formed
 * key. No pattern can tell those apart, so it is REUSED, and the bundle row written against it is
 * what makes the reference resolve. The key stays ugly; the survey publishes. That is the right
 * trade: the alternative is renumbering a key an API consumer may have chosen deliberately, and a
 * cosmetic key is worth far less than a translation that stays attached.
 *
 * Prose that is unmistakably prose — a sentence, or the `<b>…</b>` the studio has also been storing
 * — fails the shape check and is replaced. Between them these two cases cover every label in the
 * surveys that could not publish.
 */
UPDATE content.question_items SET label_key = 'Apple'
 WHERE survey_version_id = pg_temp.ver() AND id = pg_temp.opt1();

SELECT is(
  content.set_item_label(pg_temp.ver(), pg_temp.opt1(), 'Apple'),
  'Apple',
  '"Apple" is indistinguishable from a deliberate key, so it is reused rather than renumbered');

SELECT is(
  (SELECT value FROM content.i18n_strings
    WHERE survey_version_id = pg_temp.ver() AND lang = 'en' AND key = 'Apple'),
  'Apple',
  'and the bundle row against that key is what makes the reference resolve — the survey publishes '
  'with a cosmetically poor key rather than not publishing at all');

UPDATE content.question_items SET label_key = '<b>What is your name?</b>'
 WHERE survey_version_id = pg_temp.ver() AND id = pg_temp.opt1();

SELECT is(
  content.set_item_label(pg_temp.ver(), pg_temp.opt1(), 'Bye'),
  'item.' || pg_temp.opt1(),
  'markup and sentences ARE distinguishable from keys, and are replaced');

/* ---------------------------------------------------------------- *
 * The refusals
 * ---------------------------------------------------------------- */

SELECT throws_ok($$
  SELECT content.set_node_label(
    (current_setting('rs.ids', true)::jsonb ->> 'ver_a_content_draft')::app.ulid,
    (current_setting('rs.ids', true)::jsonb ->> 'q1_a')::app.ulid,
    'headline', 'nope')
$$, '22023', NULL, 'an unknown field is refused rather than silently ignored');

DELETE FROM content.i18n_strings WHERE survey_version_id = pg_temp.ver();
DELETE FROM content.languages WHERE survey_version_id = pg_temp.ver();

SELECT throws_ok($$
  SELECT content.set_node_label(
    (current_setting('rs.ids', true)::jsonb ->> 'ver_a_content_draft')::app.ulid,
    (current_setting('rs.ids', true)::jsonb ->> 'q1_a')::app.ulid,
    'label', 'no base language here')
$$, '22023', NULL,
   'a version with no base language is REFUSED, not defaulted to en. Defaulting is what made the '
   'compiler report twenty-one keys missing from a bundle that did not exist');

SELECT * FROM finish();
ROLLBACK;
