-- 0010_publish_path — the three defects that make P1-08's publish path non-functional, closed.
--
-- Deliverable B §2 (the RPC shape: SECURITY DEFINER, search_path pinned, NO org_id argument),
-- §4 (the version-scoped content model), §4.1 (one node table; ids stable across versions),
-- §10.1 (ops.jobs is the durable record of a thing a user pressed a button for), §12 (RLS),
-- §14 (expand/contract, forward-only, the timeout header); Deliverable C §5.1 (QuestionItem is
-- ONE SHAPE for option, row and column), §9 (the redirect map: default / by_vendor /
-- by_language plus CUSTOM), §17 (the artifact and the static gate); Deliverable K §1 (the role
-- ranks), §2 (the disposition registry and which dispositions require a redirect); ADR-001
-- (the plane boundary), ADR-002 (the version is the unit of immutability, so editing a
-- published survey is a copy-on-write clone), ADR-009 (org_id on every row, and no RPC takes
-- one as a parameter); roadmap P1-08.
--
-- WHAT THIS MIGRATION IS FOR. All three of the things below were found while building
-- apps/worker's compile job against 0007/0008/0009, each is documented in code at its site, and
-- each one alone is sufficient to make publishing impossible:
--
--   1. THE STUDIO CANNOT QUEUE ITS OWN PUBLISH JOB. ops.enqueue_job is SECURITY DEFINER, but
--      `authoring` holds no USAGE on schema ops, and EXECUTE without schema USAGE is inert — so
--      GRANT EXECUTE on it fails with "permission denied for schema ops". 0005 §2 hit exactly
--      this on the READ side and solved it with app.get_job; the write side never got its
--      wrapper. §1 is that wrapper.
--   2. NO SURVEY CAN PASS THE STATIC GATE. C §9's `redirects` has no column anywhere, and
--      CMP-0300 blocks any survey whose flow can reach a redirect-required disposition — which
--      is every survey, since the synthesized flow of C §6 always reaches COMPLETE. §2 gives
--      redirects a version-scoped home and §3 teaches content.clone_version() about it.
--   3. EVERY MATRIX QUESTION FAILS PUBLISH. 0007 made content.question_items.id kind-dependent
--      (row_… for a row) while packages/schema brands every item id Id<'opt'>, so asId('opt', …)
--      throws on a legitimately stored row id. C §5.1 is the contract and 0007 diverged. §4
--      normalizes the database to opt_ for all three kinds.
--
-- Migration header first, mandated by Deliverable B §14 and enforced by
-- tools/ci/lint-migrations.mjs (which reads the first 60 lines, so the reasoning below comes
-- after it rather than before): an ALTER TABLE waiting behind a long read drags an
-- ACCESS EXCLUSIVE lock queue with it and stalls the runtime. Failing fast and retrying is
-- strictly better than blocking. Everything here is expand-only — one new type, one new table,
-- one new function, two function bodies replaced, one CHECK added NOT VALID and then validated —
-- so there is no rename, no in-place type change, and no default that has to be materialized
-- over rows that already exist.
SET lock_timeout = '3s';
SET statement_timeout = '120s';

-- ---------------------------------------------------------------------------
-- 0. The decisions, and the alternatives that were rejected
-- ---------------------------------------------------------------------------
-- Recorded before the DDL, because each of the four is a thing a later reader will want to
-- reopen and three of them look arbitrary until the reason is stated.
--
-- (a) app.enqueue_job TAKES NO org_id AND NO created_by. Both are derived inside the definer,
--     from app.current_org() and app.current_user_id(). This is 0009's catalog assertion applied
--     to the control plane: B §2's rule is that no runtime RPC takes an org id, because a
--     parameter for org_id is a way to write a row into another tenant, and 0004's test.sql
--     asserts it from pg_proc.proargnames. The same argument holds here for a stronger reason
--     than symmetry: ops.jobs.org_id and ops.jobs.created_by are the ONLY inputs to the publish
--     capability check. 0009's calling convention has the compile worker assume the enqueuing
--     user's identity from those two columns before calling app.publish_version, so a request
--     body that could set either would be a way to publish as somebody else, in somebody else's
--     org, with a real audit row naming a human who never clicked anything.
--
--     REJECTED: a service-role enqueue from the studio's route (an INSERT into ops.jobs with the
--     service key). It is one line and it is unusable: a service-role write leaves created_by
--     NULL, and 0009's publish transaction refuses a job with a NULL created_by — RAISE
--     insufficient_privilege from app.publish_version, because "the system published this" is
--     not an answer anyone accepts six months later. The worker's identityOf() refuses it one
--     step earlier for the same reason. So the service-role shortcut does not merely bypass a
--     check; it produces a job that can never succeed.
--
--     REJECTED: GRANT USAGE ON SCHEMA ops TO authoring, which would make GRANT EXECUTE on
--     ops.enqueue_job work directly. 0005 §2 rejected the same trade on the read side and the
--     wording stands: it trades a documented plane boundary for one convenience function, and
--     both 0001's and 0003's test.sql assert has_schema_privilege('authoring','ops','USAGE')
--     = false.
--
-- (b) REDIRECTS GET A NARROWER, VERSION-SCOPED STORE NOW, NOT P2-10's FULL TABLE. Deliverable B
--     schedules content.redirects for Phase 2 (P2-10, the vendor work) "flattened with
--     allow_pii". This migration creates content.redirects with B's name, B's flattening and B's
--     version scoping — and WITHOUT allow_pii, which is the only field P1-08 has no consumer
--     for. Two reasons, and they point the same way:
--       * allow_pii's semantics are defined by the vendor work that has not happened. C §9 says
--         a redirect template is where personal data leaves the platform and that pii: true
--         variables are blocked "unless explicitly allowed"; whether "allowed" is per redirect,
--         per vendor, per variable, or a K §1 capability check is exactly what P2-10 decides.
--         Guessing now produces a column whose meaning has to be migrated, which is worse than
--         a column that does not exist yet. 0008 declined content.logic_rules.on_unknown on this
--         argument and 0009 declined runtime.survey_tokens.quota_policy on it: a column nothing
--         writes is the table equivalent of a grant with no consumer.
--       * Adding it later is ONE expand step — ADD COLUMN allow_pii boolean NOT NULL DEFAULT
--         false — which is non-rewriting on PostgreSQL 16 and is the safe direction (a redirect
--         that has not opted in does not leak). Nothing about the shape below has to change for
--         P2-10 to land on top of it.
--     What is NOT deferred, because deferring any of it would make the table wrong rather than
--     incomplete: it is version-scoped (redirects are part of what a version publishes, so they
--     freeze with it — ADR-002, B §0 ground rule 3), RLS-forced, carries content.tg_draft_only,
--     and is in content.clone_version()'s enumerated list.
--
--     REJECTED: a `redirects jsonb` column on app.survey_versions, or a one-row-per-version
--     table holding C §9's document verbatim. It is less code here and it is the wrong shape for
--     the same reason B §6 gives for one row per string rather than a JSONB bundle per language:
--     the interesting operational questions are per-row. "Which surveys still point at the
--     vendor we are dropping" and "which redirect templates interpolate a PII variable" are an
--     index scan over rows and a full document walk over blobs — and allow_pii, when it arrives,
--     is a per-redirect fact that has nowhere to live in a blob but its own duplicated key.
--
-- (c) THE DISPOSITION IS `text` WITH A CHECK, NOT runtime.disposition. K §2's registry is an
--     ENUM and it lives in schema runtime, and a column of that type would require every writer
--     to hold USAGE on schema runtime to resolve the type name — which is precisely the grant
--     ADR-001's plane boundary exists to withhold from `authoring` (db/README.md: it "may not
--     reach ops or runtime", and 0001 grants runtime_writer USAGE on `app` purely so the domains
--     in the RPC signatures resolve). So the labels are MIRRORED into a CHECK, the way 0008
--     mirrored RULE_EVALUATIONS and RULE_AUTHORED_IN rather than growing two more enums, and the
--     CHECK is the SUBSET K §2 marks "redirect required" — which is
--     runtime.disposition_requires_redirect()'s predicate, spelled out because a CHECK may not
--     call across the same boundary the type cannot cross. IN_PROGRESS is not terminal;
--     ABANDONED and TIMED_OUT are inferred by a sweeper and there is nobody left to redirect
--     (K §2, and C §17's compile check excludes them for the same reason). A redirect row for
--     one of those three is not a configuration this platform can honour, so it is unstorable.
--
-- (d) THE ITEM-ID PREFIX IS NORMALIZED FORWARD, WITH NO DATA STEP, AND §4 SHOWS THE WORKING.
--     lint-migrations.mjs rejects ALTER TABLE … RENAME and ALTER COLUMN … TYPE and forward-only
--     is the rule, so the question is what is actually legal. Replacing the assumption that
--     lived in a COLUMN COMMENT with a CHECK CONSTRAINT is neither a rename nor a type change:
--     the column stays app.ulid, no row is rewritten, and the constraint is added NOT VALID and
--     then validated, which is B §14's expand pattern. The claim this rests on — that no stored
--     row carries a row_/col_ id — is verified in §4 rather than assumed, because if it were
--     false the repair would not be a batched UPDATE: an item id is referenced by
--     content.question_cells (two composite FKs), by content.logic_rules.target_item_id, by
--     content.variables.source_item_id, and by opaque JSONB — mask item_ids (C §5.1's explicit
--     mask arm) and rule ASTs — which no SQL backfill can rewrite safely. That is the argument
--     for doing this now and not later.

-- ---------------------------------------------------------------------------
-- 1. app.enqueue_job — the write-side wrapper 0005 did not build (DEFECT 1)
-- ---------------------------------------------------------------------------
-- 0005 §2's placement argument, restated because it is the whole reason this function is in
-- schema `app`: EXECUTE on a function is not sufficient to call it, the caller also needs USAGE
-- on its schema, and `authoring` deliberately has none on `ops`. A GRANT EXECUTE on
-- ops.enqueue_job is therefore INERT — the studio's first publish click gets
-- "permission denied for schema ops" — and that is what apps/studio/src/server/repo/types.ts
-- reports today, in JobRepo.enqueue's comment, as a missing database object.
--
-- This is app.get_job's shape, mirrored to the write side: a narrow SECURITY DEFINER function in
-- the control-plane schema, granted to `authoring`, doing the tenancy work INSIDE the definer so
-- it cannot be forgotten at a call site. Two differences from app.get_job, both because a write
-- is not a read:
--
--   * It DELEGATES to ops.enqueue_job rather than inserting into ops.jobs. That keeps
--     0003's jobs_idem_key semantics — ON CONFLICT DO NOTHING against the partial unique index,
--     returning the EXISTING id so M0.4's "double-clicking Publish produces exactly one job
--     row" holds — in exactly one implementation. Duplicating the INSERT here would be a second
--     place the idempotency contract is expressed, and the copy that is wrong is always the one
--     the API calls. The delegation works because SECURITY DEFINER runs the body as this
--     function's owner (the migration runner), which does hold USAGE on ops.
--   * It REFUSES rather than returning nothing. A read that finds nothing returns zero rows,
--     because an error is an existence oracle (0005's phrasing). A write that cannot establish
--     who is asking must not silently create a row that names nobody: 0009's publish transaction
--     refuses a job with a NULL created_by, so an enqueue that let one through would move the
--     failure from the click to the worker, where the user cannot see it and the operator sees
--     insufficient_privilege from a definer function three stages away.
--
-- THE FLOOR IS `analyst` (K §1 rank 30), and that is a deliberate coarsening. This function
-- cannot check a per-kind capability, because 0003 made ops.jobs.kind FREE TEXT on purpose —
-- "job kinds are an implementation detail of apps/worker and adding one must not require a
-- migration" — so a kind -> capability mapping in SQL would be a second registry that can
-- disagree with apps/worker/src/kinds/registry.ts, and a CHECK cannot read the other one. What
-- the floor answers is only "may this caller create background work at all": an analyst runs
-- exports (K §1: "read response data, build reports, export"), which is the weakest role that
-- legitimately queues a job, and a reviewer or viewer has nothing to queue. THE REAL
-- AUTHORIZATION IS THE JOB'S OWN, one layer down and un-bypassable: the compile job assumes this
-- caller's identity and app.publish_version then re-checks project_manager for production and
-- programmer for staging (K §1), so an analyst who queues a compile gets a job that fails the
-- capability check rather than a publish.
CREATE FUNCTION app.enqueue_job(
  p_kind              text,
  p_payload           jsonb DEFAULT '{}',
  p_idempotency_key   text DEFAULT NULL,
  p_project_id        app.ulid DEFAULT NULL,
  p_survey_version_id app.ulid DEFAULT NULL,
  p_max_attempts      integer DEFAULT 3,
  p_delay_ms          integer DEFAULT 0
) RETURNS TABLE (id app.ulid, created boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_org  app.ulid;
  v_user uuid;
BEGIN
  v_org  := app.current_org();
  v_user := app.current_user_id();

  -- ONE message for "no active org", "not authenticated" and "below the floor", for the reason
  -- 0009's publish_version gives at length: distinguishing them is an oracle, and there is
  -- nothing a caller can do with the distinction that it cannot do with the union.
  IF v_org IS NULL OR v_user IS NULL OR NOT app.has_role('analyst') THEN
    RAISE EXCEPTION 'this caller may not enqueue a % job', p_kind
      USING ERRCODE = 'insufficient_privilege',
            HINT = 'a job carries the org and the user it was queued by (ops.jobs.org_id / '
                   'created_by); those two columns are the publish capability check''s only '
                   'input, so an anonymous enqueue is refused here rather than later.';
  END IF;

  -- Scope the two optional references to what this caller can actually see. Without these a
  -- caller could file a job row against another tenant's project or version — the job's own
  -- org_id would still be its own, so nothing downstream would be published, but ops.jobs would
  -- hold a cross-tenant reference and the studio's job list would render a version it may not
  -- read. Checked here rather than by a FK because ops.jobs deliberately has none: B §10.1 keeps
  -- the queue readable after the survey it referenced has been purged.
  --
  -- NOTE THE ORG PREDICATE ON THE PROJECT CHECK, and that the version check needs none.
  -- app.can_see_project() is a project-SCOPING predicate, not a tenancy one: it answers "does
  -- this member's project_ids admit this project id" and, for a staff role with an empty array,
  -- that is true of ANY id — including one belonging to another org. 0004 pairs it with an
  -- explicit `org_id = app.current_org()` at every call site for exactly this reason (see
  -- app.can_see_survey and 0007's app.can_see_version, both of which compare org_id themselves
  -- and then defer). Omitting the pair here made org A's owner able to file a job against org
  -- B's project, and this suite's test.sql caught it.
  IF p_project_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM app.projects pr
                      WHERE pr.id = p_project_id AND pr.org_id = v_org) THEN
    RAISE EXCEPTION 'this caller may not enqueue a % job', p_kind
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_project_id IS NOT NULL AND NOT app.can_see_project(p_project_id) THEN
    RAISE EXCEPTION 'this caller may not enqueue a % job', p_kind
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- app.can_see_version already compares org_id to app.current_org() inside its own definer, so
  -- this one line is both the tenancy check and the project scoping.
  IF p_survey_version_id IS NOT NULL AND NOT app.can_see_version(p_survey_version_id) THEN
    RAISE EXCEPTION 'this caller may not enqueue a % job', p_kind
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN QUERY
    SELECT j.id, j.created
      FROM ops.enqueue_job(
             p_kind              => p_kind,
             p_payload           => COALESCE(p_payload, '{}'),
             p_idempotency_key   => p_idempotency_key,
             -- DERIVED, never a parameter. See §0(a).
             p_org_id            => v_org,
             p_project_id        => p_project_id,
             p_survey_version_id => p_survey_version_id,
             p_max_attempts      => COALESCE(p_max_attempts, 3),
             p_delay_ms          => COALESCE(p_delay_ms, 0)) j;
END $$;
COMMENT ON FUNCTION app.enqueue_job(text, jsonb, text, app.ulid, app.ulid, integer, integer) IS
  'THE WRITE-SIDE TWIN OF app.get_job (0005 §2), and the object apps/studio''s JobRepo.enqueue '
  'was already written against. ops.enqueue_job is SECURITY DEFINER but lives in schema ops, '
  'which `authoring` holds no USAGE on — and EXECUTE without schema USAGE is inert, so '
  'GRANT EXECUTE on it fails with "permission denied for schema ops" and the studio cannot queue '
  'its own publish job. Takes NO org_id and NO created_by: both are derived inside the definer '
  'from app.current_org() and app.current_user_id(), because those two columns are the ONLY '
  'input to 0009''s publish capability check (the compile worker assumes the enqueuing user''s '
  'identity from them), so a parameter for either would be a way to publish as somebody else. '
  'A service-role enqueue is NOT an acceptable alternative: it leaves created_by NULL and '
  '0009''s publish transaction then refuses the job with insufficient_privilege — correctly, '
  'since "the system published this" is not an answer anyone accepts six months later. '
  'DELEGATES to ops.enqueue_job so 0003''s jobs_idem_key contract ("double-clicking Publish '
  'produces exactly one job row", M0.4) has exactly one implementation. Floor is `analyst` '
  '(K §1 rank 30) — the weakest role that legitimately queues work — and NOT a per-kind '
  'capability check, because 0003 made `kind` free text on purpose and a kind -> capability map '
  'here would be a second registry that can disagree with apps/worker''s. The real '
  'authorization is the job''s own: app.publish_version re-checks project_manager/programmer.';

REVOKE EXECUTE ON FUNCTION
  app.enqueue_job(text, jsonb, text, app.ulid, app.ulid, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  app.enqueue_job(text, jsonb, text, app.ulid, app.ulid, integer, integer) TO authoring;
-- And to nobody else. runtime_writer and analytics_reader are named here for the reason 0009
-- names them: "nothing granted it" and "it is revoked" read differently to an auditor, and the
-- data plane creating control-plane work is the shape of risk R3.
REVOKE EXECUTE ON FUNCTION
  app.enqueue_job(text, jsonb, text, app.ulid, app.ulid, integer, integer)
  FROM runtime_writer, analytics_reader;

-- ---------------------------------------------------------------------------
-- 2. content.redirects — where a terminated respondent is sent (DEFECT 2)
-- ---------------------------------------------------------------------------
-- C §9's Redirects is three maps: `default`, `by_vendor` keyed by vendor ref, and `by_language`
-- keyed by BCP-47 tag; each map is disposition -> URL template, plus a `CUSTOM` sub-map keyed by
-- TerminationNode.custom_key. Flattened, that is one row per (version, scope, scope key,
-- disposition, custom key) with a template — which is B's own word for this table ("flattened")
-- and is the shape §0(b) argues for.
--
-- NO `id` COLUMN, deliberately: this is a mapping keyed by its own coordinates, not an entity
-- anything else references. content.languages and content.i18n_strings are the precedent, and
-- the consequence is the one that matters here — the primary key IS the uniqueness rule, so
-- "two templates for one disposition" is not expressible and there is no "last one wins" for a
-- redirect, which is a decision about where a respondent's browser goes.
--
-- NO `deleted_at`, for the same reason those two tables have none: deleted_at is the editor's
-- undo buffer for rows other rows point AT (B §4.1 — a soft-deleted question keeps its id alive
-- so every AST that referenced it survives undo), and nothing references a redirect row.
-- Deleting one and retyping it is lossless.
CREATE TYPE content.redirect_scope AS ENUM ('default', 'vendor', 'language');
COMMENT ON TYPE content.redirect_scope IS
  'C §9''s three arms of Redirects: `default`, `by_vendor` (keyed by vendor ref) and '
  '`by_language` (keyed by BCP-47 tag). An ENUM rather than a CHECK, unlike this table''s '
  '`disposition`, and the difference is the reason 0008 gives for the same split: this is a '
  'CLOSED structural discriminator of the physical model — C §9 has exactly these three arms and '
  'a fourth would be a new shape in the document format, not a new label — while `disposition` '
  'mirrors a Deliverable K registry that lives in another schema and must stay cheap to widen. '
  'It lives in schema content with the table it discriminates, like 0007''s node_kind and '
  'item_kind, and is NOT a K §7 registry.';

CREATE TABLE content.redirects (
  survey_version_id app.ulid NOT NULL,
  scope             content.redirect_scope NOT NULL,
  -- '' for the default scope, a vendor ref or a language tag otherwise. Empty string rather
  -- than NULL because it is half of the primary key, and NULL in a key means the uniqueness
  -- rule stops applying exactly where it is needed (0007's nodes_sibling_order_key had to reach
  -- for NULLS NOT DISTINCT to recover the same property).
  scope_key         text NOT NULL DEFAULT '',
  disposition       text NOT NULL,
  custom_key        text NOT NULL DEFAULT '',
  url_template      text NOT NULL,
  org_id            app.ulid NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (survey_version_id, scope, scope_key, disposition, custom_key),
  FOREIGN KEY (org_id, survey_version_id)
    REFERENCES app.survey_versions (org_id, id) ON DELETE CASCADE,
  -- K §2's "redirect required" column, mirrored. See §0(c) for why it is a CHECK over `text`
  -- rather than the runtime.disposition ENUM the registry actually is.
  CONSTRAINT redirects_disposition_registry CHECK (disposition IN
    ('COMPLETE', 'SCREENOUT', 'QUOTA_FULL', 'QUALITY', 'DUPLICATE', 'FRAUD', 'TERMINATE',
     'CUSTOM')),
  -- Biconditionals, in 0008's rules_one_target style: they say which value goes with which
  -- discriminator rather than merely that one is present. A `default` row with a vendor ref, or
  -- a vendor row with no ref, is a redirect that silently never matches.
  CONSTRAINT redirects_scope_key_shape CHECK ((scope = 'default') = (scope_key = '')),
  CONSTRAINT redirects_custom_key_shape CHECK ((disposition = 'CUSTOM') = (custom_key <> '')),
  -- A row that exists and has no template is worse than a missing row: CMP-0300 would pass and
  -- the respondent would be sent to the empty string.
  CONSTRAINT redirects_template_nonempty CHECK (btrim(url_template) <> '')
);
COMMENT ON TABLE content.redirects IS
  'C §9''s redirect map, flattened one row per (version, scope, scope key, disposition, custom '
  'key) as Deliverable B specifies. VERSION-SCOPED and never survey-scoped (B §0 ground rule 3, '
  'ADR-002): where a completed respondent is sent is part of what a version publishes, so it '
  'freezes with the version and a draft that retargets a new vendor cannot change where the '
  'wave already in field sends people. Created in P1-08 rather than P2-10 because C §17''s '
  'CMP-0300 — "a termination with no configured redirect is a compile error" — blocks EVERY '
  'survey until this table exists: the synthesized flow of C §6 always reaches COMPLETE, so '
  'with no redirect there is no publishable survey at all. DELIBERATELY WITHOUT B''s '
  '`allow_pii`: C §9 blocks pii variables in a template "unless explicitly allowed" and what '
  '"allowed" is scoped to is decided by the vendor work in P2-10, so the column would be a guess '
  'that has to be migrated — and adding it later is one non-rewriting ADD COLUMN in the safe '
  'direction (default false). Same argument 0008 made for on_unknown and 0009 for quota_policy.';
COMMENT ON COLUMN content.redirects.scope_key IS
  'The vendor ref or the BCP-47 language tag; '''' for the default scope, pinned by '
  'redirects_scope_key_shape. NO FOREIGN KEY to a vendor or a language, and both omissions are '
  'deliberate rather than pending: content.vendors does not exist yet (P2-10), and a redirect '
  'override for a language the version does not offer is dead configuration rather than a '
  'corrupt row — C §16 already makes the offered set a per-version fact, and the compiler is '
  'where a mismatch becomes a diagnostic the author can act on. When content.vendors lands, a '
  'composite FK on (survey_version_id, scope_key) for the vendor scope is a partial-index '
  'problem worth its own conversation, not something to pre-empt here.';
COMMENT ON COLUMN content.redirects.disposition IS
  'Deliverable K §2''s disposition, restricted to the eight the registry marks "redirect '
  'required". IN_PROGRESS is not terminal; ABANDONED and TIMED_OUT are inferred by a sweeper and '
  'there is nobody left to redirect — which is exactly why C §17''s compile error excludes them '
  'and why runtime.disposition_requires_redirect() exists. A row for one of those three is not '
  'a configuration this platform can honour, so it is unstorable. `text` + CHECK rather than the '
  'runtime.disposition ENUM: a column of that type would need every writer to hold USAGE on '
  'schema runtime, which is the grant ADR-001''s plane boundary exists to withhold from '
  '`authoring`.';
COMMENT ON COLUMN content.redirects.custom_key IS
  'C §9''s CUSTOM sub-map key — TerminationNode.custom_key — and '''' for every other '
  'disposition, pinned by redirects_custom_key_shape. Part of the primary key rather than a '
  'JSONB sub-object because that is what makes "one template per named termination" a database '
  'guarantee rather than a client-side merge.';
COMMENT ON COLUMN content.redirects.url_template IS
  'The redirect target, interpolated through the same piping engine as question text with '
  'URL-encoding applied (C §9). Stored as written, never as a parsed AST: this string is what a '
  'panel vendor gave the programmer, it goes in a support ticket verbatim, and the piping '
  'engine is the one place that has to understand it.';
COMMENT ON CONSTRAINT redirects_disposition_registry ON content.redirects IS
  'MIRRORS Deliverable K §2''s "redirect required" column and '
  'runtime.disposition_requires_redirect()''s predicate. A CHECK rather than an ENUM for the '
  'reason 0008''s rules_authored_in_registry gives — widening is DROP CONSTRAINT + ADD '
  'CONSTRAINT NOT VALID + VALIDATE, which takes no ACCESS EXCLUSIVE lock for a scan, while '
  'ALTER TYPE ... ADD VALUE has no reverse — and, decisively, because the ENUM is in schema '
  'runtime and using it here would drag USAGE on that schema into the control plane.';
COMMENT ON CONSTRAINT redirects_custom_key_shape ON content.redirects IS
  'A CUSTOM redirect names the termination it belongs to and no other redirect does. Stated as a '
  'biconditional so both mistakes are unstorable: a CUSTOM row with no key would collide with '
  'every other CUSTOM row in the same scope on the primary key, and a COMPLETE row carrying a '
  'key would be a second COMPLETE redirect that never matches anything.';

CREATE TRIGGER redirects_touch BEFORE UPDATE ON content.redirects
  FOR EACH ROW EXECUTE FUNCTION app.tg_touch_updated_at();

-- ADR-002's second layer, on every content table (B §12.1). The write POLICIES below make an
-- edit to a frozen version return "0 rows updated"; this trigger makes anything reaching the
-- table by another route — the owner, a migration, a 2 a.m. service-role script — raise.
-- ops.content_tables_without_draft_trigger() fails CI for a content table that lacks it.
CREATE TRIGGER redirects_draft_only
  BEFORE INSERT OR UPDATE OR DELETE ON content.redirects
  FOR EACH ROW EXECUTE FUNCTION content.tg_draft_only();

-- No secondary index. The primary key leads with survey_version_id, so the compiler's
-- whole-version read — which is the only query in P1-08 — is a primary-key prefix scan. Stated
-- rather than left out silently: B §13's index list for this table is P2-10's, when
-- "which surveys point at the vendor we are dropping" becomes a question anybody asks.

-- --- RLS (B §12, ADR-009) --------------------------------------------------
-- ENABLE makes policies apply; FORCE makes them apply to the table OWNER too, which every
-- migration runs as. The shape is 0007's and 0008's, unchanged and deliberately so: SELECT at
-- the `reviewer` floor with no draft restriction (reviewing a frozen version is the review
-- link), INSERT/UPDATE/DELETE at the `programmer` floor with app.version_is_draft in every
-- clause. One policy per command, never FOR ALL, and the WITH CHECK repeats every USING
-- predicate — USING says which rows you may touch, WITH CHECK says what they may become.
ALTER TABLE content.redirects ENABLE ROW LEVEL SECURITY;
ALTER TABLE content.redirects FORCE  ROW LEVEL SECURITY;

CREATE POLICY redirects_select ON content.redirects FOR SELECT TO authoring
USING (org_id = app.current_org() AND app.has_role('reviewer')
       AND app.can_see_version(survey_version_id));
COMMENT ON POLICY redirects_select ON content.redirects IS
  'Readable at the `reviewer` floor and NOT restricted to drafts, for the same reason '
  'nodes_select is not: reading a frozen version IS the review link, and a reviewer who cannot '
  'see where a screenout is sent cannot review the screener.';
CREATE POLICY redirects_insert ON content.redirects FOR INSERT TO authoring
WITH CHECK (org_id = app.current_org() AND app.has_role('programmer')
            AND app.can_see_version(survey_version_id)
            AND app.version_is_draft(survey_version_id));
CREATE POLICY redirects_update ON content.redirects FOR UPDATE TO authoring
USING (org_id = app.current_org() AND app.has_role('programmer')
       AND app.can_see_version(survey_version_id)
       AND app.version_is_draft(survey_version_id))
WITH CHECK (org_id = app.current_org() AND app.has_role('programmer')
            AND app.can_see_version(survey_version_id)
            AND app.version_is_draft(survey_version_id));
CREATE POLICY redirects_delete ON content.redirects FOR DELETE TO authoring
USING (org_id = app.current_org() AND app.has_role('programmer')
       AND app.can_see_version(survey_version_id)
       AND app.version_is_draft(survey_version_id));
COMMENT ON POLICY redirects_update ON content.redirects IS
  'The write floor is `programmer` (K §1 rank 40) and not project_manager, even though a '
  'redirect URL is where the respondent leaves the platform. Two reasons. A redirect template is '
  'authored alongside the vendor''s entry link while the questionnaire is being programmed — K '
  '§1 gives the programmer "full survey authoring" — and making a PM paste every vendor callback '
  'is how they end up in a shared spreadsheet instead of in the survey. And the moment that '
  'matters is already PM-gated one layer up: nothing here reaches a respondent until '
  'app.publish_version, which K §1 puts on project_manager. version_is_draft in BOTH clauses is '
  'ADR-002 — you cannot retarget a frozen version''s redirects, and you cannot move a draft row '
  'onto a frozen version.';

-- --- Grants (ADR-009, B §2) ------------------------------------------------
-- Explicit rather than relying on 0001's ALTER DEFAULT PRIVILEGES, per db/README.md.
GRANT SELECT, INSERT, UPDATE, DELETE ON content.redirects TO authoring;
-- ADR-009's negative capability, restated for the table that just appeared: 0007's
-- REVOKE ALL ON ALL TABLES IN SCHEMA content applied to the tables that existed when it ran.
-- The runtime reads redirects out of the compiled artifact (C §17), never as rows.
REVOKE ALL ON content.redirects FROM runtime_writer, analytics_reader;

-- ---------------------------------------------------------------------------
-- 3. content.clone_version() — REDEFINED to carry redirects (DEFECT 2, cont.)
-- ---------------------------------------------------------------------------
-- NOT OPTIONAL, and 0008 already wrote the argument in full when it added logic_rules: this
-- function enumerates its tables BY NAME, so a content table it does not know about is a table
-- whose rows are SILENTLY DROPPED on the copy-on-write that ADR-002 makes the only way to edit
-- a published survey. Publish a survey, click Edit, and every redirect in it would be gone —
-- with no error, because dropping rows nobody selected is not an error. The next publish of that
-- draft then fails CMP-0300 on a survey that was live an hour ago, and the author has no way to
-- know that clicking Edit is what deleted the configuration.
--
-- db/README.md's rule for redefining an earlier migration's object applies. The SIGNATURE is
-- unchanged, so 0007's has_function assertion stays there; the behavioural assertions in 0007
-- and 0008 compare the returned per-table count map by jsonb equality and therefore gain a
-- "redirects" key, and they are maintained in those files in this same commit. That count map is
-- the ONLY mechanical protection against this omission — the linter cannot see it and neither
-- can the catalog assertions — so a missing table shows up as a missing key.
--
-- The INSERT goes last, after i18n_strings: a redirect row's only FK is to the version, so it
-- has no ordering requirement of its own, and appending keeps the diff against 0008 to one
-- statement plus one count.
CREATE OR REPLACE FUNCTION content.clone_version(p_from app.ulid, p_to app.ulid)
RETURNS jsonb
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  v_counts jsonb := '{}';
  v_n      integer;
BEGIN
  IF p_from = p_to THEN
    RAISE EXCEPTION 'cannot clone version % onto itself', p_from
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- Cloning INTO a version that already has content would interleave two surveys. The
  -- caller creates the draft, then clones exactly once.
  IF EXISTS (SELECT 1 FROM content.nodes n WHERE n.survey_version_id = p_to) THEN
    RAISE EXCEPTION 'target version % already has content', p_to
      USING ERRCODE = 'unique_violation',
            HINT = 'clone into a freshly created draft.';
  END IF;

  -- Nodes first. ONE statement, parents and children together: PostgreSQL's referential
  -- triggers are AFTER ROW and fire at end of STATEMENT, so the self-FK
  -- (survey_version_id, parent_id) is satisfied by the time it is checked even though a
  -- child may be inserted before its parent.
  --
  -- NOTE WHAT IS NOT HERE: no id remapping, no parent_id rewrite, no ref fixups. Node ids
  -- are stable across versions (B §4.1) and every internal reference is scoped by
  -- survey_version_id through the composite FKs, so changing the version column is the
  -- entire operation. That is the most load-bearing structural decision in Deliverable B,
  -- and this function is where it pays: version diffing aligns nodes by identity rather
  -- than fuzzy matching, so "Q12 option removed" is a set difference. It is also why the
  -- logic_rules branch below needs no attention paid to its three target ids or to the two
  -- dependency-closure arrays: every id in them is still correct in the new version.
  INSERT INTO content.nodes (
    survey_version_id, id, org_id, node_kind, parent_id, sort_key, ref,
    label_key, instruction_key, title_key, question_type, required,
    config, settings, validation, masks, scripts, flags, emits, created_at)
  SELECT p_to, n.id, n.org_id, n.node_kind, n.parent_id, n.sort_key, n.ref,
         n.label_key, n.instruction_key, n.title_key, n.question_type, n.required,
         n.config, n.settings, n.validation, n.masks, n.scripts, n.flags, n.emits,
         n.created_at
    FROM content.nodes n
   WHERE n.survey_version_id = p_from AND n.deleted_at IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('nodes', v_n);

  INSERT INTO content.question_items (
    survey_version_id, id, org_id, question_id, item_kind, ref, code, label_key, sort_key,
    anchor, exclusive, behaviour, media_asset_id, value_override, custom_class, meta,
    created_at)
  SELECT p_to, i.id, i.org_id, i.question_id, i.item_kind, i.ref, i.code, i.label_key,
         i.sort_key, i.anchor, i.exclusive, i.behaviour, i.media_asset_id,
         i.value_override, i.custom_class, i.meta, i.created_at
    FROM content.question_items i
   WHERE i.survey_version_id = p_from AND i.deleted_at IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('question_items', v_n);

  INSERT INTO content.question_cells (
    survey_version_id, id, org_id, question_id, row_item_id, column_item_id,
    question_type, config, use_columns, created_at)
  SELECT p_to, c.id, c.org_id, c.question_id, c.row_item_id, c.column_item_id,
         c.question_type, c.config, c.use_columns, c.created_at
    FROM content.question_cells c
   WHERE c.survey_version_id = p_from;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('question_cells', v_n);

  INSERT INTO content.variables (
    survey_version_id, id, org_id, name, kind, vtype, source_question_id, source_item_id,
    source_part, enum_domain, expression, storage, export_include, export_column,
    export_label_key, pii, persist, sort_key, created_at)
  SELECT p_to, v.id, v.org_id, v.name, v.kind, v.vtype, v.source_question_id,
         v.source_item_id, v.source_part, v.enum_domain, v.expression, v.storage,
         v.export_include, v.export_column, v.export_label_key, v.pii, v.persist,
         v.sort_key, v.created_at
    FROM content.variables v
   WHERE v.survey_version_id = p_from AND v.deleted_at IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('variables', v_n);

  -- 0008. After variables, because a rule's targets and its dependency closure point at
  -- nodes, items and variables. authored_in and trivia ride along unchanged: which surface
  -- authored a rule is a fact about the rule, not about the version it happens to sit in.
  INSERT INTO content.logic_rules (
    survey_version_id, id, org_id, kind, target_kind, target_node_id, target_item_id,
    target_variable_id, condition, effect, evaluation, authored_in, trivia, notes,
    depends_on_variable_ids, depends_on_node_ids, sort_key, created_at)
  SELECT p_to, r.id, r.org_id, r.kind, r.target_kind, r.target_node_id, r.target_item_id,
         r.target_variable_id, r.condition, r.effect, r.evaluation, r.authored_in,
         r.trivia, r.notes, r.depends_on_variable_ids, r.depends_on_node_ids, r.sort_key,
         r.created_at
    FROM content.logic_rules r
   WHERE r.survey_version_id = p_from AND r.deleted_at IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('logic_rules', v_n);

  INSERT INTO content.languages (
    survey_version_id, lang, org_id, is_base, rtl, on_missing,
    block_publish_if_incomplete, created_at)
  SELECT p_to, l.lang, l.org_id, l.is_base, l.rtl, l.on_missing,
         l.block_publish_if_incomplete, l.created_at
    FROM content.languages l
   WHERE l.survey_version_id = p_from;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('languages', v_n);

  -- B §6 acknowledges the cost: ~300k narrow rows for a 2,000-question survey in 12
  -- languages, duplicated on every publish. ~30 MB and under a second for INSERT … SELECT,
  -- and it is what buys per-string translation state and the publish gate as an EXISTS.
  INSERT INTO content.i18n_strings (
    survey_version_id, lang, key, value, state, org_id, updated_by, updated_at)
  SELECT p_to, s.lang, s.key, s.value, s.state, s.org_id, s.updated_by, s.updated_at
    FROM content.i18n_strings s
   WHERE s.survey_version_id = p_from;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('i18n_strings', v_n);

  -- 0010. THE BRANCH THIS REDEFINITION EXISTS FOR. Without it, publish -> Edit silently drops
  -- every redirect and the next publish of that draft fails CMP-0300 on a survey that was live
  -- an hour ago. No remapping: a redirect row's key is (version, scope, scope_key, disposition,
  -- custom_key) and only the version half changes.
  INSERT INTO content.redirects (
    survey_version_id, scope, scope_key, disposition, custom_key, url_template, org_id,
    created_at)
  SELECT p_to, d.scope, d.scope_key, d.disposition, d.custom_key, d.url_template, d.org_id,
         d.created_at
    FROM content.redirects d
   WHERE d.survey_version_id = p_from;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('redirects', v_n);

  RETURN v_counts;
END $$;
COMMENT ON FUNCTION content.clone_version(app.ulid, app.ulid) IS
  'ADR-002 copy-on-write: publishing freezes a version, editing clones a new draft. ONE '
  'INSERT … SELECT per content table with NO REFERENCE REMAPPING, because node ids are '
  'stable across versions (B §4.1) and every internal reference is scoped by '
  'survey_version_id through a composite FK. Two consequences, both wanted: the clone is a '
  'flat copy with the version column changed, and version diffing aligns by identity so '
  '"Q12 option removed" is a set difference. Soft-deleted rows are dropped — the undo buffer '
  'belongs to the draft that has it, not to its successor. SECURITY INVOKER: the source is '
  'read through the caller''s policies (nodes_select permits reading a FROZEN version) and '
  'the target through the caller''s write policies plus content.tg_draft_only, so cloning '
  'into a non-draft is refused by both layers. THE TABLE LIST IS ENUMERATED BY NAME, so '
  'every new content table must be added here (0008 added content.logic_rules, 0010 added '
  'content.redirects): a table this function does not know about loses its rows on the clone '
  'with no error, because dropping rows nobody selected is not an error — and for redirects '
  'the symptom is a survey that was live an hour ago failing CMP-0300 after somebody clicked '
  'Edit.';

-- CREATE OR REPLACE preserves the function's ACL, so 0007's REVOKE/GRANT pair still stands.
-- Restated anyway, and idempotently, for the reason 0008 restated it: "preserves the ACL" is a
-- property of the statement rather than something visible at the call site, and
-- ops.functions_executable_by_public() is the guard that would have to catch it being wrong.
REVOKE EXECUTE ON FUNCTION content.clone_version(app.ulid, app.ulid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION content.clone_version(app.ulid, app.ulid) TO authoring;

-- ---------------------------------------------------------------------------
-- 4. content.question_items.id — one prefix for all three kinds (DEFECT 3)
-- ---------------------------------------------------------------------------
-- THE CONTRADICTION. Deliverable C §5.1 is explicit that QuestionItem is "one shape for option,
-- row and column", and packages/schema implements exactly that: `QuestionItem.id` is `OptionId`
-- = `Id<'opt'>` for all three kinds, ID_PREFIXES carries `option: 'opt'` and no `row` or
-- `column`, and `asId('opt', …)` THROWS on anything else. 0007's comment on this column went the
-- other way — it refused a column default because "the prefix is kind-dependent, and a single
-- default would mint `opt_...` for two of the three item kinds, breaking B §0's 'every id is
-- self-describing'" — and ops.test_seed_content duly wrote `row_…` for its matrix row.
--
-- C is the contract: it is the document format the API validates against, the compiler consumes
-- and the artifact serializes, and 0007's position exists only in a comment and a fixture.
-- Concretely, the divergence means apps/studio's DSL registry (`asOptionId(item.id)`) throws on
-- any matrix, and the compile worker's `parseValue` reports SCH-0104 against every row and
-- column it loads — so NO MATRIX QUESTION CAN BE PUBLISHED. This section normalizes the
-- database.
--
-- WHAT IS LEGAL HERE. lint-migrations.mjs rejects ALTER TABLE … RENAME (IN_PLACE_RENAME) and
-- ALTER COLUMN … TYPE (IN_PLACE_TYPE_CHANGE), and both bans are about the deploy window rather
-- than the database: the previous application version is still running and still writing the old
-- shape. Neither applies. The column keeps its name and keeps its type (app.ulid); what changes
-- is a CONSTRAINT, and adding one is expand — NOT VALID first, so ACCESS EXCLUSIVE is held only
-- briefly, then VALIDATE CONSTRAINT under SHARE UPDATE EXCLUSIVE, which blocks neither readers
-- nor writers (B §14, and 0009 §9 uses the same pattern for its two array-shape CHECKs).
--
-- THERE IS NO DATA STEP, AND THE CLAIM WAS VERIFIED RATHER THAN ASSUMED. Three checks, in
-- increasing order of how much they would have cost to be wrong about:
--   1. THE TABLE IS EMPTY in every database these migrations have been applied to. On the
--      development cluster, after `up`: SELECT count(*) FROM content.question_items = 0, as are
--      content.nodes, app.survey_versions and app.organizations. P1-08 is pre-launch — 0009
--      created the first runtime table in this programme and no token has been issued.
--   2. NOTHING IN THE APPLICATION HAS EVER WRITTEN THIS TABLE. Grepped across apps/ and
--      packages/: apps/studio touches content.question_items in exactly one place, a SELECT in
--      SupabaseRepo.registry.forVersion, and there is no INSERT path anywhere. apps/worker only
--      reads it. When a writer does arrive it will mint ids through packages/schema's IdFactory,
--      which can only produce `opt_`.
--   3. THE ONLY PRODUCERS OF A row_/col_ ID IN THE TREE ARE TEST FIXTURES: 0007 §15's
--      ops.test_seed_content (rewritten in §5 below) and 0007's own test.sql (maintained in this
--      same commit). Both run inside a transaction the runner rolls back, so neither has ever
--      left a row behind.
-- Had any of the three been false, the repair would NOT have been a batched UPDATE, and that is
-- the reason to do this now rather than after the first customer: an item id is referenced by
-- content.question_cells (row_item_id and column_item_id, two composite FKs),
-- content.logic_rules.target_item_id, content.variables.source_item_id, and — the part no SQL
-- can fix safely — by OPAQUE JSONB: C §5.1's explicit mask arm carries `item_ids`, and rule
-- conditions and effects carry item ids inside ASTs. A prefix rewrite after real content exists
-- is an expand/contract with a dual-read id-alias column and a per-AST migration in TypeScript.
-- At zero rows it is one constraint.
ALTER TABLE content.question_items
  ADD CONSTRAINT qitems_id_prefix CHECK (id LIKE 'opt\_%') NOT VALID;
ALTER TABLE content.question_items VALIDATE CONSTRAINT qitems_id_prefix;

COMMENT ON CONSTRAINT qitems_id_prefix ON content.question_items IS
  'Deliverable C §5.1: QuestionItem is ONE SHAPE for option, row and column, and its comment '
  'says rows and columns use `opt_` ids too. packages/schema implements that — every item id is '
  'branded Id<''opt''> and ID_PREFIXES has only `option: ''opt''` — so asId(''opt'', …) throws '
  'on a `row_` id and NO MATRIX QUESTION COULD BE PUBLISHED before this constraint existed: '
  'apps/studio''s DSL registry raised on asOptionId(item.id) and the compile worker''s '
  'parseValue reported SCH-0104 against every row and column. 0007''s column comment claimed the '
  'prefix was kind-dependent and its fixture wrote `row_`; C is the contract and 0007 diverged, '
  'so the database is normalized rather than the document format widened. The KIND still lives '
  'in item_kind, which is where a discriminator belongs — B §0''s "every id is self-describing" '
  'is satisfied by `opt_` describing "an item of a question", and the alternative made one '
  'concept wear three names in a table whose whole point (B §4.2) is that rows and columns have '
  'the same shape as options. LIKE ''opt\_%'' rather than a regex on the whole id because '
  'app.ulid already constrains the body; this constraint says only which prefix.';

COMMENT ON COLUMN content.question_items.id IS
  'No DEFAULT, for two of the three reasons 0007 gave and not the third. A clone must reuse the '
  'SOURCE id verbatim (B §4.1), and item ids are minted in TypeScript from the question '
  'plugin''s declared parts — P1-02''s variableSignature keeps them STABLE across a recompute — '
  'so a server-side random id would silently replace a stable id with a fresh one. 0007''s third '
  'reason, that "the prefix is kind-dependent", IS WITHDRAWN by 0010: Deliverable C §5.1 gives '
  'options, rows and columns one shape and one `opt_` prefix, packages/schema brands all three '
  'Id<''opt''>, and the divergence made every matrix question unpublishable. qitems_id_prefix is '
  'the enforcement. app.gen_ulid(''opt'') would now be a legal default; it is still not one, '
  'because of the first two reasons.';

-- ---------------------------------------------------------------------------
-- 5. ops.test_seed_content() — REDEFINED for §2 and §4
-- ---------------------------------------------------------------------------
-- The fixture five test suites and apps/worker's integration suite call. Two changes, both
-- forced by the sections above, and one consequence worth naming.
--
--   * The matrix row's id becomes opt_… (§4). It was the ONE producer of a row_ id outside a
--     test file, and leaving it would make every suite that calls this function fail on
--     qitems_id_prefix. The seed map's `row_<letter>` KEY is kept — five suites and one
--     TypeScript integration suite look up "the row item of survey X" by that name, and the key
--     names the item's KIND, which has not changed. Its VALUE is now an opt_ id, and the tag is
--     `<letter>R01` rather than `<letter>001` so it cannot collide with the 60 options.
--   * Two default-scope redirect rows per version (§2), so content.redirects is not the one
--     content table every suite leaves EMPTY. 0007 made exactly this argument for
--     content.question_cells: "a cross-tenant probe over an empty table passes vacuously, and
--     content.clone_version's question_cells branch would never be executed by any test". Both
--     failure modes apply here verbatim, and the second one is the defect this migration
--     exists to prevent recurring.
--     COMPLETE and SCREENOUT specifically: COMPLETE is the disposition C §6's synthesized flow
--     always reaches, so it is what CMP-0300 blocks on, and SCREENOUT is the one every real
--     screener needs. Two rows rather than eight because the point is that the branch and the
--     policy are exercised, not that the registry is enumerated.
--
-- CREATE OR REPLACE, signature unchanged, so 0007 keeps its has_function assertion; the
-- behavioural assertions this invalidates — 0007's and 0008's clone_version count maps, and
-- 0007's item and cell inserts — are maintained in those files in this same commit, per
-- db/README.md's rule.
CREATE OR REPLACE FUNCTION ops.test_seed_content(p_ids jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_out    jsonb := '{}';
  v_letter text;
  v_role   text;
  v_org    app.ulid;
  v_svy    app.ulid;
  v_user   uuid;
  v_ver    app.ulid;
  v_code   text;
  v_blk    app.ulid;
  v_pg     app.ulid;
  v_q1     app.ulid;
  v_q2     app.ulid;
  v_row    app.ulid;
  i        integer;
BEGIN
  FOREACH v_letter IN ARRAY ARRAY['a', 'b'] LOOP
    v_org  := (p_ids ->> ('org_'  || v_letter))::app.ulid;
    v_svy  := (p_ids ->> ('svy_'  || v_letter))::app.ulid;
    v_user := (p_ids ->> ('user_' || v_letter))::uuid;

    -- ops.test_ulid upper-cases its tag into a Crockford base32 body, which excludes I, L, O
    -- and U and has no underscore, so the readable letter is used directly and the tags stay
    -- short enough to remain legible in a failure message.
    v_code := upper(v_letter);
    v_blk  := ops.test_ulid('blk', v_code);
    v_pg   := ops.test_ulid('pg',  v_code);
    v_q1   := ops.test_ulid('qst', v_code || '1');
    v_q2   := ops.test_ulid('qst', v_code || '2');
    -- The matrix row. `opt_` because C §5.1 gives all three item kinds one prefix (0010 §4);
    -- the R01 tag keeps it clear of opt_<letter>001..060 below.
    v_row  := ops.test_ulid('opt', v_code || 'R01');

    FOREACH v_role IN ARRAY ARRAY['frozen', 'draft'] LOOP
      IF v_role = 'frozen' THEN
        -- 0004's empty draft (version_no 2). Frozen at the end of this iteration.
        v_ver := (p_ids ->> ('ver_' || v_letter || '_draft'))::app.ulid;
      ELSE
        -- The successor draft, created only after version 2 has left `draft` so that
        -- app.sv_one_draft is satisfied at every instant.
        v_ver := ops.test_ulid('ver', v_code || '3');
        INSERT INTO app.survey_versions
          (id, org_id, survey_id, version_no, status, compile_state, schema_version,
           created_by, cloned_from_version_id)
        VALUES (v_ver, v_org, v_svy, 3, 'draft', 'none', 1, v_user,
                (p_ids ->> ('ver_' || v_letter || '_draft'))::app.ulid);
      END IF;

      INSERT INTO content.nodes
        (survey_version_id, id, org_id, node_kind, parent_id, sort_key, ref, title_key)
      VALUES (v_ver, v_blk, v_org, 'block', NULL, '0100', 'SCREENER', 'blk.screener.title'),
             (v_ver, v_pg,  v_org, 'page',  v_blk, '0100', 'P1',      'pg.p1.title');
      INSERT INTO content.nodes
        (survey_version_id, id, org_id, node_kind, parent_id, sort_key, ref,
         question_type, required, label_key)
      VALUES (v_ver, v_q1, v_org, 'question', v_pg, '0100', 'S1',
              'single_select', true,  'q.s1.label'),
             (v_ver, v_q2, v_org, 'question', v_pg, '0200', 'S2',
              'multi_select',  false, 'q.s2.label');

      -- 60 options on S2, because P1-03's acceptance criterion is a 60-option list reordered
      -- by dragging, and a 3-option fixture would not distinguish one UPDATE from sixty.
      FOR i IN 1..60 LOOP
        INSERT INTO content.question_items
          (survey_version_id, id, org_id, question_id, item_kind, ref, code, label_key,
           sort_key)
        VALUES (v_ver, ops.test_ulid('opt', v_code || lpad(i::text, 3, '0')), v_org,
                v_q2, 'option', 'o' || i, i, 'q.s2.opt.' || i,
                content.frac_key_at(i, 4));
      END LOOP;

      -- One matrix row on S1 plus a per-row control override, so that
      -- content.question_cells is not the one content table every suite leaves EMPTY. A
      -- cross-tenant probe over an empty table passes vacuously, and content.clone_version's
      -- question_cells branch would never be executed by any test.
      INSERT INTO content.question_items
        (survey_version_id, id, org_id, question_id, item_kind, ref, code, label_key, sort_key)
      VALUES (v_ver, v_row, v_org, v_q1, 'row', 'r1', 1, 'q.s1.row.1', '0100');
      INSERT INTO content.question_cells
        (survey_version_id, id, org_id, question_id, row_item_id, question_type, config)
      VALUES (v_ver, ops.test_ulid('cel', v_code || '001'), v_org, v_q1,
              v_row, 'numeric', '{"min":0,"max":100}');

      INSERT INTO content.languages (survey_version_id, lang, org_id, is_base)
      VALUES (v_ver, 'en', v_org, true), (v_ver, 'de', v_org, false);
      INSERT INTO content.i18n_strings
        (survey_version_id, lang, key, value, state, org_id)
      VALUES (v_ver, 'en', 'q.s1.label', 'Do you drink coffee?', 'reviewed', v_org),
             (v_ver, 'de', 'q.s1.label', NULL,                   'missing',  v_org);

      -- 0010 §2. Two default-scope redirects, for the same reason the matrix row above exists:
      -- an empty content table makes its cross-tenant probe vacuous and leaves its
      -- clone_version branch unexecuted by every suite. COMPLETE is the disposition C §6's
      -- synthesized flow always reaches, so it is the one CMP-0300 blocks on.
      INSERT INTO content.redirects
        (survey_version_id, scope, scope_key, disposition, url_template, org_id)
      VALUES (v_ver, 'default', '', 'COMPLETE',
              'https://vendor.example/c?pid={{VENDOR_PID}}', v_org),
             (v_ver, 'default', '', 'SCREENOUT',
              'https://vendor.example/s?pid={{VENDOR_PID}}', v_org);

      -- Four variables, chosen so that every arm of every CHECK on content.variables has a
      -- live example rather than only the easy one:
      --   S1         response  enum  source, no expression
      --   S2         derived   set   source, NO EXPRESSION      <- the vars_derived_expr
      --                                                            carve-out, C §1's set view
      --                                                            over a boolean fan-out
      --   AGE_BAND   derived   enum  NO source, WITH expression <- the AUTHORED derived case
      --   VENDOR_PID hidden    text  no source, pii             <- variables_pii_idx
      INSERT INTO content.variables
        (survey_version_id, id, org_id, name, kind, vtype, source_question_id, source_part,
         enum_domain, export_column, sort_key)
      VALUES (v_ver, ops.test_ulid('var', v_code || '1'), v_org, 'S1', 'response', 'enum',
              v_q1, '{"kind":"scalar"}',
              '[{"code":1,"label_key":"s1.o1"},{"code":2,"label_key":"s1.o2"}]',
              'S1', '0100');
      INSERT INTO content.variables
        (survey_version_id, id, org_id, name, kind, vtype, source_question_id, source_part,
         enum_domain, export_column, sort_key, persist)
      VALUES (v_ver, ops.test_ulid('var', v_code || '2'), v_org, 'S2', 'derived', 'set',
              v_q2, '{"kind":"set_view"}',
              '[{"code":1,"label_key":"s2.o1"},{"code":2,"label_key":"s2.o2"}]',
              'S2', '0200', false);
      INSERT INTO content.variables
        (survey_version_id, id, org_id, name, kind, vtype, expression, enum_domain,
         export_column, sort_key)
      VALUES (v_ver, ops.test_ulid('var', v_code || '3'), v_org, 'AGE_BAND', 'derived',
              'enum',
              '{"op":"case","cases":[{"when":{"op":"<","args":[{"var":"AGE"},{"lit":25}]},'
              '"then":{"lit":1}}],"else":{"lit":2}}',
              '[{"code":1,"label_key":"ageb.18_24"},{"code":2,"label_key":"ageb.25_plus"}]',
              'AGE_BAND', '0300');
      INSERT INTO content.variables
        (survey_version_id, id, org_id, name, kind, vtype, export_column, sort_key, pii)
      VALUES (v_ver, ops.test_ulid('var', v_code || '4'), v_org, 'VENDOR_PID', 'hidden',
              'text', 'VENDOR_PID', '0400', true);

      UPDATE content.nodes
         SET emits = ARRAY[ops.test_ulid('var', v_code || '1')]::app.ulid[]
       WHERE survey_version_id = v_ver AND id = v_q1;
      UPDATE content.nodes
         SET emits = ARRAY[ops.test_ulid('var', v_code || '2')]::app.ulid[]
       WHERE survey_version_id = v_ver AND id = v_q2;

      IF v_role = 'frozen' THEN
        -- draft -> review: the ONE transition app.tg_version_guard permits out of draft that
        -- freezes the version without needing a compiled artifact (K §3's
        -- sv_live_needs_compiled applies to staging and production only). A review link over
        -- a frozen version is also exactly what content's SELECT policies exist to serve.
        UPDATE app.survey_versions SET status = 'review' WHERE id = v_ver;
      END IF;

      v_out := v_out || jsonb_build_object('ver_' || v_letter || '_content_' || v_role, v_ver);
    END LOOP;

    v_out := v_out || jsonb_build_object(
      'blk_' || v_letter, v_blk,
      'pg_'  || v_letter, v_pg,
      'q1_'  || v_letter, v_q1,
      'q2_'  || v_letter, v_q2,
      'opt_' || v_letter || '_first', ops.test_ulid('opt', v_code || '001'),
      'opt_' || v_letter || '_last',  ops.test_ulid('opt', v_code || '060'),
      -- The KEY still says `row`, because it names the item's KIND and that has not changed.
      -- The VALUE is an opt_ id (0010 §4).
      'row_' || v_letter, v_row,
      'cel_' || v_letter, ops.test_ulid('cel', v_code || '001'),
      'var_' || v_letter || '_setview', ops.test_ulid('var', v_code || '2'));
  END LOOP;

  -- An EMPTY draft on a SECOND survey in org A, as the clone target. It has to be a second
  -- survey: app.sv_one_draft allows one draft per survey and survey A's is the one that was
  -- just seeded, so there is nowhere else for content.clone_version() to land.
  INSERT INTO app.surveys (id, org_id, project_id, ref, name, created_by)
  VALUES (ops.test_ulid('svy', 'AC'), (p_ids ->> 'org_a')::app.ulid,
          (p_ids ->> 'prj_a')::app.ulid, 'SVYAC', 'Survey A clone target',
          (p_ids ->> 'user_a')::uuid);
  INSERT INTO app.survey_versions
    (id, org_id, survey_id, version_no, status, compile_state, schema_version, created_by)
  VALUES (ops.test_ulid('ver', 'AC'), (p_ids ->> 'org_a')::app.ulid,
          ops.test_ulid('svy', 'AC'), 1, 'draft', 'none', 1,
          (p_ids ->> 'user_a')::uuid);
  v_out := v_out || jsonb_build_object(
    'svy_a_clone', ops.test_ulid('svy', 'AC'),
    'ver_a_clone_target', ops.test_ulid('ver', 'AC'));

  RETURN v_out;
END $$;
COMMENT ON FUNCTION ops.test_seed_content(jsonb) IS
  'Takes ops.test_seed_two_orgs()''s id map and adds content to it: per survey, ONE frozen '
  '(`review`) version and ONE draft version, each holding a block, a page, two questions, a '
  '60-option list, a matrix row with a per-row control override (so content.question_cells '
  'is never the table every suite leaves empty), TWO DEFAULT-SCOPE REDIRECTS (0010, for the '
  'same reason — and because content.redirects being missing from content.clone_version is the '
  'defect 0010 exists to stop recurring), two languages, two i18n strings and four '
  'variables — one per arm of every '
  'CHECK on content.variables, including the structurally-derived set_view that the '
  'vars_derived_expr carve-out exists for. Node ids are identical across both versions of a '
  'survey (B §4.1). Every question_item id is `opt_`-prefixed, including the matrix row: '
  'Deliverable C §5.1 gives all three item kinds one shape and one prefix, and 0010 §4 made the '
  'database agree (the `row_<letter>` key in the returned map is unchanged — it names the KIND, '
  'not the prefix). Plus an empty draft on a second survey in org A as content.clone_version''s '
  'target, because app.sv_one_draft allows only one draft per survey. Reaches the frozen state '
  'by going FORWARD (seed the draft, then draft -> review), never by reverting a published '
  'version — app.tg_version_guard rejects production -> draft, which is the correct behaviour '
  'and was what broke the first version of this fixture. Separate function rather than '
  're-signing test_seed_two_orgs, whose signature five earlier test.sql files depend on. '
  'SECURITY DEFINER and ungranted: called by the migration runner inside a transaction that is '
  'rolled back, and it makes no attempt to be idempotent.';
REVOKE EXECUTE ON FUNCTION ops.test_seed_content(jsonb) FROM PUBLIC;
