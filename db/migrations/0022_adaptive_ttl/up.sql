-- 0022_adaptive_ttl — measured length-of-interview, for the quota reservation TTL (roadmap P2-07).
--
-- E §10.3 states the policy and why it matters: "TTL default is 3x median completion time, computed
-- per survey version from actual completes once there are >= 50 (before that, from the author's
-- estimated LOI). Too short and a slow respondent's reservation vanishes and the cell overfills; too
-- long and abandons hold cells for hours and fieldwork stalls. Making it adaptive from measured LOI
-- is a small piece of code that removes a whole category of 'why is my quota stuck at 94%' support
-- ticket."
--
-- Until now `reservation_ttl_s` was read straight off the authored policy and nothing measured
-- anything, so both failure modes were live: an author who guessed 20 minutes for a 45-minute survey
-- overfilled every cell, and one who guessed 4 hours stalled fieldwork behind abandons.
--
-- ## Why the MEDIAN and not the mean
--
-- Completion times have a long right tail — a respondent who leaves the tab open over lunch records
-- 4 hours. A mean over 200 completes with three such rows is dragged far above anything typical, so
-- the TTL grows to cover a case that is not a slow respondent but an idle browser. The median is
-- unmoved by them, which is exactly the property wanted: the question is "how long does a REAL
-- respondent take", and the tail is not respondents.
--
-- ## Why a threshold of 50
--
-- A median over three completes is noise, and a TTL that swings on the fourth respondent is worse
-- than a fixed guess: fieldwork ops cannot reason about a number that moves. Fifty is the roadmap's
-- figure and is the point where the median is stable enough that the next completion does not
-- meaningfully move it. Below it the authored estimate is used unchanged — a deliberate estimate
-- beats an unstable measurement.
--
-- ## Why TEST sessions are excluded
--
-- A programmer clicking through their own survey in test mode completes it in 40 seconds. Ten such
-- sessions during setup would pull the median down and set a TTL that expires real respondents'
-- reservations mid-survey. Test traffic is excluded here for the same reason
-- `reconcile_quota_counters` excludes it by default.

SET lock_timeout = '3s';
SET statement_timeout = '120s';

/* ------------------------------------------------------------------ *
 * The measurement
 * ------------------------------------------------------------------ */

-- Partial, on exactly the rows the median reads. `duration_s IS NOT NULL` as well as the
-- disposition, because a COMPLETE row whose duration was never stamped contributes nothing and
-- should not be walked.
CREATE INDEX sessions_loi_idx
  ON runtime.sessions (survey_version_id, duration_s)
  WHERE disposition = 'COMPLETE' AND NOT is_test AND duration_s IS NOT NULL;
COMMENT ON INDEX runtime.sessions_loi_idx IS
  'The measured-LOI query''s access path. Partial on completed, non-test, duration-stamped rows — '
  'which in a live survey is a minority of runtime.sessions, so a full index would be mostly dead '
  'weight. Same shape and same reasoning as 0016''s quota_counters_drift_idx.';

CREATE FUNCTION runtime.measured_loi(p_survey_version_id app.ulid)
RETURNS TABLE (completes integer, median_s integer)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = '' SET statement_timeout = '5s'
AS $fn$
  SELECT
    count(*)::int,
    -- percentile_cont over an int column returns double precision; rounded, and NULL when there
    -- are no rows, which the caller distinguishes from zero.
    round(percentile_cont(0.5) WITHIN GROUP (ORDER BY s.duration_s))::int
  FROM runtime.sessions s
  WHERE s.survey_version_id = p_survey_version_id
    AND s.disposition = 'COMPLETE'
    AND NOT s.is_test
    AND s.duration_s IS NOT NULL
    -- A guard, not a filter on outliers: a duration of 0 is a clock artefact and a duration above
    -- a day is an idle browser, and neither is a respondent. The median is robust to a few of
    -- these, and excluding them keeps it robust to many.
    AND s.duration_s > 0
    AND s.duration_s < 86400
$fn$;

COMMENT ON FUNCTION runtime.measured_loi(app.ulid) IS
  'Completed non-test sessions for a version and their MEDIAN duration — E §10.3''s input to the '
  'adaptive reservation TTL. Returns the count as well as the median so the CALLER decides whether '
  'there is enough data (the >= 50 threshold lives in apps/runtime, with the rest of the policy, '
  'rather than being baked into this function): a measurement and a policy about the measurement '
  'are different things, and mixing them would mean a migration to change a threshold. '
  'MEDIAN and not mean because completion times have a long right tail — a respondent who leaves '
  'the tab open over lunch records four hours, and a mean dragged up by three such rows sets a TTL '
  'covering an idle browser rather than a slow respondent. NO ORG PARAMETER (B 2): the version id '
  'is the only key, and the caller is the runtime, which already holds a session pinned to it.';

REVOKE ALL ON FUNCTION runtime.measured_loi(app.ulid) FROM PUBLIC;
-- The runtime's own read. ADR-009 keeps runtime_writer's surface to function signatures, and this
-- is one more signature rather than a table grant — 0020 had to learn that distinction the hard
-- way when it granted INSERT on a table and 0011's standing assertion refused it.
GRANT EXECUTE ON FUNCTION runtime.measured_loi(app.ulid) TO runtime_writer;
-- And the dashboard's, so operations can see the number the TTL is derived from rather than
-- inferring it from behaviour.
GRANT EXECUTE ON FUNCTION runtime.measured_loi(app.ulid) TO authoring;
