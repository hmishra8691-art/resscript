-- 0021_themes — the theme entity, token inheritance, and the per-version pin (roadmap P2-12).
--
-- Roadmap P2-12's DB line: "app.themes, content.version_theme". `app.surveys.theme_id` has existed
-- since 0004 with NO FOREIGN KEY, because its target table did not exist — a dangling pin that the
-- publish path carried into `Survey.theme_ref` and that nothing ever read. This closes that chain
-- and adds the one it was missing.
--
-- ## Why a survey-level pin was not enough, and version_theme exists
--
-- `app.surveys.theme_id` says which theme a survey uses NOW. That is the right thing for an editor
-- and the wrong thing for an artifact. ADR-002 freezes what a version publishes; a theme is a shared,
-- mutable, org-level object. So "the survey's theme" and "the CSS a wave in field is rendering" are
-- two different facts, and if only the first is stored then editing a theme silently restyles every
-- survey already collecting data — including ones whose screenshots are in a client's approval
-- email.
--
-- `content.version_theme` is therefore not a second pointer to the same thing. It records the
-- RESOLVED TOKENS as of publish, plus the sha256 of the CSS compiled from them. The theme row can
-- then change freely and a published version keeps rendering what it was approved with; a client
-- who wants the new look republishes, which is the same act every other content change requires.
--
-- The alternative — storing `theme_id` and re-resolving at publish — fails on the same test 0019's
-- sanitizer_report fails: the compiler that resolved it has since changed, so re-resolving answers a
-- different question than the one that was approved.
--
-- ## Tokens are jsonb here and a closed vocabulary in the compiler
--
-- `packages/compiler/src/emit/theme.ts` owns the vocabulary and the per-kind value patterns, and it
-- has to: a token value is interpolated into a stylesheet, so validating it is a CSS question, not a
-- SQL one. The database's job is the part it can actually guarantee — the column is an OBJECT of
-- STRINGS, bounded, with no nesting — which is what stops a caller storing a structure the compiler
-- would have to defend against rather than merely reject.
--
-- Deliberately NOT a CHECK enumerating the token names: the vocabulary grows in TypeScript, and a
-- mirrored list in SQL would be a second source of truth that drifts on the first addition. 0019's
-- code_assets_hooks_registry mirrors SCRIPT_HOOKS and is worth it because hooks are a security
-- boundary; a typo'd token name is a diagnostic, not a vulnerability.

SET lock_timeout = '3s';
SET statement_timeout = '120s';

/* ------------------------------------------------------------------ *
 * 1. The token shape predicate
 * ------------------------------------------------------------------ */

CREATE FUNCTION content.is_token_map(p_tokens jsonb) RETURNS boolean
  LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
  SET search_path = ''
  AS $fn$
  SELECT pg_catalog.jsonb_typeof(p_tokens) = 'object'
     AND NOT pg_catalog.jsonb_path_exists(p_tokens, '$.* ? (@.type() != "string")')
     AND (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(p_tokens)) <= 200
  $fn$;
COMMENT ON FUNCTION content.is_token_map(jsonb) IS
  'A flat object of string values, at most 200 keys. The database guarantees the SHAPE and leaves '
  'the vocabulary and the value patterns to packages/compiler/src/emit/theme.ts, which has to own '
  'them: a token value is interpolated into a stylesheet, so validating it is a CSS question. A '
  'function rather than an inline CHECK because a CHECK cannot contain a subquery (0A000) — 0019 '
  'hit the same wall — and the same caveat applies: a CHECK that calls a function is not '
  'revalidated if the function is redefined, which is tolerable for a total shape predicate and '
  'would not be for anything carrying a policy.';

REVOKE ALL ON FUNCTION content.is_token_map(jsonb) FROM PUBLIC;
-- Granted because a CHECK constraint evaluates with the WRITER's privileges, not the table's — the
-- fact 0019 had to learn from an insert failing with "permission denied for function".
GRANT EXECUTE ON FUNCTION content.is_token_map(jsonb) TO authoring;

/* ------------------------------------------------------------------ *
 * 2. app.themes
 * ------------------------------------------------------------------ */

CREATE TABLE app.themes (
  id              app.ulid PRIMARY KEY,
  org_id          app.ulid NOT NULL REFERENCES app.organizations (id) ON DELETE CASCADE,
  name            text NOT NULL,
  -- Single-parent inheritance. A theme resolves as parent-tokens overlaid by its own, which is
  -- `resolveTokens(parent, child)` in the compiler — one function, so the database and the CSS
  -- cannot disagree about what inheritance means.
  parent_theme_id app.ulid REFERENCES app.themes (id) ON DELETE RESTRICT,
  tokens          jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_default      boolean NOT NULL DEFAULT false,
  created_by      uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT themes_name_nonempty CHECK (btrim(name) <> ''),
  CONSTRAINT themes_name_key UNIQUE (org_id, name),
  CONSTRAINT themes_tokens_shape CHECK (content.is_token_map(tokens)),
  -- A theme cannot be its own parent. Deeper cycles are caught by the trigger below; this is the
  -- one case a CHECK can see, and catching it here means the common typo fails with a clear
  -- constraint name rather than inside a walk.
  CONSTRAINT themes_no_self_parent CHECK (parent_theme_id IS DISTINCT FROM id)
);

COMMENT ON TABLE app.themes IS
  'Org-level visual themes: a name, a token map, and an optional parent to inherit from. ORG-SCOPED '
  'and mutable, deliberately — a theme is a brand, and a brand is edited. What makes that safe for '
  'surveys already in field is content.version_theme, which snapshots the RESOLVED tokens at '
  'publish so editing a theme cannot restyle a wave whose screenshots are in a client''s approval '
  'email. Created in P2-12; app.surveys.theme_id has pointed at this table since 0004 without it '
  'existing, which is why that column had no foreign key.';
COMMENT ON COLUMN app.themes.tokens IS
  'A flat map of token name to value, over the vocabulary in packages/compiler/src/emit/theme.ts. '
  'Only the SHAPE is enforced here (see content.is_token_map): a token value is interpolated into a '
  'stylesheet, so whether "red;}*{display:none}" is a valid colour is a CSS question the compiler '
  'answers, and it answers it twice — validateTokens reports it to the author, resolveTokens drops '
  'it so a caller that skipped validation cannot ship it.';
COMMENT ON COLUMN app.themes.parent_theme_id IS
  'Single-parent inheritance, resolved as parent-then-child by the compiler''s resolveTokens — the '
  'same function the emitter uses, so "what does this theme look like" has one answer. ON DELETE '
  'RESTRICT and not CASCADE: deleting a base brand theme must not silently delete every theme '
  'derived from it.';

CREATE INDEX themes_org_idx ON app.themes (org_id);
-- At most one default per org, as a partial unique index rather than a trigger: two defaults is a
-- state where "which theme does a new survey get" has no answer, and a uniqueness rule the database
-- enforces cannot be raced.
CREATE UNIQUE INDEX themes_one_default_idx ON app.themes (org_id) WHERE is_default;

CREATE TRIGGER themes_touch BEFORE UPDATE ON app.themes
  FOR EACH ROW EXECUTE FUNCTION app.tg_touch_updated_at();

-- Inheritance cycles. A CHECK sees only self-parenthood; A→B→A needs a walk, and a walk needs a
-- trigger. Without it, resolveTokens would recurse forever on a chain a single UPDATE can create.
CREATE FUNCTION app.tg_themes_no_cycle() RETURNS trigger
LANGUAGE plpgsql
SET search_path = '' AS $fn$
DECLARE
  v_id app.ulid := NEW.parent_theme_id;
  v_depth integer := 0;
BEGIN
  WHILE v_id IS NOT NULL LOOP
    IF v_id = NEW.id THEN
      RAISE EXCEPTION 'theme % would create an inheritance cycle', NEW.id USING ERRCODE = '23514';
    END IF;
    v_depth := v_depth + 1;
    -- A depth cap as well as a cycle check: a 500-deep chain is not a cycle and is still a
    -- resolution nobody can reason about, and the cap is what stops this walk being unbounded on
    -- data a cycle check alone would accept.
    IF v_depth > 16 THEN
      RAISE EXCEPTION 'theme inheritance deeper than 16 is refused' USING ERRCODE = '23514';
    END IF;
    SELECT parent_theme_id INTO v_id FROM app.themes WHERE id = v_id;
  END LOOP;
  RETURN NEW;
END $fn$;
REVOKE ALL ON FUNCTION app.tg_themes_no_cycle() FROM PUBLIC;

CREATE TRIGGER themes_no_cycle BEFORE INSERT OR UPDATE OF parent_theme_id ON app.themes
  FOR EACH ROW EXECUTE FUNCTION app.tg_themes_no_cycle();

ALTER TABLE app.themes ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.themes FORCE ROW LEVEL SECURITY;

-- Read at the `reviewer` floor, matching content.nodes: approving a survey means seeing how it
-- looks. Write at `admin`: a theme is org branding shared across every project, so changing one is
-- an organisation decision rather than a per-survey one — the same reasoning 0020 applies to a
-- webhook subscription, for the same reason (blast radius beyond the survey being edited).
CREATE POLICY themes_select ON app.themes FOR SELECT TO authoring
USING (org_id = app.current_org() AND app.has_role('reviewer'));
CREATE POLICY themes_insert ON app.themes FOR INSERT TO authoring
WITH CHECK (org_id = app.current_org() AND app.has_role('admin'));
CREATE POLICY themes_update ON app.themes FOR UPDATE TO authoring
USING (org_id = app.current_org() AND app.has_role('admin'))
WITH CHECK (org_id = app.current_org() AND app.has_role('admin'));
CREATE POLICY themes_delete ON app.themes FOR DELETE TO authoring
USING (org_id = app.current_org() AND app.has_role('admin'));
COMMENT ON POLICY themes_update ON app.themes IS
  'admin to write, reviewer to read. The asymmetry is the point: a reviewer cannot approve a survey '
  'whose appearance is invisible to them, and a programmer editing one survey must not be able to '
  'restyle every other survey in the org by editing a shared theme.';

/* ------------------------------------------------------------------ *
 * 3. content.version_theme — the snapshot
 * ------------------------------------------------------------------ */

CREATE TABLE content.version_theme (
  survey_version_id app.ulid PRIMARY KEY,
  org_id            app.ulid NOT NULL,
  -- Which theme this came from, for provenance only. NO foreign key, deliberately: the snapshot
  -- must survive the theme being deleted, because the artifact it describes is still in field.
  theme_id          app.ulid,
  theme_name        text NOT NULL DEFAULT '',
  -- The RESOLVED tokens — parent overlaid by child, already merged — as of publish. Not the
  -- theme's own tokens: re-resolving later would consult a parent that has since changed.
  tokens_snapshot   jsonb NOT NULL,
  -- The sha256 of the CSS compiled from exactly those tokens. What makes the snapshot checkable:
  -- recompiling and comparing answers "is this artifact still what we think it is".
  compiled_css_sha256 text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id, survey_version_id)
    REFERENCES app.survey_versions (org_id, id) ON DELETE CASCADE,
  CONSTRAINT version_theme_tokens_shape CHECK (content.is_token_map(tokens_snapshot)),
  CONSTRAINT version_theme_sha_shape CHECK (compiled_css_sha256 ~ '^[0-9a-f]{64}$')
);

COMMENT ON TABLE content.version_theme IS
  'The theme a version PUBLISHED WITH, snapshotted: the resolved tokens and the sha256 of the CSS '
  'compiled from them. VERSION-SCOPED (B 0 ground rule 3, ADR-002) so editing a shared theme cannot '
  'restyle a wave already collecting data — a client approves an appearance, and an appearance that '
  'changes underneath them is a support ticket that starts "this is not what I signed off". A '
  'client who wants the new look republishes, which is what every other content change already '
  'requires.';
COMMENT ON COLUMN content.version_theme.theme_id IS
  'Provenance only, with NO foreign key on purpose: the snapshot has to outlive the theme row. A '
  'theme deleted a year after a wave shipped must not take with it the record of what that wave '
  'looked like.';
COMMENT ON COLUMN content.version_theme.tokens_snapshot IS
  'The RESOLVED tokens — parent overlaid by child, already merged — and not the theme''s own map. '
  'Storing the unmerged map would mean re-resolving against a parent that has since changed, which '
  'is the same mistake 0019''s sanitizer_report avoids by archiving a verdict rather than promising '
  'to recompute one.';

CREATE TRIGGER version_theme_touch BEFORE UPDATE ON content.version_theme
  FOR EACH ROW EXECUTE FUNCTION app.tg_touch_updated_at();

CREATE TRIGGER version_theme_draft_only
  BEFORE INSERT OR UPDATE OR DELETE ON content.version_theme
  FOR EACH ROW EXECUTE FUNCTION content.tg_draft_only();

ALTER TABLE content.version_theme ENABLE ROW LEVEL SECURITY;
ALTER TABLE content.version_theme FORCE ROW LEVEL SECURITY;

CREATE POLICY version_theme_select ON content.version_theme FOR SELECT TO authoring
USING (org_id = app.current_org() AND app.has_role('reviewer')
       AND app.can_see_version(survey_version_id));
CREATE POLICY version_theme_insert ON content.version_theme FOR INSERT TO authoring
WITH CHECK (org_id = app.current_org() AND app.has_role('programmer')
            AND app.can_see_version(survey_version_id)
            AND app.version_is_draft(survey_version_id));
CREATE POLICY version_theme_update ON content.version_theme FOR UPDATE TO authoring
USING (org_id = app.current_org() AND app.has_role('programmer')
       AND app.can_see_version(survey_version_id)
       AND app.version_is_draft(survey_version_id))
WITH CHECK (org_id = app.current_org() AND app.has_role('programmer')
            AND app.can_see_version(survey_version_id)
            AND app.version_is_draft(survey_version_id));
CREATE POLICY version_theme_delete ON content.version_theme FOR DELETE TO authoring
USING (org_id = app.current_org() AND app.has_role('programmer')
       AND app.can_see_version(survey_version_id)
       AND app.version_is_draft(survey_version_id));
COMMENT ON POLICY version_theme_insert ON content.version_theme IS
  'programmer, matching every other content table — pinning a version''s appearance is part of '
  'preparing that version, not org configuration, which is why the bar here is LOWER than the '
  'admin bar on app.themes. The two answer different questions: who may change the brand, and who '
  'may choose which brand this survey uses.';

-- 0001's ALTER DEFAULT PRIVILEGES already granted authoring full DML on both new tables (schemas
-- app and content), so RLS is what narrows it. Stated rather than assumed, because 0020 found the
-- reverse case — a table needing a REVOKE — the hard way.

/* ------------------------------------------------------------------ *
 * 4. The pin that has dangled since 0004
 * ------------------------------------------------------------------ */

-- `app.surveys.theme_id` has had no foreign key since 0004 because app.themes did not exist. NOT
-- VALID so the ALTER takes no full-table scan under an ACCESS EXCLUSIVE lock (B §16.3), then
-- VALIDATE, which takes only a SHARE UPDATE EXCLUSIVE. Any pre-existing value is necessarily NULL —
-- there was no table to point at — so the validation cannot fail, and doing it in two steps anyway
-- is the habit that matters on a table that will not always be small.
ALTER TABLE app.surveys
  ADD CONSTRAINT surveys_theme_fk FOREIGN KEY (theme_id)
  REFERENCES app.themes (id) ON DELETE SET NULL NOT VALID;
ALTER TABLE app.surveys VALIDATE CONSTRAINT surveys_theme_fk;
COMMENT ON CONSTRAINT surveys_theme_fk ON app.surveys IS
  'The reference 0004 could not declare: app.themes did not exist for seventeen migrations, so '
  'theme_id was an unenforced pointer that the publish path carried into Survey.theme_ref and '
  'nothing read. ON DELETE SET NULL, not RESTRICT: deleting a theme should not make a survey '
  'unmodifiable, and a survey with no theme renders the platform default — which, since P2-12, '
  'actually exists.';
