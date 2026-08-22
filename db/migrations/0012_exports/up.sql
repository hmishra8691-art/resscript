-- 0012_exports — app.exports and the export read path (roadmap P1-12).
--
-- Roadmap P1-12 DB column, in full: "app.exports with pii_included. Nothing else new." The
-- table is the durable record of "who exported what, with or without PII" — API §2.15's
-- GET /v1/exports answers from it, and security §7.2's audit question ("who exported the
-- open-ends") is answered by ONE ROW, with pii_included STORED at request time rather than
-- recomputed from grants that may since have been revoked (P5-02 restates this: "stored,
-- not recomputed").
--
-- TWO OBJECTS BESIDE THE TABLE, and why each is not scope creep on "nothing else new":
--
--   1. app.tg_exports_pii_guard — the K §1 capability gate on pii_included, as a TRIGGER
--      rather than inside a policy. Not a style choice: K §1 forbids app.has_role() from
--      appearing in any policy that governs pii_access ("CI greps for it" —
--      tools/ci/lint-migrations.mjs HAS_ROLE_IN_CAPABILITY_POLICY), and the INSERT policy
--      here legitimately needs the analyst role floor. One statement cannot carry both, so
--      the split follows 0004's sv_update comment verbatim: "policies for whose rows,
--      triggers for what shape". The policy says which org and which floor; the trigger says
--      a pii_included row is a shape only a capability holder may write — and raises with a
--      message, where a WITH CHECK would silently insert zero rows.
--
--   2. app.export_response_page — the worker's ONLY way to read runtime.response_documents.
--      0011 gave that table exactly one SELECT policy, for runtime_rpc_owner, and its test
--      asserts authoring has no USAGE on schema runtime AT ALL (ADR-001's plane boundary).
--      Without a definer function the export worker cannot read a single row, so the
--      function is not an extra — it IS the backend deliverable ("paging response_documents
--      by keyset"). SECURITY DEFINER on the same terms as app.publish_version, which crosses
--      the same boundary in the write direction (0009 §5): the worker assumes the enqueuing
--      user's identity (request.jwt.claims + SET LOCAL ROLE authoring, publish-store.ts's
--      calling convention), and the function re-checks that identity — org match against the
--      version, analyst floor — on every call. Keyset: (survey_version_id, session_id),
--      which is the PRIMARY KEY's own order and 0011's respdoc_export_idx, built "for the
--      export path" in that migration. session_id is a ULID, so its lexicographic order is
--      creation order; started_at would sort the same rows but has no index, and the roadmap
--      says nothing else new. One survey_version_id also lands in exactly ONE hash partition,
--      so the keyset never merges across partitions.
--
-- PII IS GATED TWICE, deliberately (security §7.2 lists four conditions; two live here):
--   * at REQUEST time, the trigger refuses pii_included = true without a live pii_access
--     grant (which itself requires the org setting — app.has_capability's own conjunction);
--   * at READ time, export_response_page strips the values of pii variables from vars unless
--     the CALLER holds the capability NOW — so a grant revoked between request and job run
--     yields empty PII columns, never a leak. The worker's column-level NULLing from the
--     artifact manifest is the export contract; this strip is the database refusing to hand
--     PII to a process whose principal lost the right to see it.
--
-- Migration header first (B §14, read by tools/ci/lint-migrations.mjs from the first 60
-- lines). Everything here is expand-only: one enum, one table, one trigger function, one
-- read function, policies and grants. No renames, no in-place type changes, no defaults
-- materialized over existing rows.
SET lock_timeout = '3s';
SET statement_timeout = '120s';

-- ---------------------------------------------------------------------------
-- 0. What this migration deliberately does NOT create
-- ---------------------------------------------------------------------------
--   * A DELETE path. API §2.15 has DELETE /v1/exports/{id}, but nothing implements it in
--     P1-12 and a policy with no consumer is a hole nobody is watching. Expand later.
--   * A `format` column. P1-12 exports exactly one format (CSV); P5-02 brings xlsx/sav/
--     parquet and adds the column with its CHECK when there is a second value to check for.
--   * An expiry / retention column (`expires_at`). API §2.15 promises 7-day retention for
--     PII exports; retention is a job over storage, and neither the job nor real object
--     storage exists yet (the worker writes a local EXPORT_DIR and records that honestly).
--   * Signed download URLs, webhooks, filters, variable subsets — all P5-02.

-- ---------------------------------------------------------------------------
-- 1. The status enum
-- ---------------------------------------------------------------------------
-- Its own type rather than ops.jobs' text status: an export row outlives the job that
-- produced it (0009's column comment: "the job is retained for a while and the version is
-- retained forever"), and the two lifecycles are not the same shape — a job can be
-- 'cancelled' or requeued; an export either finished or it did not.
CREATE TYPE app.export_status AS ENUM ('pending', 'running', 'succeeded', 'failed');
COMMENT ON TYPE app.export_status IS
  'The export lifecycle. pending = row created, job enqueued; running = the worker claimed '
  'it; succeeded/failed are terminal. Narrower than ops.jobs.status on purpose: retry '
  'mechanics live on the job, the export row records only the outcome.';

-- ---------------------------------------------------------------------------
-- 2. app.exports (roadmap P1-12, API §2.15, security §7.2)
-- ---------------------------------------------------------------------------
CREATE TABLE app.exports (
  id                app.ulid PRIMARY KEY DEFAULT app.gen_ulid('exp'),
  org_id            app.ulid NOT NULL,
  survey_version_id app.ulid NOT NULL,
  requested_by      uuid NOT NULL REFERENCES auth.users(id),
  status            app.export_status NOT NULL DEFAULT 'pending',
  pii_included      boolean NOT NULL DEFAULT false,
  include_test      boolean NOT NULL DEFAULT false,
  row_count         bigint CHECK (row_count IS NULL OR row_count >= 0),
  storage_key       text,
  error             jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  started_at        timestamptz,
  finished_at       timestamptz,
  -- The composite FK is the tenancy pattern 0004 established on app.surveys: it is what
  -- keeps the denormalized org_id honest, so an export row cannot carry its own org while
  -- pointing at another org's version and have every RLS predicate agree with itself.
  FOREIGN KEY (org_id, survey_version_id) REFERENCES app.survey_versions (org_id, id),
  CONSTRAINT exports_id_prefix CHECK (id LIKE 'exp\_%')
);
COMMENT ON TABLE app.exports IS
  'One row per export request (roadmap P1-12). The row is the audit answer to "who exported '
  'the open-ends": pii_included is stored at request time, not recomputed (P5-02), because '
  'the grant that authorized it may be revoked later and the historical fact must not move. '
  'The worker updates status/row_count/storage_key as the enqueuing user, the same '
  'impersonation convention as the compile job (0009 §5 calling convention).';
COMMENT ON COLUMN app.exports.pii_included IS
  'Whether pii-flagged variables carry values in this file. Guarded on write by '
  'app.tg_exports_pii_guard (K §1: capability, never rank) and honoured on read twice — '
  'app.export_response_page strips PII values for callers without a live grant, and the '
  'worker NULLs pii columns from the artifact manifest when this is false.';
COMMENT ON COLUMN app.exports.include_test IS
  'Test responses (is_test rows, E §14.1) are EXCLUDED by default and included only by this '
  'explicit flag — the same default as every response count in studio.';
COMMENT ON COLUMN app.exports.storage_key IS
  'Where the file landed, relative to the worker''s export store. Phase 1 ships a local '
  'filesystem directory (EXPORT_DIR), not a bucket — recorded as a key so the P5-02 move to '
  'object storage with signed URLs changes the store, not the row.';
COMMENT ON COLUMN app.exports.error IS
  'AppError.toJSON() of the failure, when status = failed. On the export row and not only '
  'on the job because the job is retained for a while and this row is the record.';
COMMENT ON CONSTRAINT exports_id_prefix ON app.exports IS
  'B §0: every id is self-describing. LIKE ''exp\_%'' rather than a regex because app.ulid '
  'already constrains the body; this says only which prefix (0010''s qitems_id_prefix '
  'precedent).';

CREATE INDEX exports_version_idx ON app.exports (survey_version_id, created_at DESC);
COMMENT ON INDEX app.exports_version_idx IS
  'API §2.15: GET /v1/exports?survey_version_id, newest first — the export dialog''s history.';
CREATE INDEX exports_org_recent_idx ON app.exports (org_id, created_at DESC);
COMMENT ON INDEX app.exports_org_recent_idx IS
  'The org-wide export history ("who exported PII and when", P5-02 frontend) without a scan.';

-- ---------------------------------------------------------------------------
-- 3. The PII capability gate (K §1), as a trigger
-- ---------------------------------------------------------------------------
-- See the header for why this is not in the INSERT policy. Fires on UPDATE too, so a row
-- created honestly as pii_included = false cannot be flipped to true afterwards without the
-- same capability check; the worker's status updates leave the column unchanged and never
-- enter the branch.
CREATE FUNCTION app.tg_exports_pii_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NEW.pii_included AND (TG_OP = 'INSERT' OR NOT OLD.pii_included) THEN
    -- Runs as the INVOKING role (not a definer), so app.has_capability() reads the real
    -- caller's claims — the same call the studio's own capability checks make. K §1: the
    -- pii_access capability never nests from rank, and app.has_capability additionally
    -- requires the org's pii_exports_enabled setting.
    IF NOT app.has_capability('pii_access') THEN
      RAISE EXCEPTION 'exporting PII requires an explicit pii_access capability grant '
        '(security 7.2); role rank never confers it'
        USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE EXECUTE ON FUNCTION app.tg_exports_pii_guard() FROM PUBLIC;
COMMENT ON FUNCTION app.tg_exports_pii_guard() IS
  'K §1''s pii_access gate on app.exports.pii_included. A trigger and not a policy because '
  'the INSERT policy needs app.has_role(), which K §1 (and the migration lint) forbids in '
  'any statement governing pii_access — and because a raised message names the missing '
  'grant, where a WITH CHECK failure is an unexplained zero-row insert.';

CREATE TRIGGER exports_pii_guard BEFORE INSERT OR UPDATE ON app.exports
  FOR EACH ROW EXECUTE FUNCTION app.tg_exports_pii_guard();

-- ---------------------------------------------------------------------------
-- 4. RLS (ADR-009, B §12)
-- ---------------------------------------------------------------------------
ALTER TABLE app.exports ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.exports FORCE  ROW LEVEL SECURITY;

CREATE POLICY exports_select ON app.exports FOR SELECT TO authoring
USING (org_id = app.current_org() AND app.has_role('analyst'));
COMMENT ON POLICY exports_select ON app.exports IS
  'Security §7.1: exports are an analyst-and-above surface (create/list/download rows all '
  'read ANL+). Org-wide at that floor rather than per-project: the row itself carries no '
  'project_id, and the file it names is version-scoped; project narrowing arrives with the '
  'download endpoint if the matrix ever needs it. Reviewers'' P (download an existing '
  'export) is an API-mediated concern, not a direct table read.';

CREATE POLICY exports_insert ON app.exports FOR INSERT TO authoring
WITH CHECK (org_id = app.current_org() AND app.has_role('analyst')
            AND requested_by = app.current_user_id()
            AND status = 'pending');
COMMENT ON POLICY exports_insert ON app.exports IS
  'requested_by is pinned to the caller — an export "requested by" someone else would '
  'launder the PII audit trail through a colleague. Born pending: the lifecycle belongs to '
  'the worker. The pii_included gate is NOT here — see app.tg_exports_pii_guard.';

CREATE POLICY exports_update ON app.exports FOR UPDATE TO authoring
USING (org_id = app.current_org() AND app.has_role('analyst')
       AND requested_by = app.current_user_id())
WITH CHECK (org_id = app.current_org() AND app.has_role('analyst')
            AND requested_by = app.current_user_id());
COMMENT ON POLICY exports_update ON app.exports IS
  'Only the requester — which is who the worker impersonates (0009 §5''s calling '
  'convention) — may advance the row. The WITH CHECK repeats requested_by so the row cannot '
  'be reassigned. No status-transition guard beyond born-pending: the worker is the only '
  'writer today, and a transition machine belongs in a definer function when a second '
  'writer (cancel, P5-02) arrives.';

-- No DELETE policy: see §0.

GRANT SELECT, INSERT, UPDATE ON app.exports TO authoring;
REVOKE DELETE ON app.exports FROM authoring;
REVOKE ALL ON app.exports FROM runtime_writer, analytics_reader;

-- ---------------------------------------------------------------------------
-- 5. app.export_response_page — the keyset read (roadmap P1-12 backend)
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.export_response_page(
  p_survey_version_id app.ulid,
  p_after_session_id  app.ulid DEFAULT NULL,  -- NULL = first page
  p_include_test      boolean  DEFAULT false, -- E §14.1: test rows out unless asked for
  p_limit             int      DEFAULT 500
) RETURNS TABLE (
  session_id   app.ulid,
  is_test      boolean,
  status       text,
  disposition  text,
  vars         jsonb,
  started_at   timestamptz,
  completed_at timestamptz
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = '' SET statement_timeout = '15s' AS $$
DECLARE
  v_pii_keys text[];
BEGIN
  -- The caller is the impersonated REQUESTER (claims + SET LOCAL ROLE authoring), so these
  -- are the same checks the studio would have made. Floor first: a caller with no standing
  -- learns nothing about whether the version exists.
  IF NOT app.has_role('analyst') THEN
    RAISE EXCEPTION 'reading responses for export requires the analyst role or above'
      USING ERRCODE = '42501';
  END IF;

  -- Org match through the version row. Zero rows here is the same answer for "no such
  -- version" and "another org''s version" — 0004''s suites insist the two stay
  -- indistinguishable, so one error code covers both.
  IF NOT EXISTS (SELECT 1 FROM app.survey_versions sv
                  WHERE sv.id = p_survey_version_id
                    AND sv.org_id = app.current_org()) THEN
    RAISE EXCEPTION 'survey version not found' USING ERRCODE = 'P0002';
  END IF;

  -- Defence in depth for PII (security §7.2, header). The pii flags live on
  -- content.variables — the same rows the compiler read to stamp the artifact manifest's
  -- pii flags — and variables_pii_idx (0007) makes this a probe. Checked LIVE, not from
  -- app.exports.pii_included: a revoked grant must stop the data, whatever the row says.
  IF NOT app.has_capability('pii_access') THEN
    SELECT coalesce(array_agg(v.id::text), '{}') INTO v_pii_keys
      FROM content.variables v
     WHERE v.survey_version_id = p_survey_version_id
       AND v.pii AND v.deleted_at IS NULL;
  ELSE
    v_pii_keys := '{}';
  END IF;

  -- Keyset over the PRIMARY KEY (survey_version_id, session_id): 0011 built
  -- respdoc_export_idx on exactly this shape for exactly this reader. session_id is a ULID
  -- (creation-ordered), one version lives in one hash partition, and the tuple is unique —
  -- so every row is returned exactly once whatever happens between pages, and rows started
  -- after the export began appear at the end or not at all, never in the middle.
  RETURN QUERY
  SELECT d.session_id, d.is_test, d.status::text, d.disposition::text,
         d.vars - v_pii_keys, d.started_at, d.completed_at
    FROM runtime.response_documents d
   WHERE d.survey_version_id = p_survey_version_id
     AND (p_include_test OR NOT d.is_test)
     AND (p_after_session_id IS NULL OR d.session_id > p_after_session_id)
   ORDER BY d.session_id
   LIMIT least(greatest(p_limit, 1), 1000);
END $$;
COMMENT ON FUNCTION app.export_response_page(app.ulid, app.ulid, boolean, int) IS
  'The export worker''s keyset page over runtime.response_documents (roadmap P1-12). '
  'SECURITY DEFINER because ADR-001 gives authoring no path into schema runtime — the same '
  'boundary app.publish_version crosses in the write direction. Re-checks the impersonated '
  'requester (analyst floor, org match via the version) on every call, and strips the '
  'values of pii-flagged variables unless the caller holds pii_access RIGHT NOW. Page shape '
  'is (session_id > last, ORDER BY session_id, LIMIT n) under a fixed survey_version_id — '
  'the primary key''s own order, served by 0011''s respdoc_export_idx.';

REVOKE EXECUTE ON FUNCTION app.export_response_page(app.ulid, app.ulid, boolean, int)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.export_response_page(app.ulid, app.ulid, boolean, int)
  TO authoring;
