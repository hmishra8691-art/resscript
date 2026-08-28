-- 0024_vendors — the vendor registry (roadmap P2-04's DB line: `content.vendors`,
-- `content.vendor_limits`).

-- Timeouts first, ahead of this file's header prose rather than after it: B §14 wants them set
-- before any DDL, and `tools/ci/lint-migrations.mjs` looks for them in the first 60 lines. They
-- were below the header here, at line 72, which satisfied the intent and failed the check —
-- MISSING_TIMEOUT_HEADER, on a migration that did set both.
SET lock_timeout = '3s';
SET statement_timeout = '120s';

-- ## What was already built, and why none of it ran
--
-- P2-04's vendor machinery is complete except for the table that feeds it. `vendorFromParams`
-- matches `?src=<ref>` against a vendor; `verifyEntry` checks the HMAC and creates no session on
-- failure; `bindInboundParams` writes declared parameters into hidden variables and refuses any
-- other kind; `resolveTemplate` resolves a redirect `by_vendor` before `by_language` before
-- `default`; `assertNoSecrets` rebuilds a vendor from a whitelist before it reaches the artifact.
-- All of it tested.
--
-- And `apps/worker`'s `assembleSurvey` never set `Survey.vendors`, because there were no columns —
-- its own header lists `vendors` among the four fields whose "absence is merely a feature not yet
-- reachable". So `vendors.json` was never emitted, `head.vendors` was always absent,
-- `vendorFromParams` always returned undefined, `session.vendor_ref` was always null, and the
-- `by_vendor` tier could not fire. An entire signed-entry and per-vendor-redirect feature, unreachable
-- for want of three tables.
--
-- ## Relational, not jsonb, and the reason is a foreign key
--
-- `Vendor.inbound_params` is a small array and jsonb would be less code. It is a table because
-- that makes ONE thing a database guarantee instead of a compiler check: an inbound parameter
-- names a variable that exists in this version. `SCH-1004` checks it today and `SCH-1004` runs at
-- publish; a composite FK to `content.variables` refuses the bad row at write time, which is where
-- a vendor console's typo happens.
--
-- The FK points at the variable's ID, not its name, and that took a correction. `content.variables`
-- enforces name uniqueness with a PARTIAL EXPRESSION index — `(survey_version_id, lower(name))
-- WHERE deleted_at IS NULL` — which no foreign key can reference. So the choice was between
-- storing a name with no integrity at all, or storing the id and deriving the name.
--
-- Storing the id is better than the compromise it first looked like. Schema §9 addresses the target
-- by ref "because vendors are authored by hand", and that stays true of the DOCUMENT: the publish
-- read joins to `content.variables` and emits `variable_ref`. Meanwhile a variable RENAME now flows
-- into the vendor configuration automatically instead of dangling — which is the same property
-- `variableSignature` is built on elsewhere in this codebase, and it is the failure
-- `apps/runtime/src/vendor/inbound.ts` calls out by name: "a ref that resolves to nothing ... is the
-- shape of a vendor config that outlived a variable rename."
--
-- What an FK still cannot express is that the target be `hidden`; the variable's kind is in no
-- unique constraint. `bindInboundParams` refuses a non-hidden target at runtime and SCH-1004's
-- sibling could at publish. Left to those two, stated so the omission is not read as an oversight.
--
-- ## What must never be in these tables
--
-- The secret. Only `security.secret_ref`, a pointer. Three layers already say so — the schema type
-- ("The secret itself is never in the survey model"), `assertNoSecrets` ("putting an HMAC secret in
-- an artifact would be the single worst bug available in this design"), and the artifact type — and
-- all three are DOWNSTREAM of a paste into a vendor console. So the check moves to the table, with
-- the same heuristic the compiler uses: a long opaque string in a `secret_ref` is refused at write
-- time rather than at publish.
--
-- ## One ceiling, not three
--
-- Three fields express "this vendor may deliver at most N completes" and nothing reads any of them:
-- `Vendor.max_completes`, `QuotaConfig.vendor_limits[].max_completes`, and
-- `Vendor.quota_plan_overrides`. Picking one is part of this migration rather than deferred:
--
--   * `content.vendors.max_completes` is THE ceiling. It sits on the vendor, which is the object an
--     operator negotiates with a panel about.
--   * `content.vendor_limits` exists because P2-04's DB line names it, and it is per (vendor, quota
--     plan) — a narrower thing than the vendor ceiling, for "this panel may fill at most 200 of the
--     Northeast cells". It does NOT duplicate max_completes.
--   * `QuotaConfig.vendor_limits[]` in the schema document is now the ARTIFACT projection of this
--     table, not an independently authored field.
--
-- Neither ceiling is ENFORCED yet: enforcement is a counter keyed by vendor at the quota gate, which
-- is P2-08 machinery pointed at a new key. Stored and unenforced is stated here rather than
-- discovered later.


/* ------------------------------------------------------------------ *
 * 1. content.vendors
 * ------------------------------------------------------------------ */

CREATE TYPE content.vendor_hash_algorithm AS ENUM ('sha256', 'sha1', 'md5');
COMMENT ON TYPE content.vendor_hash_algorithm IS
  'VendorSecurity.algorithm. sha1 and md5 are here because panel vendors use them and refusing a '
  'client''s panel is not this platform''s call to make — but they are weak, they are not the '
  'default, and a vendor console should say so. sha256 is what a new integration gets.';

CREATE TABLE content.vendors (
  survey_version_id app.ulid NOT NULL,
  id                app.ulid NOT NULL,
  org_id            app.ulid NOT NULL,
  -- The identity `?src=<ref>` matches, so it is unique per version and case-sensitive (schema §3).
  ref               app.ref NOT NULL,
  name              text NOT NULL,
  entry_url_template text,
  -- The per-vendor completes ceiling. See the header on why this is the one field that means it.
  max_completes     integer,
  quota_plan_overrides text[] NOT NULL DEFAULT '{}',
  -- Security, flattened. NULL algorithm/hash_param/secret_ref together means an UNSIGNED vendor,
  -- which is a real configuration: a QR code or a client's own mailing list has no panel to sign.
  hash_param        text,
  algorithm         content.vendor_hash_algorithm,
  secret_ref        text,
  signed_params     text[] NOT NULL DEFAULT '{}',
  max_skew_s        integer,
  timestamp_param   text,
  nonce_param       text,
  sort_key          text NOT NULL DEFAULT '0100',
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (survey_version_id, id),
  FOREIGN KEY (org_id, survey_version_id)
    REFERENCES app.survey_versions (org_id, id) ON DELETE CASCADE,
  CONSTRAINT vendors_ref_key UNIQUE (survey_version_id, ref),
  CONSTRAINT vendors_name_nonempty CHECK (btrim(name) <> ''),
  -- Signed or unsigned, never half. A vendor with an algorithm and no secret_ref would verify
  -- against nothing; one with a secret_ref and no hash_param has nowhere to read the signature
  -- from. `verifyEntry` reports `no_secret` / `no_signed_params` for exactly these states, and a
  -- runtime that reports a configuration error to a respondent as a 403 is a configuration error
  -- that should not have been storable.
  CONSTRAINT vendors_security_all_or_none CHECK (
    (hash_param IS NULL AND algorithm IS NULL AND secret_ref IS NULL)
    OR (hash_param IS NOT NULL AND algorithm IS NOT NULL AND secret_ref IS NOT NULL)),
  -- A signed vendor must say WHICH params are signed. `verifyEntry`'s `no_signed_params` is the
  -- runtime's answer; this is the write-time one, because a signature over nothing verifies
  -- everything.
  CONSTRAINT vendors_signed_params_present CHECK (
    secret_ref IS NULL OR cardinality(signed_params) > 0),
  CONSTRAINT vendors_signed_params_distinct CHECK (content.array_is_distinct(signed_params)),
  CONSTRAINT vendors_overrides_distinct CHECK (content.array_is_distinct(quota_plan_overrides)),
  -- THE SECRET CHECK. Same heuristic as the compiler's LOOKS_LIKE_SECRET, moved to the write path:
  -- 32+ characters of opaque base64/hex is a secret, not a reference. Every other layer that says
  -- "never the secret itself" is downstream of a paste into a vendor console.
  CONSTRAINT vendors_secret_ref_is_a_reference CHECK (
    secret_ref IS NULL OR secret_ref !~ '^[A-Za-z0-9+/=_-]{32,}$'),
  CONSTRAINT vendors_secret_ref_nonempty CHECK (secret_ref IS NULL OR btrim(secret_ref) <> ''),
  CONSTRAINT vendors_max_completes_positive CHECK (max_completes IS NULL OR max_completes > 0),
  CONSTRAINT vendors_max_skew_positive CHECK (max_skew_s IS NULL OR max_skew_s > 0)
);

COMMENT ON TABLE content.vendors IS
  'Panel vendors: the entry identity `?src=<ref>` matches, the inbound parameter allowlist (its own '
  'table), the HMAC configuration, and the per-vendor completes ceiling. VERSION-SCOPED (B §0 '
  'ground rule 3, ADR-002) because a vendor relationship is part of what a version publishes — the '
  'wave in field keeps the panel and the signing configuration it was fielded with, and a draft '
  'that adds a panel does not retroactively let that panel into a running wave. Created in P2-04, '
  'seventeen migrations after the runtime that reads it: every piece of vendor handling was built '
  'and tested against an artifact field that no publish could populate, so signed entry and '
  'per-vendor redirects were unreachable in production.';
COMMENT ON COLUMN content.vendors.secret_ref IS
  'A POINTER into the secrets store, never the secret. Enforced here by the same heuristic the '
  'compiler''s assertNoSecrets uses, because every other layer that forbids a secret value — the '
  'schema type, the compiler, the artifact type — sits DOWNSTREAM of a paste into a vendor console. '
  'A false positive is a secret_ref somebody has to rename; a false negative is an HMAC key on a '
  'CDN.';
COMMENT ON COLUMN content.vendors.max_completes IS
  'The per-vendor completes ceiling, and the ONE field that means it. The schema also carries '
  'QuotaConfig.vendor_limits[].max_completes and Vendor.quota_plan_overrides, neither of which any '
  'code reads; this column is authoritative and content.vendor_limits is the narrower per-plan '
  'thing. STORED AND NOT YET ENFORCED: enforcement is a quota counter keyed by vendor at the gate, '
  'which is P2-08 machinery pointed at a new key.';
COMMENT ON CONSTRAINT vendors_security_all_or_none ON content.vendors IS
  'Signed or unsigned, never half. verifyEntry reports `no_secret` and `no_signed_params` for the '
  'half states, which means a respondent sees a 403 for somebody else''s configuration mistake — '
  'so the mistake is made unstorable instead.';

CREATE INDEX vendors_version_idx ON content.vendors (survey_version_id, sort_key);

CREATE TRIGGER vendors_touch BEFORE UPDATE ON content.vendors
  FOR EACH ROW EXECUTE FUNCTION app.tg_touch_updated_at();
CREATE TRIGGER vendors_draft_only
  BEFORE INSERT OR UPDATE OR DELETE ON content.vendors
  FOR EACH ROW EXECUTE FUNCTION content.tg_draft_only();

/* ------------------------------------------------------------------ *
 * 2. content.vendor_inbound_params
 * ------------------------------------------------------------------ */

CREATE TABLE content.vendor_inbound_params (
  survey_version_id app.ulid NOT NULL,
  vendor_id         app.ulid NOT NULL,
  param             text NOT NULL,
  -- The variable's ID. The DOCUMENT keeps a ref (schema §9) — the publish read joins and emits
  -- `variable_ref` — but the STORED form is an id, because that is what a foreign key can hold and
  -- because it makes a rename flow through instead of dangling. See the header.
  variable_id       app.ulid NOT NULL,
  required          boolean NOT NULL DEFAULT false,
  sort_key          text NOT NULL DEFAULT '0100',
  org_id            app.ulid NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (survey_version_id, vendor_id, param),
  FOREIGN KEY (survey_version_id, vendor_id)
    REFERENCES content.vendors (survey_version_id, id) ON DELETE CASCADE,
  -- The reason this is a table and not a jsonb column: an inbound parameter cannot target a
  -- variable that does not exist in this version. SCH-1004 checks it at publish; this refuses the
  -- row at the moment a vendor console's typo is made. RESTRICT and not CASCADE — deleting a
  -- variable that a panel writes into should fail loudly, because the alternative is a vendor whose
  -- entry link silently stops carrying a panel id.
  FOREIGN KEY (survey_version_id, variable_id)
    REFERENCES content.variables (survey_version_id, id) ON DELETE RESTRICT,
  CONSTRAINT vendor_params_param_shape CHECK (param ~ '^[A-Za-z0-9_.-]{1,64}$')
);

COMMENT ON TABLE content.vendor_inbound_params IS
  'A vendor''s inbound parameter allowlist — the ONLY query-string parameters that may write into a '
  'variable. The allowlist is the security boundary: the query string is the one input a respondent '
  'types freely, so without it a respondent appending ?PANEL_AGE=99 sets a variable a quota '
  'dimension reads (apps/runtime/src/vendor/inbound.ts). A table rather than jsonb on the vendor so '
  'the composite FK to content.variables makes "targets a declared variable" a write-time guarantee '
  'instead of a publish-time diagnostic.';
COMMENT ON CONSTRAINT vendor_params_param_shape ON content.vendor_inbound_params IS
  'A query-string parameter name, bounded. Excludes the characters that would need escaping in a '
  'URL or a signature''s canonical string — a param called `a&b` would split the canonical form and '
  'make two different query strings produce one signature.';

CREATE TRIGGER vendor_params_touch BEFORE UPDATE ON content.vendor_inbound_params
  FOR EACH ROW EXECUTE FUNCTION app.tg_touch_updated_at();
CREATE TRIGGER vendor_params_draft_only
  BEFORE INSERT OR UPDATE OR DELETE ON content.vendor_inbound_params
  FOR EACH ROW EXECUTE FUNCTION content.tg_draft_only();

/* ------------------------------------------------------------------ *
 * 3. content.vendor_limits
 * ------------------------------------------------------------------ */

CREATE TABLE content.vendor_limits (
  survey_version_id app.ulid NOT NULL,
  vendor_id         app.ulid NOT NULL,
  plan_id           app.ulid NOT NULL,
  max_completes     integer NOT NULL,
  org_id            app.ulid NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (survey_version_id, vendor_id, plan_id),
  FOREIGN KEY (survey_version_id, vendor_id)
    REFERENCES content.vendors (survey_version_id, id) ON DELETE CASCADE,
  -- To the PLAN and not to a cell: a per-vendor ceiling is "this panel may fill at most N of this
  -- plan", which is a plan-level statement. Per-cell would be a different feature and a much bigger
  -- authoring surface.
  FOREIGN KEY (survey_version_id, plan_id)
    REFERENCES content.quota_plans (survey_version_id, id) ON DELETE CASCADE,
  CONSTRAINT vendor_limits_positive CHECK (max_completes > 0)
);

COMMENT ON TABLE content.vendor_limits IS
  'A per-(vendor, quota plan) completes ceiling — "this panel may fill at most 200 of the Northeast '
  'cells". Named by P2-04''s DB line, and NARROWER than content.vendors.max_completes rather than a '
  'duplicate of it: that column is the vendor''s total, this is its share of one plan. 0016 '
  'declined to create it ("a limit with no vendor table is a column nobody can populate") and '
  'pointed here. STORED AND NOT YET ENFORCED — enforcement is a quota counter keyed by (plan, '
  'vendor), which is P2-08 machinery pointed at a new key, and a limit that silently did nothing '
  'while looking configured is exactly what this comment exists to prevent somebody assuming.';

CREATE TRIGGER vendor_limits_touch BEFORE UPDATE ON content.vendor_limits
  FOR EACH ROW EXECUTE FUNCTION app.tg_touch_updated_at();
CREATE TRIGGER vendor_limits_draft_only
  BEFORE INSERT OR UPDATE OR DELETE ON content.vendor_limits
  FOR EACH ROW EXECUTE FUNCTION content.tg_draft_only();

/* ------------------------------------------------------------------ *
 * 4. RLS — one policy per command, following 0010's redirects exactly
 * ------------------------------------------------------------------ */

-- Read at the PROGRAMMER floor, not `reviewer`, and that differs from most content tables on
-- purpose. 0010's redirects route makes the same call and states it: "a redirect row is a vendor
-- relationship (which panel, which callback host), which is not part of what a review link is for."
-- A vendor row is that relationship directly, plus a pointer into the secrets store — a `secret_ref`
-- is not a secret, but a list of them is a map of the secret store, and a review link is shared
-- outside the programming team.
/* Written out three times rather than looped over `FOREACH t IN ARRAY ARRAY[...]`, which is how
 * this section was first drafted.
 *
 * The loop was correct — the catalog ended up in exactly this state — and it still cost the repo
 * one of its two protections against precisely this class of mistake.
 * `tools/ci/lint-migrations.mjs` matches `ALTER TABLE <schema>.<table> (ENABLE|FORCE) ROW LEVEL
 * SECURITY` STATICALLY, against the text of up.sql, and cannot see through
 * `format('ALTER TABLE content.%I ENABLE ROW LEVEL SECURITY', t)` because the table name is a
 * variable. So all three tables were reported as TABLE_WITHOUT_FORCED_RLS, and the useful reading
 * of that is not "false positive" but "these three tables are now covered by one net instead of
 * two". The linter's own header says both layers exist on purpose: `ops.tables_without_rls()` is
 * the catalog net and runs only after a migration has been applied, while this one runs on a pull
 * request nobody applied to a database and can name the file and line.
 *
 * That rule is also the one rule the linter refuses to let anybody waive — STATIC_EXEMPTIBLE holds
 * CONTENT_TABLE_WITHOUT_DRAFT_TRIGGER and nothing else, with a comment saying a missing-RLS
 * failure is "a conversation worth having in review rather than one a directive can end". A
 * migration written so that the check cannot run is that waiver taken silently.
 *
 * Sixty lines of repetition for a static guarantee on tenant isolation is a trade this file should
 * make every time.
 */

ALTER TABLE content.vendors ENABLE ROW LEVEL SECURITY;
-- FORCE, so the table owner is not exempt: every migration runs as the owner, so ENABLE alone
-- leaves the isolation suite passing while production leaks.
ALTER TABLE content.vendors FORCE ROW LEVEL SECURITY;

CREATE POLICY vendors_select ON content.vendors FOR SELECT TO authoring
USING (org_id = app.current_org() AND app.has_role('programmer')
       AND app.can_see_version(survey_version_id));
CREATE POLICY vendors_insert ON content.vendors FOR INSERT TO authoring
WITH CHECK (org_id = app.current_org() AND app.has_role('programmer')
            AND app.can_see_version(survey_version_id)
            AND app.version_is_draft(survey_version_id));
CREATE POLICY vendors_update ON content.vendors FOR UPDATE TO authoring
USING (org_id = app.current_org() AND app.has_role('programmer')
       AND app.can_see_version(survey_version_id)
       AND app.version_is_draft(survey_version_id))
WITH CHECK (org_id = app.current_org() AND app.has_role('programmer')
            AND app.can_see_version(survey_version_id)
            AND app.version_is_draft(survey_version_id));
CREATE POLICY vendors_delete ON content.vendors FOR DELETE TO authoring
USING (org_id = app.current_org() AND app.has_role('programmer')
       AND app.can_see_version(survey_version_id)
       AND app.version_is_draft(survey_version_id));

-- Explicit rather than relying on 0001's ALTER DEFAULT PRIVILEGES (db/README.md), and the REVOKE
-- restated because 0007's blanket revoke applied to the tables that existed when it ran. The
-- runtime reads vendors out of the compiled artifact (C §17), never as rows.
GRANT SELECT, INSERT, UPDATE, DELETE ON content.vendors TO authoring;
REVOKE ALL ON content.vendors FROM runtime_writer, analytics_reader;

ALTER TABLE content.vendor_inbound_params ENABLE ROW LEVEL SECURITY;
-- FORCE, so the table owner is not exempt: every migration runs as the owner, so ENABLE alone
-- leaves the isolation suite passing while production leaks.
ALTER TABLE content.vendor_inbound_params FORCE ROW LEVEL SECURITY;

CREATE POLICY vendor_inbound_params_select ON content.vendor_inbound_params FOR SELECT TO authoring
USING (org_id = app.current_org() AND app.has_role('programmer')
       AND app.can_see_version(survey_version_id));
CREATE POLICY vendor_inbound_params_insert ON content.vendor_inbound_params FOR INSERT TO authoring
WITH CHECK (org_id = app.current_org() AND app.has_role('programmer')
            AND app.can_see_version(survey_version_id)
            AND app.version_is_draft(survey_version_id));
CREATE POLICY vendor_inbound_params_update ON content.vendor_inbound_params FOR UPDATE TO authoring
USING (org_id = app.current_org() AND app.has_role('programmer')
       AND app.can_see_version(survey_version_id)
       AND app.version_is_draft(survey_version_id))
WITH CHECK (org_id = app.current_org() AND app.has_role('programmer')
            AND app.can_see_version(survey_version_id)
            AND app.version_is_draft(survey_version_id));
CREATE POLICY vendor_inbound_params_delete ON content.vendor_inbound_params FOR DELETE TO authoring
USING (org_id = app.current_org() AND app.has_role('programmer')
       AND app.can_see_version(survey_version_id)
       AND app.version_is_draft(survey_version_id));

-- Explicit rather than relying on 0001's ALTER DEFAULT PRIVILEGES (db/README.md), and the REVOKE
-- restated because 0007's blanket revoke applied to the tables that existed when it ran. The
-- runtime reads vendors out of the compiled artifact (C §17), never as rows.
GRANT SELECT, INSERT, UPDATE, DELETE ON content.vendor_inbound_params TO authoring;
REVOKE ALL ON content.vendor_inbound_params FROM runtime_writer, analytics_reader;

ALTER TABLE content.vendor_limits ENABLE ROW LEVEL SECURITY;
-- FORCE, so the table owner is not exempt: every migration runs as the owner, so ENABLE alone
-- leaves the isolation suite passing while production leaks.
ALTER TABLE content.vendor_limits FORCE ROW LEVEL SECURITY;

CREATE POLICY vendor_limits_select ON content.vendor_limits FOR SELECT TO authoring
USING (org_id = app.current_org() AND app.has_role('programmer')
       AND app.can_see_version(survey_version_id));
CREATE POLICY vendor_limits_insert ON content.vendor_limits FOR INSERT TO authoring
WITH CHECK (org_id = app.current_org() AND app.has_role('programmer')
            AND app.can_see_version(survey_version_id)
            AND app.version_is_draft(survey_version_id));
CREATE POLICY vendor_limits_update ON content.vendor_limits FOR UPDATE TO authoring
USING (org_id = app.current_org() AND app.has_role('programmer')
       AND app.can_see_version(survey_version_id)
       AND app.version_is_draft(survey_version_id))
WITH CHECK (org_id = app.current_org() AND app.has_role('programmer')
            AND app.can_see_version(survey_version_id)
            AND app.version_is_draft(survey_version_id));
CREATE POLICY vendor_limits_delete ON content.vendor_limits FOR DELETE TO authoring
USING (org_id = app.current_org() AND app.has_role('programmer')
       AND app.can_see_version(survey_version_id)
       AND app.version_is_draft(survey_version_id));

-- Explicit rather than relying on 0001's ALTER DEFAULT PRIVILEGES (db/README.md), and the REVOKE
-- restated because 0007's blanket revoke applied to the tables that existed when it ran. The
-- runtime reads vendors out of the compiled artifact (C §17), never as rows.
GRANT SELECT, INSERT, UPDATE, DELETE ON content.vendor_limits TO authoring;
REVOKE ALL ON content.vendor_limits FROM runtime_writer, analytics_reader;

COMMENT ON POLICY vendors_select ON content.vendors IS
  'PROGRAMMER to read, not reviewer — the one content table in this codebase whose read floor is '
  'above the review bar, matching the reasoning 0010''s redirects route already applies: a vendor '
  'row is a commercial relationship plus a pointer into the secrets store, and a list of '
  'secret_refs is a map of the secret store. A review link is shared outside the programming team.';

/* ------------------------------------------------------------------ *
 * 5. Clone composition, restructured so this cannot keep happening
 * ------------------------------------------------------------------ *
 *
 * 0023's `ops.content_tables_not_cloned()` refused this migration on its first run — all three
 * vendor tables reported as version-scoped and uncloned. That is the check doing precisely the job
 * it was written for, on the very next opportunity, and it is why the restructuring below is here
 * rather than in a later migration.
 *
 * ## The remaining fragility 0023 did not remove
 *
 * 0023 put its six branches INLINE in `content.clone_version`. So adding vendors meant
 * `CREATE OR REPLACE`-ing that function — and a replacement either retypes 0023's branches or
 * silently drops them. Writing this migration, I reached for a `clone_version_quotas` helper that
 * did not exist and would have shipped a function missing six tables. The catalog check would have
 * caught it, which is the point; but a design where the correct move is "retype the previous
 * migration's work" is a design that keeps generating this bug.
 *
 * ## Composition over the catalog
 *
 * `content.clone_version` now calls `clone_version_core` and then EVERY
 * `content.clone_version_part_%` function it finds, in name order, merging their count maps. Adding
 * a content table becomes: write one part function. `clone_version` is never edited again, so it
 * cannot lose a branch, and `ops.content_tables_not_cloned()` already matches the whole
 * `clone_version%` family so it sees the parts without changing.
 *
 * Name order, not creation order, so the result is stable across a rebuild from migrations — and
 * the parts are independent by construction (each inserts into its own tables), so the only thing
 * order buys is a deterministic count map.
 *
 * 0023's six branches move into `clone_version_part_p2` VERBATIM. Retyping them was the thing to
 * avoid, so they are copied, not rewritten.
 */

CREATE FUNCTION content.clone_version_part_p2(p_from app.ulid, p_to app.ulid)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = ''
AS $fn$
DECLARE
  v_counts jsonb := '{}';
  v_n      integer;
BEGIN
  /* ---- quotas (0016) ---------------------------------------------- */

  INSERT INTO content.quota_dimensions (
    survey_version_id, id, org_id, ref, variable_id, sort_key, created_at, updated_at, deleted_at)
  SELECT p_to, d.id, d.org_id, d.ref, d.variable_id, d.sort_key, d.created_at, d.updated_at,
         d.deleted_at
    FROM content.quota_dimensions d WHERE d.survey_version_id = p_from;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || pg_catalog.jsonb_build_object('quota_dimensions', v_n);

  INSERT INTO content.quota_buckets (
    survey_version_id, id, org_id, dimension_id, ref, match, sort_key, created_at, updated_at,
    deleted_at)
  SELECT p_to, b.id, b.org_id, b.dimension_id, b.ref, b.match, b.sort_key, b.created_at,
         b.updated_at, b.deleted_at
    FROM content.quota_buckets b WHERE b.survey_version_id = p_from;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || pg_catalog.jsonb_build_object('quota_buckets', v_n);

  INSERT INTO content.quota_plans (
    survey_version_id, id, org_id, ref, plan_type, dimension_ids, count_at, reservation_ttl_s,
    on_store_unavailable, counter_scope, overflow, sort_key, created_at, updated_at, deleted_at)
  SELECT p_to, q.id, q.org_id, q.ref, q.plan_type, q.dimension_ids, q.count_at,
         q.reservation_ttl_s, q.on_store_unavailable, q.counter_scope, q.overflow, q.sort_key,
         q.created_at, q.updated_at, q.deleted_at
    FROM content.quota_plans q WHERE q.survey_version_id = p_from;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || pg_catalog.jsonb_build_object('quota_plans', v_n);

  INSERT INTO content.quota_cells (
    survey_version_id, id, org_id, plan_id, cell_key, target, target_pct, mode, created_at,
    updated_at, deleted_at)
  SELECT p_to, c.id, c.org_id, c.plan_id, c.cell_key, c.target, c.target_pct, c.mode, c.created_at,
         c.updated_at, c.deleted_at
    FROM content.quota_cells c WHERE c.survey_version_id = p_from;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || pg_catalog.jsonb_build_object('quota_cells', v_n);

  /* ---- code assets (0019) ----------------------------------------- */

  -- `sha256` is omitted because it is GENERATED ALWAYS: naming it would raise, and the clone
  -- recomputes it from the copied source — which is the point of generating it (0019's header).
  --
  -- `sanitizer_report` and `analyzed_at` ARE copied, and that is a decision rather than a default.
  -- The report is an archive of what the sanitizer found for these exact bytes, and the bytes are
  -- unchanged by a clone, so the verdict still describes them. Dropping it would make every clone
  -- look unanalysed; 0019's own header says the publish path re-analyses regardless, so a stale
  -- report can mislead nobody.
  INSERT INTO content.code_assets (
    id, survey_version_id, org_id, kind, ref, source, runs_on, scope, hooks, sanitizer_report,
    analyzed_at, created_at, updated_at)
  SELECT a.id, p_to, a.org_id, a.kind, a.ref, a.source, a.runs_on, a.scope, a.hooks,
         a.sanitizer_report, a.analyzed_at, a.created_at, a.updated_at
    FROM content.code_assets a WHERE a.survey_version_id = p_from;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || pg_catalog.jsonb_build_object('code_assets', v_n);

  /* ---- the theme pin (0021) --------------------------------------- */

  -- The SNAPSHOT is copied, not re-resolved from the theme. 0021's header is explicit about why:
  -- re-resolving consults a parent theme that may have changed, which answers a different question
  -- than the one that was approved. A clone starts life looking exactly like what it was cloned
  -- from, and an author who wants the new brand re-pins deliberately.
  INSERT INTO content.version_theme (
    survey_version_id, org_id, theme_id, theme_name, tokens_snapshot, compiled_css_sha256,
    created_at, updated_at)
  SELECT p_to, t.org_id, t.theme_id, t.theme_name, t.tokens_snapshot, t.compiled_css_sha256,
         t.created_at, t.updated_at
    FROM content.version_theme t WHERE t.survey_version_id = p_from;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || pg_catalog.jsonb_build_object('version_theme', v_n);
  RETURN v_counts;
END $fn$;

COMMENT ON FUNCTION content.clone_version_part_p2(app.ulid, app.ulid) IS
  '0023''s six branches — the four quota tables, content.code_assets and content.version_theme — '
  'moved verbatim out of content.clone_version''s body so that adding a seventh table never again '
  'requires replacing a function that owns other migrations'' work.';

CREATE FUNCTION content.clone_version_part_vendors(p_from app.ulid, p_to app.ulid)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = ''
AS $fn$
DECLARE
  v_counts jsonb := '{}';
  v_n      integer;
BEGIN
  -- Vendors before their params and limits: both reference the vendor through a composite FK and
  -- these are separate statements, so PostgreSQL's AFTER-ROW referential triggers do not paper over
  -- a wrong order the way they do for nodes' self-FK.
  INSERT INTO content.vendors (
    survey_version_id, id, org_id, ref, name, entry_url_template, max_completes,
    quota_plan_overrides, hash_param, algorithm, secret_ref, signed_params, max_skew_s,
    timestamp_param, nonce_param, sort_key, created_at, updated_at)
  SELECT p_to, v.id, v.org_id, v.ref, v.name, v.entry_url_template, v.max_completes,
         v.quota_plan_overrides, v.hash_param, v.algorithm, v.secret_ref, v.signed_params,
         v.max_skew_s, v.timestamp_param, v.nonce_param, v.sort_key, v.created_at, v.updated_at
    FROM content.vendors v WHERE v.survey_version_id = p_from;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || pg_catalog.jsonb_build_object('vendors', v_n);

  INSERT INTO content.vendor_inbound_params (
    survey_version_id, vendor_id, param, variable_id, required, sort_key, org_id, created_at,
    updated_at)
  SELECT p_to, p.vendor_id, p.param, p.variable_id, p.required, p.sort_key, p.org_id, p.created_at,
         p.updated_at
    FROM content.vendor_inbound_params p WHERE p.survey_version_id = p_from;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || pg_catalog.jsonb_build_object('vendor_inbound_params', v_n);

  INSERT INTO content.vendor_limits (
    survey_version_id, vendor_id, plan_id, max_completes, org_id, created_at, updated_at)
  SELECT p_to, l.vendor_id, l.plan_id, l.max_completes, l.org_id, l.created_at, l.updated_at
    FROM content.vendor_limits l WHERE l.survey_version_id = p_from;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || pg_catalog.jsonb_build_object('vendor_limits', v_n);

  RETURN v_counts;
END $fn$;

CREATE OR REPLACE FUNCTION content.clone_version(p_from app.ulid, p_to app.ulid)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = ''
AS $fn$
DECLARE
  v_counts jsonb;
  v_part   record;
  v_one    jsonb;
BEGIN
  v_counts := content.clone_version_core(p_from, p_to);

  -- Every part, in name order. THE LAST EDIT THIS FUNCTION SHOULD EVER NEED: a new content table
  -- adds a `clone_version_part_*` function and nothing here changes, so this function cannot lose a
  -- branch to a careless CREATE OR REPLACE — which is how six tables went unnoticed through 0016,
  -- 0019 and 0021.
  FOR v_part IN
    -- The qualified NAME, not `oid::regprocedure`. A regprocedure renders as
    -- `content.clone_version_part_p2(app.ulid,app.ulid)`, so interpolating it produced
    -- `SELECT f(app.ulid,app.ulid)($1, $2)` — a syntax error raised from inside the dynamic
    -- EXECUTE, which surfaces at whatever statement called clone_version and is therefore
    -- reported against a file that has nothing wrong with it. `%I` on the parts separately is
    -- both correct and unambiguous: pronargs = 2 already pins the signature.
    SELECT n.nspname AS schema_name, p.proname AS fn_name
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'content'
       AND p.proname LIKE 'clone\_version\_part\_%'
       AND p.pronargs = 2
     ORDER BY p.proname
  LOOP
    EXECUTE pg_catalog.format('SELECT %I.%I($1, $2)', v_part.schema_name, v_part.fn_name)
      INTO v_one USING p_from, p_to;
    v_counts := v_counts || v_one;
  END LOOP;

  RETURN v_counts;
END $fn$;

COMMENT ON FUNCTION content.clone_version(app.ulid, app.ulid) IS
  'ADR-002''s copy-on-write. Calls content.clone_version_core (0008''s eight tables) and then every '
  'content.clone_version_part_% function in name order, merging their per-table count maps. '
  'COMPOSED OVER THE CATALOG since 0024: a new content table adds a part function and this body is '
  'never touched, so it cannot lose a branch to a CREATE OR REPLACE that forgets one — which is '
  'what happened across 0016, 0019 and 0021 and left every clone without quotas, code assets or a '
  'theme. ops.content_tables_not_cloned() matches the whole family, so it checks the parts too.';

REVOKE ALL ON FUNCTION content.clone_version_part_p2(app.ulid, app.ulid) FROM PUBLIC;
REVOKE ALL ON FUNCTION content.clone_version_part_vendors(app.ulid, app.ulid) FROM PUBLIC;
-- clone_version is SECURITY INVOKER, so every part it dispatches to must be callable by the same
-- role. Not a separate capability: a caller who can clone can already clone.
GRANT EXECUTE ON FUNCTION content.clone_version_part_p2(app.ulid, app.ulid) TO authoring;
GRANT EXECUTE ON FUNCTION content.clone_version_part_vendors(app.ulid, app.ulid) TO authoring;
