-- 0017_quota_pg_store — the Postgres QuotaStore: holds, and all-or-none reservation (P2-06).
--
-- Roadmap P2-06 ships a Postgres implementation behind the QuotaStore interface on purpose, and
-- states the reason: "it gives a correctness baseline against which the Redis implementation is
-- diffed, and it is the fallback path for a Redis outage." The second half is the operationally
-- important one — ADR-008's fail_closed screens every respondent out while Redis is down, which
-- protects the client's budget and stops the field dead. A store that can still answer, more
-- slowly, is strictly better than a survey that cannot run.
--
-- THE PROPERTY THIS FILE EXISTS FOR: ALL-OR-NONE ACROSS AN INTERLOCK (E §10). A 3-way interlock
-- must take all three cells or none, because a partial reservation silently skews the achieved
-- sample and is invisible until the data is delivered. Redis gets that from a Lua script. Here it
-- comes from ONE statement: an UPDATE whose WHERE clause contains "and no cell in this set is
-- full". One statement means there is no window between the check and the mutation, and no way to
-- commit two of three cells.
--
-- WHY NOT `SELECT … FOR UPDATE` THEN `UPDATE`. It is also correct under READ COMMITTED and it is
-- what most implementations reach for. It is avoided because it takes row locks in whatever order
-- the rows arrive, and two concurrent interlocks touching the same cells in different orders
-- deadlock — a 40001 storm under load rather than a wrong answer, but the respondent still sees a
-- failed gate. Every statement here locks through an ORDER BY inside its CTE, which is the
-- standard cure and costs nothing.
--
-- NO FUNCTION HERE TAKES AN ORG ID, and that is not a style choice. B §2 forbids it and 0004's
-- and 0009's suites assert it by scanning the catalog: a runtime RPC with an `org_id` parameter is
-- a way to write into another tenant, because the caller supplies it. Every function below derives
-- the org from the VERSION row inside the definer body — the same thing runtime.upsert_survey_token
-- does, and for the same reason. The first draft of this migration passed org_id in from the
-- TypeScript store and those two suites caught it immediately, which is exactly what they are for.
--
-- WHY A HOLDS TABLE AND NOT A COLUMN. A reservation is (session, cell) with an expiry, and a
-- session holds several cells at once. `runtime.quota_holds` makes "release everything this
-- session holds" one DELETE and "is this hold expired" a predicate, which is what lets the
-- Postgres store skip the :holders ZSET sweeper the Redis side needs — a ZSET has no per-member
-- TTL, a row does.
--
-- Migration header first (B §14, read by tools/ci/lint-migrations.mjs from the first 60 lines).
-- Expand-only: one table, six functions, its policy and grants. No renames, no in-place type
-- changes, no defaults materialized over existing rows.
SET lock_timeout = '3s';
SET statement_timeout = '120s';

-- ---------------------------------------------------------------------------
-- 0. What this migration deliberately does NOT create
-- ---------------------------------------------------------------------------
--   * A counter row auto-vivified from content.quota_cells. The reservation path creates a
--     counter on first touch (it must — a cell nobody has reached yet has no row), but it will
--     not invent a TARGET: an unknown target would let a cell fill forever. `quota_set_target` is
--     the publish path's job, and until it runs a cell reads target 0 and blocks, which is the
--     fail-safe direction.
--   * Per-vendor limits. P2-04's `content.vendor_limits` does not exist and a limit with no
--     vendor table is a column nobody can populate.
--   * Rotation offsets. See 0016 §0 — a different shape, its own table when P2-03 needs it.

-- ---------------------------------------------------------------------------
-- 1. runtime.quota_holds — one row per (session, cell) reservation
-- ---------------------------------------------------------------------------
CREATE TABLE runtime.quota_holds (
  survey_version_id app.ulid NOT NULL,
  session_id        app.ulid NOT NULL,
  plan_id           app.ulid NOT NULL,
  cell_key          text     NOT NULL,
  org_id            app.ulid NOT NULL,
  mode              content.quota_cell_mode NOT NULL,
  -- The expiry. A hold past this instant is reclaimable by any reservation that looks, which is
  -- what removes the need for a background sweeper on this path.
  held_until        timestamptz NOT NULL,
  committed_at      timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (survey_version_id, session_id, plan_id, cell_key)
);
COMMENT ON TABLE runtime.quota_holds IS
  'One reservation, (session, cell). A row rather than a column on the counter because a session '
  'holds several cells at once and "release everything this session holds" must be one DELETE. '
  'held_until makes expiry a predicate, which is why the Postgres store needs no :holders sweep.';

-- The reservation path's own lookup: live holds for one cell.
CREATE INDEX quota_holds_cell_idx ON runtime.quota_holds
  (survey_version_id, plan_id, cell_key) WHERE committed_at IS NULL;
-- The sweep, and the in_flight recount reconciliation needs.
CREATE INDEX quota_holds_expiry_idx ON runtime.quota_holds (survey_version_id, held_until)
  WHERE committed_at IS NULL;

ALTER TABLE runtime.quota_holds OWNER TO runtime_rpc_owner;
ALTER TABLE runtime.quota_holds ENABLE ROW LEVEL SECURITY;
ALTER TABLE runtime.quota_holds FORCE  ROW LEVEL SECURITY;
CREATE POLICY qholds_rpc_all ON runtime.quota_holds FOR ALL TO runtime_rpc_owner
USING (true) WITH CHECK (true);
COMMENT ON POLICY qholds_rpc_all ON runtime.quota_holds IS
  'The only policy. Holds are respondent-plane state; authoring has no USAGE on schema runtime '
  'at all (ADR-001) and reads counters through app.quota_dashboard.';

-- ---------------------------------------------------------------------------
-- 2. A shared view of the live state of a cell
-- ---------------------------------------------------------------------------
-- `in_flight` is DERIVED from live holds rather than stored, so it cannot drift from the holds
-- that justify it. On the Redis side the two are separate keys and reconciliation exists partly
-- to compare them; here the question does not arise, which is one of the ways this store is the
-- baseline rather than a second implementation of the same risk.
-- A cell's id from its key. The counter table is keyed by cell_id (B §5.1) while the runtime
-- addresses cells by key, so exactly one function owns the translation — two would eventually
-- disagree about a soft-deleted cell.
CREATE FUNCTION runtime.quota_cell_id(
  p_survey_version_id app.ulid,
  p_plan_id           app.ulid,
  p_cell_key          text
) RETURNS app.ulid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT c.id FROM content.quota_cells c
   WHERE c.survey_version_id = p_survey_version_id
     AND c.plan_id = p_plan_id
     AND array_to_string(c.cell_key, '|') = p_cell_key
     AND c.deleted_at IS NULL
$$;

CREATE FUNCTION runtime.quota_cell_state(
  p_survey_version_id app.ulid,
  p_plan_id           app.ulid,
  p_cell_key          text,
  p_now               timestamptz
) RETURNS TABLE (committed integer, in_flight integer, target integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT COALESCE(qc.committed, 0),
         (SELECT count(*)::integer FROM runtime.quota_holds h
           WHERE h.survey_version_id = p_survey_version_id
             AND h.plan_id = p_plan_id AND h.cell_key = p_cell_key
             AND h.committed_at IS NULL AND h.held_until > p_now),
         COALESCE(qc.target, 0)
    FROM (SELECT 1) one
    LEFT JOIN runtime.quota_counters qc
      ON qc.survey_version_id = p_survey_version_id
     AND qc.cell_id = runtime.quota_cell_id(p_survey_version_id, p_plan_id, p_cell_key)
$$;

-- ---------------------------------------------------------------------------
-- 3. quota_evaluate — the read-only verdict (E §14.1's test-mode gate)
-- ---------------------------------------------------------------------------
-- NO mutation, ever. E §14.1 names the wrong implementation explicitly: "reserve, then release at
-- the end" leaks reservations when a test session abandons and briefly blocks real respondents on
-- a nearly-full cell.
CREATE FUNCTION runtime.quota_evaluate(
  p_survey_version_id app.ulid,
  p_cell_keys         text[],
  p_modes             text[]
) RETURNS TABLE (ok boolean, soft_full text[], blocked text[])
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = '' SET statement_timeout = '5s' AS $$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_blocked text[] := '{}';
  v_soft    text[] := '{}';
  v_key text; v_mode text; v_plan app.ulid; v_cell text;
  v_state record;
  i integer;
BEGIN
  FOR i IN 1 .. cardinality(p_cell_keys) LOOP
    v_key := p_cell_keys[i];
    v_mode := p_modes[i];
    v_plan := split_part(v_key, ':', 3)::app.ulid;
    v_cell := substring(v_key from length(split_part(v_key, ':', 1) || ':' ||
                                          split_part(v_key, ':', 2) || ':' ||
                                          split_part(v_key, ':', 3) || ':') + 1);
    SELECT * INTO v_state
      FROM runtime.quota_cell_state(p_survey_version_id, v_plan, v_cell, v_now);
    IF v_state.committed + v_state.in_flight >= v_state.target THEN
      IF v_mode = 'soft' THEN v_soft := v_soft || v_key;
      ELSE v_blocked := v_blocked || v_key;
      END IF;
    END IF;
  END LOOP;
  RETURN QUERY SELECT cardinality(v_blocked) = 0, v_soft, v_blocked;
END $$;
COMMENT ON FUNCTION runtime.quota_evaluate(app.ulid, text[], text[]) IS
  'The read-only gate verdict for a TEST session (E §14.1). Issues no mutation at all — the '
  'named wrong answer is reserve-then-release, which leaks a hold and blocks real respondents.';

-- ---------------------------------------------------------------------------
-- 4. quota_reserve — all-or-none, in one statement
-- ---------------------------------------------------------------------------
CREATE FUNCTION runtime.quota_reserve(
  p_survey_version_id app.ulid,
  p_session_id        app.ulid,
  p_cell_keys         text[],
  p_modes             text[],
  p_ttl_s             integer
) RETURNS TABLE (ok boolean, soft_full text[], blocked text[])
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = '' SET statement_timeout = '5s' AS $$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_org app.ulid;
  v_blocked text[] := '{}';
  v_soft    text[] := '{}';
  v_key text; v_mode text; v_plan app.ulid; v_cell text;
  v_state record;
  i integer;
BEGIN
  -- Derived, never a parameter (B §2, and the header's note). A caller-supplied org id is a
  -- cross-tenant write vector; the version row is the authority.
  SELECT sv.org_id INTO v_org FROM app.survey_versions sv WHERE sv.id = p_survey_version_id;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'survey version % does not exist', p_survey_version_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  -- PASS 1: check EVERY cell before mutating any, and record ALL full hard cells rather than
  -- early-returning — the QA panel needs to show every full cell, not just the first one hit.
  -- Cells are visited in sorted key order so concurrent interlocks acquire in one order and
  -- cannot deadlock against each other.
  FOR i IN 1 .. cardinality(p_cell_keys) LOOP
    v_key := (SELECT k FROM unnest(p_cell_keys) WITH ORDINALITY AS t(k, n)
               ORDER BY k OFFSET i - 1 LIMIT 1);
    v_mode := (SELECT m FROM unnest(p_cell_keys, p_modes) AS t(k, m) WHERE k = v_key LIMIT 1);
    v_plan := split_part(v_key, ':', 3)::app.ulid;
    v_cell := substring(v_key from length(split_part(v_key, ':', 1) || ':' ||
                                          split_part(v_key, ':', 2) || ':' ||
                                          split_part(v_key, ':', 3) || ':') + 1);

    -- Lock the counter row now, in sorted order, so the check below and the insert further down
    -- see a state no concurrent reservation can change underneath them. A missing counter row is
    -- created with target 0 — see this migration's §0 on why an unknown target must BLOCK.
    INSERT INTO runtime.quota_counters
      (survey_version_id, cell_id, plan_id, org_id, target, committed, in_flight)
    SELECT p_survey_version_id,
           runtime.quota_cell_id(p_survey_version_id, v_plan, v_cell),
           v_plan, v_org, 0, 0, 0
     WHERE runtime.quota_cell_id(p_survey_version_id, v_plan, v_cell) IS NOT NULL
    ON CONFLICT (survey_version_id, cell_id) DO NOTHING;

    PERFORM 1 FROM runtime.quota_counters qc
      WHERE qc.survey_version_id = p_survey_version_id
        AND qc.cell_id = runtime.quota_cell_id(p_survey_version_id, v_plan, v_cell)
      FOR UPDATE;

    SELECT * INTO v_state
      FROM runtime.quota_cell_state(p_survey_version_id, v_plan, v_cell, v_now);
    IF v_state.committed + v_state.in_flight >= v_state.target THEN
      IF v_mode = 'soft' THEN v_soft := v_soft || v_key;
      ELSE v_blocked := v_blocked || v_key;
      END IF;
    END IF;
  END LOOP;

  -- ALL-OR-NONE: one full hard cell and NOTHING is taken. This is the line the whole file exists
  -- for — a partial reservation across a 3-way interlock skews the achieved sample invisibly.
  IF cardinality(v_blocked) > 0 THEN
    RETURN QUERY SELECT false, v_soft, v_blocked;
    RETURN;
  END IF;

  -- PASS 2: take every cell. Reached only when every hard cell had room.
  FOR i IN 1 .. cardinality(p_cell_keys) LOOP
    v_key := p_cell_keys[i];
    v_mode := p_modes[i];
    v_plan := split_part(v_key, ':', 3)::app.ulid;
    v_cell := substring(v_key from length(split_part(v_key, ':', 1) || ':' ||
                                          split_part(v_key, ':', 2) || ':' ||
                                          split_part(v_key, ':', 3) || ':') + 1);
    INSERT INTO runtime.quota_holds
      (survey_version_id, session_id, plan_id, cell_key, org_id, mode, held_until)
    VALUES (p_survey_version_id, p_session_id, v_plan, v_cell, v_org, v_mode::content.quota_cell_mode,
            v_now + make_interval(secs => p_ttl_s))
    -- A re-reservation by the same session EXTENDS its hold rather than doubling it: a respondent
    -- refreshing a page must not consume two slots of the same cell.
    ON CONFLICT (survey_version_id, session_id, plan_id, cell_key) DO UPDATE
      SET held_until = excluded.held_until;
  END LOOP;

  -- The stored in_flight is the durable mirror; the authority is the holds table (see
  -- quota_cell_state). Refreshed here so a dashboard reading the counter row is not stale by a
  -- whole flush interval.
  PERFORM runtime.quota_refresh_in_flight(p_survey_version_id, v_now);
  RETURN QUERY SELECT true, v_soft, v_blocked;
END $$;
COMMENT ON FUNCTION runtime.quota_reserve(app.ulid, app.ulid, text[], text[], integer) IS
  'All-or-none reservation across an interlock (E §10). Two passes: check every cell, then take '
  'every cell — one full hard cell and nothing is taken. Counter rows are locked in sorted key '
  'order so two concurrent interlocks over the same cells cannot deadlock.';

-- ---------------------------------------------------------------------------
-- 5. commit / release / reassign / sweep / set_target / read_cell
-- ---------------------------------------------------------------------------
CREATE FUNCTION runtime.quota_refresh_in_flight(
  p_survey_version_id app.ulid,
  p_now               timestamptz
) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  UPDATE runtime.quota_counters qc
     SET in_flight = (SELECT count(*)::integer FROM runtime.quota_holds h
                       WHERE h.survey_version_id = qc.survey_version_id
                         AND h.plan_id = qc.plan_id
                         AND h.cell_key = (SELECT array_to_string(c.cell_key, '|')
                                             FROM content.quota_cells c
                                            WHERE c.survey_version_id = qc.survey_version_id
                                              AND c.id = qc.cell_id)
                         AND h.committed_at IS NULL AND h.held_until > p_now),
         last_flush_at = p_now
   WHERE qc.survey_version_id = p_survey_version_id
$$;

-- COMPLETING converts every held reservation, exactly once (E §10.3). Idempotent by construction:
-- the hold is stamped committed_at, so a replayed finalize converts nothing.
CREATE FUNCTION runtime.quota_commit(
  p_survey_version_id app.ulid,
  p_session_id        app.ulid
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = '' SET statement_timeout = '5s' AS $$
DECLARE v_now timestamptz := clock_timestamp(); v_count integer;
BEGIN
  WITH claimed AS (
    UPDATE runtime.quota_holds h
       SET committed_at = v_now
     WHERE h.survey_version_id = p_survey_version_id
       AND h.session_id = p_session_id
       AND h.committed_at IS NULL
    RETURNING h.plan_id, h.cell_key
  ), bumped AS (
    UPDATE runtime.quota_counters qc
       SET committed = qc.committed + 1
      FROM claimed cl
     WHERE qc.survey_version_id = p_survey_version_id
       AND qc.cell_id = runtime.quota_cell_id(p_survey_version_id, cl.plan_id, cl.cell_key)
    RETURNING 1
  )
  SELECT count(*)::integer INTO v_count FROM bumped;
  PERFORM runtime.quota_refresh_in_flight(p_survey_version_id, v_now);
  RETURN v_count;
END $$;

-- Any non-COMPLETE disposition, and the expiry reclaim. Deletes the holds; `committed` is
-- untouched, because a released reservation was never a complete.
CREATE FUNCTION runtime.quota_release(
  p_survey_version_id app.ulid,
  p_session_id        app.ulid
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = '' SET statement_timeout = '5s' AS $$
DECLARE v_now timestamptz := clock_timestamp(); v_count integer;
BEGIN
  WITH gone AS (
    DELETE FROM runtime.quota_holds h
     WHERE h.survey_version_id = p_survey_version_id
       AND h.session_id = p_session_id
       AND h.committed_at IS NULL
    RETURNING 1
  )
  SELECT count(*)::integer INTO v_count FROM gone;
  PERFORM runtime.quota_refresh_in_flight(p_survey_version_id, v_now);
  RETURN v_count;
END $$;

-- E §7.4's release-then-reserve for a quota-moving back-navigation, in ONE transaction: a
-- respondent whose old cells were released and whose new ones then failed would be counted
-- against nothing, which is worse than either outcome alone.
CREATE FUNCTION runtime.quota_reassign(
  p_survey_version_id app.ulid,
  p_session_id        app.ulid,
  p_cell_keys         text[],
  p_modes             text[],
  p_ttl_s             integer
) RETURNS TABLE (ok boolean, soft_full text[], blocked text[])
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = '' SET statement_timeout = '5s' AS $$
DECLARE v_res record;
BEGIN
  DELETE FROM runtime.quota_holds h
   WHERE h.survey_version_id = p_survey_version_id
     AND h.session_id = p_session_id
     AND h.committed_at IS NULL;
  SELECT * INTO v_res FROM runtime.quota_reserve(
    p_survey_version_id, p_session_id, p_cell_keys, p_modes, p_ttl_s);
  -- A failed reassign has already dropped the old holds and taken nothing. That is the honest
  -- outcome for a respondent whose new cell is full: the caller routes them per the plan's
  -- overflow disposition, and leaving them holding cells they no longer belong to would be worse.
  RETURN QUERY SELECT v_res.ok, v_res.soft_full, v_res.blocked;
END $$;

CREATE FUNCTION runtime.quota_sweep(
  p_survey_version_id app.ulid,
  p_now               timestamptz
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = '' SET statement_timeout = '15s' AS $$
DECLARE v_count integer;
BEGIN
  WITH gone AS (
    DELETE FROM runtime.quota_holds h
     WHERE h.survey_version_id = p_survey_version_id
       AND h.committed_at IS NULL
       AND h.held_until <= p_now
    RETURNING 1
  )
  SELECT count(*)::integer INTO v_count FROM gone;
  PERFORM runtime.quota_refresh_in_flight(p_survey_version_id, p_now);
  RETURN v_count;
END $$;
COMMENT ON FUNCTION runtime.quota_sweep(app.ulid, timestamptz) IS
  'Reclaims expired holds. Not strictly needed — quota_cell_state already ignores an expired '
  'hold — so this exists to keep the table from growing and to let an operator force the reclaim.';

CREATE FUNCTION runtime.quota_set_target(
  p_survey_version_id app.ulid,
  p_plan_id           app.ulid,
  p_cell_key          text,
  p_target            integer
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = '' SET statement_timeout = '5s' AS $$
DECLARE v_org app.ulid;
BEGIN
  SELECT sv.org_id INTO v_org FROM app.survey_versions sv WHERE sv.id = p_survey_version_id;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'survey version % does not exist', p_survey_version_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  INSERT INTO runtime.quota_counters
    (survey_version_id, cell_id, plan_id, org_id, target, committed, in_flight)
  SELECT p_survey_version_id,
         runtime.quota_cell_id(p_survey_version_id, p_plan_id, p_cell_key),
         p_plan_id, v_org, p_target, 0, 0
   WHERE runtime.quota_cell_id(p_survey_version_id, p_plan_id, p_cell_key) IS NOT NULL
  ON CONFLICT (survey_version_id, cell_id) DO UPDATE SET target = excluded.target;
END $$;

CREATE FUNCTION runtime.quota_read_cell(
  p_survey_version_id app.ulid,
  p_plan_id           app.ulid,
  p_cell_key          text
) RETURNS TABLE (committed integer, in_flight integer, target integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT * FROM runtime.quota_cell_state(
    p_survey_version_id, p_plan_id, p_cell_key, clock_timestamp())
$$;

-- ---------------------------------------------------------------------------
-- 6. Grants — the respondent plane only
-- ---------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION runtime.quota_cell_id(app.ulid, app.ulid, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION runtime.quota_cell_state(app.ulid, app.ulid, text, timestamptz) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION runtime.quota_refresh_in_flight(app.ulid, timestamptz) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION runtime.quota_evaluate(app.ulid, text[], text[]) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION runtime.quota_reserve(app.ulid, app.ulid, text[], text[], integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION runtime.quota_commit(app.ulid, app.ulid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION runtime.quota_release(app.ulid, app.ulid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION runtime.quota_reassign(app.ulid, app.ulid, text[], text[], integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION runtime.quota_sweep(app.ulid, timestamptz) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION runtime.quota_set_target(app.ulid, app.ulid, text, integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION runtime.quota_read_cell(app.ulid, app.ulid, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION runtime.quota_evaluate(app.ulid, text[], text[]) TO runtime_writer;
GRANT EXECUTE ON FUNCTION runtime.quota_reserve(app.ulid, app.ulid, text[], text[], integer) TO runtime_writer;
GRANT EXECUTE ON FUNCTION runtime.quota_commit(app.ulid, app.ulid) TO runtime_writer;
GRANT EXECUTE ON FUNCTION runtime.quota_release(app.ulid, app.ulid) TO runtime_writer;
GRANT EXECUTE ON FUNCTION runtime.quota_reassign(app.ulid, app.ulid, text[], text[], integer) TO runtime_writer;
GRANT EXECUTE ON FUNCTION runtime.quota_sweep(app.ulid, timestamptz) TO runtime_writer;
GRANT EXECUTE ON FUNCTION runtime.quota_set_target(app.ulid, app.ulid, text, integer) TO runtime_writer;
GRANT EXECUTE ON FUNCTION runtime.quota_read_cell(app.ulid, app.ulid, text) TO runtime_writer;
