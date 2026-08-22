-- 0013_field_stats — app.field_stats, the studio's response counter (roadmap P1-12).
--
-- Roadmap P1-12 Frontend asks for a "response counter and a simple field dashboard (entries,
-- completes, screenouts, dispositions)", and every one of those numbers lives in
-- runtime.sessions — a table `authoring` cannot reach AT ALL (ADR-001's plane boundary:
-- 0011's suite asserts authoring has no USAGE on schema runtime). This migration is the one
-- bridge that read needs: a single SECURITY DEFINER counter, on the same terms as 0012's
-- app.export_response_page, which crosses the identical boundary for the export worker.
-- Nothing else is new — no table, no policy, no column.
--
-- WHAT THE FUNCTION RETURNS, and the two decisions inside it:
--
--   1. Counts grouped by disposition, with sessions still in flight (disposition IS NULL,
--      status = 'active') returned under the label 'IN_PROGRESS'. That is not an invention:
--      K §2's registry names IN_PROGRESS as exactly this state, and the runtime stores it as
--      NULL only because a flow node never writes it (runtime.disposition's comment). One
--      spelling on the wire means the studio never renders "null" as a disposition and never
--      re-derives the mapping.
--
--   2. is_test rows are EXCLUDED unless p_include_test — the P1-11 acceptance line verbatim
--      ("excluded from the default response count shown in studio") and the same default as
--      app.exports.include_test and app.export_response_page. Three readers, one default,
--      because a dashboard that counted test traffic while the export excluded it would send
--      a project manager chasing a discrepancy that is actually a flag.
--
-- THE FLOOR IS ANALYST, checked FIRST: response counts are respondent data in aggregate —
-- the same plane exports read from (security §7.1 puts every response-data surface at ANL+)
-- — and the floor precedes the org check so a caller with no standing learns nothing about
-- whether the version exists. The org check answers "no such version" and "another org's
-- version" with ONE error (P0002), 0004's existence-oracle rule, exactly as
-- export_response_page does.
--
-- WHY A FUNCTION AND NOT A POLICY: there is nothing to attach a policy to — authoring holds
-- no USAGE on schema runtime, and granting it for one aggregate would trade a documented
-- plane boundary for a count. The definer function IS the narrow interface: it can return
-- only what its RETURNS TABLE names, and it re-checks the caller on every call.
--
-- Migration header first (B §14, read by tools/ci/lint-migrations.mjs from the first 60
-- lines). Everything here is expand-only: one read function, its grants. No tables, no
-- renames, no in-place type changes, no defaults materialized over existing rows.
SET lock_timeout = '3s';
SET statement_timeout = '120s';

-- ---------------------------------------------------------------------------
-- 0. What this migration deliberately does NOT create
-- ---------------------------------------------------------------------------
--   * Time-bucketed series, per-vendor splits, quota fill, completion rates by device —
--     the P4 field dashboard. This function answers the P1-12 sentence and nothing more,
--     so adding a dimension is a new function with its own review, not a widened one.
--   * A viewer-floor variant. If the matrix ever wants the bare counter below ANL, that is
--     a deliberate loosening to make in review, not a default to walk back.
--   * An index. sessions_version_started_idx (0011) already leads on survey_version_id, and
--     one version's sessions land in exactly ONE hash partition — the GROUP BY scans only
--     the rows it counts.

-- ---------------------------------------------------------------------------
-- 1. app.field_stats (roadmap P1-12 frontend's read; P1-11's acceptance default)
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.field_stats(
  p_survey_version_id app.ulid,
  p_include_test      boolean DEFAULT false  -- E §14.1: test rows out unless asked for
) RETURNS TABLE (
  disposition text,
  sessions    bigint
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = '' SET statement_timeout = '15s' AS $$
BEGIN
  -- Floor first: a caller with no standing learns nothing about whether the version exists.
  IF NOT app.has_role('analyst') THEN
    RAISE EXCEPTION 'reading field stats requires the analyst role or above'
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

  -- One version = one hash partition, and sessions_version_started_idx leads on the version,
  -- so this is a partition-local scan of exactly the rows counted. NULL disposition is a
  -- session still in flight, spelled IN_PROGRESS on the wire — see the header, decision 1.
  RETURN QUERY
  SELECT coalesce(s.disposition::text, 'IN_PROGRESS'), count(*)
    FROM runtime.sessions s
   WHERE s.survey_version_id = p_survey_version_id
     AND (p_include_test OR NOT s.is_test)
   GROUP BY 1
   ORDER BY 1;
END $$;
COMMENT ON FUNCTION app.field_stats(app.ulid, boolean) IS
  'The studio''s field dashboard counter (roadmap P1-12): sessions grouped by disposition '
  'for one version, in-flight sessions (disposition IS NULL) returned as IN_PROGRESS (K §2''s '
  'name for that state), is_test rows EXCLUDED unless asked for (the P1-11 acceptance '
  'default, shared with app.exports.include_test and app.export_response_page). SECURITY '
  'DEFINER because ADR-001 gives authoring no path into schema runtime — the same boundary '
  'app.export_response_page crosses for the export worker. Re-checks the caller on every '
  'call: analyst floor first, then the org match via the version, one P0002 for "no such '
  'version" and "another org''s version" alike.';

REVOKE EXECUTE ON FUNCTION app.field_stats(app.ulid, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.field_stats(app.ulid, boolean) TO authoring;
