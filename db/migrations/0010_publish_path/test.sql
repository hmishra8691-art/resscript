-- 0010_publish_path/test.sql — pgTAP. The three defects, each asserted at the point where it
-- used to be fatal.
--
-- What this file has to prove:
--   * DEFECT 1, THE ENQUEUE WRAPPER. app.enqueue_job is callable by `authoring` and by NOTHING
--     ELSE — not by runtime_writer, not by analytics_reader — and it DERIVES org_id from
--     app.current_org() and created_by from app.current_user_id() rather than taking either as a
--     parameter, which is asserted three ways: from the enqueued row, from the catalog
--     (proargnames mentions no org), and from the tenant boundary (a forged active_org_id, a
--     foreign version and a foreign project are each refused). Plus the two facts that make the
--     wrapper necessary at all rather than merely tidy: `authoring` has no USAGE on schema ops
--     and holds EXECUTE on no function there, so GRANT EXECUTE on ops.enqueue_job is inert.
--   * DEFECT 2, THE REDIRECT STORE. content.redirects is RLS enabled AND forced, carries
--     content.tg_draft_only, refuses a redirect for a disposition K §2 says needs none, refuses
--     the two malformed scope/custom-key shapes by name, is invisible across a tenant boundary
--     and under a forged active_org_id — and SURVIVES content.clone_version WITH ITS ROWS
--     INTACT, which is the assertion that exists because a content table missing from that
--     function's enumerated list loses its rows on every publish-then-edit with no error at all.
--   * DEFECT 3, THE ITEM-ID PREFIX. Every content.question_items.id the constraint accepts is
--     `opt_`-prefixed — including the matrix ROW the fixture seeds — a `row_`-prefixed insert is
--     rejected BY CONSTRAINT NAME, and the constraint is VALIDATED rather than merely NOT VALID,
--     which is the difference between protecting future rows and protecting all of them.
--   * the three standing catalog guards, on every migration forever.
--
-- A note on what is NOT asserted here, because a reader will look for it: there is no assertion
-- that a survey compiles. The static gate is TypeScript (packages/compiler) and its behaviour
-- belongs to apps/worker's suite, which is where "a survey with redirect rows publishes and one
-- without draws CMP-0300" is pinned. What this file owns is the shape of the storage those tests
-- read through.
BEGIN;
SELECT plan(64);

-- pgTAP lives in schema `public`, hardened by 0001's REVOKE ALL ... FROM PUBLIC. Granted inside
-- this transaction, which is rolled back, exactly as 0004's, 0007's, 0008's and 0009's suites do.
GRANT USAGE ON SCHEMA public TO authoring, runtime_writer, analytics_reader;

SELECT set_config('rs.ids', ops.test_seed_two_orgs()::text, true);
SELECT set_config('rs.ids',
  (current_setting('rs.ids')::jsonb
     || ops.test_seed_content(current_setting('rs.ids')::jsonb))::text, true);

CREATE FUNCTION pg_temp.tid(k text) RETURNS text LANGUAGE sql STABLE AS
$$ SELECT current_setting('rs.ids', true)::jsonb ->> k $$;

CREATE FUNCTION pg_temp.act_as(p_user uuid, p_org text, p_role text DEFAULT 'authoring')
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', p_user, 'role', p_role,
                      'app_metadata', json_build_object('active_org_id', p_org))::text,
    true);
  EXECUTE format('SET LOCAL ROLE %I', p_role);
END $$;

-- ---------------------------------------------------------------------------
-- 1. Shape
-- ---------------------------------------------------------------------------
SELECT has_function('app', 'enqueue_job',
  ARRAY['text', 'jsonb', 'text', 'app.ulid', 'app.ulid', 'integer', 'integer'],
  'app.enqueue_job exists with the signature apps/studio''s JobRepo.enqueue already calls — '
  'and note what is NOT in the argument list: no org_id and no created_by');
SELECT is_definer('app', 'enqueue_job',
  ARRAY['text', 'jsonb', 'text', 'app.ulid', 'app.ulid', 'integer', 'integer'],
  'and it is SECURITY DEFINER, which is the only way a caller with no USAGE on schema ops can '
  'reach ops.enqueue_job at all — the same argument 0005 §2 makes for app.get_job');

SELECT has_table('content', 'redirects',
  'content.redirects exists (C §9, flattened per Deliverable B): until it did, CMP-0300 blocked '
  'EVERY survey, because C §6''s synthesized flow always reaches COMPLETE and a COMPLETE with '
  'no redirect is a publish-blocking error');
SELECT col_is_pk('content', 'redirects',
  ARRAY['survey_version_id', 'scope', 'scope_key', 'disposition', 'custom_key'],
  'the primary key IS the uniqueness rule, so "two templates for one disposition in one scope" '
  'is not expressible — there is no last-one-wins for a decision about where a respondent''s '
  'browser goes. No surrogate `id` column: this is a mapping keyed by its own coordinates, like '
  'content.languages and content.i18n_strings, not an entity anything references');
SELECT col_type_is('content', 'redirects', 'survey_version_id', 'app.ulid',
  'scoped to a survey VERSION and never a survey (B §0 ground rule 3, ADR-002): where a '
  'completed respondent is sent freezes with the version, so retargeting a new vendor in a '
  'draft cannot change where the wave already in field sends people');
SELECT hasnt_column('content', 'redirects', 'allow_pii',
  'Deliverable B''s `allow_pii` is deliberately NOT here. C §9 blocks a pii variable in a '
  'template "unless explicitly allowed" and what "allowed" is scoped to is decided by the vendor '
  'work in P2-10 — so the column would be a guess that has to be migrated, which is the '
  'argument 0008 made for on_unknown and 0009 for quota_policy. Adding it later is one '
  'non-rewriting ADD COLUMN, defaulting false, which is the safe direction');
SELECT has_type('content', 'redirect_scope', 'content.redirect_scope exists');
SELECT enum_has_labels('content', 'redirect_scope', ARRAY['default', 'vendor', 'language'],
  'C §9''s three arms and no more: `default`, `by_vendor`, `by_language`. A closed structural '
  'discriminator, which is why this one is an ENUM while `disposition` — which mirrors a '
  'Deliverable K registry living in schema runtime — is a CHECK over text');
SELECT fk_ok('content', 'redirects', ARRAY['org_id', 'survey_version_id'],
             'app', 'survey_versions', ARRAY['org_id', 'id'],
  'ADR-009''s composite FK, as on every other content table: the denormalized org_id is kept '
  'honest by the key rather than by the writer being careful');
SELECT has_trigger('content', 'redirects', 'redirects_draft_only',
  'content.tg_draft_only is attached (ADR-002, B §12.1) — the layer that catches a write '
  'reaching the table by a route the policies do not cover');
SELECT has_trigger('content', 'redirects', 'redirects_touch',
  'and updated_at is maintained by trigger, not by whoever remembers');
SELECT is_empty($$
  SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'content' AND c.relname = 'redirects'
     AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity)
$$, 'RLS is ENABLED and FORCED, asserted from pg_class as well as through '
    'ops.tables_without_rls() below: ENABLE alone leaves the table OWNER exempt, which every '
    'migration runs as, so the isolation suite would pass while production leaked');
SELECT policies_are('content', 'redirects',
  ARRAY['redirects_select', 'redirects_insert', 'redirects_update', 'redirects_delete'],
  'four policies, one per command, never FOR ALL — a read predicate that doubles as a write '
  'predicate is a hole nobody reviews (0007''s shape, unchanged)');
SELECT policy_cmd_is('content', 'redirects', 'redirects_select', 'SELECT',
  'and the reviewer-floor policy is the SELECT one specifically');

SELECT is(
  (SELECT convalidated FROM pg_constraint
    WHERE conrelid = 'content.question_items'::regclass AND conname = 'qitems_id_prefix'),
  true,
  'qitems_id_prefix exists and is VALIDATED, not merely NOT VALID. The distinction is the whole '
  'point: NOT VALID protects rows written from now on, and this constraint''s job is to say that '
  'NO row in the table has a kind-dependent prefix. Added NOT VALID and then validated in a '
  'second statement, which is B §14''s expand pattern — brief ACCESS EXCLUSIVE, then a scan '
  'under SHARE UPDATE EXCLUSIVE that blocks neither readers nor writers');

-- ---------------------------------------------------------------------------
-- 2. DEFECT 1: the write side of the plane boundary
-- ---------------------------------------------------------------------------
-- First, the two facts that make this wrapper necessary rather than convenient. Phrased over the
-- catalog rather than against ops.enqueue_job's signature, per db/README.md: "re-signing the
-- function silently changed what that line tested."
SELECT is(has_schema_privilege('authoring', 'ops', 'USAGE'), false,
  '`authoring` STILL holds no USAGE on schema ops (Deliverable B §0: ops is service-role only), '
  'which is the fact that made this migration necessary — EXECUTE on a function is not '
  'sufficient to call it, so GRANT EXECUTE ON FUNCTION ops.enqueue_job would have been INERT '
  'and the studio''s first publish click would have got "permission denied for schema ops"');
SELECT is_empty($$
  SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'ops' AND has_function_privilege('authoring', p.oid, 'EXECUTE')
$$, 'and it holds EXECUTE on NO function in schema ops — including ops.enqueue_job. 0010 did '
    'not widen the plane boundary to fix the enqueue path, it put a wrapper on the near side of '
    'it, exactly as 0005 §2 did for the read path');

SELECT pg_temp.act_as(pg_temp.tid('user_a')::uuid, pg_temp.tid('org_a'));
SELECT lives_ok($$
  SELECT set_config('rs.job',
    (SELECT id::text FROM app.enqueue_job(
       p_kind              => 'compile',
       p_payload           => '{"survey_version_id":"x","target_status":"staging"}'::jsonb,
       p_idempotency_key   => 'publish:ver_a3:1',
       p_survey_version_id => (current_setting('rs.ids')::jsonb ->> 'ver_a_content_draft')::app.ulid)),
    true)
$$, 'AN ORG-WIDE OWNER CAN QUEUE ITS OWN PUBLISH JOB. This is the defect: the studio''s publish '
    'route could not do this at all, so nothing downstream of it — the compile worker, 0009''s '
    'publish transaction, the token — was reachable from a click');
SELECT matches(current_setting('rs.job'), '^job_[0-7][0-9A-HJKMNP-TV-Z]{25}$',
  'and it returned a real ops.jobs id in the app.ulid domain');

SELECT results_eq($$
  SELECT id::text, created FROM app.enqueue_job(
    p_kind            => 'compile',
    p_payload         => '{"survey_version_id":"x","target_status":"staging"}'::jsonb,
    p_idempotency_key => 'publish:ver_a3:1')
$$, $$ VALUES (current_setting('rs.job'), false) $$,
  'DOUBLE-CLICKING PUBLISH PRODUCES ONE JOB ROW (roadmap M0.4 acceptance): the same '
  'idempotency key returns the EXISTING id with created = false, which the API maps to 200 '
  'rather than 201. Delegated to ops.enqueue_job rather than reimplemented, so 0003''s '
  'jobs_idem_key contract has exactly one implementation — the copy that is wrong is always the '
  'one the API calls');

SELECT results_eq($$
  SELECT org_id::text, kind, status FROM app.get_job(current_setting('rs.job')::app.ulid)
$$, $$ VALUES (current_setting('rs.ids')::jsonb ->> 'org_a', 'compile', 'queued') $$,
  'THE ENQUEUED ROW CARRIES THE CALLER''S OWN ORG, derived from app.current_org() inside the '
  'definer and not accepted as a parameter. That matters beyond tidiness: 0009''s calling '
  'convention has the compile worker assume the enqueuing user''s identity from ops.jobs.org_id '
  'and created_by before calling app.publish_version, so those two columns ARE the publish '
  'capability check''s input — a parameter for either would be a way to publish into another '
  'tenant with an audit row naming a human who never clicked anything');

RESET ROLE;   -- ops.jobs is unreachable from `authoring`; this read is the owner's
SELECT is(
  (SELECT created_by FROM ops.jobs WHERE id = current_setting('rs.job')::app.ulid),
  pg_temp.tid('user_a')::uuid,
  'and created_by is the AUTHENTICATED USER, derived from app.current_user_id(). A service-role '
  'enqueue would leave this NULL, and 0009''s publish transaction then refuses the job with '
  'insufficient_privilege — correctly, since "the system published this" is not an answer '
  'anyone accepts six months later. So the service-role shortcut does not merely skip a check; '
  'it produces a job that can never succeed');
SELECT is(
  (SELECT survey_version_id::text FROM ops.jobs
    WHERE id = current_setting('rs.job')::app.ulid),
  pg_temp.tid('ver_a_content_draft'),
  'the optional version reference is recorded as passed — it is scoped by app.can_see_version '
  'inside the definer rather than dropped, so the studio''s job list can render the version the '
  'job is about');

-- --- the floor, and the tenant boundary ------------------------------------
SELECT pg_temp.act_as(pg_temp.tid('user_a2')::uuid, pg_temp.tid('org_a'));
SELECT throws_ok($$ SELECT id FROM app.enqueue_job(p_kind => 'compile') $$, '42501', NULL,
  'a REVIEWER (K §1 rank 20) cannot enqueue: the floor is `analyst` (30), the weakest role that '
  'legitimately queues background work — an analyst runs exports. The floor is deliberately NOT '
  'a per-kind capability check, because 0003 made ops.jobs.kind free text on purpose ("job '
  'kinds are an implementation detail of apps/worker") and a kind -> capability map here would '
  'be a second registry that can disagree with apps/worker''s. The real authorization is one '
  'layer down: app.publish_version re-checks project_manager for production');

SELECT pg_temp.act_as(pg_temp.tid('user_c')::uuid, pg_temp.tid('org_a'));
SELECT throws_ok($$ SELECT id FROM app.enqueue_job(p_kind => 'compile') $$, '42501', NULL,
  'a user with NO MEMBERSHIP ROW in the org it claims is refused. Note it is one message for '
  '"no active org", "not authenticated" and "below the floor", for the reason 0009''s '
  'publish_version gives: distinguishing them is an oracle and no caller can act on the '
  'distinction');

SELECT pg_temp.act_as(pg_temp.tid('user_a')::uuid, pg_temp.tid('org_b'));
SELECT throws_ok($$ SELECT id FROM app.enqueue_job(p_kind => 'compile') $$, '42501', NULL,
  'FORGING active_org_id to org B does not help: app.has_role() reads app.org_members, finds no '
  'row, and returns false (ADR-009, P1-01 acceptance). This is the assertion that says org_id '
  'is derived from a MEMBERSHIP-CHECKED claim rather than from the claim itself');

SELECT pg_temp.act_as(pg_temp.tid('user_a')::uuid, pg_temp.tid('org_a'));
SELECT throws_ok($$
  SELECT id FROM app.enqueue_job(
    p_kind              => 'compile',
    p_survey_version_id => (current_setting('rs.ids')::jsonb ->> 'ver_b_draft')::app.ulid)
$$, '42501', NULL,
  'ORG A''S OWNER CANNOT FILE A JOB AGAINST ORG B''S VERSION. The job''s own org_id would still '
  'have been org A, so nothing would ever have been published — but ops.jobs would hold a '
  'cross-tenant reference and the studio''s job list would render a version its caller may not '
  'read. Checked with app.can_see_version rather than by a foreign key, because ops.jobs '
  'deliberately has none: B §10.1 keeps the queue readable after the survey it referenced is '
  'gone');
SELECT throws_ok($$
  SELECT id FROM app.enqueue_job(
    p_kind       => 'export',
    p_project_id => (current_setting('rs.ids')::jsonb ->> 'prj_b')::app.ulid)
$$, '42501', NULL,
  'and the same for a project in another org, through app.can_see_project — which is also what '
  'makes K §1''s client inversion apply here without being restated');

-- --- the roles that must NOT reach it -------------------------------------
RESET ROLE;
SET LOCAL ROLE runtime_writer;
SELECT throws_ok($$ SELECT id FROM app.enqueue_job(p_kind => 'compile') $$, '42501', NULL,
  'runtime_writer CANNOT EXECUTE app.enqueue_job. The data plane creating control-plane work is '
  'the shape of risk R3: its capability surface is two RPC signatures in schema runtime, and a '
  'leaked edge credential must not be able to queue a compile');
RESET ROLE;
SET LOCAL ROLE analytics_reader;
SELECT throws_ok($$ SELECT id FROM app.enqueue_job(p_kind => 'export') $$, '42501', NULL,
  'nor may analytics_reader, which reads generated flat tables in schema export and has no '
  'business in the queue either');
RESET ROLE;

SELECT is_empty($$
  SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'app' AND p.proname = 'enqueue_job'
     AND EXISTS (SELECT 1 FROM unnest(coalesce(p.proargnames, '{}')) an WHERE an ~ 'org')
$$, 'THE CATALOG FORM: app.enqueue_job accepts no argument whose name mentions an org. This is '
    'the discipline 0009 asserts for schema runtime (B §2: "no RPC takes an org_id, because a '
    'cross-tenant request is then unphraseable rather than merely unauthorized") applied to the '
    'control-plane write path, and it fails by name if somebody adds p_org_id "for the admin '
    'console"');
SELECT is_empty($$
  SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'app' AND p.proname = 'enqueue_job'
     AND EXISTS (SELECT 1 FROM unnest(coalesce(p.proargnames, '{}')) an
                  WHERE an ~ 'created_by' OR an ~ 'user')
$$, 'and none whose name mentions the creating user, for the same reason 0005 gave when it '
    'DROPPED p_created_by from ops.enqueue_job: "a nullable who-did-this that can be spoofed by '
    'the caller is worse than one derived from the session"');

-- ---------------------------------------------------------------------------
-- 3. DEFECT 2: the redirect store
-- ---------------------------------------------------------------------------
SELECT pg_temp.act_as(pg_temp.tid('user_a')::uuid, pg_temp.tid('org_a'));

SELECT results_eq($$ SELECT count(*)::int FROM content.redirects $$, ARRAY[4],
  'org A sees exactly its own four redirect rows — two dispositions in each of its two seeded '
  'versions. Non-empty on purpose: 0007 made the same point about content.question_cells, that '
  'a cross-tenant probe over an EMPTY table passes vacuously and the table''s clone_version '
  'branch would never be executed by any test');
SELECT results_eq($$
  SELECT scope::text, scope_key, disposition, custom_key
    FROM content.redirects
   WHERE survey_version_id = current_setting('rs.ids')::jsonb ->> 'ver_a_content_draft'
   ORDER BY disposition
$$, $$ VALUES ('default', '', 'COMPLETE', ''), ('default', '', 'SCREENOUT', '') $$,
  'and they are C §9''s default-scope map: disposition -> template, with the empty scope key '
  'and empty custom key the two biconditional CHECKs require of a default row');

SELECT lives_ok($$
  INSERT INTO content.redirects
    (survey_version_id, scope, scope_key, disposition, url_template, org_id)
  VALUES ((current_setting('rs.ids')::jsonb ->> 'ver_a_content_draft')::app.ulid,
          'vendor', 'lucid', 'COMPLETE', 'https://lucid.example/c?rid={{VENDOR_PID}}',
          (current_setting('rs.ids')::jsonb ->> 'org_a')::app.ulid)
$$, 'a PROGRAMMER-floor write adds C §9''s by_vendor override for the same disposition: the '
    'primary key is (version, scope, scope key, disposition, custom key), so a vendor-specific '
    'COMPLETE coexists with the default one rather than colliding with it');
SELECT lives_ok($$
  INSERT INTO content.redirects
    (survey_version_id, scope, scope_key, disposition, custom_key, url_template, org_id)
  VALUES ((current_setting('rs.ids')::jsonb ->> 'ver_a_content_draft')::app.ulid,
          'default', '', 'CUSTOM', 'over_quota_soft',
          'https://vendor.example/oq', (current_setting('rs.ids')::jsonb ->> 'org_a')::app.ulid)
$$, 'and C §9''s CUSTOM sub-map is a row whose custom_key is the TerminationNode.custom_key — '
    'part of the primary key, which is what makes "one template per named termination" a '
    'database guarantee instead of a client-side merge');

SELECT throws_like($$
  INSERT INTO content.redirects
    (survey_version_id, scope, scope_key, disposition, url_template, org_id)
  VALUES ((current_setting('rs.ids')::jsonb ->> 'ver_a_content_draft')::app.ulid,
          'default', '', 'ABANDONED', 'https://vendor.example/a',
          (current_setting('rs.ids')::jsonb ->> 'org_a')::app.ulid)
$$, '%redirects_disposition_registry%',
  'A REDIRECT FOR ABANDONED IS UNSTORABLE, rejected by name. Deliverable K §2: ABANDONED and '
  'TIMED_OUT are inferred server-side by a sweeper and there is NOBODY LEFT TO REDIRECT, which '
  'is exactly why C §17''s "termination with no configured redirect" compile error excludes them '
  'and why runtime.disposition_requires_redirect() exists. Configuration this platform cannot '
  'honour should not be storable');
SELECT throws_like($$
  INSERT INTO content.redirects
    (survey_version_id, scope, scope_key, disposition, url_template, org_id)
  VALUES ((current_setting('rs.ids')::jsonb ->> 'ver_a_content_draft')::app.ulid,
          'vendor', '', 'QUALITY', 'https://vendor.example/q',
          (current_setting('rs.ids')::jsonb ->> 'org_a')::app.ulid)
$$, '%redirects_scope_key_shape%',
  'a VENDOR-scoped row with no vendor ref is rejected by name. Stated as a biconditional rather '
  'than a null check, so the mirror-image mistake is caught too: a `default` row carrying a '
  'vendor ref is a redirect that silently never matches anything, which is the worst kind of '
  'misconfiguration because it looks configured');
SELECT throws_like($$
  INSERT INTO content.redirects
    (survey_version_id, scope, scope_key, disposition, url_template, org_id)
  VALUES ((current_setting('rs.ids')::jsonb ->> 'ver_a_content_draft')::app.ulid,
          'default', '', 'CUSTOM', 'https://vendor.example/x',
          (current_setting('rs.ids')::jsonb ->> 'org_a')::app.ulid)
$$, '%redirects_custom_key_shape%',
  'and a CUSTOM redirect with no custom_key is rejected by name: every CUSTOM row in a scope '
  'would otherwise collide on the primary key, so the failure would have read as a duplicate '
  'rather than as a missing key');
SELECT throws_like($$
  INSERT INTO content.redirects
    (survey_version_id, scope, scope_key, disposition, url_template, org_id)
  VALUES ((current_setting('rs.ids')::jsonb ->> 'ver_a_content_draft')::app.ulid,
          'language', 'de', 'COMPLETE', '   ',
          (current_setting('rs.ids')::jsonb ->> 'org_a')::app.ulid)
$$, '%redirects_template_nonempty%',
  'a whitespace template is rejected: a row that exists and names nowhere is WORSE than a '
  'missing row, because CMP-0300 would pass and the respondent would be sent to the empty '
  'string');
SELECT throws_ok($$
  INSERT INTO content.redirects
    (survey_version_id, scope, scope_key, disposition, url_template, org_id)
  VALUES ((current_setting('rs.ids')::jsonb ->> 'ver_a_content_draft')::app.ulid,
          'default', '', 'COMPLETE', 'https://elsewhere.example/c',
          (current_setting('rs.ids')::jsonb ->> 'org_a')::app.ulid)
$$, '23505', NULL,
  'and a SECOND default COMPLETE for one version is refused by the primary key. Two templates '
  'for one disposition is not "last one wins"; it is a survey whose vendor callback depends on '
  'row order');

-- --- ADR-002, in both layers ----------------------------------------------
SELECT results_eq($$
  WITH u AS (
    UPDATE content.redirects SET url_template = 'https://pwned.example/'
     WHERE survey_version_id = current_setting('rs.ids')::jsonb ->> 'ver_a_content_frozen'
    RETURNING 1)
  SELECT count(*)::int FROM u
$$, ARRAY[0],
  'retargeting a FROZEN version''s redirects updates ZERO ROWS through the policy '
  '(app.version_is_draft in both USING and WITH CHECK). ADR-002: the wave in field keeps '
  'sending respondents where it was published to send them, and an editor bug surfaces as "0 '
  'rows updated" rather than as a live redirect change nobody reviewed');
RESET ROLE;
SELECT throws_ok($$
  UPDATE content.redirects SET url_template = 'https://pwned.example/'
   WHERE survey_version_id = current_setting('rs.ids')::jsonb ->> 'ver_a_content_frozen'
$$, '23514', NULL,
  'and as the OWNER — who bypasses RLS altogether — the same write RAISES from '
  'content.tg_draft_only. Two layers, because the policy protects the application and the '
  'trigger protects against the 2 a.m. service-role script (B §12.1)');

-- --- the tenant boundary ---------------------------------------------------
SELECT pg_temp.act_as(pg_temp.tid('user_a')::uuid, pg_temp.tid('org_a'));
SELECT is_empty($$
  SELECT 1 FROM content.redirects WHERE org_id <> app.current_org()
$$, 'org A reads NONE of org B''s redirect rows — and the probe is not vacuous, because org B '
    'has four of them');
SELECT pg_temp.act_as(pg_temp.tid('user_a')::uuid, pg_temp.tid('org_b'));
SELECT is_empty($$ SELECT 1 FROM content.redirects $$,
  'and a FORGED active_org_id yields zero rows rather than an error (P1-01 acceptance): a '
  'cross-tenant probe must not be able to confirm that org B has redirects at all');
SELECT pg_temp.act_as(pg_temp.tid('user_b2')::uuid, pg_temp.tid('org_b'));
SELECT results_eq($$ SELECT count(*)::int FROM content.redirects $$, ARRAY[4],
  'while a programmer scoped to org B''s one project reads org B''s four rows: '
  'app.can_see_version resolves version -> survey -> project, so K §1''s project scoping '
  'applies to redirects without being restated in the policy');

-- ---------------------------------------------------------------------------
-- 4. DEFECT 2, cont.: the clone round trip
-- ---------------------------------------------------------------------------
-- THE ASSERTION THIS TABLE EXISTS TO SURVIVE. content.clone_version enumerates its tables by
-- name, and ADR-002 makes that clone the ONLY way to edit a published survey. A content table
-- missing from the list loses its rows with no error, because dropping rows nobody selected is
-- not an error — so the symptom would be: publish a survey, click Edit, and the next publish of
-- that draft fails CMP-0300 on a survey that was live an hour ago, with nothing anywhere saying
-- that clicking Edit is what deleted the configuration.
SELECT pg_temp.act_as(pg_temp.tid('user_a')::uuid, pg_temp.tid('org_a'));
SELECT is(
  content.clone_version(pg_temp.tid('ver_a_content_frozen')::app.ulid,
                        pg_temp.tid('ver_a_clone_target')::app.ulid) -> 'redirects',
  '2'::jsonb,
  'content.clone_version() REPORTS redirects in its count map. The map is the only mechanical '
  'protection there is here — the linter cannot see the omission and neither can the catalog '
  'assertions — so a future content table left out of the enumerated list shows up as a missing '
  'key in 0007''s, 0008''s and this suite''s comparisons');
SELECT results_eq($$
  SELECT scope::text, scope_key, disposition, custom_key, url_template, org_id::text
    FROM content.redirects
   WHERE survey_version_id = current_setting('rs.ids')::jsonb ->> 'ver_a_clone_target'
   ORDER BY disposition
$$, $$
  SELECT scope::text, scope_key, disposition, custom_key, url_template, org_id::text
    FROM content.redirects
   WHERE survey_version_id = current_setting('rs.ids')::jsonb ->> 'ver_a_content_frozen'
   ORDER BY disposition
$$, 'and THE ROWS ARRIVE INTACT, template for template. No remapping: a redirect row''s key is '
    '(version, scope, scope_key, disposition, custom_key) and only the version half changes, '
    'which is B §4.1''s stable-id decision paying out on one more table');
SELECT is_empty($$
  SELECT 1 FROM content.redirects
   WHERE survey_version_id = current_setting('rs.ids')::jsonb ->> 'ver_a_clone_target'
     AND org_id <> current_setting('rs.ids')::jsonb ->> 'org_a'
$$, 'no redirect row belonging to another org landed in org A''s draft');

-- ---------------------------------------------------------------------------
-- 5. DEFECT 3: one prefix for all three item kinds
-- ---------------------------------------------------------------------------
RESET ROLE;
SELECT is_empty($$
  SELECT id::text FROM content.question_items WHERE id NOT LIKE 'opt\_%'
$$, 'EVERY question_items.id IN THE DATABASE IS `opt_`-PREFIXED, read as the OWNER so the sweep '
    'covers both tenants, every seeded version and the clone made above — matrix rows included. '
    'Deliverable C §5.1: QuestionItem is one shape for option, row and column, and '
    'packages/schema brands all three Id<''opt''>, so asId(''opt'', …) used to throw on a '
    'legitimately stored row id and NO MATRIX QUESTION COULD BE PUBLISHED');
SELECT isnt_empty($$
  SELECT id::text FROM content.question_items WHERE item_kind = 'row'
$$, 'and the sweep above is not vacuous: the fixture really does seed matrix rows, which is what '
    'made this defect reachable in the first place');
-- Version-qualified, because the id is the SAME in every version that contains the item — which
-- is B §4.1's stable-id decision and the reason an unqualified lookup here returns three rows.
SELECT is(
  (SELECT item_kind::text FROM content.question_items
    WHERE id = pg_temp.tid('row_a')::app.ulid
      AND survey_version_id = pg_temp.tid('ver_a_content_draft')::app.ulid),
  'row',
  'THE KIND STILL LIVES IN item_kind, which is where a discriminator belongs. B §0''s "every id '
  'is self-describing" is satisfied by `opt_` describing "an item of a question": 0007''s '
  'alternative made one concept wear three names in a table whose entire premise (B §4.2) is '
  'that rows and columns have the same shape as options, and it cost the ability to publish a '
  'matrix');

SELECT pg_temp.act_as(pg_temp.tid('user_a')::uuid, pg_temp.tid('org_a'));
SELECT throws_like($$
  INSERT INTO content.question_items
    (survey_version_id, id, org_id, question_id, item_kind, ref, code, sort_key)
  VALUES ((current_setting('rs.ids')::jsonb ->> 'ver_a_content_draft')::app.ulid,
          'row_0AZZ000000000000000000000A',
          (current_setting('rs.ids')::jsonb ->> 'org_a')::app.ulid,
          (current_setting('rs.ids')::jsonb ->> 'q1_a')::app.ulid, 'row', 'rZ', 99, '9000')
$$, '%qitems_id_prefix%',
  'A `row_`-PREFIXED ITEM ID IS REJECTED BY CONSTRAINT NAME. Named, not merely refused, because '
  'the writer that hits this is a client minting ids by hand or a fixture copied from 0007, and '
  '"violates check constraint qitems_id_prefix" is a sentence that leads straight to the '
  'constraint comment and to C §5.1');
SELECT throws_like($$
  INSERT INTO content.question_items
    (survey_version_id, id, org_id, question_id, item_kind, ref, code, sort_key)
  VALUES ((current_setting('rs.ids')::jsonb ->> 'ver_a_content_draft')::app.ulid,
          'col_0AZZ000000000000000000000B',
          (current_setting('rs.ids')::jsonb ->> 'org_a')::app.ulid,
          (current_setting('rs.ids')::jsonb ->> 'q1_a')::app.ulid, 'column', 'cZ', 99, '9100')
$$, '%qitems_id_prefix%',
  'and so is a `col_` one. Both spellings appeared in 0007 — in its column comment, its fixture '
  'and its own test.sql — which is why both are asserted rather than one standing for the pair');
SELECT lives_ok($$
  INSERT INTO content.question_items
    (survey_version_id, id, org_id, question_id, item_kind, ref, code, sort_key)
  VALUES ((current_setting('rs.ids')::jsonb ->> 'ver_a_content_draft')::app.ulid,
          'opt_0AZZ000000000000000000000C',
          (current_setting('rs.ids')::jsonb ->> 'org_a')::app.ulid,
          (current_setting('rs.ids')::jsonb ->> 'q1_a')::app.ulid, 'row', 'rY', 98, '9200')
$$, 'while an `opt_`-prefixed id for a ROW is accepted, which is the whole shape of the fix: the '
    'id says "item of a question" and item_kind says which axis');
SELECT is(
  (SELECT item_kind::text FROM content.question_items
    WHERE id = 'opt_0AZZ000000000000000000000C'),
  'row', 'and it really is stored as a row');

-- The other half of C §5.1, re-asserted here because the prefix change must not have widened
-- anything: an item ref and an item code are unique per (question, KIND), so a row `r1` and a
-- column `r1` still coexist even though their ids now share a prefix.
SELECT lives_ok($$
  INSERT INTO content.question_items
    (survey_version_id, id, org_id, question_id, item_kind, ref, code, sort_key)
  VALUES ((current_setting('rs.ids')::jsonb ->> 'ver_a_content_draft')::app.ulid,
          'opt_0AZY000000000000000000000A',
          (current_setting('rs.ids')::jsonb ->> 'org_a')::app.ulid,
          (current_setting('rs.ids')::jsonb ->> 'q1_a')::app.ulid, 'column', 'r1', 1, '9300')
$$, 'a COLUMN may still be `r1` with code 1 while a ROW of the same question already is: '
    'uniqueness is scoped by item_kind (qitems_ref_key, qitems_code_key), and collapsing the id '
    'prefixes did not collapse that scope');
SELECT throws_ok($$
  INSERT INTO content.question_items
    (survey_version_id, id, org_id, question_id, item_kind, ref, code, sort_key)
  VALUES ((current_setting('rs.ids')::jsonb ->> 'ver_a_content_draft')::app.ulid,
          'opt_0AZY000000000000000000000B',
          (current_setting('rs.ids')::jsonb ->> 'org_a')::app.ulid,
          (current_setting('rs.ids')::jsonb ->> 'q1_a')::app.ulid, 'row', 'r1', 7, '9400')
$$, '23505', NULL,
  'and two ROWS of one question still cannot share a ref, which is what stops "one prefix" from '
  'being read as "one namespace"');

-- ---------------------------------------------------------------------------
-- 6. The standing guards, after everything above has finished mutating
-- ---------------------------------------------------------------------------
RESET ROLE;
SELECT is_empty($$ SELECT ops.tables_without_rls() $$,
  'ops.tables_without_rls() is STILL EMPTY with content.redirects added — the ninth content '
  'table, and the one whose absence made every survey unpublishable');
SELECT is_empty($$ SELECT ops.content_tables_without_draft_trigger() $$,
  'ops.content_tables_without_draft_trigger() is still empty: content.redirects carries '
  'content.tg_draft_only, so a published version''s redirects are sealed by the same two layers '
  'as its questions. The only exempted table is still K §6''s global reserved namespace');
SELECT is_empty($$ SELECT ops.functions_executable_by_public() $$,
  'and nothing in the six schemas is executable by PUBLIC — one new function, one explicit '
  'REVOKE, because ALTER DEFAULT PRIVILEGES does not close PUBLIC EXECUTE (0006)');
SELECT is_empty($$
  SELECT n.nspname || '.' || p.proname
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname IN ('app','content','runtime','export','billing','ops')
     AND p.prosecdef
     AND NOT EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig, '{}')) c
                      WHERE c LIKE 'search\_path=%')
$$, 'every SECURITY DEFINER function still pins search_path, including app.enqueue_job: an '
    'unpinned one is a privilege-escalation primitive, because the caller controls which schema '
    'an unqualified name resolves in');
SELECT is_empty($$
  SELECT n.nspname || '.' || c.relname || ':' || a.privilege_type
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    CROSS JOIN LATERAL aclexplode(c.relacl) a
   WHERE n.nspname IN ('app','content','runtime')
     AND c.relkind IN ('r','p','v','m')
     AND c.relacl IS NOT NULL
     AND a.grantee IN ('runtime_writer'::regrole, 'analytics_reader'::regrole)
$$, 'and the two non-control-plane roles hold NO privilege on any table in app, content or '
    'runtime, content.redirects included: the runtime reads redirects out of the compiled '
    'artifact (C §17), never as rows, and the export plane has no business in them at all');
SELECT table_privs_are('content', 'redirects', 'authoring',
  ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
  '`authoring` holds exactly the four DML privileges on content.redirects and nothing more — '
  'every ROW decision is RLS''s (ADR-009), and the grant only decides who may ask');

SELECT * FROM finish();
ROLLBACK;
