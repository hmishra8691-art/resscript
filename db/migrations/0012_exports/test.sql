-- 0012_exports/test.sql — pgTAP. The export record and the keyset read path.
--
-- What this file has to prove:
--   * app.exports exists with the P1-12 shape (status enum, pii_included NOT NULL, the
--     exp_ id prefix), RLS enabled AND forced, and exactly the three policies —
--     select/insert/update, no delete;
--   * THE PII GATE IS A CAPABILITY, NEVER RANK (K §1, security §7.2): an org OWNER without
--     a pii_access grant cannot request a PII export; the same owner WITH a grant can; a
--     reviewer WITH a grant still cannot, because the analyst role floor and the capability
--     are independent conditions and each is asserted failing alone;
--   * requested_by is pinned to the caller and only the requester advances the row — the
--     worker impersonates the requester (0009 §5), so this is also the worker's write path;
--   * tenant isolation: org B sees nothing, and inserting an export against another org's
--     version dies on the composite FK even with a forged org_id;
--   * app.export_response_page pages by keyset (session_id order, exclusive lower bound),
--     EXCLUDES is_test rows by default and includes them by flag (E §14.1), strips the
--     values of pii-flagged variables for a caller without a live grant and returns them to
--     a caller with one, refuses below the analyst floor by name, and answers "another
--     org's version" identically to "no such version".
BEGIN;
SELECT plan(38);

GRANT USAGE ON SCHEMA public TO authoring, runtime_writer, analytics_reader, runtime_rpc_owner;

SELECT set_config('rs.ids', ops.test_seed_two_orgs()::text, true);
CREATE FUNCTION pg_temp.tid(k text) RETURNS text LANGUAGE sql STABLE AS
$$ SELECT current_setting('rs.ids', true)::jsonb ->> k $$;

-- Impersonate a caller exactly as PostgREST does (0004's helper): claims GUC + SET LOCAL
-- ROLE. Anything that passes this is reachable by a real HTTP caller.
CREATE FUNCTION pg_temp.act_as(p_user uuid, p_org text, p_role text DEFAULT 'authoring')
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', p_user, 'role', p_role,
                      'app_metadata', json_build_object('active_org_id', p_org))::text,
    true);
  EXECUTE format('SET LOCAL ROLE %I', p_role);
END $$;

-- Crockford-safe tags only (no i/l/o/u): the app.ulid domain rejects those characters.
-- pg_temp.uid mirrors ops.test_ulid because the suite impersonates `authoring`, which has
-- no USAGE on schema ops — a deliberate posture 0006 asserts, not an inconvenience.
CREATE FUNCTION pg_temp.uid(p_prefix text, p_tag text) RETURNS app.ulid
LANGUAGE sql IMMUTABLE AS
$$ SELECT (p_prefix || '_0' || rpad(upper(p_tag), 25, '0'))::app.ulid $$;
CREATE FUNCTION pg_temp.sid(p_tag text) RETURNS app.ulid LANGUAGE sql IMMUTABLE AS
$$ SELECT ('ses_0' || rpad(upper(p_tag), 25, '0'))::app.ulid $$;

-- ---------------------------------------------------------------------------
-- 1. Structure
-- ---------------------------------------------------------------------------
SELECT has_table('app', 'exports', 'app.exports exists');
SELECT has_type('app', 'export_status', 'app.export_status exists');
SELECT enum_has_labels('app', 'export_status',
  ARRAY['pending', 'running', 'succeeded', 'failed'],
  'the export lifecycle is pending/running/succeeded/failed');
SELECT col_not_null('app', 'exports', 'pii_included',
  'pii_included is NOT NULL — "was PII in this file" must never be three-valued');
SELECT col_not_null('app', 'exports', 'include_test',
  'include_test is NOT NULL and defaults off (E 14.1)');

SELECT ok((SELECT c.relrowsecurity AND c.relforcerowsecurity
             FROM pg_class c WHERE c.oid = 'app.exports'::regclass),
  'app.exports has RLS enabled AND forced (ADR-009) — without FORCE the table owner is '
  'exempt from its own policies');
SELECT is((SELECT count(*) FROM pg_policy WHERE polrelid = 'app.exports'::regclass),
  3::bigint, 'exactly three policies — select, insert, update; DELETE has no consumer yet');

SELECT throws_ok(
  format('INSERT INTO app.exports (id, org_id, survey_version_id, requested_by) '
         'VALUES (%L, %L, %L, %L)',
         pg_temp.uid('xyz', 'bad'), pg_temp.tid('org_a'), pg_temp.tid('ver_a_frozen'),
         pg_temp.tid('user_a')),
  '23514', NULL, 'an export id must carry the exp_ prefix (B 0: ids are self-describing)');

-- ---------------------------------------------------------------------------
-- 2. Requesting an export: floor, capability, tenancy, lifecycle
-- ---------------------------------------------------------------------------
SELECT pg_temp.act_as(pg_temp.tid('user_a')::uuid, pg_temp.tid('org_a'));

SELECT lives_ok(
  format('INSERT INTO app.exports (id, org_id, survey_version_id, requested_by) '
         'VALUES (%L, %L, %L, %L)',
         pg_temp.uid('exp', 'a1'), pg_temp.tid('org_a'), pg_temp.tid('ver_a_frozen'),
         pg_temp.tid('user_a')),
  'an org owner (rank above the analyst floor) can request a coded, non-PII export');
SELECT is((SELECT count(*) FROM app.exports
            WHERE survey_version_id = pg_temp.tid('ver_a_frozen')::app.ulid),
  1::bigint, 'and the requester reads the row back');

-- user_a OUTRANKS everyone in org A and still has NO pii_access grant: rank must not leak
-- into the capability (K §1's whole point).
SELECT throws_ok(
  format('INSERT INTO app.exports (id, org_id, survey_version_id, requested_by, '
         'pii_included) VALUES (%L, %L, %L, %L, true)',
         pg_temp.uid('exp', 'ax'), pg_temp.tid('org_a'), pg_temp.tid('ver_a_frozen'),
         pg_temp.tid('user_a')),
  '42501', NULL,
  'an OWNER without a pii_access grant cannot request a PII export — capability, not rank');

-- Grant the capability (as the seeding superuser, the P1-13 grant flow not being under
-- test), and the same insert succeeds: the trigger tests the grant and nothing else.
RESET ROLE;
INSERT INTO app.capability_grants (org_id, user_id, capability, granted_by, justification)
VALUES (pg_temp.tid('org_a')::app.ulid, pg_temp.tid('user_a')::uuid, 'pii_access',
        pg_temp.tid('user_a')::uuid, 'export gate test grant, issued by 0012 test.sql');
SELECT pg_temp.act_as(pg_temp.tid('user_a')::uuid, pg_temp.tid('org_a'));
SELECT lives_ok(
  format('INSERT INTO app.exports (id, org_id, survey_version_id, requested_by, '
         'pii_included) VALUES (%L, %L, %L, %L, true)',
         pg_temp.uid('exp', 'a2'), pg_temp.tid('org_a'), pg_temp.tid('ver_a_frozen'),
         pg_temp.tid('user_a')),
  'the same owner WITH the grant can request a PII export');
SELECT is((SELECT count(*) FROM app.exports WHERE pii_included), 1::bigint,
  'pii_included is stored on the row — the audit answers from here, not from the grant');

-- user_a2 is a REVIEWER holding a pii_access grant (the seed): the capability alone does
-- not clear the analyst floor. The two conditions fail independently.
SELECT pg_temp.act_as(pg_temp.tid('user_a2')::uuid, pg_temp.tid('org_a'));
SELECT throws_ok(
  format('INSERT INTO app.exports (id, org_id, survey_version_id, requested_by) '
         'VALUES (%L, %L, %L, %L)',
         pg_temp.uid('exp', 'a3'), pg_temp.tid('org_a'), pg_temp.tid('ver_a_frozen'),
         pg_temp.tid('user_a2')),
  '42501', NULL, 'a reviewer cannot request an export at all — the floor is analyst');
SELECT is((SELECT count(*) FROM app.exports), 0::bigint,
  'and below the floor the export history is invisible too');

-- Tenancy.
SELECT pg_temp.act_as(pg_temp.tid('user_b')::uuid, pg_temp.tid('org_b'));
SELECT is((SELECT count(*) FROM app.exports), 0::bigint,
  'org B sees none of org A''s exports');
SELECT throws_ok(
  format('INSERT INTO app.exports (id, org_id, survey_version_id, requested_by) '
         'VALUES (%L, %L, %L, %L)',
         pg_temp.uid('exp', 'b1'), pg_temp.tid('org_b'), pg_temp.tid('ver_a_frozen'),
         pg_temp.tid('user_b')),
  '23503', NULL,
  'an export cannot reference another org''s version even with its own org_id — the '
  'composite FK (0004''s pattern) keeps the denormalized org_id honest');

-- The lifecycle write the worker performs, as the requester it impersonates.
SELECT pg_temp.act_as(pg_temp.tid('user_a')::uuid, pg_temp.tid('org_a'));
SELECT lives_ok(
  format('UPDATE app.exports SET status = %L, started_at = now() WHERE id = %L',
         'running', pg_temp.uid('exp', 'a1')),
  'the requester (= the worker acting as them) advances the lifecycle');
SELECT is((SELECT status::text FROM app.exports WHERE id = pg_temp.uid('exp', 'a1')),
  'running', 'and the transition stuck');

-- A DIFFERENT analyst in the same org: may read the history, may not touch the row.
RESET ROLE;
INSERT INTO app.org_members (org_id, user_id, role, project_ids)
VALUES (pg_temp.tid('org_a')::app.ulid, pg_temp.tid('user_c')::uuid, 'analyst', '{}');
SELECT pg_temp.act_as(pg_temp.tid('user_c')::uuid, pg_temp.tid('org_a'));
SELECT is((SELECT count(*) FROM app.exports), 2::bigint,
  'another org-A analyst reads the export history (who exported PII is org-visible '
  'at the analyst floor, security 7.1)');
SELECT lives_ok(
  format('UPDATE app.exports SET status = %L WHERE id = %L',
         'succeeded', pg_temp.uid('exp', 'a1')),
  'a non-requester''s UPDATE runs (RLS filters rather than raises)');
SELECT is((SELECT status::text FROM app.exports WHERE id = pg_temp.uid('exp', 'a1')),
  'running', '...and changed nothing — only the requester advances the row');

-- ---------------------------------------------------------------------------
-- 3. app.export_response_page: keyset, is_test, PII strip, tenancy
-- ---------------------------------------------------------------------------
-- Seeded as superuser: response rows are the runtime RPCs' job (0011, tested there), and a
-- pii-flagged variable on the DRAFT version because content rows are writable only while
-- draft (content.tg_draft_only). The response documents deliberately reference the draft
-- version too — response_documents carries no FK to versions (B §8.1), so the read path is
-- testable without publish machinery.
RESET ROLE;
INSERT INTO content.variables
  (survey_version_id, id, org_id, name, kind, vtype, export_column, sort_key, pii)
VALUES (pg_temp.tid('ver_a_draft')::app.ulid, pg_temp.uid('var', 'p1'),
        pg_temp.tid('org_a')::app.ulid, 'PX1', 'hidden', 'text', 'PX1', 'a1', true);

INSERT INTO runtime.response_documents
  (survey_version_id, session_id, org_id, is_test, status, disposition, vars, started_at)
VALUES
  (pg_temp.tid('ver_a_draft')::app.ulid, pg_temp.sid('s1'), pg_temp.tid('org_a')::app.ulid,
   false, 'completed', 'COMPLETE',
   jsonb_build_object('var_q1', 1, pg_temp.uid('var', 'p1')::text, 'a@example.test'),
   now()),
  (pg_temp.tid('ver_a_draft')::app.ulid, pg_temp.sid('s2'), pg_temp.tid('org_a')::app.ulid,
   false, 'active', NULL, '{"var_q1": 2}', now()),
  (pg_temp.tid('ver_a_draft')::app.ulid, pg_temp.sid('s3'), pg_temp.tid('org_a')::app.ulid,
   true, 'completed', 'COMPLETE', '{"var_q1": 3}', now());

-- user_c: analyst, NO pii grant — the default reader.
SELECT pg_temp.act_as(pg_temp.tid('user_c')::uuid, pg_temp.tid('org_a'));
SELECT is((SELECT count(*) FROM app.export_response_page(
             pg_temp.tid('ver_a_draft')::app.ulid, NULL, false, 10)),
  2::bigint, 'test responses are EXCLUDED by default (E 14.1)');
SELECT is((SELECT array_agg(p.session_id::text)
             FROM app.export_response_page(
               pg_temp.tid('ver_a_draft')::app.ulid, NULL, false, 10) p),
  ARRAY[pg_temp.sid('s1')::text, pg_temp.sid('s2')::text],
  'rows come back in session_id order — the keyset''s total order');
SELECT is((SELECT array_agg(p.session_id::text)
             FROM app.export_response_page(
               pg_temp.tid('ver_a_draft')::app.ulid, pg_temp.sid('s1'), false, 10) p),
  ARRAY[pg_temp.sid('s2')::text],
  'the lower bound is EXCLUSIVE — paging from the last seen id never repeats a row');
SELECT is((SELECT count(*) FROM app.export_response_page(
             pg_temp.tid('ver_a_draft')::app.ulid, NULL, true, 10)),
  3::bigint, 'include_test = true brings the test response back');
SELECT is((SELECT count(*) FROM app.export_response_page(
             pg_temp.tid('ver_a_draft')::app.ulid, NULL, true, 2)),
  2::bigint, 'LIMIT is honoured — the page size is the caller''s batch');
SELECT ok((SELECT NOT p.vars ? pg_temp.uid('var', 'p1')::text
             FROM app.export_response_page(
               pg_temp.tid('ver_a_draft')::app.ulid, NULL, false, 1) p),
  'a pii-flagged variable''s value is STRIPPED for a caller without the grant — the row '
  'says pii_included, the data says no (security 7.2 defence in depth)');
SELECT is((SELECT p.vars ->> 'var_q1'
             FROM app.export_response_page(
               pg_temp.tid('ver_a_draft')::app.ulid, NULL, false, 1) p),
  '1', 'and the non-pii values in the same document survive the strip');

-- user_a: analyst-and-above WITH the grant issued in section 2.
SELECT pg_temp.act_as(pg_temp.tid('user_a')::uuid, pg_temp.tid('org_a'));
SELECT ok((SELECT p.vars ? pg_temp.uid('var', 'p1')::text
             FROM app.export_response_page(
               pg_temp.tid('ver_a_draft')::app.ulid, NULL, false, 1) p),
  'a caller holding pii_access reads the pii value — checked LIVE, not from the export row');

-- The floor and the tenant boundary, each by its own error.
SELECT pg_temp.act_as(pg_temp.tid('user_a2')::uuid, pg_temp.tid('org_a'));
SELECT throws_ok(
  format('SELECT count(*) FROM app.export_response_page(%L, NULL, false, 10)',
         pg_temp.tid('ver_a_draft')),
  '42501', NULL, 'a reviewer cannot read responses for export — floor first, by name');
SELECT pg_temp.act_as(pg_temp.tid('user_b')::uuid, pg_temp.tid('org_b'));
SELECT throws_ok(
  format('SELECT count(*) FROM app.export_response_page(%L, NULL, false, 10)',
         pg_temp.tid('ver_a_draft')),
  'P0002', NULL,
  'another org''s version reads as NOT FOUND — indistinguishable from a version that '
  'never existed (0004''s existence-oracle rule)');
SELECT is((SELECT count(*) FROM app.export_response_page(
             pg_temp.tid('ver_b_frozen')::app.ulid, NULL, false, 10)),
  0::bigint, 'org B pages its own (empty) version cleanly — zero rows, not an error');

-- ---------------------------------------------------------------------------
-- 4. Posture (ADR-001, ADR-009)
-- ---------------------------------------------------------------------------
RESET ROLE;
SELECT set_config('request.jwt.claims', '', true);
SELECT ok(has_function_privilege('authoring',
  'app.export_response_page(app.ulid, app.ulid, boolean, int)', 'EXECUTE'),
  'authoring holds EXECUTE on export_response_page — the worker''s impersonated read');
SELECT ok(NOT has_function_privilege('runtime_writer',
  'app.export_response_page(app.ulid, app.ulid, boolean, int)', 'EXECUTE'),
  'runtime_writer does NOT — the respondent plane never reads exports');
SELECT ok(NOT has_table_privilege('analytics_reader', 'app.exports', 'SELECT'),
  'analytics_reader cannot read app.exports — its plane is schema export (B 11), not app');
SELECT ok(NOT has_table_privilege('runtime_writer', 'app.exports', 'SELECT'),
  'runtime_writer cannot read app.exports');
SELECT ok(NOT has_table_privilege('authoring', 'app.exports', 'DELETE'),
  'authoring cannot DELETE export rows — no delete path exists yet, in privileges or policy');

SELECT * FROM finish();
ROLLBACK;
