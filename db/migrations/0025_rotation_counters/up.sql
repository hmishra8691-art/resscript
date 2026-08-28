-- 0025_rotation_counters — the shared ticket counter-backed randomization runs on (roadmap P2-03).
--
-- ## Why this table and not runtime.quota_counters
--
-- P2-03's DB line says "counter rows for rotation offsets, reusing `runtime.quota_counters` shape",
-- and 0016 declined the literal reading with a reason worth keeping:
--
--   "The roadmap says 'reusing runtime.quota_counters shape', which is a shape and not this table:
--    a rotation offset has no target, no in_flight and no cell key, and overloading a hot counter
--    table with a second meaning is how a query grows a `WHERE kind = ...` nobody expected. It gets
--    its own narrow table when that milestone lands."
--
-- This is that table. Two columns of substance: a key and a monotonically issued count.
--
-- ## Redis is the arbiter; this is the durable record
--
-- Same division ADR-008 sets for quotas, for the same reason: a ticket has to be handed out on the
-- respondent's critical path, and a Postgres round trip per entry is not that. Redis `INCR` issues;
-- this table records, by write-behind.
--
-- The consequence is stated rather than discovered: after a Redis flush the counter restarts from
-- whatever this table last recorded, so a handful of respondents can receive a ticket somebody
-- already had. For a ROTATION that is a rounding error — two respondents seeing the same brand order
-- out of a thousand — which is why rotation can live on a best-effort counter while a quota cannot.
-- `runtime.rotation_seed_from_db` is what makes the restart pick up near where it left off rather
-- than at zero.
--
-- ## Why `issued` and not `next`
--
-- The column records how many tickets have been HANDED OUT, so it is monotonic and a write-behind
-- flush is `GREATEST(existing, incoming)` — idempotent, order-independent, and safe to replay. A
-- `next` column would be the same number with an off-by-one nobody can audit, and a flush that
-- overwrote rather than maximised would let a late, stale write move the counter backwards and
-- re-issue a whole block of tickets.

SET lock_timeout = '3s';
SET statement_timeout = '120s';

CREATE TABLE runtime.rotation_counters (
  survey_version_id app.ulid NOT NULL,
  -- The counter's scope, opaque here on purpose: `apps/runtime` composes it from the axis and the
  -- spec's salt, and a rotation over question options, over a battery's shared group and over a
  -- randomizer's flow targets are three different keys with no structure this table needs to parse.
  -- A CHECK on its shape would be a second place to change when a new axis appears.
  counter_key       text NOT NULL,
  -- Tickets HANDED OUT. See the header on why this and not `next`.
  issued            bigint NOT NULL DEFAULT 0,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (survey_version_id, counter_key),
  CONSTRAINT rotation_counters_key_bounded CHECK (length(counter_key) BETWEEN 1 AND 200),
  CONSTRAINT rotation_counters_issued_nonneg CHECK (issued >= 0)
);

COMMENT ON TABLE runtime.rotation_counters IS
  'The durable record of counter-backed randomization tickets (E §8.4, roadmap P2-03). Redis is the '
  'arbiter — a ticket is issued on the respondent''s critical path and a Postgres round trip per '
  'entry is not that — and this is written behind it, exactly as ADR-008 divides the quota '
  'counters. ITS OWN TABLE and not runtime.quota_counters, which 0016 refused to overload: a '
  'rotation offset has no target, no in_flight and no cell key. NOT VERSION-FROZEN in the '
  'content sense — a counter belongs to a fielding version and keeps counting across a republish '
  'of the same version, which is what makes rotation even over a wave rather than restarting at '
  'every deploy.';
COMMENT ON COLUMN runtime.rotation_counters.issued IS
  'How many tickets have been handed out — monotonic, so the write-behind flush is '
  'GREATEST(existing, incoming): idempotent, order-independent and safe to replay. A `next` column '
  'would be the same number with an off-by-one nobody can audit, and a flush that overwrote rather '
  'than maximised would let a late stale write move the counter backwards and re-issue a whole '
  'block of tickets.';

CREATE INDEX rotation_counters_version_idx ON runtime.rotation_counters (survey_version_id);

/* ------------------------------------------------------------------ *
 * The write-behind flush
 * ------------------------------------------------------------------ */

CREATE FUNCTION runtime.flush_rotation_counters(p_rows jsonb)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = '' SET statement_timeout = '15s' AS $fn$
DECLARE
  v_n integer;
BEGIN
  IF pg_catalog.jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'flush_rotation_counters: expected a JSON array' USING ERRCODE = '22023';
  END IF;

  INSERT INTO runtime.rotation_counters (survey_version_id, counter_key, issued, updated_at)
  SELECT (r->>'v')::app.ulid, r->>'k', (r->>'i')::bigint, pg_catalog.clock_timestamp()
    FROM pg_catalog.jsonb_array_elements(p_rows) AS r
   WHERE r->>'v' IS NOT NULL AND r->>'k' IS NOT NULL AND r->>'i' IS NOT NULL
  ON CONFLICT (survey_version_id, counter_key) DO UPDATE
    -- GREATEST, never assignment. A drain batch can arrive out of order after a retry, and an
    -- overwrite would move the counter BACKWARDS and re-issue tickets that were already handed
    -- out. 0016's flush_quota_counters guards the same hazard with `WHERE excluded.redis_epoch >
    -- qc.redis_epoch`; a monotonic counter needs no epoch because the value IS the epoch.
    -- GREATEST unqualified: it is a SQL construct, not a catalog function, so `pg_catalog.greatest`
    -- does not resolve even under an empty search_path — and being a construct it needs no
    -- qualification to be safe from search_path games.
    SET issued = GREATEST(runtime.rotation_counters.issued, excluded.issued),
        updated_at = pg_catalog.clock_timestamp();

  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $fn$;

COMMENT ON FUNCTION runtime.flush_rotation_counters(jsonb) IS
  'Write-behind for the rotation tickets. GREATEST rather than assignment, so an out-of-order or '
  'replayed batch cannot move a counter backwards and re-issue a block of tickets — the hazard '
  '0016''s flush_quota_counters needed a redis_epoch to guard, which a monotonic counter does not '
  'because the value IS the epoch. NO ORG PARAMETER (B §2): each row carries its own version id.';

/**
 * What Redis should start from after a flush, so a restart resumes near where it stopped.
 *
 * Deliberately returns the RECORDED value and not that value plus a safety margin. A margin would
 * skip tickets, and skipping is not free: a rotation with gaps is no longer even. Re-issuing a
 * handful is the cheaper error for this feature, and the header says so.
 */
CREATE FUNCTION runtime.rotation_seed_from_db(p_survey_version_id app.ulid)
RETURNS TABLE (counter_key text, issued bigint)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = '' SET statement_timeout = '10s'
AS $fn$
  SELECT rc.counter_key, rc.issued
    FROM runtime.rotation_counters rc
   WHERE rc.survey_version_id = p_survey_version_id
   ORDER BY rc.counter_key
$fn$;

COMMENT ON FUNCTION runtime.rotation_seed_from_db(app.ulid) IS
  'Every recorded ticket count for a version, for rebuilding Redis after a flush. Returns the '
  'RECORDED value and not that plus a margin: a margin would skip tickets, and a rotation with '
  'gaps is no longer even. Re-issuing a handful is the cheaper error here — which is exactly why '
  'rotation can live on a best-effort counter and a quota cannot.';

/* ------------------------------------------------------------------ *
 * Posture
 * ------------------------------------------------------------------ */

ALTER TABLE runtime.rotation_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE runtime.rotation_counters FORCE ROW LEVEL SECURITY;
-- No policies and no table grants. Every reader and writer goes through the two definer functions
-- above, which keeps `runtime_writer`'s capability surface a set of FUNCTION SIGNATURES — ADR-009
-- risk R3, and the posture 0011's standing assertion enforces. 0020 had to learn that the hard way
-- when it granted INSERT on a table and that assertion refused it.

REVOKE ALL ON FUNCTION runtime.flush_rotation_counters(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION runtime.rotation_seed_from_db(app.ulid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION runtime.flush_rotation_counters(jsonb) TO runtime_writer;
GRANT EXECUTE ON FUNCTION runtime.rotation_seed_from_db(app.ulid) TO runtime_writer;
