-- 0002_registry_types/test.sql — pgTAP.
--
-- These assertions are the executable form of Deliverable K. K exists because four values
-- were independently defined in more than one document and three of the definitions
-- disagreed; the point of this file is that the disagreement can never come back silently.
-- In particular the role-rank ordering is asserted VALUE BY VALUE, all eight of them,
-- because the specific defect K caught was an INVERSION of two adjacent ranks — which a
-- test asserting "owner outranks viewer" would happily have passed.
BEGIN;
SELECT plan(46);

-- ---------------------------------------------------------------------------
-- K §1 — role hierarchy
-- ---------------------------------------------------------------------------
SELECT has_type('app', 'org_role', 'type app.org_role exists');
SELECT enum_has_labels('app', 'org_role',
  ARRAY['owner','admin','project_manager','programmer','analyst','reviewer','viewer','client'],
  'app.org_role has exactly K §1''s eight labels, in descending rank order');

SELECT is(app.role_rank('owner'),           70, 'role_rank(owner) = 70');
SELECT is(app.role_rank('admin'),           60, 'role_rank(admin) = 60');
SELECT is(app.role_rank('project_manager'), 50, 'role_rank(project_manager) = 50');
SELECT is(app.role_rank('programmer'),      40, 'role_rank(programmer) = 40');
SELECT is(app.role_rank('analyst'),         30, 'role_rank(analyst) = 30');
SELECT is(app.role_rank('reviewer'),        20, 'role_rank(reviewer) = 20');
SELECT is(app.role_rank('viewer'),          10, 'role_rank(viewer) = 10');
SELECT is(app.role_rank('client'),           5, 'role_rank(client) = 5');

-- THE defect Deliverable K was written to catch. Deliverable B ranked reviewer 30 above
-- analyst 20; Deliverable G ranked analyst above reviewer. Ship B's enum with G's policy
-- and a Reviewer — typically an external client contact — passes has_role('analyst') and
-- can export response data including open-ends.
SELECT ok(app.role_rank('analyst') > app.role_rank('reviewer'),
  'analyst OUTRANKS reviewer (K §1; Deliverable B had this inverted, and the inversion '
  'let an external reviewer export open-ends)');
SELECT ok(app.role_rank('client') < app.role_rank('viewer'),
  'client is the lowest rank (K §1)');
SELECT ok(app.role_rank('project_manager') > app.role_rank('programmer'),
  'project_manager outranks programmer by rank — which is exactly why custom-code '
  'authoring must NOT be a rank check (K §1)');

-- Enum ordering and rank ordering must agree, or two places in the codebase disagree
-- about who outranks whom depending on which comparison they happened to use.
SELECT is_empty($$
  WITH r AS (SELECT unnest(enum_range(NULL::app.org_role)) AS v),
  n AS (SELECT v, row_number() OVER (ORDER BY v) AS enum_pos,
               rank() OVER (ORDER BY app.role_rank(v) DESC) AS rank_pos FROM r)
  SELECT v::text FROM n WHERE enum_pos <> rank_pos
$$, 'native enum ordering agrees with app.role_rank() for every label');

-- No unranked label: role_rank has no ELSE branch on purpose, so an unranked role fails
-- closed instead of silently becoming a viewer.
SELECT is_empty($$
  SELECT v::text FROM unnest(enum_range(NULL::app.org_role)) v
   WHERE app.role_rank(v) IS NULL
$$, 'every app.org_role label has a rank');

SELECT volatility_is('app', 'role_rank', ARRAY['app.org_role'], 'immutable',
  'role_rank is IMMUTABLE so it is free inside a policy predicate');
SELECT matches(obj_description('app.org_role'::regtype, 'pg_type'), 'Deliverable K',
  'app.org_role''s comment names Deliverable K as its source of truth');

-- ---------------------------------------------------------------------------
-- K §2 — dispositions
-- ---------------------------------------------------------------------------
SELECT has_type('runtime', 'disposition', 'type runtime.disposition exists');
SELECT enum_has_labels('runtime', 'disposition',
  ARRAY['COMPLETE','SCREENOUT','QUOTA_FULL','QUALITY','DUPLICATE','FRAUD','TERMINATE',
        'CUSTOM','IN_PROGRESS','ABANDONED','TIMED_OUT'],
  'runtime.disposition has exactly K §2''s eleven values');

-- PARTIAL is removed on purpose: it conflated a session still open (IN_PROGRESS, holds a
-- quota reservation) with one that will never return (ABANDONED, must release it). A
-- single value cannot drive both behaviours.
SELECT ok(NOT ('PARTIAL' = ANY (enum_range(NULL::runtime.disposition)::text[])),
  'PARTIAL is absent (K §2): it conflated IN_PROGRESS with ABANDONED, and one holds a '
  'quota reservation while the other must release it');
SELECT ok('ABANDONED' = ANY (enum_range(NULL::runtime.disposition)::text[]),
  'ABANDONED is present (Deliverable H''s session.abandoned webhook depends on it)');
SELECT ok('TIMED_OUT' = ANY (enum_range(NULL::runtime.disposition)::text[]),
  'TIMED_OUT is present');

SELECT is(runtime.disposition_is_terminal('IN_PROGRESS'), false,
  'IN_PROGRESS is the only non-terminal disposition');
SELECT is(runtime.disposition_is_terminal('COMPLETE'), true, 'COMPLETE is terminal');
SELECT is(runtime.disposition_is_terminal('ABANDONED'), true, 'ABANDONED is terminal');
SELECT is_empty($$
  SELECT v::text FROM unnest(enum_range(NULL::runtime.disposition)) v
   WHERE v <> 'IN_PROGRESS' AND NOT runtime.disposition_is_terminal(v)
$$, 'every disposition except IN_PROGRESS is terminal (K §2 Terminal column)');

SELECT is(runtime.disposition_requires_redirect('SCREENOUT'), true,
  'a screenout must be redirected');
SELECT is(runtime.disposition_requires_redirect('ABANDONED'), false,
  'ABANDONED needs no redirect: it is inferred by a sweeper and nobody is there to '
  'redirect (K §2, and why Deliverable C §17''s compile error excludes it)');
SELECT is(runtime.disposition_requires_redirect('TIMED_OUT'), false,
  'TIMED_OUT needs no redirect, same reason');
SELECT is(runtime.disposition_requires_redirect('IN_PROGRESS'), false,
  'IN_PROGRESS needs no redirect: the session is still running');
SELECT results_eq($$
  SELECT v::text FROM unnest(enum_range(NULL::runtime.disposition)) v
   WHERE NOT runtime.disposition_requires_redirect(v) ORDER BY 1
$$, ARRAY['ABANDONED','IN_PROGRESS','TIMED_OUT'],
  'exactly three dispositions require no redirect (K §2)');

SELECT is(runtime.disposition_counts_toward_quota('COMPLETE'), true,
  'only COMPLETE commits a quota reservation');
SELECT results_eq($$
  SELECT v::text FROM unnest(enum_range(NULL::runtime.disposition)) v
   WHERE runtime.disposition_counts_toward_quota(v)
$$, ARRAY['COMPLETE'],
  'no disposition other than COMPLETE counts toward quota (ADR-008: everything else '
  'releases the reservation)');
SELECT matches(obj_description('runtime.disposition'::regtype, 'pg_type'), 'Deliverable K',
  'runtime.disposition''s comment names Deliverable K');

-- ---------------------------------------------------------------------------
-- K §3 — status and compile_state are two axes
-- ---------------------------------------------------------------------------
SELECT has_type('app', 'version_status', 'type app.version_status exists');
SELECT enum_has_labels('app', 'version_status',
  ARRAY['draft','review','staging','production','archived'],
  'app.version_status is K §3''s human-workflow axis');
SELECT has_type('app', 'compile_state', 'type app.compile_state exists');
SELECT enum_has_labels('app', 'compile_state',
  ARRAY['none','compiling','compiled','failed'],
  'app.compile_state is K §3''s four values — K overrides B §3''s '
  'none/queued/compiling/succeeded/failed');

-- The specific conflations K §3 forbids.
SELECT ok(NOT ('compiling' = ANY (enum_range(NULL::app.version_status)::text[])),
  'version_status has no ''compiling'': Deliverable A §3.2 wrote status=compiling, which '
  'conflates review position with artifact state (K §3)');
SELECT ok(NOT ('live' = ANY (enum_range(NULL::app.version_status)::text[])),
  'version_status has no ''live'': that is production plus compile_state=compiled');
SELECT ok(NOT ('succeeded' = ANY (enum_range(NULL::app.compile_state)::text[])),
  'compile_state uses K''s ''compiled'', not B''s ''succeeded''');
SELECT ok(NOT ('queued' = ANY (enum_range(NULL::app.compile_state)::text[])),
  'compile_state has no ''queued'': queue depth belongs to ops.jobs, not to the version');
SELECT matches(obj_description('app.compile_state'::regtype, 'pg_type'), 'Deliverable K',
  'app.compile_state''s comment names Deliverable K');
SELECT matches(obj_description('app.version_status'::regtype, 'pg_type'), 'Deliverable K',
  'app.version_status''s comment names Deliverable K');

-- ---------------------------------------------------------------------------
-- Structural guards still clear
-- ---------------------------------------------------------------------------
SELECT is_empty($$ SELECT ops.tables_without_rls() $$,
  '0002 added no table without RLS');
SELECT is_empty($$ SELECT ops.content_tables_without_draft_trigger() $$,
  '0002 added no content table without the draft trigger');

SELECT * FROM finish();
ROLLBACK;
