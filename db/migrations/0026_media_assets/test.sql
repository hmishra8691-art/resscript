-- 0026_media_assets — tests.
--
-- Two things worth asserting, and the first is a NEGATIVE:
--
--   1. `image/svg+xml` is UNSTORABLE. An SVG is an XML document that can carry script and event
--      handlers — security §4 strips `<svg>` from author HTML for exactly that reason — so it is not
--      an image for serving purposes. The sniffer in apps/runtime refuses one; this is the storage
--      layer saying the same thing, so a future writer that skipped the sniffer still cannot store
--      one on an origin that serves respondent-facing bytes.
--
--   2. It is NOT a content table. DB §11 splits assets by lifecycle, and this one is org-scoped and
--      reusable rather than frozen with a version — so it must stay invisible to
--      ops.content_tables_not_cloned(), which keys on `survey_version_id` precisely so a registry
--      is not mistaken for content.

BEGIN;
SELECT plan(23);

GRANT USAGE ON SCHEMA public TO authoring, runtime_writer, analytics_reader, runtime_rpc_owner;

SELECT set_config('rs.ids', ops.test_seed_two_orgs()::text, true);
CREATE FUNCTION pg_temp.tid(k text) RETURNS text LANGUAGE sql STABLE AS
$$ SELECT current_setting('rs.ids', true)::jsonb ->> k $$;

CREATE FUNCTION pg_temp.act_as(p_user uuid, p_org text, p_role text DEFAULT 'authoring')
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', p_user, 'role', p_role,
                      'app_metadata', json_build_object('active_org_id', p_org))::text, true);
  EXECUTE format('SET LOCAL ROLE %I', p_role);
END $$;

CREATE FUNCTION pg_temp.mid(p_tag text) RETURNS app.ulid LANGUAGE sql IMMUTABLE AS
$$ SELECT ('med_0' || rpad(translate(upper(p_tag), 'ILOU', '110V') || 'V', 25, '0'))::app.ulid $$;

SELECT set_config('rs.org', pg_temp.tid('org_a'), true);
SELECT set_config('rs.sha', repeat('ab', 32), true);

/* ---------------------------------------------------------------- *
 * 1. Structure and lifecycle
 * ---------------------------------------------------------------- */

SELECT has_table('app', 'media_assets', 'app.media_assets exists');
SELECT has_index('app', 'media_assets', 'media_dedupe_key', 'DB §11''s content-hash dedupe index');
SELECT ok(
  (SELECT relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'app' AND c.relname = 'media_assets'),
  'RLS is FORCED');

SELECT hasnt_column('app', 'media_assets', 'survey_version_id',
  'NOT version-scoped. DB §11: "media is org-scoped and reusable (a logo used across 40 waves) '
  'while code is content that must freeze with its version; copying a 4 MB image on every publish '
  'would be absurd."');

SELECT is_empty($$
  SELECT table_name FROM ops.content_tables_not_cloned()
$$, 'and 0023''s clone check is still empty — a registry with no survey_version_id is correctly '
   'invisible to it, which is why that check keys on the column rather than on a name list');

SELECT ok(
  NOT has_table_privilege('runtime_writer', 'app.media_assets', 'SELECT'),
  'runtime_writer cannot read it — the runtime serves media by storage key from the artifact, never '
  'from these rows, so a mid-field media table edit cannot change what a respondent fetches');

SELECT is_empty($$
  SELECT policyname FROM pg_policies
   WHERE schemaname = 'app' AND tablename = 'media_assets' AND cmd = 'DELETE'
$$, 'there is NO delete policy: soft delete only, because a hard delete of a row a published '
   'artifact references produces a dangling reference in an artifact ADR-002 makes immutable');

/* ---------------------------------------------------------------- *
 * 2. The SVG refusal
 * ---------------------------------------------------------------- */

SELECT pg_temp.act_as(pg_temp.tid('user_a')::uuid, pg_temp.tid('org_a'));

INSERT INTO app.media_assets
  (id, org_id, storage_key, mime, bytes, width, height, sha256, uploaded_by)
VALUES (pg_temp.mid('png1'), current_setting('rs.org')::app.ulid, 'media/a/logo.png', 'image/png',
        4096, 512, 512, current_setting('rs.sha'), pg_temp.tid('user_a')::uuid);
SELECT is((SELECT count(*)::int FROM app.media_assets), 1, 'a PNG stores');

SELECT throws_ok(
  format($ins$INSERT INTO app.media_assets
           (id, org_id, storage_key, mime, bytes, sha256, uploaded_by)
         VALUES (%L, %L, 'media/a/evil.svg', 'image/svg+xml', 100, %L, %L)$ins$,
    pg_temp.mid('svg1'), current_setting('rs.org'), repeat('cd', 32), pg_temp.tid('user_a')),
  '23514', NULL,
  'image/svg+xml is UNSTORABLE. An SVG is an XML document that can carry <script> and onload — '
  'security §4 strips <svg> from author HTML for that reason — so it is not an image for serving '
  'purposes, and the media origin serves files to browsers. The sniffer refuses one; this is the '
  'storage layer saying the same thing so a writer that skipped the sniffer still cannot');

SELECT throws_ok(
  format($ins$INSERT INTO app.media_assets
           (id, org_id, storage_key, mime, bytes, sha256, uploaded_by)
         VALUES (%L, %L, 'media/a/x.html', 'text/html', 100, %L, %L)$ins$,
    pg_temp.mid('html'), current_setting('rs.org'), repeat('ce', 32), pg_temp.tid('user_a')),
  '23514', NULL, 'and text/html is too, for the same reason');

SELECT lives_ok(
  format($ins$INSERT INTO app.media_assets
           (id, org_id, storage_key, mime, bytes, sha256, uploaded_by)
         VALUES (%L, %L, 'media/a/brief.pdf', 'application/pdf', 90000, %L, %L)$ins$,
    pg_temp.mid('pdf'), current_setting('rs.org'), repeat('cf', 32), pg_temp.tid('user_a')),
  'a PDF stores — it is allowed but served as a download (see mediaHeaders), which is the split '
  'security §4 asks for: by whether the type is DISPLAYABLE, not by whether it is "safe"');

/* ---------------------------------------------------------------- *
 * 3. Dedupe and shape
 * ---------------------------------------------------------------- */

SELECT throws_ok(
  format($ins$INSERT INTO app.media_assets
           (id, org_id, storage_key, mime, bytes, sha256, uploaded_by)
         VALUES (%L, %L, 'media/a/logo-again.png', 'image/png', 4096, %L, %L)$ins$,
    pg_temp.mid('png2'), current_setting('rs.org'), current_setting('rs.sha'),
    pg_temp.tid('user_a')),
  '23505', NULL,
  'the same bytes twice in one org is one row — media is the only asset class measured in '
  'megabytes, and a tracker re-uploading its stimulus set every wave is how a storage bill becomes '
  'a conversation');

-- ...but the same file in ANOTHER org is a separate row. A global dedupe would let one org discover
-- that another holds a given file by uploading it and seeing a conflict.
SELECT pg_temp.act_as(pg_temp.tid('user_b')::uuid, pg_temp.tid('org_b'));
SELECT lives_ok(
  format($ins$INSERT INTO app.media_assets
           (id, org_id, storage_key, mime, bytes, sha256, uploaded_by)
         VALUES (%L, %L, 'media/b/logo.png', 'image/png', 4096, %L, %L)$ins$,
    pg_temp.mid('png3'), pg_temp.tid('org_b'), current_setting('rs.sha'),
    pg_temp.tid('user_b')),
  'the same bytes in ANOTHER org store separately — a global dedupe would be a cross-tenant '
  'existence oracle');
SELECT is((SELECT count(*)::int FROM app.media_assets), 1, 'and org B sees only its own');

SELECT pg_temp.act_as(pg_temp.tid('user_a')::uuid, pg_temp.tid('org_a'));

SELECT throws_ok(
  format($ins$INSERT INTO app.media_assets
           (id, org_id, storage_key, mime, bytes, width, sha256, uploaded_by)
         VALUES (%L, %L, 'media/a/half.png', 'image/png', 10, 512, %L, %L)$ins$,
    pg_temp.mid('half'), current_setting('rs.org'), repeat('da', 32), pg_temp.tid('user_a')),
  '23514', NULL,
  'a width with no height is refused — stated as a biconditional so both halves are unstorable, '
  'and a PDF or an audio file legitimately has neither');

SELECT throws_ok(
  format($ins$INSERT INTO app.media_assets
           (id, org_id, storage_key, mime, bytes, sha256, uploaded_by)
         VALUES (%L, %L, '  ', 'image/png', 10, %L, %L)$ins$,
    pg_temp.mid('nokey'), current_setting('rs.org'), repeat('db', 32), pg_temp.tid('user_a')),
  '23514', NULL, 'a blank storage key is refused: it addresses nothing');

SELECT throws_ok(
  format($ins$INSERT INTO app.media_assets
           (id, org_id, storage_key, mime, bytes, sha256, uploaded_by)
         VALUES (%L, %L, 'media/a/empty.png', 'image/png', 0, %L, %L)$ins$,
    pg_temp.mid('zero'), current_setting('rs.org'), repeat('dc', 32), pg_temp.tid('user_a')),
  '23514', NULL, 'a zero-byte asset is refused');

/* ---------------------------------------------------------------- *
 * 4. Soft delete and roles
 * ---------------------------------------------------------------- */

-- Through the DEFINER function, not an UPDATE. A plain `UPDATE ... SET deleted_at` fails with
-- "new row violates row-level security policy", because PostgreSQL applies a SELECT policy's USING
-- clause to the NEW row of an UPDATE — so the `deleted_at IS NULL` filter in media_assets_select
-- makes setting deleted_at self-refusing. Asserted both ways, because that behaviour is surprising
-- enough that the next person to touch this will otherwise rediscover it.
SELECT throws_ok(
  format($u$UPDATE app.media_assets SET deleted_at = now() WHERE id = %L$u$, pg_temp.mid('pdf')),
  '42501', NULL,
  'a plain UPDATE cannot set deleted_at: Postgres applies the SELECT policy''s USING to the NEW '
  'row, so the deleted_at IS NULL filter refuses the row it has to admit');

SELECT lives_ok(
  format($u$SELECT app.retire_media_asset(%L)$u$, pg_temp.mid('pdf')),
  'app.retire_media_asset does it, giving retirement one audited path');

SELECT is((SELECT count(*)::int FROM app.media_assets WHERE id = pg_temp.mid('pdf')), 0,
  'and the retired asset disappears from the READ — the filter stays at the POLICY level, where a '
  'forgotten WHERE in one caller cannot leak it back into a picker');

-- And the dedupe index frees up, so the same bytes can be re-uploaded after a delete.
SELECT lives_ok(
  format($ins$INSERT INTO app.media_assets
           (id, org_id, storage_key, mime, bytes, sha256, uploaded_by)
         VALUES (%L, %L, 'media/a/brief2.pdf', 'application/pdf', 90000, %L, %L)$ins$,
    pg_temp.mid('pdf2'), current_setting('rs.org'), repeat('cf', 32), pg_temp.tid('user_a')),
  'and its hash is free again — the dedupe index is partial on deleted_at, so re-uploading a file '
  'somebody removed works rather than colliding with a tombstone');

-- user_a2 is org A's reviewer.
SELECT pg_temp.act_as(pg_temp.tid('user_a2')::uuid, pg_temp.tid('org_a'));
SELECT ok((SELECT count(*)::int FROM app.media_assets) > 0,
  'a REVIEWER can read media — approving a survey means seeing the images in it, and a media '
  'library is not a secret the way a vendor''s secret_ref list is');
SELECT throws_ok(
  format($ins$INSERT INTO app.media_assets
           (id, org_id, storage_key, mime, bytes, sha256, uploaded_by)
         VALUES (%L, %L, 'media/a/rev.png', 'image/png', 10, %L, %L)$ins$,
    pg_temp.mid('rev'), current_setting('rs.org'), repeat('dd', 32), pg_temp.tid('user_a2')),
  '42501', NULL, 'but cannot upload one');

SELECT * FROM finish();
ROLLBACK;
