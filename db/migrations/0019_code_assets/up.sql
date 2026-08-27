-- 0019_code_assets — author-supplied code, its integrity hash and its sanitizer verdict (P2-11).
--
-- Roadmap P2-11's DB line: "content.code_assets with runs_on, sha256, sanitizer_report". This is
-- the authoring-side home for what `packages/compiler/src/analyses/assets.ts` already analyses and
-- what `apps/runtime/src/script/host.ts` already executes: until now a script existed only inside
-- the survey document, which meant the sanitizer's verdict existed only in a compile log.
--
-- WHY THE VERDICT IS STORED AND NOT RECOMPUTED. `assets.ts` is a detector, not a rewriter: it
-- reports what an allowlist would strip and refuses to publish rather than silently changing an
-- author's markup. That choice is right, and it makes the verdict a fact worth keeping. Three
-- readers need it and none can recompute it:
--
--   * an incident review, months later, asking what this exact script was allowed to do when it was
--     published — the compiler has since changed, so re-running it answers a different question;
--   * a support conversation about why a version will not publish, where the author has already
--     edited the source and the failing text is gone;
--   * the CSP the runtime serves, which is derived from the hashes and must match the bytes that
--     actually shipped.
--
-- So `sanitizer_report` is the verdict AS OF the analysis that produced it, stamped with the
-- compiler version that produced it. A report whose `analyzer_version` is older than the current
-- compiler is not wrong — it is the historical record — and the publish path re-analyses rather
-- than trusting it. This table is the archive, never the authority for a publish decision. That
-- distinction is the whole reason `sanitizer_report` has no CHECK asserting the verdict is `pass`:
-- a failing report is exactly the row an author needs to see.
--
-- WHY sha256 IS GENERATED AND NOT SUPPLIED. `ScriptAsset.sha256` is optional in the schema and
-- nullable in the artifact, because a hand-authored document may not carry one. In the database it
-- is `GENERATED ALWAYS AS ... STORED` over `source`, which turns "the hash matches the bytes" from
-- something a writer promises into something the table cannot violate. A supplied hash is a hash
-- that can be wrong, and a wrong script hash is a CSP that blocks the script it was meant to allow
-- — or, worse, allows bytes nobody reviewed.
--
-- WHY runs_on HAS NO DEFAULT. `assets.ts`' own words: "A client script and a server script have
-- completely different security models (ADR-005) ... mixing them up is a vulnerability, not a
-- mistake." A default would pick one of those security models for an author who did not state
-- which they meant. Same reasoning 0016 applied to the quota policy columns.

SET lock_timeout = '3s';
SET statement_timeout = '120s';

/* ------------------------------------------------------------------ *
 * 1. The registries, as ENUMs mirroring packages/schema
 * ------------------------------------------------------------------ */

-- In schema `content` and not `runtime`: ADR-001's plane boundary means a column typed from a
-- runtime ENUM would drag USAGE on schema runtime into the authoring role, which is the grant the
-- boundary exists to withhold. 0010's redirects_disposition_registry comment states the same
-- trade-off and reaches the opposite conclusion for the same reason (that registry lives in
-- runtime already, so it had to be a CHECK).
CREATE TYPE content.script_target AS ENUM ('client', 'server');
COMMENT ON TYPE content.script_target IS
  'SCRIPT_TARGETS from packages/schema/src/types/assets.ts. An ENUM rather than a CHECK because '
  'this registry will not widen: "client" and "server" are the two sides of ADR-001''s plane '
  'boundary, not an open list, and a third value would be a new security model rather than a new '
  'option.';

CREATE TYPE content.script_scope AS ENUM ('survey', 'page', 'question');
COMMENT ON TYPE content.script_scope IS
  'SCRIPT_SCOPES from packages/schema. Which authoring object the script attaches to; the hooks '
  'column says WHEN it runs, and CMP-0501 is the check that the two are coherent.';

CREATE TYPE content.code_asset_kind AS ENUM ('script', 'html_template', 'css');
COMMENT ON TYPE content.code_asset_kind IS
  'One table for the three author-supplied code kinds, discriminated. They share every column '
  'that matters — version, ref, source, hash, sanitizer verdict — and differ only in which of '
  'runs_on/scope/hooks apply, which the CHECKs below pin per kind. Three near-identical tables '
  'would triple the RLS, the draft-only trigger and the publish-path join for no gain; media is '
  'NOT here because a PNG has no source text to sanitize and no hash-based CSP directive.';

/* ------------------------------------------------------------------ *
 * 2. The hash function, and why it is allowed to claim IMMUTABLE
 * ------------------------------------------------------------------ */

-- `encode` and `sha256` are both immutable; `convert_to` is STABLE, because in general its result
-- depends on resolving an encoding NAME, and Postgres therefore refuses the composition in a
-- generated column ("generation expression is not immutable", 42P17).
--
-- Wrapping a stable function in one declared immutable is normally a lie, and lying to the planner
-- about volatility corrupts indexes. It is not a lie here, and the reason is narrow enough to state
-- exactly: the encoding argument is the literal 'UTF8', and a database's encoding is fixed when the
-- database is created and cannot be altered afterwards. So for any one database this expression has
-- exactly one value per input, forever — which is what IMMUTABLE means.
--
-- That argument has a precondition, so test.sql asserts it: the database encoding IS UTF8. An
-- assumption a stored hash depends on is checked rather than trusted — the same reasoning ADR-004
-- applies to client/server verdict agreement.
-- A CHECK cannot contain a subquery (0A000), and there is no subquery-free way to deduplicate an
-- array with built-ins. So the predicate is a function — with the footgun stated rather than
-- ignored: a CHECK that calls a function is not revalidated if the function is later redefined, so
-- changing this body silently changes what the table already accepted. That is tolerable here
-- because the predicate is total and has no plausible future revision ("are these elements
-- distinct" is not a policy), and it would not be tolerable for anything with a business rule in
-- it. `@>`/`<@` handled the registry check without a function for exactly that reason.
CREATE FUNCTION content.array_is_distinct(p_items text[]) RETURNS boolean
  LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
  SET search_path = ''
  AS $$ SELECT pg_catalog.cardinality(p_items)
             = (SELECT pg_catalog.count(DISTINCT x)::int FROM pg_catalog.unnest(p_items) AS t(x)) $$;

COMMENT ON FUNCTION content.array_is_distinct(text[]) IS
  'True when every element of the array is distinct. Exists because a CHECK constraint cannot '
  'contain a subquery and no built-in deduplicates an array without one. STRICT, so NULL in gives '
  'NULL out and the CHECK passes — which is correct: the hooks column is NOT NULL, so the only way '
  'to reach this with NULL is a future nullable caller that should state its own intent.';

CREATE FUNCTION content.source_sha256(p_source text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
  SET search_path = ''
  AS $$ SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_source, 'UTF8')), 'hex') $$;

COMMENT ON FUNCTION content.source_sha256(text) IS
  'The hex sha256 of an asset''s source, as packages/compiler emits it into the artifact manifest. '
  'Declared IMMUTABLE over a STABLE convert_to, which is sound ONLY because the encoding argument '
  'is a literal and a database''s encoding cannot change after creation — test.sql asserts the '
  'database is UTF8, because a stored hash must not depend on an unchecked assumption. STRICT so a '
  'NULL source yields NULL rather than the hash of the empty string, which would make "no source" '
  'and "empty source" indistinguishable in a CSP.';

-- 0006's standing check: ALTER DEFAULT PRIVILEGES does not close PUBLIC EXECUTE on a function
-- created afterwards, so every new function needs its own explicit REVOKE. This is not
-- belt-and-braces — the check in 0006/test.sql caught both of these being world-executable on the
-- first run of this migration, which is the entire reason that check exists.
REVOKE ALL ON FUNCTION content.array_is_distinct(text[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION content.source_sha256(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION content.source_sha256(text) TO authoring;
-- array_is_distinct needs the grant too, and finding that out was worth recording: a CHECK
-- constraint's expression is evaluated with the PRIVILEGES OF THE WRITER, not of the table or its
-- owner. An ungranted helper therefore does not make the constraint owner-only — it makes every
-- INSERT by `authoring` fail with "permission denied for function array_is_distinct". Which is how
-- this suite failed on the first run after the REVOKE above.
GRANT EXECUTE ON FUNCTION content.array_is_distinct(text[]) TO authoring;

/* ------------------------------------------------------------------ *
 * 3. content.code_assets
 * ------------------------------------------------------------------ */

CREATE TABLE content.code_assets (
  id                 app.ulid PRIMARY KEY,
  survey_version_id  app.ulid NOT NULL,
  org_id             app.ulid NOT NULL,
  kind               content.code_asset_kind NOT NULL,
  ref                text NOT NULL,
  source             text NOT NULL,
  -- The hash the CSP is built from, over the bytes actually stored. See the header on why this is
  -- generated rather than supplied. `sha256` is `pgcrypto`'s digest, hex-encoded lowercase to
  -- match what `packages/compiler` emits into the manifest.
  sha256             text GENERATED ALWAYS AS (content.source_sha256(source)) STORED,
  -- NULL for a template or stylesheet; required for a script. No default: see the header.
  runs_on            content.script_target,
  scope              content.script_scope,
  -- SCRIPT_HOOKS, as text[] rather than an ENUM array so that adding a hook is a compiler change
  -- and not an ALTER TYPE with no reverse. The CHECK below mirrors the registry.
  hooks              text[] NOT NULL DEFAULT '{}',
  -- The sanitizer's verdict as of the analysis that produced it. Nullable: a row inserted before
  -- its first analysis has no verdict, and inventing an empty "pass" would be a lie that reads as
  -- a clean bill of health.
  sanitizer_report   jsonb,
  analyzed_at        timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id, survey_version_id)
    REFERENCES app.survey_versions (org_id, id) ON DELETE CASCADE,
  -- A ref is how the document, the artifact manifest and the CSP all name this asset, so it must
  -- be unique within the version AND within the kind's namespace. Across kinds it need not be: a
  -- script `HEADER` and a template `HEADER` are different things named by their author the same
  -- way, and forcing them apart would be a rule with no reason behind it.
  CONSTRAINT code_assets_ref_key UNIQUE (survey_version_id, kind, ref),
  CONSTRAINT code_assets_ref_nonempty CHECK (btrim(ref) <> ''),
  -- Biconditionals in 0010's redirects_scope_key_shape style: they say which value goes with which
  -- discriminator, so both mistakes are unstorable rather than only the missing half. A template
  -- with runs_on = 'server' is a security model applied to something that never executes; a script
  -- with runs_on NULL is the vulnerability the header quotes.
  CONSTRAINT code_assets_runs_on_shape CHECK ((kind = 'script') = (runs_on IS NOT NULL)),
  CONSTRAINT code_assets_scope_shape   CHECK ((kind = 'script') = (scope IS NOT NULL)),
  -- Only a script has hooks, and a script with none never runs — which is a configuration mistake
  -- CMP-0501 reports at publish, not a corrupt row, so it stays storable.
  CONSTRAINT code_assets_hooks_shape CHECK (kind = 'script' OR cardinality(hooks) = 0),
  -- Mirrors SCRIPT_HOOKS. `<@` over an array literal rather than a per-element ENUM cast: the
  -- failure message names the offending array, and widening is one DROP/ADD CONSTRAINT.
  CONSTRAINT code_assets_hooks_registry CHECK (hooks <@ ARRAY[
    'onSurveyStart', 'onPageLoad', 'onAnswer', 'onValidate', 'onPageSubmit', 'onSurveyEnd']::text[]),
  -- No duplicate hook. `onAnswer` twice is not twice as often, it is an author error that would
  -- make the hook runner's behaviour depend on iteration order.
  CONSTRAINT code_assets_hooks_distinct CHECK (content.array_is_distinct(hooks)),
  -- A verdict without a time is unreadable — "as of when" is the whole value of an archived
  -- report — and a time without a verdict claims an analysis that produced nothing.
  CONSTRAINT code_assets_analyzed_shape CHECK ((sanitizer_report IS NULL) = (analyzed_at IS NULL)),
  -- A report must be an object, not an array or a bare scalar: every reader indexes it by key.
  CONSTRAINT code_assets_report_object CHECK (
    sanitizer_report IS NULL OR jsonb_typeof(sanitizer_report) = 'object'),
  -- The one field the archive is useless without. See the header: a report that does not say which
  -- compiler produced it cannot be distinguished from a current one, which is exactly the mistake
  -- that turns an archive into a false authority.
  CONSTRAINT code_assets_report_versioned CHECK (
    sanitizer_report IS NULL OR sanitizer_report ? 'analyzer_version')
);

COMMENT ON TABLE content.code_assets IS
  'C §14''s author-supplied code assets — scripts, HTML templates and stylesheets — one row per '
  'asset per version, with the integrity hash the CSP is built from and the sanitizer verdict as '
  'of the analysis that produced it. VERSION-SCOPED and never survey-scoped (B §0 ground rule 3, '
  'ADR-002): a script is part of what a version publishes, so it freezes with the version and a '
  'draft cannot change the code running in a wave already in field. Created in P2-11 because that '
  'is where the sanitizer verdict acquires a reader: the QuickJS host (ADR-005) and the '
  'compile-time analyses both already existed, and what was missing was the durable record '
  'between them.';
COMMENT ON COLUMN content.code_assets.sha256 IS
  'GENERATED ALWAYS over `source`, hex-encoded lowercase to match what packages/compiler emits '
  'into the artifact manifest. Generated and not supplied because a hash a writer promises is a '
  'hash that can be wrong, and a wrong script hash is either a CSP that blocks the script it was '
  'meant to allow or — worse — one that allows bytes nobody reviewed. ScriptAsset.sha256 is '
  'optional in the schema for hand-authored documents; here it cannot be absent and cannot '
  'disagree with the source.';
COMMENT ON COLUMN content.code_assets.runs_on IS
  'ADR-005''s client/server split, required for a script and NULL for everything else. NO '
  'DEFAULT, deliberately: assets.ts states that "a client script and a server script have '
  'completely different security models ... mixing them up is a vulnerability, not a mistake", '
  'and a default would pick one of those models on behalf of an author who did not say which they '
  'meant. Same reasoning 0016 applied to the quota policy columns.';
COMMENT ON COLUMN content.code_assets.sanitizer_report IS
  'The verdict CMP-0500/0501/0502 reached, as of `analyzed_at`, stamped with the compiler that '
  'reached it. AN ARCHIVE, NEVER THE AUTHORITY FOR A PUBLISH DECISION: the publish path '
  're-analyses, because a report produced by an older compiler answers a different question than '
  'the one being asked now. Nullable, and with no CHECK requiring a passing verdict — a failing '
  'report is exactly the row an author needs to read.';
COMMENT ON CONSTRAINT code_assets_runs_on_shape ON content.code_assets IS
  'Stated as a biconditional so both mistakes are unstorable: a script with no target is the '
  'vulnerability ADR-005 names, and a stylesheet with runs_on = ''server'' is a security model '
  'applied to something that never executes — a row a later reader would reasonably act on.';
COMMENT ON CONSTRAINT code_assets_report_versioned ON content.code_assets IS
  'A report that does not name the compiler that produced it cannot be told apart from a current '
  'one, which is the single mistake that turns this archive into a false authority. Enforced here '
  'rather than in application code because every writer — the publish path, a backfill, a support '
  'script — has to obey it for the archive to mean anything.';

CREATE INDEX code_assets_version_kind_idx
  ON content.code_assets (survey_version_id, kind);
COMMENT ON INDEX content.code_assets_version_kind_idx IS
  'The publish path''s access pattern: every script for a version, then every template. The PK is '
  'on id and the UNIQUE is (version, kind, ref), which serves a point lookup but not the ordered '
  'scan the compiler does once per compile.';

-- The sanitizer-backlog query: assets whose verdict is missing or predates the current analyzer.
-- Partial, because in steady state almost every row has been analysed and a full index on a
-- column that is NULL for a vanishing minority is mostly dead weight — 0016's
-- quota_counters_drift_idx is the same shape for the same reason.
CREATE INDEX code_assets_unanalyzed_idx
  ON content.code_assets (survey_version_id)
  WHERE sanitizer_report IS NULL;

CREATE TRIGGER code_assets_touch BEFORE UPDATE ON content.code_assets
  FOR EACH ROW EXECUTE FUNCTION app.tg_touch_updated_at();

-- ADR-002's second layer (B §12.1). The write POLICIES below make an edit to a frozen version
-- return "0 rows updated"; this trigger makes anything reaching the table by another route — the
-- owner, a migration, a 2 a.m. service-role script — raise.
-- ops.content_tables_without_draft_trigger() fails CI for a content table that lacks it.
CREATE TRIGGER code_assets_draft_only
  BEFORE INSERT OR UPDATE OR DELETE ON content.code_assets
  FOR EACH ROW EXECUTE FUNCTION content.tg_draft_only();

/* ------------------------------------------------------------------ *
 * 4. RLS — the same shape every content table has
 * ------------------------------------------------------------------ */

ALTER TABLE content.code_assets ENABLE ROW LEVEL SECURITY;
-- FORCE, so the table owner is not exempt. ops.tables_without_rls() checks for this specifically:
-- an owner-exempt policy is a policy that does not apply to the connection a migration runs on.
ALTER TABLE content.code_assets FORCE ROW LEVEL SECURITY;

-- Split per command, following 0007's nodes_* policies exactly. The WITH CHECK repeats every
-- predicate in USING so an UPDATE cannot move a row into another org or onto another version —
-- USING says which rows you may touch, WITH CHECK says what they may become, and omitting the
-- second is how a row escapes its tenant.
CREATE POLICY code_assets_select ON content.code_assets FOR SELECT TO authoring
USING (org_id = app.current_org() AND app.has_role('reviewer')
       AND app.can_see_version(survey_version_id));
COMMENT ON POLICY code_assets_select ON content.code_assets IS
  'Read floor `reviewer`, matching content.nodes: reading a survey definition includes reading the '
  'code attached to it, and a reviewer whose job is "read survey definitions, comment, approve" '
  '(K §1) cannot approve a survey whose scripts are invisible to them. Deliberately NOT restricted '
  'to drafts — reading a frozen version IS the review link.';

CREATE POLICY code_assets_insert ON content.code_assets FOR INSERT TO authoring
WITH CHECK (org_id = app.current_org() AND app.has_role('programmer')
            AND app.can_see_version(survey_version_id)
            AND app.version_is_draft(survey_version_id));
CREATE POLICY code_assets_update ON content.code_assets FOR UPDATE TO authoring
USING (org_id = app.current_org() AND app.has_role('programmer')
       AND app.can_see_version(survey_version_id)
       AND app.version_is_draft(survey_version_id))
WITH CHECK (org_id = app.current_org() AND app.has_role('programmer')
            AND app.can_see_version(survey_version_id)
            AND app.version_is_draft(survey_version_id));
CREATE POLICY code_assets_delete ON content.code_assets FOR DELETE TO authoring
USING (org_id = app.current_org() AND app.has_role('programmer')
       AND app.can_see_version(survey_version_id)
       AND app.version_is_draft(survey_version_id));
COMMENT ON POLICY code_assets_update ON content.code_assets IS
  'Write floor `programmer`, and deliberately NOT lower despite this being "just an asset": custom '
  'JavaScript is the highest-privilege thing an author can add to a survey — it is why ADR-005 '
  'built a QuickJS sandbox and P2-11 an egress proxy — so the write bar is the survey-logic bar '
  'and not the copy-editing one. version_is_draft is ADR-002''s first layer; code_assets_draft_only '
  'is the second, for writers RLS does not govern.';

GRANT SELECT, INSERT, UPDATE, DELETE ON content.code_assets TO authoring;
-- NOT to runtime_writer, and NOT to any runtime role. ADR-001: the runtime reads code from the
-- pinned artifact in object storage, never from the authoring tables, which is what makes a
-- mid-field edit unable to change what a respondent executes.
