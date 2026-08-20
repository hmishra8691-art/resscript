-- 0002_registry_types — the four cross-plane enumerations, generated from Deliverable K.
--
-- Deliverable K exists because ten interlocking design documents independently defined
-- four values, and in three cases the definitions disagreed in ways that would have
-- shipped as defects. Every type in this file is one of those four. Where Deliverable B
-- says something different, B is wrong and K is right — the WHY is spelled out in each
-- COMMENT ON TYPE, because the next person to touch these will be reading the database,
-- not the design docs.
--
-- K §7: these types are generated from packages/schema/src/registries.ts and CI fails if a
-- migration introduces a CREATE TYPE for a registry name without going through the
-- generator. That generator lands in P1-02; until then this file IS the generated output
-- and must stay byte-compatible with registries.ts when it appears.
SET lock_timeout = '3s';
SET statement_timeout = '60s';

-- ---------------------------------------------------------------------------
-- K §1 — Role hierarchy
-- ---------------------------------------------------------------------------
-- Enum labels are declared in descending rank order so that Postgres's native enum
-- ordering agrees with app.role_rank(). Two orderings that can disagree is exactly the
-- class of defect Deliverable K was written to prevent.
CREATE TYPE app.org_role AS ENUM (
  'owner',            -- 70
  'admin',            -- 60
  'project_manager',  -- 50
  'programmer',       -- 40
  'analyst',          -- 30
  'reviewer',         -- 20
  'viewer',           -- 10
  'client'            --  5
);
COMMENT ON TYPE app.org_role IS
  'CANONICAL: Deliverable K §1 is the source of truth for this enum; K overrides '
  'Deliverable B §1, which defined only six roles ranked owner 60 / admin 50 / '
  'programmer 40 / reviewer 30 / analyst 20 / viewer 10. B and Deliverable G had ANALYST '
  'AND REVIEWER INVERTED relative to each other, and the defect was live: B''s generated '
  'RLS policy tests has_role(''analyst''), so shipping B''s enum with G''s policy lets a '
  'Reviewer — typically an external client contact — pass an analyst-level check and export '
  'response data including open-ends. That is a data-protection incident arising purely '
  'from two documents being written independently. K''s ordering (analyst 30 ABOVE '
  'reviewer 20) is the one to trust. Adding project_manager and client is the other half of '
  'K''s reconciliation.';

CREATE FUNCTION app.role_rank(r app.org_role) RETURNS integer
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = '' AS $$
  SELECT CASE r
           WHEN 'owner'           THEN 70
           WHEN 'admin'           THEN 60
           WHEN 'project_manager' THEN 50
           WHEN 'programmer'      THEN 40
           WHEN 'analyst'         THEN 30
           WHEN 'reviewer'        THEN 20
           WHEN 'viewer'          THEN 10
           WHEN 'client'          THEN  5
         END
$$;
COMMENT ON FUNCTION app.role_rank(app.org_role) IS
  'Deliverable K §1 ranks, exactly. Ranked so policies can express "at least" without a '
  'CASE in fifty places. IMMUTABLE and PARALLEL SAFE so it is free inside a policy '
  'predicate. There is deliberately NO `ELSE` branch: adding a role to app.org_role without '
  'ranking it makes this function return NULL, every has_role() comparison then evaluates '
  'to NULL, and the policy denies. Failing closed on an unranked role beats defaulting it '
  'to 10. K §1''s standing warning: "ranking is a convenience, not the authorization '
  'model" — see app.has_capability() in 0004 for the two capabilities that do not nest.';

REVOKE EXECUTE ON FUNCTION app.role_rank(app.org_role) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.role_rank(app.org_role) TO authoring, analytics_reader;

-- ---------------------------------------------------------------------------
-- K §2 — Dispositions
-- ---------------------------------------------------------------------------
CREATE TYPE runtime.disposition AS ENUM (
  'COMPLETE',      -- terminal, `end` flow node,        redirect, counts toward quota
  'SCREENOUT',     -- terminal, `termination` node,     redirect, reservation released
  'QUOTA_FULL',    -- terminal, quota_gate on_full,     redirect
  'QUALITY',       -- terminal, termination or score,   redirect
  'DUPLICATE',     -- terminal, entry-time dup check,   redirect
  'FRAUD',         -- terminal, entry/in-survey signal, redirect
  'TERMINATE',     -- terminal, generic termination,    redirect
  'CUSTOM',        -- terminal, named custom key,       redirect
  'IN_PROGRESS',   -- NOT terminal, reservation held
  'ABANDONED',     -- terminal, inferred by sweeper,    NO redirect
  'TIMED_OUT'      -- terminal, inferred by sweeper,    NO redirect
);
COMMENT ON TYPE runtime.disposition IS
  'CANONICAL: Deliverable K §2. Reconciles Deliverable B (which carried PARTIAL but not '
  'ABANDONED or TIMED_OUT) with Deliverable E (which carried the reverse); Deliverable H''s '
  'session.abandoned webhook depends on E''s version. PARTIAL IS REMOVED ON PURPOSE: it '
  'conflated a session still open (IN_PROGRESS) with one that will never return '
  '(ABANDONED), and the distinction is not cosmetic — one holds a quota reservation and the '
  'other must release it. A single value cannot drive both behaviours, so anything that '
  'still writes PARTIAL is a bug and this enum makes it a type error. ABANDONED and '
  'TIMED_OUT are inferred server-side by a sweeper, never reached by a flow node, and '
  'therefore require no redirect: nobody is there to redirect. That is why Deliverable C '
  '§17''s "termination with no configured redirect" compile error excludes them — see '
  'runtime.disposition_requires_redirect().';

CREATE FUNCTION runtime.disposition_is_terminal(d runtime.disposition) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = '' AS $$
  SELECT d <> 'IN_PROGRESS'
$$;
COMMENT ON FUNCTION runtime.disposition_is_terminal(runtime.disposition) IS
  'K §2 "Terminal" column. IN_PROGRESS is the only non-terminal value; everything else ends '
  'the session. Encoded as a function rather than left to be re-derived in the runtime, the '
  'worker and the export pipeline, because three independent derivations is how B and E '
  'drifted apart in the first place.';

CREATE FUNCTION runtime.disposition_requires_redirect(d runtime.disposition) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = '' AS $$
  SELECT d NOT IN ('IN_PROGRESS', 'ABANDONED', 'TIMED_OUT')
$$;
COMMENT ON FUNCTION runtime.disposition_requires_redirect(runtime.disposition) IS
  'K §2 "Redirect required" column, and the exact predicate Deliverable C §17''s compile '
  'check must use: a termination node with no configured redirect is a compile error for '
  'every disposition EXCEPT the two the sweeper infers, because a respondent who has '
  'already gone away cannot be redirected anywhere.';

CREATE FUNCTION runtime.disposition_counts_toward_quota(d runtime.disposition) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = '' AS $$
  SELECT d = 'COMPLETE'
$$;
COMMENT ON FUNCTION runtime.disposition_counts_toward_quota(runtime.disposition) IS
  'K §2 "Counts toward quota" column: only COMPLETE commits. Every other terminal value '
  'releases the reservation (ADR-008). Getting this wrong overfills or underfills a study, '
  'which is the single most expensive class of bug in survey delivery, so it is one '
  'function and not an inline list.';

REVOKE EXECUTE ON FUNCTION
  runtime.disposition_is_terminal(runtime.disposition),
  runtime.disposition_requires_redirect(runtime.disposition),
  runtime.disposition_counts_toward_quota(runtime.disposition) FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- K §3 — Version status vs compile state: two orthogonal axes, two columns
-- ---------------------------------------------------------------------------
CREATE TYPE app.version_status AS ENUM (
  'draft', 'review', 'staging', 'production', 'archived'
);
COMMENT ON TYPE app.version_status IS
  'CANONICAL: Deliverable K §3. Where a version sits in the HUMAN WORKFLOW: '
  'draft -> review -> staging -> production -> archived. Deliverable A §3.2 wrote '
  'status=compiling and status=live while A §6 defined this same enum — two orthogonal '
  'concerns forced into one column. Compile progress lives in app.compile_state instead. '
  'These are lifecycle statuses, NOT infrastructure environments: the collision between '
  '"staging" the survey status and "staging" the deployment environment is unfortunate, and '
  'K §3 asks the UI to call this status "Review link" to avoid it.';

CREATE TYPE app.compile_state AS ENUM (
  'none', 'compiling', 'compiled', 'failed'
);
COMMENT ON TYPE app.compile_state IS
  'CANONICAL: Deliverable K §3 — none -> compiling -> compiled | failed. Whether a compiled '
  'artifact exists and is usable, which is a separate axis from where the version sits in '
  'review. K overrides Deliverable B §3, which spelled the members none/queued/compiling/'
  'succeeded/failed; K''s four are the canonical set and ''compiled'' (not ''succeeded'') is '
  'the terminal success value. Rules that depend on this being a separate column: a version '
  'may only enter staging or production with compile_state = ''compiled''; a recompile of a '
  'production version does not change status, it produces a new artifact hash and '
  'atomically repoints artifact_hash (rollback repoints it back); and compile_state = '
  '''failed'' never changes status, so a FAILED PUBLISH ALWAYS LEAVES THE PREVIOUSLY LIVE '
  'ARTIFACT SERVING (Deliverable A §7). Collapsing these two axes back into one column '
  'breaks that last guarantee. On the missing ''queued'': queue depth is a property of '
  'ops.jobs (0003), not of the version. A version whose compile job is enqueued but not yet '
  'started is compile_state=''none'' with a live ops.jobs row. One fact, one home.';
