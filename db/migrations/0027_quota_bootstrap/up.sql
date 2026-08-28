-- 0027_quota_bootstrap — the first link in ADR-008's chain, which had no caller.

SET lock_timeout = '3s';
SET statement_timeout = '120s';

-- ## The defect
--
-- ADR-008 says Redis is the quota arbiter and Postgres the durable record. The arbiter half works
-- and is load-tested. **The record half had never been written to in any deployment.**
--
-- Five links, each built, tested, and correct in isolation:
--
--   1. `runtime.quota_set_target` creates a counter row carrying the cell's target.
--   2. `runtime.quota_rebuild_state` reads those rows; `rebuildRedis` seeds Redis with the target
--      and the cell identity.
--   3. the reserve script counts against a seeded cell.
--   4. `drainOnce` reads each dirty cell and flushes it through `runtime.flush_quota_counters`.
--   5. `reconcile_quota_counters` compares the record against the event log.
--
-- Nothing called link 1. Looking only at 2 and 4 it reads as circular — rebuild reads
-- `runtime.quota_counters`, and the only writer of that table from the application is the drain,
-- which needs the identity rebuild writes — but link 1 is the way in and is not circular: it
-- inserts a counter row from `content.quota_cells`. With no caller, `quota_rebuild_state` returned
-- zero rows, so Redis cells carried no identity, so `drainOnce` skipped every one of them
-- (logging `quota_drain_incomplete_hash`) and `runtime.quota_counters` stayed empty forever.
--
-- Consequences, in order of severity. Postgres held NO quota counters, so losing Redis lost every
-- completed-quota count — the "durable record" did not exist. Reconciliation and repair had nothing
-- to compare, which is why Phase 2's "reconciliation reports zero drift" criterion could not be
-- met. And no cell target was ever seeded into Redis: a cell hash with no `target` reads 0, and the
-- fullness check is guarded by `target > 0`, so on the Redis path a cell that was never explicitly
-- targeted DOES NOT CLOSE.
--
-- Invisible because every component's own test constructs its own preconditions. `drain.test.ts`
-- seeds cell hashes carrying the identity production never writes — its helper says so, commented
-- "shaped exactly as the reserve script leaves it, PLUS the identity the drain reads" — while
-- `drain.ts` claims a hash without identity "was written by something that is not the reserve
-- script". The test comment was the accurate one. `tools/perf/p2-quota-load.mjs` sets its own
-- targets and never touches Postgres, so it never compared the arbiter to the record.
--
-- ## Why a trigger on the publish transition
--
-- Publish is the right moment and the only one that is both cheap and unmissable. The targets are
-- known (they are `content.quota_cells` rows, frozen with the version), it happens once per
-- version, and it blocks no respondent. The alternative — warm on first gate touch — puts a
-- Postgres round trip in the respondent's path at exactly the moment ADR-008 exists to keep fast,
-- and needs a cache with its own invalidation story.
--
-- A TRIGGER rather than a line inside `app.publish_version` for the reason 0020 gives for the
-- webhook outbox and 0007 for `tg_draft_only`: `publish_version` is ONE publisher, and a support
-- script or a later second path would each have to remember. The one that forgets produces a
-- version whose quotas silently do not enforce.
--
-- Fires only on a transition INTO a published status, not on every UPDATE — a version row is
-- updated on every edit (`tg_version_guard` bumps `revision`), and re-seeding on each would be
-- pointless work. Re-publishing IS a legitimate re-seed and is idempotent: `quota_set_target`
-- upserts `ON CONFLICT (survey_version_id, cell_id) DO UPDATE SET target = excluded.target`.
--
-- ## Percentage-mode cells are skipped, and that is a known limitation
--
-- `content.quota_cells` carries `target` OR `target_pct`, and nothing anywhere resolves a
-- percentage into an absolute count: `QuotaPlan` has no sample size, the compiler's `LGC-Q002`
-- only checks that the percentages are arithmetically sound, and `runtime.quota_set_target` takes
-- an integer. So a percentage-mode plan has no enforceable target in any component, and seeding
-- can only cover cells with an explicit `target`. The count is returned so a caller can see the
-- difference between "nothing to seed" and "some cells could not be seeded".


CREATE FUNCTION runtime.quota_seed_targets(p_survey_version_id app.ulid)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = '' AS $$
DECLARE
  v_seeded integer := 0;
  r        record;
BEGIN
  FOR r IN
    SELECT c.plan_id, array_to_string(c.cell_key, '|') AS cell_key, c.target
      FROM content.quota_cells c
     WHERE c.survey_version_id = p_survey_version_id
       AND c.deleted_at IS NULL
       -- Only count-mode cells: see the header on target_pct.
       AND c.target IS NOT NULL
     ORDER BY c.plan_id, c.cell_key
  LOOP
    PERFORM runtime.quota_set_target(p_survey_version_id, r.plan_id, r.cell_key, r.target);
    v_seeded := v_seeded + 1;
  END LOOP;
  RETURN v_seeded;
END $$;

COMMENT ON FUNCTION runtime.quota_seed_targets(app.ulid) IS
  'Creates the runtime.quota_counters row for every count-mode cell of a version — the first link '
  'in ADR-008''s chain, which had no caller before this migration. Idempotent: quota_set_target '
  'upserts on (survey_version_id, cell_id). Percentage-mode cells are skipped because no component '
  'can resolve a percentage into a count (see the migration header); the return value is the '
  'number seeded, so "no quotas" and "quotas that cannot be seeded" are distinguishable.';

REVOKE ALL ON FUNCTION runtime.quota_seed_targets(app.ulid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION runtime.quota_seed_targets(app.ulid) TO runtime_writer;

CREATE FUNCTION app.tg_seed_quota_targets() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = '' AS $$
BEGIN
  -- Only the transition INTO a published status. `IS DISTINCT FROM` rather than `<>` because
  -- OLD.status is never NULL here but the comparison should not depend on that, and because 0020
  -- learned the same lesson the other way round: a plain inequality against a NULL fires for
  -- nothing at all, which is the quietest possible bug.
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;
  IF NEW.status NOT IN ('staging', 'production') THEN
    RETURN NEW;
  END IF;

  PERFORM runtime.quota_seed_targets(NEW.id);
  RETURN NEW;
END $$;

COMMENT ON FUNCTION app.tg_seed_quota_targets() IS
  'Seeds the durable quota record when a version is published. SECURITY DEFINER because it crosses '
  'ADR-001''s plane boundary — an authoring transaction writing a runtime table — which the ADR '
  'permits only this way.';

REVOKE ALL ON FUNCTION app.tg_seed_quota_targets() FROM PUBLIC;

CREATE TRIGGER seed_quota_targets
  AFTER UPDATE OF status ON app.survey_versions
  FOR EACH ROW EXECUTE FUNCTION app.tg_seed_quota_targets();

COMMENT ON TRIGGER seed_quota_targets ON app.survey_versions IS
  'Without this, runtime.quota_counters was never populated, so ADR-008''s "Postgres is the durable '
  'record" was false and a Redis loss lost every quota count.';

/* ------------------------------------------------------------------ *
 * 2. org_id stops travelling — flush_quota_counters derives it
 * ------------------------------------------------------------------ *
 *
 * `rebuildRedis` wrote `org_id: ''` onto every cell hash it restored, because it had no org to
 * write: `quota_rebuild_state` did not return one. `drainOnce` requires cell_id,
 * survey_version_id AND org_id, and skips the cell when any is falsy — and '' is falsy in
 * JavaScript. So even a SUCCESSFUL rebuild produced cells the drain refused.
 *
 * The first fix attempted here was to add `org_id` to `quota_rebuild_state`'s return. **0004's
 * standing check refused it**, and was right to: it scans `proargnames`, which includes the OUT
 * columns of a `RETURNS TABLE`, and B §2's rule is that NO function in schema `runtime` takes an
 * org id because that is how a cross-tenant request would be phrased. An OUT org_id is the same
 * hazard travelling the other way — it is precisely what would have let an org id ride through
 * Redis and come back as the tenant a counter row is filed under.
 *
 * So org_id stops travelling at all. `flush_quota_counters` derives it from the version, exactly
 * as `quota_set_target` already does, which is strictly better than carrying it:
 *
 *   * it cannot be wrong, because the version row is the only authority on which org owns it;
 *   * it removes a field from the Redis hash, and every field on that hash is a thing some writer
 *     has to remember to set — the reason the drain was skipping cells in the first place;
 *   * a caller that passed a hostile org_id is no longer expressible.
 *
 * A row whose `survey_version_id` does not exist is now REJECTED rather than filed under a NULL
 * org. The drain reads the version id off the hash, and a hash naming a version that has been
 * deleted is a cell nobody can account for.
 */

CREATE OR REPLACE FUNCTION runtime.flush_quota_counters(p_rows jsonb)
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
           (r ->> 'target')::integer             AS target,
           (r ->> 'committed')::integer          AS committed,
           (r ->> 'in_flight')::integer          AS in_flight,
           COALESCE((r ->> 'is_test')::boolean, false) AS is_test,
           (r ->> 'redis_epoch')::bigint         AS redis_epoch
      FROM jsonb_array_elements(p_rows) AS r
  ), resolved AS (
    -- The JOIN is the authorization: a row naming a version that does not exist contributes
    -- nothing, so a flush cannot create a counter for a tenant it invented. `org_id` is no longer
    -- read from the payload at all — see the header.
    SELECT i.*, sv.org_id
      FROM incoming i
      JOIN app.survey_versions sv ON sv.id = i.survey_version_id
  ), upserted AS (
    INSERT INTO runtime.quota_counters AS qc
      (survey_version_id, cell_id, plan_id, org_id, target, committed, in_flight, is_test,
       redis_epoch, last_flush_at)
    SELECT survey_version_id, cell_id, plan_id, org_id, target, committed, in_flight, is_test,
           redis_epoch, now()
      FROM resolved
    ON CONFLICT (survey_version_id, cell_id) DO UPDATE
      SET committed     = excluded.committed,
          in_flight     = excluded.in_flight,
          target        = excluded.target,
          redis_epoch   = excluded.redis_epoch,
          last_flush_at = now()
      -- The monotonic guard, unchanged. A flush that arrived late carries a lower epoch and is
      -- DROPPED, rather than rewinding a counter the arbiter has already moved forward.
      WHERE excluded.redis_epoch > qc.redis_epoch
    RETURNING 1
  )
  SELECT count(*)::integer INTO v_count FROM upserted;
  RETURN v_count;
END $$;

COMMENT ON FUNCTION runtime.flush_quota_counters(jsonb) IS
  'The write-behind sink. Derives org_id by joining app.survey_versions rather than reading it from '
  'the payload: B §2 forbids a runtime function taking an org id, and the version row is the only '
  'authority on which tenant owns a counter. A row naming a nonexistent version is dropped by that '
  'join. The epoch guard is what makes an out-of-order flush harmless.';
