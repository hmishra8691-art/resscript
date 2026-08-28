-- 0026_media_assets — org-scoped reusable media (roadmap P2-12, DB §11).
--
-- ## Why media is NOT a content table
--
-- DB §11 states the split and the reason: "Assets are split by lifecycle. 03 §11 groups scripts,
-- HTML, CSS and media together. Physically media is org-scoped and reusable (a logo used across 40
-- waves) while code is *content* that must freeze with its version; copying a 4 MB image on every
-- publish would be absurd."
--
-- So this lives in schema `app`, has no `survey_version_id`, is not cloned by
-- `content.clone_version` and is not caught by `ops.content_tables_not_cloned()` — which keys on
-- that column precisely so a registry is not mistaken for content. A version references media by
-- id; the bytes are shared.
--
-- The consequence, stated because it is the one thing that surprises people: REPLACING an image
-- changes it for every wave that references it, including ones in field. That is the correct
-- behaviour for a logo (a rebrand should propagate) and the wrong behaviour for stimulus material,
-- and the answer for the second case is to upload a new asset rather than overwrite one. There is
-- no update path for `storage_key` here, so an overwrite has to be deliberate.
--
-- ## Dedupe by content hash
--
-- `UNIQUE (org_id, sha256) WHERE deleted_at IS NULL`, per DB §11. The same logo uploaded by four
-- programmers is one row and one object, which matters more than it sounds: media is the only asset
-- class measured in megabytes, and a tracker re-uploading its stimulus set every wave is how a
-- storage bill becomes a conversation.
--
-- Scoped to the ORG rather than globally, because a global dedupe would let one org discover that
-- another has a given file by uploading it and seeing a conflict.
--
-- ## MIME is validated, not trusted
--
-- The column carries what the SERVER determined from the bytes, never what the client's
-- `Content-Type` header claimed. Security §4 requires the SVG defence in particular — an SVG is a
-- document that can carry script, so it is not an image for serving purposes — and the sniffing
-- lives in `apps/runtime/src/media.ts` where it can be unit-tested against real magic bytes. The
-- CHECK here is the storage-layer restatement: a mime outside the allowlist is unstorable, so a
-- future writer that skipped the sniffer cannot put one in.

SET lock_timeout = '3s';
SET statement_timeout = '120s';

CREATE TABLE app.media_assets (
  id           app.ulid PRIMARY KEY,
  org_id       app.ulid NOT NULL REFERENCES app.organizations (id) ON DELETE CASCADE,
  -- Optional: a logo belongs to the org, a study's stimulus set belongs to a project. NULL means
  -- org-wide, the same convention app.webhooks uses for its project scope.
  project_id   app.ulid REFERENCES app.projects (id) ON DELETE SET NULL,
  storage_key  text NOT NULL,
  -- What the SERVER determined from the bytes. See the header.
  mime         text NOT NULL,
  bytes        bigint NOT NULL,
  width        integer,
  height       integer,
  sha256       app.sha256 NOT NULL,
  -- An i18n key, not a string: alt text is copy and has to translate like every other string a
  -- respondent reads. A plain text column here is how a survey ends up with English alt text in
  -- its French wave.
  alt_key      text,
  uploaded_by  uuid NOT NULL REFERENCES auth.users (id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  -- Soft delete, because a version in field may still reference the row. A hard delete would make
  -- an artifact point at nothing, and ADR-002 makes that artifact immutable — so the reference
  -- cannot be repaired.
  deleted_at   timestamptz,
  CONSTRAINT media_storage_key_nonempty CHECK (btrim(storage_key) <> ''),
  CONSTRAINT media_bytes_positive CHECK (bytes > 0),
  -- Dimensions are for a raster; a PDF or an audio file has none, and 0 would be a lie.
  CONSTRAINT media_dims_shape CHECK (
    (width IS NULL) = (height IS NULL) AND (width IS NULL OR (width > 0 AND height > 0))),
  -- The allowlist, restated at the storage layer. `image/svg+xml` is DELIBERATELY ABSENT: an SVG is
  -- a document that can carry script and an event handler, so it is not an image for serving
  -- purposes. Security §4 lists it among the tags a sanitizer strips for exactly this reason, and
  -- admitting it here would put a scriptable document on the media origin.
  CONSTRAINT media_mime_allowlist CHECK (mime IN (
    'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif',
    'video/mp4', 'video/webm',
    'audio/mpeg', 'audio/ogg', 'audio/wav',
    'application/pdf'))
);

COMMENT ON TABLE app.media_assets IS
  'Org-scoped reusable media (DB §11, roadmap P2-12). In schema `app` and NOT a content table, '
  'because DB §11 splits assets by lifecycle: "media is org-scoped and reusable (a logo used across '
  '40 waves) while code is content that must freeze with its version; copying a 4 MB image on every '
  'publish would be absurd." So it carries no survey_version_id, is not cloned, and is correctly '
  'invisible to ops.content_tables_not_cloned(), which keys on that column so a registry is not '
  'mistaken for content. The consequence: replacing an image changes it for every wave referencing '
  'it, including ones in field — right for a rebrand, wrong for stimulus material, and the answer '
  'for the second is a new asset rather than an overwrite.';
COMMENT ON COLUMN app.media_assets.mime IS
  'What the SERVER determined from the bytes, never what the client''s Content-Type claimed. The '
  'sniffing lives in apps/runtime/src/media.ts where it is unit-tested against real magic bytes; '
  'this column''s CHECK is the storage-layer restatement, so a future writer that skipped the '
  'sniffer still cannot store a type outside the allowlist. image/svg+xml is deliberately absent — '
  'an SVG is a scriptable document, not an image.';
COMMENT ON COLUMN app.media_assets.alt_key IS
  'An i18n KEY, not a string. Alt text is copy a respondent reads, so it translates like every '
  'other string; a plain text column here is how a survey ends up with English alt text in its '
  'French wave.';
COMMENT ON COLUMN app.media_assets.deleted_at IS
  'Soft delete, because a version in field may still reference the row. A hard delete would make a '
  'published artifact point at nothing, and ADR-002 makes that artifact immutable — so the dangling '
  'reference could never be repaired.';

-- DB §11's dedupe index, verbatim. Scoped to the org rather than globally: a global dedupe would
-- let one org discover that another holds a given file by uploading it and seeing a conflict.
CREATE UNIQUE INDEX media_dedupe_key ON app.media_assets (org_id, sha256)
  WHERE deleted_at IS NULL;
CREATE INDEX media_assets_org_idx ON app.media_assets (org_id, created_at DESC)
  WHERE deleted_at IS NULL;

-- NO `updated_at` and no touch trigger, matching DB §11's column list. I added one and it failed
-- with "record new has no field updated_at" — the same mistake I made on app.webhook_deliveries in
-- 0020, which is twice, so it is worth writing down: `app.tg_touch_updated_at` is not a free
-- addition, it is a contract with a column.
--
-- The column is genuinely unnecessary here. `created_at` records the upload and `deleted_at` the
-- removal, and the only mutable field is `alt_key` — a caption edit whose time nobody audits. A
-- version's use of an asset is pinned in its artifact, so "when did this change" is answered by the
-- artifact rather than by a row.

ALTER TABLE app.media_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.media_assets FORCE ROW LEVEL SECURITY;

-- Read at the REVIEWER floor: a reviewer approving a survey has to see the images in it, and a
-- media library is not a secret the way a vendor's secret_ref list is.
CREATE POLICY media_assets_select ON app.media_assets FOR SELECT TO authoring
USING (org_id = app.current_org() AND app.has_role('reviewer') AND deleted_at IS NULL);
CREATE POLICY media_assets_insert ON app.media_assets FOR INSERT TO authoring
WITH CHECK (org_id = app.current_org() AND app.has_role('programmer'));
-- UPDATE exists for `alt_key` and the soft delete. `storage_key` has no update path in the repo,
-- so replacing an image's BYTES is a new row rather than an edit — see the table comment.
CREATE POLICY media_assets_update ON app.media_assets FOR UPDATE TO authoring
USING (org_id = app.current_org() AND app.has_role('programmer'))
WITH CHECK (org_id = app.current_org() AND app.has_role('programmer'));
-- NO DELETE POLICY. Soft delete only: a hard delete of a row a published artifact references
-- produces a dangling reference in an immutable artifact.
COMMENT ON POLICY media_assets_select ON app.media_assets IS
  'reviewer to read — approving a survey means seeing the images in it, and a media library is not '
  'a secret the way a vendor''s secret_ref list is. `deleted_at IS NULL` is IN THE POLICY rather '
  'than left to every query: a soft-deleted asset that reappeared in a picker because one caller '
  'forgot a WHERE is the failure a policy-level filter exists to prevent. The cost is that it makes '
  'the soft delete itself impossible through the UPDATE policy — see app.retire_media_asset.';

GRANT SELECT, INSERT, UPDATE ON app.media_assets TO authoring;
-- The runtime serves media from its own origin by storage key and never reads these rows: the
-- artifact carries the key, so a mid-field media table edit cannot change what a respondent
-- fetches. ADR-001's plane boundary, applied to bytes.
REVOKE ALL ON app.media_assets FROM runtime_writer, analytics_reader;


/* ------------------------------------------------------------------ *
 * The soft delete, and the Postgres behaviour that forced it here
 * ------------------------------------------------------------------ */

-- `UPDATE ... SET deleted_at = now()` by an `authoring` caller FAILS with "new row violates
-- row-level security policy", and working out why was worth the detour: PostgreSQL applies a
-- SELECT policy's USING clause to the NEW row of an UPDATE, not only the UPDATE policy's WITH
-- CHECK. So a SELECT policy that filters `deleted_at IS NULL` makes setting `deleted_at`
-- self-refusing — the new row is invisible to the very policy that has to admit it.
--
-- Three ways out, and the choice is not close:
--
--   1. Drop the filter from the SELECT policy and put it in every query. That is the failure the
--      filter exists to prevent: one caller forgets a WHERE and a retired asset reappears in a
--      picker.
--   2. Add `deleted_at IS NULL` to the UPDATE policy's USING and leave the WITH CHECK open. It
--      works and it also opens every other column to an update on a retired row.
--   3. A SECURITY DEFINER function that does the one thing. Retiring an asset is a distinct
--      operation with its own authorization question, and this is where a "is it still referenced
--      by a published version" check belongs when there is a reference table to consult.
--
-- (3), which also means the retirement has ONE path rather than being an UPDATE anybody can spell
-- differently.
CREATE FUNCTION app.retire_media_asset(p_id app.ulid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = '' SET statement_timeout = '10s' AS $fn$
DECLARE
  v_org app.ulid;
BEGIN
  SELECT m.org_id INTO v_org FROM app.media_assets m WHERE m.id = p_id AND m.deleted_at IS NULL;
  -- Not found and already retired are the same answer, and a cross-org id is too: 0004's
  -- existence-oracle rule means a wrong-tenant id must be indistinguishable from one that never
  -- existed.
  IF v_org IS NULL OR v_org <> app.current_org() OR NOT app.has_role('programmer') THEN
    RAISE EXCEPTION 'media asset % not found', p_id USING ERRCODE = 'P0002';
  END IF;

  UPDATE app.media_assets SET deleted_at = pg_catalog.clock_timestamp() WHERE id = p_id;
END $fn$;

COMMENT ON FUNCTION app.retire_media_asset(app.ulid) IS
  'Soft-delete one media asset. A DEFINER function rather than an UPDATE, because PostgreSQL '
  'applies a SELECT policy''s USING clause to the NEW row of an UPDATE — so the '
  '`deleted_at IS NULL` filter in media_assets_select makes setting deleted_at self-refusing, the '
  'new row being invisible to the policy that must admit it. Routing it here keeps the read filter '
  'at the policy level (where a forgotten WHERE cannot leak a retired asset) and gives retirement '
  'one audited path instead of an UPDATE anybody can spell differently. SOFT only: a hard delete of '
  'a row a published artifact references produces a dangling reference in an artifact ADR-002 makes '
  'immutable.';

REVOKE ALL ON FUNCTION app.retire_media_asset(app.ulid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.retire_media_asset(app.ulid) TO authoring;
