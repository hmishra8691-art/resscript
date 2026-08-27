-- 0016_quota_model — the quota definitions, cells and counters (roadmap P2-06, P2-07, P2-08).
--
-- Roadmap P2-06's DB line, in full: "content.quota_dimensions, content.quota_buckets,
-- content.quota_plans (with qplan_marginal_one_dim), content.quota_cells with cell_key text[],
-- runtime.quota_counters including redis_epoch, counter_scope on the plan policy." P2-07 adds
-- runtime.flush_quota_counters; P2-08 adds reconciled_at / reconciled_committed and the partial
-- drift index. All three land here, in ONE migration, because they are one table's finished shape
-- plus the two functions that read and write it — and B §16.3's warning about adding columns to a
-- hot table under load applies to quota_counters specifically. Building it complete before any
-- counter exists costs nothing; adding reconciled_committed to a live counter table during
-- fieldwork is the migration nobody wants to run.
--
-- WHY THE CONTENT SIDE IS FOUR TABLES AND NOT ONE JSONB COLUMN. `app.survey_versions` could carry
-- the whole quota config as jsonb, and the artifact does exactly that (quotas.json). The authoring
-- side does not, for the reason B §5 gives about junction tables: the compile-time feasibility
-- check ("is any cell unreachable", "do the interlocked targets exceed the marginal target on the
-- same dimension") is a JOIN over rows, and against jsonb it is a walk in application code that
-- cannot be indexed and cannot be checked by a constraint. `cell_key text[]` in particular is
-- what makes "which cell does this bucket tuple name" an index lookup rather than a scan.
--
-- WHY `qplan_marginal_one_dim` IS A CHECK AND NOT A COMMENT. 03 §8 makes interlocked and marginal
-- plans different mathematical objects: an interlocked plan's cells are the cross-product of every
-- dimension, a marginal plan's cells are per-dimension and independent. A marginal plan over two
-- dimensions is not a plan with fewer cells — it is two plans, and treating it as one is how a
-- sample plan silently becomes unfillable. The constraint refuses the ambiguous row.
--
-- WHY COUNTERS LIVE IN `runtime` AND NOT `content`. ADR-008 makes Redis the arbiter and Postgres
-- the durable record; a counter is respondent-plane data written by the runtime, and the plane
-- boundary (ADR-001) puts it in `runtime` with no authoring grant at all. The studio's dashboard
-- reads it through a SECURITY DEFINER function, on the same terms as app.field_stats (0013) and
-- app.export_response_page (0012) — the two functions that already cross this boundary.
--
-- Migration header first (B §14, read by tools/ci/lint-migrations.mjs from the first 60 lines).
-- Everything here is expand-only: four content tables, one runtime table, two functions, their
-- policies, triggers and grants. No renames, no in-place type changes, no defaults materialized
-- over existing rows.
SET lock_timeout = '3s';
SET statement_timeout = '120s';

-- ---------------------------------------------------------------------------
-- 0. What this migration deliberately does NOT create
-- ---------------------------------------------------------------------------
--   * `content.vendor_limits`. P2-04's DB line names it beside content.vendors, and neither
--     exists yet — vendors reach the runtime through the artifact today. A per-vendor quota
--     override is a plan-level concept (`quota_plan_overrides` on the vendor), so it belongs
--     with the vendor table, in the migration that creates it.
--   * Rotation-offset counters for P2-03's `rotate` / `even_distribution`. The roadmap says
--     "reusing runtime.quota_counters shape", which is a shape and not this table: a rotation
--     offset has no target, no in_flight and no cell key, and overloading a hot counter table
--     with a second meaning is how a query grows a `WHERE kind = ...` nobody expected. It gets
--     its own narrow table when that milestone lands.
--   * A DELETE path on quota_counters. Counters are the durable record of a fielded survey; a
--     version's counters die with the version's own CASCADE, and nothing else should remove one.

-- ---------------------------------------------------------------------------
-- 1. Enums
-- ---------------------------------------------------------------------------
-- Their own types rather than text + CHECK: each is a closed vocabulary the compiler and the
-- runtime both switch on, and 03 §8 names every member. A text column would let a typo reach
-- the gate, where the failure mode is "this respondent counted against no cell".
CREATE TYPE content.quota_plan_type AS ENUM ('interlocked', 'marginal');
CREATE TYPE content.quota_cell_mode AS ENUM ('hard', 'soft');
CREATE TYPE content.quota_count_at AS ENUM ('reservation', 'completion');
CREATE TYPE content.quota_store_failure AS ENUM ('fail_closed', 'fail_open');
CREATE TYPE content.quota_counter_scope AS ENUM ('survey', 'version');

-- ---------------------------------------------------------------------------
-- 2. content.quota_dimensions — a dimension is defined over a VARIABLE
-- ---------------------------------------------------------------------------
-- 03 §1's model again: quotas are defined over variables, not questions. A dimension naming a
-- question would break the moment the question fanned out (which of Q5's six booleans is the
-- gender dimension?), and it would make a hidden vendor parameter — the most common real quota
-- dimension after gender and age — inexpressible.
CREATE TABLE content.quota_dimensions (
  survey_version_id app.ulid NOT NULL,
  id                app.ulid NOT NULL,
  org_id            app.ulid NOT NULL,
  ref               app.ref NOT NULL,
  variable_id       app.ulid NOT NULL,
  sort_key          content.sort_key NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  deleted_at        timestamptz,
  PRIMARY KEY (survey_version_id, id),
  FOREIGN KEY (org_id, survey_version_id)
    REFERENCES app.survey_versions (org_id, id) ON DELETE CASCADE,
  -- The variable must belong to the same version. Without the composite FK a dimension could
  -- name a variable from another survey, and the gate would evaluate a bucket against a value
  -- the respondent's survey never collects.
  FOREIGN KEY (survey_version_id, variable_id)
    REFERENCES content.variables (survey_version_id, id) ON DELETE CASCADE
);
COMMENT ON TABLE content.quota_dimensions IS
  'One axis of a quota plan, defined over a VARIABLE (03 §1): gender, age band, region. A '
  'dimension over a question would be inexpressible for a fan-out and impossible for a hidden '
  'vendor parameter, which is the most common real dimension after gender and age.';

CREATE UNIQUE INDEX qdim_ref_key ON content.quota_dimensions
  (survey_version_id, lower(ref)) WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- 3. content.quota_buckets — the AST that decides membership
-- ---------------------------------------------------------------------------
CREATE TABLE content.quota_buckets (
  survey_version_id app.ulid NOT NULL,
  id                app.ulid NOT NULL,
  org_id            app.ulid NOT NULL,
  dimension_id      app.ulid NOT NULL,
  ref               app.ref NOT NULL,
  -- The condition, as the same opaque AST envelope every other condition column carries. Typed
  -- and checked by packages/logic at publish (LGC-*), never by a database constraint: the AST's
  -- validity depends on the variable registry, which SQL cannot see.
  match             jsonb NOT NULL,
  sort_key          content.sort_key NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  deleted_at        timestamptz,
  PRIMARY KEY (survey_version_id, id),
  FOREIGN KEY (survey_version_id, dimension_id)
    REFERENCES content.quota_dimensions (survey_version_id, id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, survey_version_id)
    REFERENCES app.survey_versions (org_id, id) ON DELETE CASCADE,
  CONSTRAINT qbucket_match_object CHECK (jsonb_typeof(match) = 'object')
);
COMMENT ON TABLE content.quota_buckets IS
  'One value-set of a dimension (M / F, 18_24 / 25_34), as the AST that decides membership. '
  'Bucket order is the tie-break for overlapping buckets — the first match wins, which is why '
  'sort_key is NOT NULL and why the runtime reads buckets in it.';

-- Ref is unique per DIMENSION, not per version: two dimensions may both have an `OTHER` bucket,
-- and a cell key names buckets positionally by dimension, so there is no ambiguity.
CREATE UNIQUE INDEX qbucket_ref_key ON content.quota_buckets
  (survey_version_id, dimension_id, lower(ref)) WHERE deleted_at IS NULL;
CREATE INDEX qbucket_dimension_idx ON content.quota_buckets
  (survey_version_id, dimension_id, sort_key) WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- 4. content.quota_plans — and the policy that has no safe default
-- ---------------------------------------------------------------------------
CREATE TABLE content.quota_plans (
  survey_version_id  app.ulid NOT NULL,
  id                 app.ulid NOT NULL,
  org_id             app.ulid NOT NULL,
  ref                app.ref NOT NULL,
  plan_type          content.quota_plan_type NOT NULL,
  -- Positional: cell_key[i] names a bucket of dimension_ids[i]. An array rather than a junction
  -- table for the reason B §5 gives — a junction turns a single-row cell probe into an N-way
  -- self-join per respondent, on the hot path.
  dimension_ids      app.ulid[] NOT NULL,
  -- The policy fields. `count_at`, `on_store_unavailable` and `counter_scope` are NOT NULL with
  -- NO DEFAULT, and that is the whole point of ADR-008's "there is no safe default": fail-closed
  -- screens everyone out and protects the client's budget, fail-open admits everyone and protects
  -- field pace, and a platform that picked one for an author has made a commercial decision on
  -- their behalf. `counter_scope` decides whether counters survive a mid-field republish, which is
  -- the same kind of choice. The publish gate refuses a hard quota with no policy; these columns
  -- make the row itself unable to omit one.
  count_at           content.quota_count_at NOT NULL,
  reservation_ttl_s  integer NOT NULL,
  on_store_unavailable content.quota_store_failure NOT NULL,
  counter_scope      content.quota_counter_scope NOT NULL,
  overflow           text,
  sort_key           content.sort_key NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  deleted_at         timestamptz,
  PRIMARY KEY (survey_version_id, id),
  FOREIGN KEY (org_id, survey_version_id)
    REFERENCES app.survey_versions (org_id, id) ON DELETE CASCADE,
  CONSTRAINT qplan_ttl_positive CHECK (reservation_ttl_s > 0 AND reservation_ttl_s <= 86400),
  CONSTRAINT qplan_has_dimensions CHECK (cardinality(dimension_ids) >= 1),
  -- 03 §8's distinction, enforced. A marginal plan is per-dimension and independent, so a
  -- marginal plan over two dimensions is not one plan with fewer cells — it is two plans, and
  -- treating it as one is how a sample plan silently becomes unfillable.
  CONSTRAINT qplan_marginal_one_dim
    CHECK (plan_type <> 'marginal' OR cardinality(dimension_ids) = 1)
);
COMMENT ON CONSTRAINT qplan_marginal_one_dim ON content.quota_plans IS
  '03 §8: interlocked and marginal plans are different mathematical objects. A marginal plan '
  'over N dimensions is N plans; accepting it as one produces cells whose arithmetic cannot be '
  'checked against anything.';
COMMENT ON COLUMN content.quota_plans.on_store_unavailable IS
  'NOT NULL with no default, deliberately (ADR-008). Fail closed protects the client budget; '
  'fail open protects field pace; there is no safe default and the platform must not pick.';

CREATE UNIQUE INDEX qplan_ref_key ON content.quota_plans
  (survey_version_id, lower(ref)) WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- 5. content.quota_cells — the targets
-- ---------------------------------------------------------------------------
CREATE TABLE content.quota_cells (
  survey_version_id app.ulid NOT NULL,
  id                app.ulid NOT NULL,
  org_id            app.ulid NOT NULL,
  plan_id           app.ulid NOT NULL,
  -- Bucket refs, one per dimension in the plan's `dimension_ids` order. Text and not ids: a cell
  -- key is what the runtime's counter key interpolates and what an operator reads in a dashboard,
  -- and B §5's own definition is `cell_key text[]`.
  cell_key          text[] NOT NULL,
  target            integer,
  target_pct        numeric(5,2),
  mode              content.quota_cell_mode NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  deleted_at        timestamptz,
  PRIMARY KEY (survey_version_id, id),
  FOREIGN KEY (survey_version_id, plan_id)
    REFERENCES content.quota_plans (survey_version_id, id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, survey_version_id)
    REFERENCES app.survey_versions (org_id, id) ON DELETE CASCADE,
  CONSTRAINT qcell_key_nonempty CHECK (cardinality(cell_key) >= 1),
  -- Exactly one of the two targets. Both would be two answers to "how many"; neither would be a
  -- cell that can never be full, which reads as a bug rather than as an intention.
  CONSTRAINT qcell_one_target CHECK ((target IS NULL) <> (target_pct IS NULL)),
  CONSTRAINT qcell_target_nonneg CHECK (target IS NULL OR target >= 0),
  CONSTRAINT qcell_pct_range CHECK (target_pct IS NULL OR (target_pct > 0 AND target_pct <= 100))
);
COMMENT ON TABLE content.quota_cells IS
  'One target. cell_key is bucket refs positionally by the plan''s dimension_ids — text because '
  'that is what the counter key interpolates and what an operator reads in a dashboard (B §5).';

-- The lookup the gate does on every respondent: which cell does this bucket tuple name.
CREATE UNIQUE INDEX qcell_key_idx ON content.quota_cells
  (survey_version_id, plan_id, cell_key) WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- 6. runtime.quota_counters — the durable mirror of Redis (B §5.1)
-- ---------------------------------------------------------------------------
CREATE TABLE runtime.quota_counters (
  survey_version_id app.ulid NOT NULL REFERENCES app.survey_versions(id),
  cell_id           app.ulid NOT NULL,
  plan_id           app.ulid NOT NULL,
  org_id            app.ulid NOT NULL,
  target            integer NOT NULL,
  committed         integer NOT NULL DEFAULT 0,
  -- Last observed, never authoritative: ADR-008 makes Redis the arbiter. Named in the column
  -- comment because a dashboard reading this as truth is the mistake the split invites.
  in_flight         integer NOT NULL DEFAULT 0,
  is_test           boolean NOT NULL DEFAULT false,
  -- Monotonic, and the reason write-behind is safe. The flush is asynchronous and can arrive out
  -- of order; the RPC below upserts only WHERE excluded.redis_epoch > the stored one, so a late
  -- flush cannot make the durable record go backwards.
  redis_epoch       bigint NOT NULL DEFAULT 0,
  last_flush_at     timestamptz NOT NULL DEFAULT now(),
  -- P2-08's reconciliation, from the event log. Drift is `committed - reconciled_committed`.
  reconciled_at        timestamptz,
  reconciled_committed integer,
  PRIMARY KEY (survey_version_id, cell_id),
  CONSTRAINT qc_nonneg CHECK (committed >= 0 AND in_flight >= 0)
);
COMMENT ON TABLE runtime.quota_counters IS
  'The durable mirror of Redis (ADR-008: Redis is the arbiter, this is the record). Lives in '
  'schema runtime because a counter is respondent-plane data; authoring reads it only through '
  'app.quota_dashboard, on the same terms as app.field_stats crosses the same boundary.';
COMMENT ON COLUMN runtime.quota_counters.in_flight IS
  'Last observed value, NOT authoritative. Redis holds the live reservations; a dashboard that '
  'treats this as truth will under-report a busy cell between flushes.';
COMMENT ON COLUMN runtime.quota_counters.redis_epoch IS
  'Monotonic. runtime.flush_quota_counters upserts only when the incoming epoch is greater, '
  'which is what makes an out-of-order write-behind idempotent instead of destructive.';

CREATE INDEX quota_counters_plan_idx ON runtime.quota_counters
  (survey_version_id, plan_id) WHERE NOT is_test;
-- Partial on a two-column comparison, so "which cells are drifting" is an index-only scan on a
-- table that is otherwise all writes (B §5.1).
CREATE INDEX quota_counters_drift_idx ON runtime.quota_counters (survey_version_id)
  WHERE reconciled_committed IS NOT NULL AND reconciled_committed <> committed;

ALTER TABLE runtime.quota_counters OWNER TO runtime_rpc_owner;

-- ---------------------------------------------------------------------------
-- 7. runtime.flush_quota_counters — write-behind (roadmap P2-07's DB line)
-- ---------------------------------------------------------------------------
-- One call per drain batch rather than one per cell: the drain is a background loop and a
-- per-cell round trip would make its cost a function of how busy the survey is, which is exactly
-- backwards. jsonb in, count out.
CREATE FUNCTION runtime.flush_quota_counters(p_rows jsonb)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = '' SET statement_timeout = '15s' AS $$
DECLARE v_count integer;
BEGIN
  IF jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'flush_quota_counters expects a json array' USING ERRCODE = '22023';
  END IF;

  WITH incoming AS (
    SELECT (r ->> 'survey_version_id')::app.ulid AS survey_version_id,
           (r ->> 'cell_id')::app.ulid           AS cell_id,
           (r ->> 'plan_id')::app.ulid           AS plan_id,
           (r ->> 'org_id')::app.ulid            AS org_id,
           (r ->> 'target')::integer             AS target,
           (r ->> 'committed')::integer          AS committed,
           (r ->> 'in_flight')::integer          AS in_flight,
           COALESCE((r ->> 'is_test')::boolean, false) AS is_test,
           (r ->> 'redis_epoch')::bigint         AS redis_epoch
      FROM jsonb_array_elements(p_rows) AS r
  ), upserted AS (
    INSERT INTO runtime.quota_counters AS qc
      (survey_version_id, cell_id, plan_id, org_id, target, committed, in_flight, is_test,
       redis_epoch, last_flush_at)
    SELECT survey_version_id, cell_id, plan_id, org_id, target, committed, in_flight, is_test,
           redis_epoch, now()
      FROM incoming
    ON CONFLICT (survey_version_id, cell_id) DO UPDATE
      SET committed     = excluded.committed,
          in_flight     = excluded.in_flight,
          target        = excluded.target,
          redis_epoch   = excluded.redis_epoch,
          last_flush_at = now()
      -- The monotonic guard. A flush that arrived late carries a lower epoch and is DROPPED,
      -- rather than rewinding a counter the arbiter has already moved forward.
      WHERE excluded.redis_epoch > qc.redis_epoch
    RETURNING 1
  )
  SELECT count(*)::integer INTO v_count FROM upserted;
  RETURN v_count;
END $$;
COMMENT ON FUNCTION runtime.flush_quota_counters(jsonb) IS
  'Write-behind drain from Redis (roadmap P2-07). Upserts a batch, dropping any row whose '
  'redis_epoch is not greater than the stored one — which is what makes an asynchronous, '
  'possibly out-of-order flush idempotent and monotonic (B §5.1).';

REVOKE EXECUTE ON FUNCTION runtime.flush_quota_counters(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION runtime.flush_quota_counters(jsonb) TO runtime_writer;

-- ---------------------------------------------------------------------------
-- 8. app.quota_dashboard — the studio's read across the plane boundary
-- ---------------------------------------------------------------------------
-- The same shape and the same argument as app.field_stats (0013): `authoring` holds no USAGE on
-- schema runtime at all (ADR-001), so a definer function IS the narrow interface. It can return
-- only what its RETURNS TABLE names, and it re-checks the caller on every call.
--
-- The floor is ANALYST for the same reason field_stats uses it: a per-cell count is respondent
-- data in aggregate, and security §7.1 puts every response-data surface at ANL+. The floor is
-- checked FIRST so a caller with no standing learns nothing about whether the version exists.
CREATE FUNCTION app.quota_dashboard(
  p_survey_version_id app.ulid,
  p_include_test      boolean DEFAULT false
) RETURNS TABLE (
  plan_id      app.ulid,
  cell_id      app.ulid,
  cell_key     text[],
  mode         text,
  target       integer,
  committed    integer,
  in_flight    integer,
  drift        integer,
  last_flush_at timestamptz
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = '' SET statement_timeout = '15s' AS $$
BEGIN
  IF NOT app.has_role('analyst') THEN
    RAISE EXCEPTION 'reading quota counters requires the analyst role or above'
      USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app.survey_versions sv
                  WHERE sv.id = p_survey_version_id
                    AND sv.org_id = app.current_org()) THEN
    -- One error for "no such version" and "another org's version" alike — 0004's
    -- existence-oracle rule, the same as field_stats and export_response_page.
    RAISE EXCEPTION 'survey version not found' USING ERRCODE = 'P0002';
  END IF;

  RETURN QUERY
  SELECT qc.plan_id,
         qc.cell_id,
         cell.cell_key,
         cell.mode::text,
         qc.target,
         qc.committed,
         qc.in_flight,
         -- NULL until a reconciliation has run, which is different from zero drift and must
         -- read differently in the dashboard.
         CASE WHEN qc.reconciled_committed IS NULL THEN NULL
              ELSE qc.committed - qc.reconciled_committed END,
         qc.last_flush_at
    FROM runtime.quota_counters qc
    LEFT JOIN content.quota_cells cell
      ON cell.survey_version_id = qc.survey_version_id AND cell.id = qc.cell_id
   WHERE qc.survey_version_id = p_survey_version_id
     AND (p_include_test OR NOT qc.is_test)
   ORDER BY qc.plan_id, cell.cell_key;
END $$;
COMMENT ON FUNCTION app.quota_dashboard(app.ulid, boolean) IS
  'The live quota dashboard''s read (roadmap P2-07 frontend). SECURITY DEFINER because ADR-001 '
  'gives authoring no path into schema runtime — the same boundary app.field_stats crosses. '
  'drift is NULL until a reconciliation has run, which is not the same as zero drift.';

REVOKE EXECUTE ON FUNCTION app.quota_dashboard(app.ulid, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.quota_dashboard(app.ulid, boolean) TO authoring;

-- ---------------------------------------------------------------------------
-- 9. Touch + draft-only triggers on every new content table
-- ---------------------------------------------------------------------------
-- ADR-002 in executable form: content rows may only be written while their version is a draft.
-- tools/ci/lint-migrations.mjs refuses a new content table without this trigger, which is what
-- keeps the rule from depending on whoever reviewed the migration.
CREATE TRIGGER qdim_touch BEFORE UPDATE ON content.quota_dimensions
  FOR EACH ROW EXECUTE FUNCTION app.tg_touch_updated_at();
CREATE TRIGGER qdim_draft_only BEFORE INSERT OR UPDATE OR DELETE ON content.quota_dimensions
  FOR EACH ROW EXECUTE FUNCTION content.tg_draft_only();

CREATE TRIGGER qbucket_touch BEFORE UPDATE ON content.quota_buckets
  FOR EACH ROW EXECUTE FUNCTION app.tg_touch_updated_at();
CREATE TRIGGER qbucket_draft_only BEFORE INSERT OR UPDATE OR DELETE ON content.quota_buckets
  FOR EACH ROW EXECUTE FUNCTION content.tg_draft_only();

CREATE TRIGGER qplan_touch BEFORE UPDATE ON content.quota_plans
  FOR EACH ROW EXECUTE FUNCTION app.tg_touch_updated_at();
CREATE TRIGGER qplan_draft_only BEFORE INSERT OR UPDATE OR DELETE ON content.quota_plans
  FOR EACH ROW EXECUTE FUNCTION content.tg_draft_only();

CREATE TRIGGER qcell_touch BEFORE UPDATE ON content.quota_cells
  FOR EACH ROW EXECUTE FUNCTION app.tg_touch_updated_at();
CREATE TRIGGER qcell_draft_only BEFORE INSERT OR UPDATE OR DELETE ON content.quota_cells
  FOR EACH ROW EXECUTE FUNCTION content.tg_draft_only();

-- ---------------------------------------------------------------------------
-- 10. Row-level security
-- ---------------------------------------------------------------------------
-- FORCE, not just ENABLE: the table owner bypasses ENABLE, and the migration runner IS the owner.
-- ops.tables_without_rls() asserts this on every migration, which is what makes "a new table
-- without RLS cannot ship" a property rather than a habit.
ALTER TABLE content.quota_dimensions ENABLE ROW LEVEL SECURITY;
ALTER TABLE content.quota_dimensions FORCE  ROW LEVEL SECURITY;
ALTER TABLE content.quota_buckets    ENABLE ROW LEVEL SECURITY;
ALTER TABLE content.quota_buckets    FORCE  ROW LEVEL SECURITY;
ALTER TABLE content.quota_plans      ENABLE ROW LEVEL SECURITY;
ALTER TABLE content.quota_plans      FORCE  ROW LEVEL SECURITY;
ALTER TABLE content.quota_cells      ENABLE ROW LEVEL SECURITY;
ALTER TABLE content.quota_cells      FORCE  ROW LEVEL SECURITY;
ALTER TABLE runtime.quota_counters   ENABLE ROW LEVEL SECURITY;
ALTER TABLE runtime.quota_counters   FORCE  ROW LEVEL SECURITY;

-- Content: reviewer reads, programmer writes, drafts only — the same four policies every other
-- content table carries (0007), because a quota plan is content like any other.
CREATE POLICY qdim_select ON content.quota_dimensions FOR SELECT TO authoring
USING (org_id = app.current_org() AND app.has_role('reviewer')
       AND app.can_see_version(survey_version_id));
CREATE POLICY qdim_insert ON content.quota_dimensions FOR INSERT TO authoring
WITH CHECK (org_id = app.current_org() AND app.has_role('programmer')
            AND app.can_see_version(survey_version_id)
            AND app.version_is_draft(survey_version_id));
CREATE POLICY qdim_update ON content.quota_dimensions FOR UPDATE TO authoring
USING (org_id = app.current_org() AND app.has_role('programmer')
       AND app.can_see_version(survey_version_id)
       AND app.version_is_draft(survey_version_id))
WITH CHECK (org_id = app.current_org() AND app.has_role('programmer')
            AND app.can_see_version(survey_version_id)
            AND app.version_is_draft(survey_version_id));
CREATE POLICY qdim_delete ON content.quota_dimensions FOR DELETE TO authoring
USING (org_id = app.current_org() AND app.has_role('programmer')
       AND app.can_see_version(survey_version_id)
       AND app.version_is_draft(survey_version_id));

CREATE POLICY qbucket_select ON content.quota_buckets FOR SELECT TO authoring
USING (org_id = app.current_org() AND app.has_role('reviewer')
       AND app.can_see_version(survey_version_id));
CREATE POLICY qbucket_insert ON content.quota_buckets FOR INSERT TO authoring
WITH CHECK (org_id = app.current_org() AND app.has_role('programmer')
            AND app.can_see_version(survey_version_id)
            AND app.version_is_draft(survey_version_id));
CREATE POLICY qbucket_update ON content.quota_buckets FOR UPDATE TO authoring
USING (org_id = app.current_org() AND app.has_role('programmer')
       AND app.can_see_version(survey_version_id)
       AND app.version_is_draft(survey_version_id))
WITH CHECK (org_id = app.current_org() AND app.has_role('programmer')
            AND app.can_see_version(survey_version_id)
            AND app.version_is_draft(survey_version_id));
CREATE POLICY qbucket_delete ON content.quota_buckets FOR DELETE TO authoring
USING (org_id = app.current_org() AND app.has_role('programmer')
       AND app.can_see_version(survey_version_id)
       AND app.version_is_draft(survey_version_id));

CREATE POLICY qplan_select ON content.quota_plans FOR SELECT TO authoring
USING (org_id = app.current_org() AND app.has_role('reviewer')
       AND app.can_see_version(survey_version_id));
CREATE POLICY qplan_insert ON content.quota_plans FOR INSERT TO authoring
WITH CHECK (org_id = app.current_org() AND app.has_role('programmer')
            AND app.can_see_version(survey_version_id)
            AND app.version_is_draft(survey_version_id));
CREATE POLICY qplan_update ON content.quota_plans FOR UPDATE TO authoring
USING (org_id = app.current_org() AND app.has_role('programmer')
       AND app.can_see_version(survey_version_id)
       AND app.version_is_draft(survey_version_id))
WITH CHECK (org_id = app.current_org() AND app.has_role('programmer')
            AND app.can_see_version(survey_version_id)
            AND app.version_is_draft(survey_version_id));
CREATE POLICY qplan_delete ON content.quota_plans FOR DELETE TO authoring
USING (org_id = app.current_org() AND app.has_role('programmer')
       AND app.can_see_version(survey_version_id)
       AND app.version_is_draft(survey_version_id));

CREATE POLICY qcell_select ON content.quota_cells FOR SELECT TO authoring
USING (org_id = app.current_org() AND app.has_role('reviewer')
       AND app.can_see_version(survey_version_id));
CREATE POLICY qcell_insert ON content.quota_cells FOR INSERT TO authoring
WITH CHECK (org_id = app.current_org() AND app.has_role('programmer')
            AND app.can_see_version(survey_version_id)
            AND app.version_is_draft(survey_version_id));
CREATE POLICY qcell_update ON content.quota_cells FOR UPDATE TO authoring
USING (org_id = app.current_org() AND app.has_role('programmer')
       AND app.can_see_version(survey_version_id)
       AND app.version_is_draft(survey_version_id))
WITH CHECK (org_id = app.current_org() AND app.has_role('programmer')
            AND app.can_see_version(survey_version_id)
            AND app.version_is_draft(survey_version_id));
CREATE POLICY qcell_delete ON content.quota_cells FOR DELETE TO authoring
USING (org_id = app.current_org() AND app.has_role('programmer')
       AND app.can_see_version(survey_version_id)
       AND app.version_is_draft(survey_version_id));

-- runtime.quota_counters gets exactly ONE policy, for the RPC owner, on the same terms 0011
-- gives runtime.response_documents: the respondent plane writes through functions, and no
-- authoring role has any grant here at all. The definer functions above are the only readers.
CREATE POLICY qcounters_rpc_all ON runtime.quota_counters FOR ALL TO runtime_rpc_owner
USING (true) WITH CHECK (true);
COMMENT ON POLICY qcounters_rpc_all ON runtime.quota_counters IS
  'The only policy. authoring holds no USAGE on schema runtime (ADR-001), so a counter is '
  'reachable from the control plane only through app.quota_dashboard.';
