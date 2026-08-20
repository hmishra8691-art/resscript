-- 0004_tenancy — organizations, membership, projects, surveys, versions, audit, and the
-- RLS layer that every migration after this one inherits.
--
-- ADR-009 ("org_id on every row, RLS for the control plane") and Deliverable B §1, §3, §10,
-- §12; roadmap P1-01. Deliverable K §1 governs the role enum (0002) and K §3 governs
-- status vs compile_state being two columns rather than one.
--
-- The isolation guarantee this migration must deliver, in the words of P1-01's acceptance
-- criteria: "a user in org A, authenticated normally, sees exactly org A's projects;
-- editing their JWT's active_org_id to org B's id yields ZERO ROWS from every table rather
-- than an error." Zero rows and not an error is the load-bearing detail — an error is an
-- oracle. It tells the attacker the org exists.
SET lock_timeout = '3s';
SET statement_timeout = '180s';

DO $$
BEGIN
  -- The RLS helper functions below are SECURITY DEFINER precisely so that a policy on
  -- app.org_members can call a function that reads app.org_members without recursing
  -- (B §1.1). That only works if the function's owner is not itself subject to those
  -- policies, i.e. the migration runner has BYPASSRLS or is a superuser — which the
  -- `postgres` role does on Supabase and in CI. Warn loudly rather than fail, because a
  -- restricted runner is a deployment choice and the failure mode (has_role() always
  -- false, so nobody can see anything) is at least safe.
  IF NOT EXISTS (SELECT 1 FROM pg_roles
                  WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE WARNING 'migration runner % has neither SUPERUSER nor BYPASSRLS: the SECURITY '
                  'DEFINER RLS helpers in app will be subject to the policies they '
                  'implement and will deny everything. See db/README.md.', current_user;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 1. Organizations (B §1)
-- ---------------------------------------------------------------------------
CREATE TABLE app.organizations (
  id           app.ulid PRIMARY KEY DEFAULT app.gen_ulid('org'),
  slug         text NOT NULL,
  name         text NOT NULL,
  data_region  text NOT NULL DEFAULT 'eu-west-1',
  settings     jsonb NOT NULL DEFAULT '{}',
  sso_domain   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  suspended_at timestamptz,
  deleted_at   timestamptz,
  CONSTRAINT org_slug_fmt CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$')
);
COMMENT ON TABLE app.organizations IS
  'B §1. The tenant. ADR-009 puts org_id on every control-plane row and derives the '
  'caller''s org from JWT claims; this is the table that org_id points at.';
COMMENT ON COLUMN app.organizations.data_region IS
  'Where this tenant''s data is allowed to live. A column and not a deployment convention '
  'because enterprise buyers ask "where is our data" in a questionnaire and the answer has '
  'to be queryable per tenant, not per cluster.';
COMMENT ON COLUMN app.organizations.settings IS
  'Org-level policy. `pii_exports_enabled` is read by app.has_capability(): Deliverable K '
  '§1 requires PII-in-exports to need an org setting IN ADDITION TO a per-user grant, so '
  'that one compromised analyst account cannot exfiltrate open-ends from an org that never '
  'turned the feature on.';
COMMENT ON COLUMN app.organizations.deleted_at IS
  'Soft delete. B §0 ground rule 5: deleting never cascades across the plane boundary — it '
  'sets a timestamp and enqueues a job, and never reaches collected responses.';

CREATE UNIQUE INDEX org_slug_key ON app.organizations (slug) WHERE deleted_at IS NULL;
COMMENT ON INDEX app.org_slug_key IS
  'B §1. Partial so a deleted org''s slug is reusable, which matters because slugs appear '
  'in URLs and customers churn and come back.';

CREATE TRIGGER organizations_touch BEFORE UPDATE ON app.organizations
  FOR EACH ROW EXECUTE FUNCTION app.tg_touch_updated_at();

-- ---------------------------------------------------------------------------
-- 2. Membership (B §1, K §1)
-- ---------------------------------------------------------------------------
CREATE TABLE app.org_members (
  org_id      app.ulid NOT NULL REFERENCES app.organizations(id),
  user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role        app.org_role NOT NULL,
  project_ids app.ulid[] NOT NULL DEFAULT '{}',
  invited_by  uuid REFERENCES auth.users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, user_id),
  -- Deliverable K §1: a client is "scoped to explicitly shared projects". An empty
  -- project_ids array means org-wide for every other role, so for `client` it would mean
  -- the exact opposite of what the role is for. Rejecting it at the constraint level
  -- removes the possibility of an accidentally org-wide client.
  CONSTRAINT members_client_must_be_scoped
    CHECK (role <> 'client' OR cardinality(project_ids) > 0)
);
COMMENT ON TABLE app.org_members IS
  'ADR-009: "membership and role live in org_members; RLS predicates read from it, and role '
  'checks are implemented as SQL functions so a policy change is one place, not fifty." '
  'This is the table app.has_role() reads, which is why has_role() must be SECURITY '
  'DEFINER — a policy on this table calling a function that reads this table would '
  'otherwise recurse.';
COMMENT ON COLUMN app.org_members.project_ids IS
  'Empty = org-wide (except for `client`, see members_client_must_be_scoped). Non-empty '
  'restricts the member to those projects: agencies staff freelancers per project and must '
  'be able to hand a contractor one study without handing them the client list. Read by '
  'app.can_see_project().';
COMMENT ON COLUMN app.org_members.role IS
  'Deliverable K §1''s eight-member hierarchy, ranked by app.role_rank(). K''s ordering — '
  'analyst ABOVE reviewer — is the canonical one; B §1''s inverted ordering would let an '
  'external reviewer pass an analyst check and export open-ends.';

CREATE INDEX org_members_user_idx ON app.org_members (user_id);
COMMENT ON INDEX app.org_members_user_idx IS
  'B §1. "Which orgs does this user belong to" — the org switcher''s query, and the reverse '
  'of the primary key.';

CREATE TRIGGER org_members_touch BEFORE UPDATE ON app.org_members
  FOR EACH ROW EXECUTE FUNCTION app.tg_touch_updated_at();

CREATE FUNCTION app.tg_org_has_owner() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_org    app.ulid;
  v_owners integer;
BEGIN
  v_org := COALESCE(NEW.org_id, OLD.org_id);
  -- Nothing to protect if the org itself is gone or soft-deleted: tearing down a tenant
  -- legitimately removes its last owner, and this trigger must not be the thing that
  -- makes account closure impossible.
  IF NOT EXISTS (SELECT 1 FROM app.organizations o
                  WHERE o.id = v_org AND o.deleted_at IS NULL) THEN
    RETURN NULL;
  END IF;
  SELECT count(*) INTO v_owners
    FROM app.org_members m WHERE m.org_id = v_org AND m.role = 'owner';
  IF v_owners = 0 THEN
    RAISE EXCEPTION 'organization % must retain at least one owner', v_org
      USING ERRCODE = 'check_violation',
            HINT = 'transfer ownership before removing or demoting the last owner';
  END IF;
  RETURN NULL;
END $$;
COMMENT ON FUNCTION app.tg_org_has_owner() IS
  'B §1: "at least one owner is a deferred constraint trigger, not a CHECK: it is a '
  'cross-row invariant." DEFERRED is what makes ownership TRANSFER expressible — promote '
  'the new owner and demote the old one in one transaction, in either order, and the '
  'invariant is only tested at commit. An immediate check would force a window in which '
  'the org has two owners or none, and every caller would have to know which order to '
  'write. SECURITY DEFINER because it counts rows in a FORCE-RLS table.';

CREATE CONSTRAINT TRIGGER org_has_owner
  AFTER INSERT OR UPDATE OR DELETE ON app.org_members
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.tg_org_has_owner();

-- ---------------------------------------------------------------------------
-- 3. Invitations (B §1)
-- ---------------------------------------------------------------------------
CREATE TYPE app.invitation_status AS ENUM ('pending', 'accepted', 'revoked', 'expired');
COMMENT ON TYPE app.invitation_status IS
  'B §1. Lifecycle of an emailed invitation. Not a Deliverable K registry: it never crosses '
  'the plane boundary or the wire protocol, so it is defined with its table.';

CREATE FUNCTION app.hash_invitation_token(p_token text) RETURNS bytea
LANGUAGE sql IMMUTABLE STRICT SECURITY DEFINER SET search_path = '' AS $$
  SELECT public.digest(p_token, 'sha256')
$$;
-- SECURITY DEFINER only so that callers do not need USAGE on schema `public` (where
-- pgcrypto lives) purely to hash a token; 0001 revoked that grant from PUBLIC and handing
-- it back to `authoring` for one function would be the larger privilege.
REVOKE EXECUTE ON FUNCTION app.hash_invitation_token(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.hash_invitation_token(text) TO authoring;
COMMENT ON FUNCTION app.hash_invitation_token(text) IS
  'The one place a raw invitation token is turned into what the database stores. Having '
  'exactly one implementation is what makes "the plaintext token is never persisted" an '
  'auditable claim rather than an aspiration: grep for this function and you have found '
  'every write path.';

CREATE TABLE app.invitations (
  id          app.ulid PRIMARY KEY DEFAULT app.gen_ulid('inv'),
  org_id      app.ulid NOT NULL REFERENCES app.organizations(id),
  email       citext NOT NULL,
  role        app.org_role NOT NULL,
  project_ids app.ulid[] NOT NULL DEFAULT '{}',
  token_hash  bytea NOT NULL,
  status      app.invitation_status NOT NULL DEFAULT 'pending',
  invited_by  uuid NOT NULL REFERENCES auth.users(id),
  expires_at  timestamptz NOT NULL,
  accepted_at timestamptz,
  accepted_by uuid REFERENCES auth.users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  -- B §1: "Owner cannot be invited by email — ownership transfer is a separate audited
  -- action. One cheap CHECK removes a whole class of takeover-by-invite bugs."
  CONSTRAINT invitations_role_not_owner CHECK (role <> 'owner'),
  -- A sha256 is exactly 32 bytes. Anything else in this column is a plaintext token, a
  -- truncation, or a different algorithm, and all three are incidents.
  CONSTRAINT invitations_token_hash_is_sha256 CHECK (octet_length(token_hash) = 32),
  CONSTRAINT invitations_client_must_be_scoped
    CHECK (role <> 'client' OR cardinality(project_ids) > 0),
  CONSTRAINT invitations_accepted_consistent
    CHECK ((status = 'accepted') = (accepted_at IS NOT NULL))
);
COMMENT ON TABLE app.invitations IS
  'B §1. The token is stored as sha256 and never in plaintext: an invitation token is a '
  'bearer credential that grants membership of a tenant, so a database dump or a support '
  'engineer''s SELECT must not be sufficient to accept somebody else''s invitation. The '
  'emailed token exists only in the API response and the email body.';
COMMENT ON COLUMN app.invitations.token_hash IS
  'sha256(token) via app.hash_invitation_token. Not bcrypt/argon2: unlike a password this '
  'is 128+ bits of CSPRNG output with no offline-guessing exposure, so a slow hash buys '
  'nothing and costs a lookup on every accept. Contrast app.api_keys.key_hash (B §10), '
  'which is argon2id because API keys are long-lived.';
COMMENT ON COLUMN app.invitations.role IS
  'Never ''owner'' (invitations_role_not_owner). Ownership arrives only through '
  'app.create_organization or an explicit, audited transfer.';

CREATE UNIQUE INDEX invitations_token_key ON app.invitations (token_hash);
COMMENT ON INDEX app.invitations_token_key IS
  'B §1. Accepting an invitation is a lookup by hash, and a collision would be a '
  'cross-tenant membership grant.';

CREATE UNIQUE INDEX invitations_open_key ON app.invitations (org_id, email)
  WHERE status = 'pending';
COMMENT ON INDEX app.invitations_open_key IS
  'B §1. At most one open invitation per (org, email), so re-inviting replaces rather than '
  'accumulating — otherwise a revoked invitation''s token stays live alongside its '
  'replacement.';

-- ---------------------------------------------------------------------------
-- 4. Projects and surveys (B §3)
-- ---------------------------------------------------------------------------
CREATE TABLE app.projects (
  id          app.ulid PRIMARY KEY DEFAULT app.gen_ulid('prj'),
  org_id      app.ulid NOT NULL REFERENCES app.organizations(id),
  ref         app.ref NOT NULL,
  name        text NOT NULL,
  client_name text,
  tags        text[] NOT NULL DEFAULT '{}',
  field_start date,
  field_end   date,
  created_by  uuid NOT NULL REFERENCES auth.users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  UNIQUE (org_id, id)
);
COMMENT ON TABLE app.projects IS
  'B §3. The UNIQUE (org_id, id) is not redundant with the primary key: it is the TARGET of '
  'the composite foreign keys on every child table. Without it a buggy INSERT could attach '
  'a survey to another org''s project while carrying its own org_id, and every RLS policy '
  'would agree, because each row''s denormalized org_id would look self-consistent.';
COMMENT ON COLUMN app.projects.archived_at IS
  'Soft archive (B §0 ground rule 5). Archived projects drop out of the partial unique '
  'index on ref, so a ref can be reused after a study closes.';

CREATE UNIQUE INDEX projects_ref_key ON app.projects (org_id, lower(ref))
  WHERE archived_at IS NULL;
COMMENT ON INDEX app.projects_ref_key IS
  'B §3. lower(ref) because a programmer who types `brandtracker` after creating '
  '`BrandTracker` means the same project, and two of them is a support ticket.';

CREATE INDEX projects_recent_idx ON app.projects (org_id, updated_at DESC)
  WHERE archived_at IS NULL;
COMMENT ON INDEX app.projects_recent_idx IS 'B §3. The project list''s default ordering.';

CREATE TRIGGER projects_touch BEFORE UPDATE ON app.projects
  FOR EACH ROW EXECUTE FUNCTION app.tg_touch_updated_at();

CREATE TABLE app.surveys (
  id               app.ulid PRIMARY KEY DEFAULT app.gen_ulid('svy'),
  org_id           app.ulid NOT NULL,
  project_id       app.ulid NOT NULL,
  ref              app.ref NOT NULL,
  name             text NOT NULL,
  description      text,
  survey_kind      text NOT NULL DEFAULT 'standard'
                     CHECK (survey_kind IN ('standard', 'tracker_wave', 'template')),
  parent_survey_id app.ulid REFERENCES app.surveys(id),
  default_language text NOT NULL DEFAULT 'en',
  theme_id         app.ulid,
  created_by       uuid NOT NULL REFERENCES auth.users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  archived_at      timestamptz,
  FOREIGN KEY (org_id, project_id) REFERENCES app.projects (org_id, id),
  UNIQUE (org_id, id)
);
COMMENT ON TABLE app.surveys IS
  'B §3. The composite FK (org_id, project_id) -> projects(org_id, id) is what keeps the '
  'denormalized org_id honest. ADR-009 denormalizes org_id onto every row so that an RLS '
  'predicate is one column comparison rather than a three-table join in every plan; the '
  'composite FK is the price of that, one extra unique index per parent.';
COMMENT ON COLUMN app.surveys.parent_survey_id IS
  'Tracker waves point at the survey they were cloned from, so "show me this tracker across '
  'waves" is a query rather than a naming convention.';

CREATE UNIQUE INDEX surveys_ref_key ON app.surveys (org_id, lower(ref))
  WHERE archived_at IS NULL;
COMMENT ON INDEX app.surveys_ref_key IS
  'B §3. Org-wide, not project-wide: survey refs end up in export file names and client '
  'emails, where project scoping is invisible.';

CREATE INDEX surveys_project_idx ON app.surveys (project_id, updated_at DESC);
COMMENT ON INDEX app.surveys_project_idx IS 'B §3. The survey list within a project.';

CREATE TRIGGER surveys_touch BEFORE UPDATE ON app.surveys
  FOR EACH ROW EXECUTE FUNCTION app.tg_touch_updated_at();

-- ---------------------------------------------------------------------------
-- 5. Survey versions (B §3, K §3)
-- ---------------------------------------------------------------------------
CREATE TABLE app.survey_versions (
  id                     app.ulid PRIMARY KEY DEFAULT app.gen_ulid('ver'),
  org_id                 app.ulid NOT NULL,
  survey_id              app.ulid NOT NULL,
  version_no             integer NOT NULL CHECK (version_no >= 1),
  status                 app.version_status NOT NULL DEFAULT 'draft',
  compile_state          app.compile_state NOT NULL DEFAULT 'none',
  artifact_hash          app.sha256,
  artifact_bytes         bigint CHECK (artifact_bytes IS NULL OR artifact_bytes >= 0),
  schema_version         integer NOT NULL,
  revision               bigint NOT NULL DEFAULT 1,
  compile_diagnostics    jsonb NOT NULL DEFAULT '[]',
  acknowledged_warnings  jsonb NOT NULL DEFAULT '[]',
  entitlement_reqs       text[] NOT NULL DEFAULT '{}',
  notes                  text,
  created_by             uuid NOT NULL REFERENCES auth.users(id),
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  frozen_at              timestamptz,
  published_at           timestamptz,
  archived_at            timestamptz,
  cloned_from_version_id app.ulid REFERENCES app.survey_versions(id),
  FOREIGN KEY (org_id, survey_id) REFERENCES app.surveys (org_id, id),
  UNIQUE (survey_id, version_no),
  UNIQUE (org_id, id),
  -- ADR-002: an artifact is content-addressed, so claiming a successful compile without a
  -- hash claims something unverifiable.
  CONSTRAINT sv_compiled_needs_artifact
    CHECK (compile_state <> 'compiled' OR artifact_hash IS NOT NULL),
  -- Deliverable K §3: "a version may only enter staging or production with
  -- compile_state = 'compiled'." Enforced here rather than only in the publish code path,
  -- because a live status with no usable artifact serves respondents an error page.
  CONSTRAINT sv_live_needs_compiled
    CHECK (status NOT IN ('staging', 'production') OR compile_state = 'compiled'),
  CONSTRAINT sv_frozen_ts CHECK ((status = 'draft') = (frozen_at IS NULL))
);
COMMENT ON TABLE app.survey_versions IS
  'ADR-002 / B §3: the version is the unit of immutability. Authoring content rows are '
  'scoped to a survey_version_id, never a survey_id; publishing freezes a version and '
  'editing clones a new draft. Deliverable K §3 is why `status` and `compile_state` are two '
  'columns: Deliverable A §3.2 wrote status=compiling and status=live, conflating "where '
  'this sits in review" with "is its artifact built". Keeping them separate is what makes '
  'A §7''s guarantee true — a failed compile never changes status, so the previously live '
  'artifact keeps serving.';
COMMENT ON COLUMN app.survey_versions.status IS
  'K §3: the HUMAN WORKFLOW axis. draft -> review -> staging -> production -> archived. Not '
  'an infrastructure environment; the UI calls ''staging'' the "Review link".';
COMMENT ON COLUMN app.survey_versions.compile_state IS
  'K §3: the ARTIFACT axis. none -> compiling -> compiled | failed. Orthogonal to status. A '
  'recompile of a production version does not change status: it produces a new artifact '
  'hash and atomically repoints artifact_hash, and rollback repoints it back.';
COMMENT ON COLUMN app.survey_versions.artifact_hash IS
  'ADR-002: sha256 of the compiled artifact in object storage. Mutable even on a frozen '
  'version — repointing this IS what publish and rollback are (01 §7) — which is exactly '
  'why app.tg_version_guard seals the content-defining columns and deliberately leaves '
  'this one open.';
COMMENT ON COLUMN app.survey_versions.revision IS
  'Optimistic lock (01 §3.1), incremented by app.tg_version_guard on every UPDATE. Two '
  'studio tabs editing one survey must produce a conflict dialog, not a silent overwrite.';
COMMENT ON COLUMN app.survey_versions.schema_version IS
  'The SURVEY DOCUMENT''s schema version (03 §18), NOT the SQL migration number — B §14.1 '
  'is emphatic that conflating the two is a specific and expensive confusion. The '
  'overwhelmingly common case is a schema_version bump with no SQL migration at all.';
COMMENT ON COLUMN app.survey_versions.acknowledged_warnings IS
  '03 §17: publishing over a warning is allowed but the acknowledgement is recorded here '
  'and audited, so "who signed off on shipping this" is answerable months later.';

CREATE UNIQUE INDEX sv_one_draft ON app.survey_versions (survey_id) WHERE status = 'draft';
CREATE UNIQUE INDEX sv_one_staging ON app.survey_versions (survey_id) WHERE status = 'staging';
CREATE UNIQUE INDEX sv_one_production ON app.survey_versions (survey_id)
  WHERE status = 'production';
COMMENT ON INDEX app.sv_one_draft IS
  'B §3 / 01 §6 lifecycle invariant: one editable draft per survey. Expressed as a partial '
  'unique index rather than application logic because two concurrent "clone a draft" '
  'requests would otherwise both succeed.';
COMMENT ON INDEX app.sv_one_staging IS
  'B §3: one review copy per survey, so a review link always means one thing.';
COMMENT ON INDEX app.sv_one_production IS
  'B §3 / K §3: AT MOST ONE production version per survey. This is the index that makes '
  '"which version are respondents seeing" a single row rather than a judgement call.';

CREATE INDEX sv_artifact_idx ON app.survey_versions (artifact_hash)
  WHERE artifact_hash IS NOT NULL;
COMMENT ON INDEX app.sv_artifact_idx IS
  'B §3. Deliberately NON-unique: ADR-002 makes republishing identical content a no-op, and '
  'two tracker waves can legitimately compile to the same bytes. It exists so "which '
  'versions are live on this artifact" — the question you ask before purging a CDN path — '
  'is an index lookup rather than a full scan.';

CREATE INDEX sv_survey_idx ON app.survey_versions (survey_id, version_no DESC);
COMMENT ON INDEX app.sv_survey_idx IS 'The version history panel, newest first.';

CREATE FUNCTION app.tg_version_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> NEW.status AND (OLD.status::text, NEW.status::text) NOT IN (
       ('draft','review'), ('draft','staging'), ('review','staging'), ('review','draft'),
       ('staging','production'), ('staging','archived'), ('review','archived'),
       ('production','archived'), ('archived','production'))  -- last one = rollback
  THEN
    RAISE EXCEPTION 'illegal version transition %->%', OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;

  -- Once frozen, the content-defining columns are sealed. artifact_hash, artifact_bytes,
  -- compile_state, compile_diagnostics, status and the lifecycle timestamps stay mutable,
  -- because repointing the artifact is precisely what publish and rollback do (01 §7).
  IF OLD.frozen_at IS NOT NULL AND
     ROW(NEW.schema_version, NEW.survey_id, NEW.org_id, NEW.version_no,
         NEW.entitlement_reqs, NEW.acknowledged_warnings, NEW.created_by,
         NEW.cloned_from_version_id)
     IS DISTINCT FROM
     ROW(OLD.schema_version, OLD.survey_id, OLD.org_id, OLD.version_no,
         OLD.entitlement_reqs, OLD.acknowledged_warnings, OLD.created_by,
         OLD.cloned_from_version_id)
  THEN
    RAISE EXCEPTION 'survey_version % is frozen (status %) and cannot be mutated',
      OLD.id, OLD.status
      USING ERRCODE = 'check_violation',
            HINT = 'ADR-002: clone a new draft to edit.';
  END IF;

  IF NEW.status <> 'draft' AND NEW.frozen_at IS NULL THEN
    NEW.frozen_at := now();
  END IF;
  IF NEW.status = 'production' AND NEW.published_at IS NULL THEN
    NEW.published_at := now();
  END IF;
  NEW.revision := OLD.revision + 1;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END $$;
COMMENT ON FUNCTION app.tg_version_guard() IS
  'B §3.1 in executable form. Three jobs: reject illegal lifecycle transitions, seal a '
  'frozen version''s content-defining columns (ADR-002), and increment `revision` so '
  'optimistic locking cannot be forgotten by a caller. Rollback is archived -> production '
  'plus repointing artifact_hash: provably the same bytes that were live before, in '
  'seconds, audited. The immutability rule is ALSO expressed in the RLS policy '
  '(sv_update), on purpose — B §12: the policy makes an editor bug surface as "0 rows '
  'updated" rather than an exception thrown halfway through a transaction, and the trigger '
  'catches anything that reaches the table by another route.';

CREATE TRIGGER version_guard BEFORE UPDATE ON app.survey_versions
  FOR EACH ROW EXECUTE FUNCTION app.tg_version_guard();

-- ---------------------------------------------------------------------------
-- 6. Capability grants — the two capabilities that do NOT nest (K §1)
-- ---------------------------------------------------------------------------
CREATE TABLE app.capability_grants (
  id            app.ulid PRIMARY KEY DEFAULT app.gen_ulid('cap'),
  org_id        app.ulid NOT NULL REFERENCES app.organizations(id),
  user_id       uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  capability    text NOT NULL CHECK (capability IN ('pii_access', 'custom_code')),
  project_id    app.ulid,
  granted_by    uuid NOT NULL REFERENCES auth.users(id),
  justification text NOT NULL,
  expires_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  revoked_at    timestamptz,
  revoked_by    uuid REFERENCES auth.users(id),
  FOREIGN KEY (org_id, project_id) REFERENCES app.projects (org_id, id),
  CONSTRAINT capgrants_justification_meaningful CHECK (length(btrim(justification)) >= 12),
  CONSTRAINT capgrants_revoked_consistent
    CHECK ((revoked_at IS NULL) = (revoked_by IS NULL))
);
COMMENT ON TABLE app.capability_grants IS
  'Deliverable K §1: "ranking is a convenience, not the authorization model". Two '
  'capabilities do not nest and must never be checked by rank:  (1) PII in exports — needs '
  'analyst AND a per-project pii_access grant AND an org setting AND an audit-logged '
  'justification; a Project Manager outranks an Analyst and does NOT inherit it.  '
  '(2) Custom code authoring — programmer only; Admins outrank programmers and still cannot '
  'author custom JS, because the threat model treats custom code as a distinct privilege '
  'rather than a seniority reward (Deliverable G §1). K: "both exceptions are implemented as '
  'explicit grants in app.capability_grants, and has_role() is forbidden from appearing in a '
  'policy that governs either. CI greps for it." That grep is '
  'tools/ci/lint-migrations.mjs''s HAS_ROLE_IN_CAPABILITY_POLICY rule, plus the '
  'pg_policies assertion in this migration''s test.sql, which checks every policy in the '
  'live database rather than only the ones written today.';
COMMENT ON COLUMN app.capability_grants.project_id IS
  'NULL = org-wide. K §1 calls pii_access "the per-project grant", so the narrow form is '
  'the intended one and org-wide is the exception a security reviewer should notice.';
COMMENT ON COLUMN app.capability_grants.justification IS
  'K §1 requires "an audit-logged justification" for PII access. NOT NULL with a minimum '
  'length so the grant itself carries the reason: a justification stored only in a ticket '
  'is a justification nobody can find during a subject-access request.';
COMMENT ON COLUMN app.capability_grants.expires_at IS
  'NULL = no expiry. Time-boxing is the difference between "an analyst had PII access for '
  'the two weeks of fieldwork" and "an analyst has had PII access since 2024".';

CREATE UNIQUE INDEX capgrants_live_key ON app.capability_grants
  (org_id, user_id, capability, COALESCE(project_id::text, '-'))
  WHERE revoked_at IS NULL;
COMMENT ON INDEX app.capgrants_live_key IS
  'One live grant per (org, user, capability, project). The ::text cast is required: '
  'COALESCE(project_id, ''-'') would coerce the sentinel into app.ulid and fail its CHECK. '
  'COALESCE at all because NULL project_id '
  'means org-wide and two org-wide grants for the same capability are a duplicate, not two '
  'facts. Partial on revoked_at so the history is retained — a revoked grant is evidence.';

CREATE INDEX capgrants_user_idx ON app.capability_grants (user_id, capability)
  WHERE revoked_at IS NULL;
COMMENT ON INDEX app.capgrants_user_idx IS
  'app.has_capability()''s lookup. Called inside policy predicates, so it must not scan.';

-- ---------------------------------------------------------------------------
-- 7. Audit log (B §10)
-- ---------------------------------------------------------------------------
CREATE TABLE app.audit_log (
  created_at        timestamptz NOT NULL DEFAULT now(),
  id                app.ulid NOT NULL DEFAULT app.gen_ulid('aud'),
  org_id            app.ulid NOT NULL,
  actor_user_id     uuid,
  actor_api_key_id  app.ulid,
  actor_kind        text NOT NULL CHECK (actor_kind IN ('user','api_key','system','support')),
  action            text NOT NULL,
  target_kind       text,
  target_id         app.ulid,
  project_id        app.ulid,
  survey_id         app.ulid,
  survey_version_id app.ulid,
  summary           text,
  diff              jsonb,
  request_id        text,
  ip                inet,
  user_agent        text,
  PRIMARY KEY (created_at, id)
) PARTITION BY RANGE (created_at);
COMMENT ON TABLE app.audit_log IS
  'B §10. Partitioned monthly by created_at, 24 months online, maintained by '
  'ops.ensure_event_partitions(). Partitioned rather than a single table because the only '
  'operations that ever happen to old audit data are "retain" and "detach", both of which '
  'are O(1) on a partition and a multi-hour DELETE on a heap. There is deliberately NO '
  'INSERT POLICY (B §12): audit rows are written only from SECURITY DEFINER functions, so '
  'an actor cannot forge or suppress their own audit trail even with full table privileges. '
  'No foreign keys to projects/surveys/versions on purpose — an audit row must survive the '
  'deletion of the thing it describes, which is the entire point of an audit row.';
COMMENT ON COLUMN app.audit_log.actor_kind IS
  'user | api_key | system | support. `support` is separate from `user` because "an '
  'Anthropic-side engineer looked at this" and "the customer looked at this" must be '
  'distinguishable in a compliance export without joining anything.';
COMMENT ON COLUMN app.audit_log.diff IS
  'Before/after for the changed fields. P1-01''s acceptance criterion — changing a member '
  'from programmer to viewer "produces one app.audit_log row naming the actor, target and '
  'old/new role" — is satisfied by this column, which is why audit_diff_idx is a GIN index.';
COMMENT ON COLUMN app.audit_log.request_id IS
  'M0.4''s correlation id, propagated studio -> worker -> runtime. The join key between a '
  'log line, a trace, and the durable record of what changed.';

CREATE INDEX audit_org_time_idx    ON app.audit_log (org_id, created_at DESC);
CREATE INDEX audit_target_idx      ON app.audit_log (org_id, target_kind, target_id, created_at DESC);
CREATE INDEX audit_actor_idx       ON app.audit_log (org_id, actor_user_id, created_at DESC);
CREATE INDEX audit_survey_idx      ON app.audit_log (survey_id, created_at DESC)
  WHERE survey_id IS NOT NULL;
CREATE INDEX audit_action_trgm_idx ON app.audit_log USING gin (action gin_trgm_ops);
CREATE INDEX audit_diff_idx        ON app.audit_log USING gin (diff jsonb_path_ops);
COMMENT ON INDEX app.audit_org_time_idx IS
  'B §13 "audit search". Leading org_id so the index is partition-pruned AND tenant-scoped.';
COMMENT ON INDEX app.audit_diff_idx IS
  'B §13. jsonb_path_ops rather than jsonb_ops: audit search is always "find rows whose '
  'diff contains this", never "find rows that have this key", and path_ops is roughly half '
  'the size for containment queries.';

-- ---------------------------------------------------------------------------
-- 8. RLS helper functions (B §1.1)
-- ---------------------------------------------------------------------------
-- app.jwt_claims(), app.current_user_id() and app.current_org() are in 0001 (no table
-- dependency). The four below read tables and therefore land with those tables.
--
-- All are STABLE so the planner evaluates them once per query rather than once per row,
-- and all pin search_path = '' so a caller cannot shadow `app` with a temp schema and
-- substitute their own org_members.

CREATE FUNCTION app.has_role(min_role app.org_role, org app.ulid DEFAULT app.current_org())
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1 FROM app.org_members m
     WHERE m.org_id = org
       AND m.user_id = app.current_user_id()
       AND app.role_rank(m.role) >= app.role_rank(min_role))
$$;
COMMENT ON FUNCTION app.has_role(app.org_role, app.ulid) IS
  'B §1.1. "At least this rank in this org." SECURITY DEFINER is load-bearing: '
  'app.org_members itself has RLS, and a policy on org_members that read org_members '
  'through the policy layer would recurse — definer breaks the cycle, which is why the body '
  'stays trivial enough to audit at a glance. Returns false (never raises) when the JWT is '
  'absent or forged, because a forged active_org_id with no matching membership row must '
  'yield ZERO ROWS rather than an error (P1-01 acceptance). NOT VALID for the two '
  'capabilities in Deliverable K §1 that do not nest — use app.has_capability() for those.';

CREATE FUNCTION app.can_see_project(p app.ulid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1 FROM app.org_members m
     WHERE m.org_id = app.current_org()
       AND m.user_id = app.current_user_id()
       AND CASE
             -- K §1: a client is scoped to EXPLICITLY SHARED projects, so an empty
             -- project_ids array must mean "nothing" for them and "everything" for
             -- everyone else. Collapsing these two readings into one is how a client
             -- contact ends up browsing the agency's whole portfolio.
             WHEN m.role = 'client' THEN p = ANY (m.project_ids)
             ELSE cardinality(m.project_ids) = 0 OR p = ANY (m.project_ids)
           END)
$$;
COMMENT ON FUNCTION app.can_see_project(app.ulid) IS
  'B §1.1 plus K §1''s client scoping. Empty project_ids = org-wide for staff roles; for '
  '`client` it grants nothing (and app.org_members.members_client_must_be_scoped makes the '
  'empty case unreachable anyway — two independent guards, because this is the predicate '
  'that keeps one agency client out of another agency client''s study).';

CREATE FUNCTION app.can_see_survey(p_survey app.ulid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1 FROM app.surveys s
     WHERE s.id = p_survey
       AND s.org_id = app.current_org()
       AND app.can_see_project(s.project_id))
$$;
COMMENT ON FUNCTION app.can_see_survey(app.ulid) IS
  'Project scoping for tables that carry survey_id but not project_id (survey_versions, and '
  'every content.* table in P1-03). SECURITY DEFINER so the lookup on app.surveys is not '
  'itself filtered by app.surveys'' policies — nesting RLS inside RLS makes the effective '
  'predicate depend on evaluation order, which is not a property anyone should have to '
  'reason about while reviewing a policy.';

CREATE FUNCTION app.has_capability(p_capability text, p_project app.ulid DEFAULT NULL)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (
           SELECT 1 FROM app.capability_grants g
            WHERE g.org_id = app.current_org()
              AND g.user_id = app.current_user_id()
              AND g.capability = p_capability
              AND g.revoked_at IS NULL
              AND (g.expires_at IS NULL OR g.expires_at > now())
              AND (g.project_id IS NULL OR g.project_id = p_project))
     AND (p_capability <> 'pii_access'
          OR EXISTS (
            SELECT 1 FROM app.organizations o
             WHERE o.id = app.current_org()
               AND o.deleted_at IS NULL
               AND COALESCE((o.settings ->> 'pii_exports_enabled')::boolean, false)))
$$;
COMMENT ON FUNCTION app.has_capability(text, app.ulid) IS
  'Deliverable K §1''s non-nesting capabilities: ''pii_access'' and ''custom_code''. '
  'DELIBERATELY CONTAINS NO CALL TO app.has_role(). That is not an oversight to be tidied '
  'up later — rank inheritance is exactly the bug K was written to prevent, because a '
  'Project Manager (50) outranks an Analyst (30) and must not thereby acquire PII access, '
  'and an Admin (60) outranks a Programmer (40) and must not thereby acquire the right to '
  'author custom JS. The role requirement is checked when the GRANT IS ISSUED (P1-13), '
  'where it can be audited and time-boxed; the CHECK here is grant-only. pii_access '
  'additionally requires the org-level `pii_exports_enabled` setting, per K §1''s "an org '
  'setting permitting it". A test in this migration asserts that no policy in the database '
  'mentions either capability alongside app.has_role().';

REVOKE EXECUTE ON FUNCTION
  app.has_role(app.org_role, app.ulid),
  app.can_see_project(app.ulid),
  app.can_see_survey(app.ulid),
  app.has_capability(text, app.ulid)
FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  app.has_role(app.org_role, app.ulid),
  app.can_see_project(app.ulid),
  app.can_see_survey(app.ulid),
  app.has_capability(text, app.ulid)
TO authoring, analytics_reader;

-- ---------------------------------------------------------------------------
-- 9. SECURITY DEFINER write paths that RLS deliberately leaves no policy for
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.write_audit_event(
  p_org_id            app.ulid,
  p_action            text,
  p_actor_kind        text DEFAULT 'user',
  p_actor_user_id     uuid DEFAULT NULL,
  p_target_kind       text DEFAULT NULL,
  p_target_id         app.ulid DEFAULT NULL,
  p_project_id        app.ulid DEFAULT NULL,
  p_survey_id         app.ulid DEFAULT NULL,
  p_survey_version_id app.ulid DEFAULT NULL,
  p_summary           text DEFAULT NULL,
  p_diff              jsonb DEFAULT NULL,
  p_request_id        text DEFAULT NULL
) RETURNS app.ulid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_id app.ulid;
BEGIN
  INSERT INTO app.audit_log (org_id, action, actor_kind, actor_user_id, target_kind,
                             target_id, project_id, survey_id, survey_version_id,
                             summary, diff, request_id)
  VALUES (p_org_id, p_action, p_actor_kind,
          COALESCE(p_actor_user_id, app.current_user_id()), p_target_kind, p_target_id,
          p_project_id, p_survey_id, p_survey_version_id, p_summary, p_diff, p_request_id)
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;
COMMENT ON FUNCTION app.write_audit_event(app.ulid, text, text, uuid, text, app.ulid,
  app.ulid, app.ulid, app.ulid, text, jsonb, text) IS
  'B §12 / P1-01: "audit writes from SECURITY DEFINER functions only." app.audit_log has a '
  'SELECT policy and no INSERT policy, so this function is the only way a row gets in. That '
  'asymmetry is the design: an actor who can write their own audit trail can rewrite '
  'history, and an actor who can delete from it can erase themselves.';

CREATE FUNCTION app.create_organization(p_slug text, p_name text, p_region text DEFAULT 'eu-west-1')
RETURNS app.ulid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_org  app.ulid;
  v_user uuid := app.current_user_id();
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'create_organization requires an authenticated caller'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  INSERT INTO app.organizations (slug, name, data_region)
  VALUES (p_slug, p_name, p_region) RETURNING id INTO v_org;
  INSERT INTO app.org_members (org_id, user_id, role) VALUES (v_org, v_user, 'owner');
  PERFORM app.write_audit_event(v_org, 'organization.created', 'user', v_user,
                                'organization', v_org, NULL, NULL, NULL,
                                format('created org %s', p_slug));
  RETURN v_org;
END $$;
COMMENT ON FUNCTION app.create_organization(text, text, text) IS
  'The only path by which an `owner` comes into existence. app.organizations has no INSERT '
  'policy and app.invitations forbids role = ''owner'', so ownership cannot be obtained by '
  'invitation (P1-01 acceptance) — it is created here, at signup, for the caller, or '
  'transferred by an explicit audited action. Also the reason a new org can satisfy the '
  'deferred "at least one owner" trigger: the org and its first owner are inserted in one '
  'transaction.';

REVOKE EXECUTE ON FUNCTION app.create_organization(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.create_organization(text, text, text) TO authoring;
REVOKE EXECUTE ON FUNCTION app.write_audit_event(app.ulid, text, text, uuid, text, app.ulid,
  app.ulid, app.ulid, app.ulid, text, jsonb, text) FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- 10. Row level security (B §12, ADR-009)
-- ---------------------------------------------------------------------------
-- ENABLE makes policies apply. FORCE makes them apply to the table OWNER as well, which is
-- the difference between an isolation suite that means something and one that passes
-- because it happened to run as the owner. Every table gets both; ops.tables_without_rls()
-- fails CI for any that does not.
--
-- Policies are DENY BY DEFAULT and ADDITIVE. Additive is the trap: because they OR
-- together, one over-broad `FOR SELECT` silently widens everything, so reviewing new
-- policies in migrations is mandatory (B §12). Separate policies per command, never
-- FOR ALL, so that a read predicate can never accidentally become a write predicate.
--
-- Where a command has NO policy that is a deliberate deny, and it is commented as such.
-- The distinction matters operationally: a missing INSERT policy raises 42501, while a
-- missing UPDATE/DELETE policy silently affects zero rows.

ALTER TABLE app.organizations     ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.organizations     FORCE  ROW LEVEL SECURITY;
ALTER TABLE app.org_members       ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.org_members       FORCE  ROW LEVEL SECURITY;
ALTER TABLE app.invitations       ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.invitations       FORCE  ROW LEVEL SECURITY;
ALTER TABLE app.projects          ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.projects          FORCE  ROW LEVEL SECURITY;
ALTER TABLE app.surveys           ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.surveys           FORCE  ROW LEVEL SECURITY;
ALTER TABLE app.survey_versions   ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.survey_versions   FORCE  ROW LEVEL SECURITY;
ALTER TABLE app.capability_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.capability_grants FORCE  ROW LEVEL SECURITY;
ALTER TABLE app.audit_log         ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.audit_log         FORCE  ROW LEVEL SECURITY;

-- --- organizations ---------------------------------------------------------
CREATE POLICY organizations_select ON app.organizations FOR SELECT TO authoring
USING (id = app.current_org() AND app.has_role('client') AND deleted_at IS NULL);
COMMENT ON POLICY organizations_select ON app.organizations IS
  'You can read the org your token says you are acting in, and only if a membership row '
  'agrees. has_role(''client'') is the lowest rank and therefore reads as "is a member at '
  'all". Forging active_org_id yields zero rows, not an error (P1-01 acceptance).';

CREATE POLICY organizations_update ON app.organizations FOR UPDATE TO authoring
USING (id = app.current_org() AND app.has_role('admin') AND deleted_at IS NULL)
WITH CHECK (id = app.current_org() AND app.has_role('admin'));
COMMENT ON POLICY organizations_update ON app.organizations IS
  'Admin and above may change org settings. The WITH CHECK repeats the org predicate so an '
  'UPDATE cannot move the row to another org — USING governs which rows you may touch, '
  'WITH CHECK governs what they may become, and omitting the second is the classic RLS '
  'hole.';

-- No INSERT policy: orgs are created only by app.create_organization(), which also
-- installs the first owner in the same transaction. No DELETE policy: B §0 ground rule 5,
-- deletion is a soft delete (an UPDATE of deleted_at) plus a job.

-- --- org_members -----------------------------------------------------------
CREATE POLICY members_select ON app.org_members FOR SELECT TO authoring
USING (user_id = app.current_user_id()
       OR (org_id = app.current_org() AND app.has_role('admin')));
COMMENT ON POLICY members_select ON app.org_members IS
  'B §12 policy 3: your own row always — you must be able to discover your own role in '
  'every org you belong to, which is what the org switcher renders — and other people''s '
  'rows only as admin.';

CREATE POLICY members_insert ON app.org_members FOR INSERT TO authoring
WITH CHECK (org_id = app.current_org() AND app.has_role('admin') AND role <> 'owner');
COMMENT ON POLICY members_insert ON app.org_members IS
  'Admins add members but cannot mint an owner. Combined with '
  'app.invitations.invitations_role_not_owner, there is no path to ownership that does not '
  'go through app.create_organization or an explicit audited transfer.';

CREATE POLICY members_update ON app.org_members FOR UPDATE TO authoring
USING (org_id = app.current_org() AND app.has_role('admin') AND role <> 'owner')
WITH CHECK (org_id = app.current_org() AND app.has_role('admin') AND role <> 'owner');
COMMENT ON POLICY members_update ON app.org_members IS
  'B §12 policy 3. `role <> ''owner''` appears in BOTH clauses: in USING so an admin cannot '
  'demote an owner, in WITH CHECK so an admin cannot promote anyone (including themselves) '
  'to owner. One without the other is a privilege-escalation path.';

CREATE POLICY members_delete ON app.org_members FOR DELETE TO authoring
USING (org_id = app.current_org() AND app.has_role('admin') AND role <> 'owner');
COMMENT ON POLICY members_delete ON app.org_members IS
  'Admins remove non-owners. Removing the last owner is additionally impossible via the '
  'deferred org_has_owner trigger, which is the cross-row half of the same invariant.';

-- --- invitations -----------------------------------------------------------
CREATE POLICY invitations_select ON app.invitations FOR SELECT TO authoring
USING (org_id = app.current_org() AND app.has_role('admin'));
CREATE POLICY invitations_insert ON app.invitations FOR INSERT TO authoring
WITH CHECK (org_id = app.current_org() AND app.has_role('admin') AND role <> 'owner'
            AND status = 'pending' AND expires_at > now());
CREATE POLICY invitations_update ON app.invitations FOR UPDATE TO authoring
USING (org_id = app.current_org() AND app.has_role('admin'))
WITH CHECK (org_id = app.current_org() AND app.has_role('admin') AND role <> 'owner');
CREATE POLICY invitations_delete ON app.invitations FOR DELETE TO authoring
USING (org_id = app.current_org() AND app.has_role('admin'));
COMMENT ON POLICY invitations_select ON app.invitations IS
  'Admin-only, and note what is NOT here: no policy lets an invitee read their own '
  'invitation row. Acceptance goes through a SECURITY DEFINER function keyed on the hashed '
  'token, so an authenticated user cannot enumerate pending invitations by email.';
COMMENT ON POLICY invitations_insert ON app.invitations IS
  'The WITH CHECK pins status to ''pending'' and requires a future expiry, so an admin '
  'cannot insert a pre-accepted or never-expiring invitation directly.';

-- --- projects --------------------------------------------------------------
CREATE POLICY projects_select ON app.projects FOR SELECT TO authoring
USING (org_id = app.current_org() AND app.has_role('client') AND app.can_see_project(id));
COMMENT ON POLICY projects_select ON app.projects IS
  'B §12 policy 1: org match + role floor + per-project scoping for freelancers and '
  'clients. The floor is ''client'' rather than B''s ''viewer'' because K §1 gives clients '
  'legitimate scoped access, and can_see_project() is what actually narrows them to the '
  'projects explicitly shared with them.';

CREATE POLICY projects_insert ON app.projects FOR INSERT TO authoring
WITH CHECK (org_id = app.current_org() AND app.has_role('project_manager'));
COMMENT ON POLICY projects_insert ON app.projects IS
  'K §1 puts "create/archive projects" on project_manager. No can_see_project() here: the '
  'row does not exist yet, so there is nothing to scope against.';

CREATE POLICY projects_update ON app.projects FOR UPDATE TO authoring
USING (org_id = app.current_org() AND app.has_role('project_manager')
       AND app.can_see_project(id))
WITH CHECK (org_id = app.current_org() AND app.has_role('project_manager'));
CREATE POLICY projects_delete ON app.projects FOR DELETE TO authoring
USING (org_id = app.current_org() AND app.has_role('admin') AND archived_at IS NOT NULL);
COMMENT ON POLICY projects_delete ON app.projects IS
  'Hard delete requires admin AND an already-archived project. B §0 ground rule 5: the '
  'normal path is archive-then-job, and archiving first means a hard delete is always a '
  'second, deliberate act.';

-- --- surveys ---------------------------------------------------------------
CREATE POLICY surveys_select ON app.surveys FOR SELECT TO authoring
USING (org_id = app.current_org() AND app.has_role('client')
       AND app.can_see_project(project_id));
CREATE POLICY surveys_insert ON app.surveys FOR INSERT TO authoring
WITH CHECK (org_id = app.current_org() AND app.has_role('programmer')
            AND app.can_see_project(project_id));
CREATE POLICY surveys_update ON app.surveys FOR UPDATE TO authoring
USING (org_id = app.current_org() AND app.has_role('programmer')
       AND app.can_see_project(project_id))
WITH CHECK (org_id = app.current_org() AND app.has_role('programmer')
            AND app.can_see_project(project_id));
CREATE POLICY surveys_delete ON app.surveys FOR DELETE TO authoring
USING (org_id = app.current_org() AND app.has_role('admin') AND archived_at IS NOT NULL);
COMMENT ON POLICY surveys_update ON app.surveys IS
  'Programmer and above, within their project scope. The WITH CHECK repeats '
  'can_see_project(project_id) so a programmer scoped to project X cannot MOVE a survey '
  'into project Y — the USING clause alone would permit exactly that.';

-- --- survey_versions -------------------------------------------------------
CREATE POLICY sv_select ON app.survey_versions FOR SELECT TO authoring
USING (org_id = app.current_org() AND app.has_role('client')
       AND app.can_see_survey(survey_id));
COMMENT ON POLICY sv_select ON app.survey_versions IS
  'Reviewers and clients must be able to read FROZEN versions — that is what a review link '
  'is — so the read policy is deliberately not restricted to drafts. B §12: "reviewers must '
  'read frozen versions; a separate, narrower policy grants exactly that."';

CREATE POLICY sv_insert ON app.survey_versions FOR INSERT TO authoring
WITH CHECK (org_id = app.current_org() AND app.has_role('programmer')
            AND app.can_see_survey(survey_id)
            AND status = 'draft' AND frozen_at IS NULL);
COMMENT ON POLICY sv_insert ON app.survey_versions IS
  'A new version is always born a draft. Creating a version directly in ''production'' '
  'would bypass every review gate, so the policy refuses it and publishing becomes an '
  'UPDATE that app.tg_version_guard validates.';

CREATE POLICY sv_update ON app.survey_versions FOR UPDATE TO authoring
USING (org_id = app.current_org() AND app.has_role('programmer')
       AND app.can_see_survey(survey_id))
WITH CHECK (org_id = app.current_org() AND app.has_role('programmer')
            AND app.can_see_survey(survey_id));
COMMENT ON POLICY sv_update ON app.survey_versions IS
  'Programmer and above. Note this policy does NOT restrict status transitions or frozen '
  'columns: app.tg_version_guard owns that, because a transition rule expressed as a policy '
  'silently updates zero rows and the editor needs to be told WHY ("illegal version '
  'transition staging->draft"). The split is deliberate — policies for "whose rows", '
  'triggers for "what shape".';

CREATE POLICY sv_delete ON app.survey_versions FOR DELETE TO authoring
USING (org_id = app.current_org() AND app.has_role('admin') AND status = 'archived');
COMMENT ON POLICY sv_delete ON app.survey_versions IS
  'Only an archived version may be hard-deleted, and only by an admin. A production version '
  'has respondents attached to it (ADR-002/ADR-007) and deleting it orphans the event log.';

-- --- capability_grants -----------------------------------------------------
-- Deliverable K §1: app.has_role() is FORBIDDEN in a policy governing pii_access or
-- custom_code. These four policies govern the GRANT TABLE ITSELF — who may hand out a
-- capability, which is ordinary org administration and correctly rank-based — and never
-- the capability check. The capability check is app.has_capability(), which contains no
-- has_role() call at all. The invariant is asserted two ways: statically by
-- tools/ci/lint-migrations.mjs (HAS_ROLE_IN_CAPABILITY_POLICY) and dynamically over
-- pg_policies in this migration's test.sql.
CREATE POLICY capgrants_select ON app.capability_grants FOR SELECT TO authoring
USING (user_id = app.current_user_id()
       OR (org_id = app.current_org() AND app.has_role('admin')));
COMMENT ON POLICY capgrants_select ON app.capability_grants IS
  'You can always see what you have been granted — a user who cannot enumerate their own '
  'elevated access cannot be expected to report a mistake — and admins see the whole org.';

CREATE POLICY capgrants_insert ON app.capability_grants FOR INSERT TO authoring
WITH CHECK (org_id = app.current_org() AND app.has_role('admin')
            AND granted_by = app.current_user_id()
            AND user_id <> app.current_user_id());
COMMENT ON POLICY capgrants_insert ON app.capability_grants IS
  'Two-person integrity: granted_by must be the caller (no forging who authorised it) and '
  'user_id must NOT be the caller (no self-grant). An admin who wants PII access has to ask '
  'another admin, which is the whole point of making these capabilities explicit rather '
  'than inherited by rank.';

CREATE POLICY capgrants_update ON app.capability_grants FOR UPDATE TO authoring
USING (org_id = app.current_org() AND app.has_role('admin'))
WITH CHECK (org_id = app.current_org() AND app.has_role('admin')
            AND revoked_at IS NOT NULL AND revoked_by = app.current_user_id());
COMMENT ON POLICY capgrants_update ON app.capability_grants IS
  'The only legal UPDATE is a revocation: the WITH CHECK requires revoked_at to be set, so '
  'an admin cannot quietly widen an existing grant''s scope or extend its expiry. Widening '
  'means revoking and issuing a new grant, which leaves both rows as evidence.';

CREATE POLICY capgrants_delete ON app.capability_grants FOR DELETE TO authoring
USING (false);
COMMENT ON POLICY capgrants_delete ON app.capability_grants IS
  'Explicitly USING (false) rather than omitted, so that "nobody may delete a capability '
  'grant" is a statement someone wrote down rather than something that might have been '
  'forgotten. Revocation is an UPDATE; the grant history is evidence and evidence is not '
  'deletable.';

-- --- audit_log -------------------------------------------------------------
CREATE POLICY audit_select ON app.audit_log FOR SELECT TO authoring
USING (org_id = app.current_org() AND app.has_role('admin'));
COMMENT ON POLICY audit_select ON app.audit_log IS
  'B §12 policy 4: admins read. There is deliberately NO INSERT, UPDATE or DELETE policy, '
  'because writes happen only inside app.write_audit_event (SECURITY DEFINER) and an audit '
  'trail its subject can edit is not an audit trail.';

-- ---------------------------------------------------------------------------
-- 11. Partitions for app.audit_log
-- ---------------------------------------------------------------------------
-- Called now that the parent exists. Also enables + forces RLS on each partition: policies
-- are NOT inherited by partitions for direct access, so an unprotected partition would let
-- a caller read another tenant's audit trail by naming the child table.
SELECT ops.ensure_event_partitions(3);

-- ---------------------------------------------------------------------------
-- 12. Grants (ADR-009, B §2)
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA app TO authoring;

-- The audit log is readable and nothing else, below the policy layer as well as at it.
-- Two independent mechanisms because this is the table that proves what happened.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON app.audit_log FROM authoring;

-- ADR-009's negative capability, stated as a grant rather than a convention: the runtime
-- gets NO table privilege anywhere. "The riskiest query surface in the system has no
-- ability to read tenant data at all, because it is granted nothing but write RPCs."
REVOKE ALL ON ALL TABLES IN SCHEMA app     FROM runtime_writer, analytics_reader;
REVOKE ALL ON ALL TABLES IN SCHEMA content FROM runtime_writer, analytics_reader;
REVOKE ALL ON ALL TABLES IN SCHEMA billing FROM runtime_writer, analytics_reader;
REVOKE ALL ON SCHEMA content FROM runtime_writer, analytics_reader;

-- ---------------------------------------------------------------------------
-- 13. Runtime RPC surface (ADR-009, B §2)
-- ---------------------------------------------------------------------------
-- Placeholders returning empty, so the GRANT SHAPE is testable now rather than after
-- P1-08. B §2: all runtime RPCs are SECURITY DEFINER owned by runtime_rpc_owner, with
-- SET search_path = '' and a 3s statement_timeout, and NO FUNCTION TAKES AN org_id
-- ARGUMENT — org is always derived from the token or session inside the definer function,
-- so there is no way to phrase a cross-tenant request.
-- runtime_rpc_owner must be able to resolve the app.ulid / app.sha256 /
-- app.version_status domains that appear in the RPC signatures. USAGE on the schema is
-- type visibility only; it carries no table privilege.
GRANT USAGE ON SCHEMA app TO runtime_rpc_owner;

CREATE FUNCTION runtime.resolve_token(p_token text)
RETURNS TABLE (survey_version_id app.ulid, artifact_hash app.sha256,
               is_test boolean, status app.version_status)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = '' SET statement_timeout = '3s' AS $$
BEGIN
  -- Validate before touching anything: the token arrives from a hostname label supplied by
  -- an anonymous respondent.
  IF p_token IS NULL OR p_token !~ '^[0-9a-z]{26}$' THEN
    RETURN;
  END IF;
  RETURN;   -- placeholder: runtime.survey_tokens lands in P1-08/P1-11
END $$;
ALTER FUNCTION runtime.resolve_token(text) OWNER TO runtime_rpc_owner;
COMMENT ON FUNCTION runtime.resolve_token(text) IS
  'PLACEHOLDER (returns no rows) — the real implementation reads runtime.survey_tokens in '
  'P1-08. Exists in P1-01 so ADR-009''s grant shape is testable from the start: '
  'runtime_writer holds EXECUTE on this and on runtime.load_session and has no table '
  'privilege anywhere. B §2: it returns (survey_version_id, artifact_hash, is_test, status) '
  'and NOTHING ELSE — no org, no survey name, no project — because the resolved token is '
  'the runtime''s only read from Postgres and every extra column is a cross-tenant leak '
  'waiting for a bug. Token format is Deliverable K §5''s 26-char lowercase base-36.';

CREATE FUNCTION runtime.load_session(p_session_id app.ulid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = '' SET statement_timeout = '3s' AS $$
BEGIN
  IF p_session_id IS NULL THEN
    RETURN NULL;
  END IF;
  RETURN NULL;   -- placeholder: runtime.response_documents lands in P1-08
END $$;
ALTER FUNCTION runtime.load_session(app.ulid) OWNER TO runtime_rpc_owner;
COMMENT ON FUNCTION runtime.load_session(app.ulid) IS
  'PLACEHOLDER (returns NULL) — the real implementation returns ONE session''s document '
  'from runtime.response_documents in P1-08. Takes a session id and no org id: org is '
  'derived from the session inside the function, which is what makes a cross-tenant request '
  'unphraseable rather than merely unauthorized.';

REVOKE EXECUTE ON FUNCTION runtime.resolve_token(text), runtime.load_session(app.ulid)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION runtime.resolve_token(text), runtime.load_session(app.ulid)
  TO runtime_writer;

-- ---------------------------------------------------------------------------
-- 14. ops.test_seed_two_orgs (roadmap M0.2, B §12.1)
-- ---------------------------------------------------------------------------
CREATE FUNCTION ops.test_ulid(p_prefix text, p_tag text) RETURNS app.ulid
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT (p_prefix || '_0' || rpad(upper(p_tag), 25, '0'))::app.ulid
$$;
COMMENT ON FUNCTION ops.test_ulid(text, text) IS
  'Deterministic, human-readable ids for fixtures: test_ulid(''org'',''a'') is always '
  'org_0A000000000000000000000000. A test that asserts "org A cannot see org B" is much '
  'easier to debug when the ids say which is which. Note the tag is upper-cased and '
  'therefore must avoid I, L, O and U, which Crockford base32 excludes.';

CREATE FUNCTION ops.test_seed_two_orgs() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_user_a  uuid := '11111111-1111-1111-1111-111111111111';
  v_user_a2 uuid := '44444444-4444-4444-4444-444444444444';
  v_user_b  uuid := '22222222-2222-2222-2222-222222222222';
  v_user_b2 uuid := '55555555-5555-5555-5555-555555555555';
  v_user_c  uuid := '33333333-3333-3333-3333-333333333333';
  v_org_a   app.ulid := ops.test_ulid('org', 'a');
  v_org_b   app.ulid := ops.test_ulid('org', 'b');
  v_prj_a   app.ulid := ops.test_ulid('prj', 'a');
  v_prj_a2  app.ulid := ops.test_ulid('prj', 'a2');
  v_prj_b   app.ulid := ops.test_ulid('prj', 'b');
  v_svy_a   app.ulid := ops.test_ulid('svy', 'a');
  v_svy_b   app.ulid := ops.test_ulid('svy', 'b');
  v_ver_a1  app.ulid := ops.test_ulid('ver', 'a1');   -- frozen, production
  v_ver_a2  app.ulid := ops.test_ulid('ver', 'a2');   -- draft
  v_ver_b1  app.ulid := ops.test_ulid('ver', 'b1');   -- frozen, production
  v_ver_b2  app.ulid := ops.test_ulid('ver', 'b2');   -- draft
  k_hash    constant app.sha256 :=
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
BEGIN
  INSERT INTO auth.users (id, email) VALUES
    (v_user_a,  'a@example.test'),
    (v_user_a2, 'a2@example.test'),
    (v_user_b,  'b@example.test'),
    (v_user_b2, 'b2@example.test'),
    (v_user_c,  'c@example.test')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO app.organizations (id, slug, name, settings) VALUES
    (v_org_a, 'org-a', 'Org A', '{"pii_exports_enabled": true}'),
    (v_org_b, 'org-b', 'Org B', '{}');

  -- user_a owns org A org-wide; user_a2 is a reviewer scoped to project A only, which is
  -- what makes can_see_project() testable rather than vacuously true; user_b owns org B;
  -- user_c belongs to NOTHING, which is the forged-claim case.
  INSERT INTO app.org_members (org_id, user_id, role, project_ids) VALUES
    (v_org_a, v_user_a,  'owner',    '{}'),
    (v_org_a, v_user_a2, 'reviewer', ARRAY[v_prj_a]::app.ulid[]),
    (v_org_b, v_user_b,  'owner',    '{}'),
    (v_org_b, v_user_b2, 'programmer', ARRAY[v_prj_b]::app.ulid[]);

  INSERT INTO app.projects (id, org_id, ref, name, created_by) VALUES
    (v_prj_a,  v_org_a, 'PRJA',  'Project A',  v_user_a),
    (v_prj_a2, v_org_a, 'PRJA2', 'Project A2', v_user_a),
    (v_prj_b,  v_org_b, 'PRJB',  'Project B',  v_user_b);

  INSERT INTO app.surveys (id, org_id, project_id, ref, name, created_by) VALUES
    (v_svy_a, v_org_a, v_prj_a, 'SVYA', 'Survey A', v_user_a),
    (v_svy_b, v_org_b, v_prj_b, 'SVYB', 'Survey B', v_user_b);

  -- One frozen production version and one draft per survey: the frozen one is what the
  -- immutability tests write against, the draft is what the happy path writes against.
  INSERT INTO app.survey_versions
    (id, org_id, survey_id, version_no, status, compile_state, artifact_hash,
     schema_version, created_by, frozen_at, published_at) VALUES
    (v_ver_a1, v_org_a, v_svy_a, 1, 'production', 'compiled', k_hash, 1, v_user_a,
     now(), now()),
    (v_ver_b1, v_org_b, v_svy_b, 1, 'production', 'compiled', k_hash, 1, v_user_b,
     now(), now());
  INSERT INTO app.survey_versions
    (id, org_id, survey_id, version_no, status, compile_state, schema_version, created_by,
     cloned_from_version_id) VALUES
    (v_ver_a2, v_org_a, v_svy_a, 2, 'draft', 'none', 1, v_user_a, v_ver_a1),
    (v_ver_b2, v_org_b, v_svy_b, 2, 'draft', 'none', 1, v_user_b, v_ver_b1);

  INSERT INTO app.invitations (org_id, email, role, token_hash, invited_by, expires_at)
  VALUES (v_org_a, 'invitee-a@example.test', 'analyst',
          app.hash_invitation_token('token-for-org-a'), v_user_a, now() + interval '7 days'),
         (v_org_b, 'invitee-b@example.test', 'analyst',
          app.hash_invitation_token('token-for-org-b'), v_user_b, now() + interval '7 days');

  -- user_a has PII access in org A (and org A's settings permit it); nobody has it in
  -- org B, and org B's settings do not permit it either. Two independent reasons, so the
  -- test can tell which one is doing the work.
  INSERT INTO app.capability_grants
    (org_id, user_id, capability, project_id, granted_by, justification) VALUES
    (v_org_a, v_user_a2, 'pii_access', v_prj_a, v_user_a,
     'Fieldwork QA for project A, approved in ticket SEC-1041'),
    -- Org B gets a grant too, so that every org_id-bearing table has at least one org-B
    -- row and the catalog-walking cross-tenant probe in test.sql is never vacuous for
    -- one of them. custom_code rather than pii_access: it needs no org setting, so the
    -- two capabilities are exercised independently.
    (v_org_b, v_user_b2, 'custom_code', v_prj_b, v_user_b,
     'Screener randomisation script for project B, approved in ticket SEC-2077');

  PERFORM app.write_audit_event(v_org_a, 'seed.created', 'system', v_user_a,
                                'organization', v_org_a, v_prj_a, v_svy_a, v_ver_a1,
                                'org A seeded');
  PERFORM app.write_audit_event(v_org_b, 'seed.created', 'system', v_user_b,
                                'organization', v_org_b, v_prj_b, v_svy_b, v_ver_b1,
                                'org B seeded');

  RETURN jsonb_build_object(
    'user_a', v_user_a, 'user_a2', v_user_a2,
    'user_b', v_user_b, 'user_b2', v_user_b2, 'user_c', v_user_c,
    'org_a', v_org_a, 'org_b', v_org_b,
    'prj_a', v_prj_a, 'prj_a2', v_prj_a2, 'prj_b', v_prj_b,
    'svy_a', v_svy_a, 'svy_b', v_svy_b,
    'ver_a_frozen', v_ver_a1, 'ver_a_draft', v_ver_a2,
    'ver_b_frozen', v_ver_b1, 'ver_b_draft', v_ver_b2);
END $$;
COMMENT ON FUNCTION ops.test_seed_two_orgs() IS
  'Roadmap M0.2 / B §12.1: the two-org fixture every cross-tenant test builds on. ADR-009 — '
  '"tenant isolation is not a thing you assert once in a design doc" — is why this is a '
  'database function rather than a fixture file in one test suite: every migration''s '
  'test.sql calls it, so the isolation assertions are cheap enough that nobody is tempted '
  'to skip them. SECURITY DEFINER because it must insert rows in FORCE-RLS tables before '
  'any impersonation is set up. Intended to be called inside a transaction that is rolled '
  'back; it makes no attempt to be idempotent.';
