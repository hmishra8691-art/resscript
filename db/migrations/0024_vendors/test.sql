-- 0024_vendors — tests.
--
-- P2-04's vendor machinery was built and tested seventeen migrations ago and none of it ran: with
-- no table, `assembleSurvey` never set `Survey.vendors`, so `vendors.json` was never emitted,
-- `head.vendors` was always absent, `vendorFromParams` always returned undefined,
-- `session.vendor_ref` was always null, and the `by_vendor` redirect tier could not fire.
--
-- So the assertions worth making here are the ones that keep a vendor from being STORABLE in a
-- state the runtime would have to report to a respondent as a 403:
--
--   * signed or unsigned, never half — `verifyEntry` answers `no_secret` / `no_signed_params` for
--     the half states, and a respondent seeing somebody else's configuration error is not a
--     failure mode worth having;
--   * a secret VALUE in `secret_ref` is refused at write time, because every other layer that
--     forbids it sits downstream of a paste into a vendor console;
--   * an inbound param cannot target a variable that does not exist — a real foreign key, which is
--     the whole reason the params are a table rather than a jsonb column;
--   * the read floor is `programmer`, above the review bar, because a list of secret_refs is a map
--     of the secret store and a review link is shared outside the programming team.

BEGIN;
SELECT plan(31);

GRANT USAGE ON SCHEMA public TO authoring, runtime_writer, analytics_reader, runtime_rpc_owner;

SELECT set_config('rs.orgs', ops.test_seed_two_orgs()::text, true);
SELECT set_config('rs.ids',
  (current_setting('rs.orgs')::jsonb
     || ops.test_seed_content(current_setting('rs.orgs')::jsonb))::text, true);
CREATE FUNCTION pg_temp.tid(k text) RETURNS text LANGUAGE sql STABLE AS
$$ SELECT current_setting('rs.ids', true)::jsonb ->> k $$;

CREATE FUNCTION pg_temp.act_as(p_user uuid, p_org text, p_role text DEFAULT 'authoring')
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', p_user, 'role', p_role,
                      'app_metadata', json_build_object('active_org_id', p_org))::text, true);
  EXECUTE format('SET LOCAL ROLE %I', p_role);
END $$;

CREATE FUNCTION pg_temp.vid(p_prefix text, p_tag text) RETURNS app.ulid LANGUAGE sql IMMUTABLE AS
$$ SELECT (p_prefix || '_0' || rpad(translate(upper(p_tag), 'ILOU', '110V') || 'V', 25, '0'))::app.ulid $$;

SELECT set_config('rs.ver', pg_temp.tid('ver_a_content_draft'), true);
SELECT set_config('rs.org', pg_temp.tid('org_a'), true);

-- A hidden variable for the inbound param to target. Seeded as superuser: content.variables is
-- 0007's business.
RESET ROLE;
INSERT INTO content.variables
  (survey_version_id, id, org_id, name, kind, vtype, export_column, sort_key)
VALUES (current_setting('rs.ver')::app.ulid, pg_temp.vid('var', 'pid'),
        current_setting('rs.org')::app.ulid, 'VENDORPID', 'hidden', 'text', 'VENDORPID', 800);

/* ---------------------------------------------------------------- *
 * 1. Structure
 * ---------------------------------------------------------------- */

SELECT has_table('content', 'vendors', 'content.vendors exists');
SELECT has_table('content', 'vendor_inbound_params', 'content.vendor_inbound_params exists');
SELECT has_table('content', 'vendor_limits',
  'content.vendor_limits exists — P2-04''s DB line names it, and 0016 declined to create it '
  'because "a limit with no vendor table is a column nobody can populate"');

SELECT is(
  (SELECT pg_get_constraintdef(oid) FROM pg_constraint
    WHERE conrelid = 'content.vendors'::regclass AND contype = 'p'),
  'PRIMARY KEY (survey_version_id, id)',
  'keyed (survey_version_id, id) like every other version-scoped content table — which is what '
  'makes ADR-002''s clone a version-column rewrite, and what 0019''s code_assets got wrong');

SELECT ok(
  (SELECT relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'content' AND c.relname = 'vendors'),
  'RLS is FORCED on content.vendors');

SELECT ok(
  EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'content' AND c.relname = 'vendors' AND t.tgname = 'vendors_draft_only'),
  'ADR-002''s draft-only trigger is present — ops.content_tables_without_draft_trigger() fails CI '
  'for a content table without it');

SELECT ok(
  NOT has_table_privilege('runtime_writer', 'content.vendors', 'SELECT'),
  'runtime_writer cannot read content.vendors — the runtime reads vendors out of the compiled '
  'artifact (C §17), never as rows, which is what makes a mid-field vendor edit unable to change '
  'what a live entry link verifies against');
SELECT ok(
  NOT has_table_privilege('analytics_reader', 'content.vendors', 'SELECT'),
  'nor analytics_reader — a list of secret_refs is a map of the secret store');

-- 0023's check, on the migration immediately after it.
SELECT is_empty($$ SELECT table_name FROM ops.content_tables_not_cloned() $$,
  'all three vendor tables are cloned. 0023''s catalog check REFUSED this migration on its first '
  'run and named them, which is the check working on the very next opportunity');

/* ---------------------------------------------------------------- *
 * 2. Signed or unsigned, never half
 * ---------------------------------------------------------------- */

SELECT pg_temp.act_as(pg_temp.tid('user_a')::uuid, pg_temp.tid('org_a'));

-- An UNSIGNED vendor is a real configuration: a QR code or a client's own mailing list has no
-- panel to sign.
INSERT INTO content.vendors (survey_version_id, id, org_id, ref, name)
VALUES (current_setting('rs.ver')::app.ulid, pg_temp.vid('vnd', 'direct'),
        current_setting('rs.org')::app.ulid, 'DIRECT', 'Direct traffic');
SELECT is((SELECT count(*)::int FROM content.vendors), 1, 'an unsigned vendor is storable');

-- And a fully signed one.
INSERT INTO content.vendors
  (survey_version_id, id, org_id, ref, name, hash_param, algorithm, secret_ref, signed_params,
   max_completes)
VALUES (current_setting('rs.ver')::app.ulid, pg_temp.vid('vnd', 'panela'),
        current_setting('rs.org')::app.ulid, 'PANEL_A', 'Panel A', 'hash', 'sha256',
        'vendor/panel_a/hmac', ARRAY['pid', 'ts'], 500);
SELECT is((SELECT count(*)::int FROM content.vendors), 2, 'and a signed one');

SELECT throws_ok(
  format($ins$INSERT INTO content.vendors
           (survey_version_id, id, org_id, ref, name, algorithm)
         VALUES (%L, %L, %L, 'HALF1', 'Half signed', 'sha256')$ins$,
    current_setting('rs.ver'), pg_temp.vid('vnd', 'half1'), current_setting('rs.org')),
  '23514', NULL,
  'an algorithm with no secret_ref is unstorable — it would verify against nothing, and '
  'verifyEntry''s answer for that state is a 403 the respondent sees for somebody else''s mistake');

SELECT throws_ok(
  format($ins$INSERT INTO content.vendors
           (survey_version_id, id, org_id, ref, name, secret_ref, signed_params)
         VALUES (%L, %L, %L, 'HALF2', 'Half signed', 'vendor/x/hmac', ARRAY['pid'])$ins$,
    current_setting('rs.ver'), pg_temp.vid('vnd', 'half2'), current_setting('rs.org')),
  '23514', NULL,
  'and a secret_ref with no hash_param is too — there would be nowhere to read the signature from');

SELECT throws_ok(
  format($ins$INSERT INTO content.vendors
           (survey_version_id, id, org_id, ref, name, hash_param, algorithm, secret_ref)
         VALUES (%L, %L, %L, 'NOPARAMS', 'No signed params', 'hash', 'sha256', 'vendor/x/hmac')$ins$,
    current_setting('rs.ver'), pg_temp.vid('vnd', 'nop'), current_setting('rs.org')),
  '23514', NULL,
  'a signed vendor must say WHICH params are signed: a signature over nothing verifies everything');

/* ---------------------------------------------------------------- *
 * 3. The secret check
 * ---------------------------------------------------------------- */

SELECT throws_ok(
  format($ins$INSERT INTO content.vendors
           (survey_version_id, id, org_id, ref, name, hash_param, algorithm, secret_ref,
            signed_params)
         VALUES (%L, %L, %L, 'LEAK', 'Pasted secret', 'hash', 'sha256', %L, ARRAY['pid'])$ins$,
    current_setting('rs.ver'), pg_temp.vid('vnd', 'leak'), current_setting('rs.org'),
    'k7Fq2mZp9xLtR4vNwYbS3jHcQ8eA6uDg'),
  '23514', NULL,
  'a 32-character opaque string in secret_ref is REFUSED at write time. Every other layer that '
  'forbids a secret value — the schema type, the compiler''s assertNoSecrets, the artifact type — '
  'sits downstream of a paste into a vendor console, and assertNoSecrets throwing at publish is '
  'too late to be the only guard');

SELECT lives_ok(
  format($ins$INSERT INTO content.vendors
           (survey_version_id, id, org_id, ref, name, hash_param, algorithm, secret_ref,
            signed_params)
         VALUES (%L, %L, %L, 'PANEL_B', 'Panel B', 'hash', 'sha256', 'vendor/panel_b/hmac',
                 ARRAY['pid'])$ins$,
    current_setting('rs.ver'), pg_temp.vid('vnd', 'panelb'), current_setting('rs.org')),
  'a path-shaped reference passes — the heuristic targets opaque length, not slashes');

SELECT throws_ok(
  format($ins$UPDATE content.vendors SET secret_ref = '   ' WHERE ref = 'PANEL_A'$ins$),
  '23514', NULL, 'a whitespace secret_ref is refused');

/* ---------------------------------------------------------------- *
 * 4. Inbound params — the FK that is the reason this is a table
 * ---------------------------------------------------------------- */

INSERT INTO content.vendor_inbound_params
  (survey_version_id, vendor_id, param, variable_id, required, org_id)
VALUES (current_setting('rs.ver')::app.ulid, pg_temp.vid('vnd', 'panela'), 'pid',
        pg_temp.vid('var', 'pid'), true, current_setting('rs.org')::app.ulid);
SELECT is((SELECT count(*)::int FROM content.vendor_inbound_params), 1, 'an inbound param stores');

SELECT throws_ok(
  format($ins$INSERT INTO content.vendor_inbound_params
           (survey_version_id, vendor_id, param, variable_id, org_id)
         VALUES (%L, %L, 'sid', %L, %L)$ins$,
    current_setting('rs.ver'), pg_temp.vid('vnd', 'panela'), pg_temp.vid('var', 'ghost'),
    current_setting('rs.org')),
  '23503', NULL,
  'a param targeting a variable that does not exist is refused BY A FOREIGN KEY — this is the '
  'whole reason the params are a table and not a jsonb column on the vendor. SCH-1004 catches it '
  'at publish; the FK catches it at the moment a vendor console''s typo is made');

SELECT throws_ok(
  format($ins$INSERT INTO content.vendor_inbound_params
           (survey_version_id, vendor_id, param, variable_id, org_id)
         VALUES (%L, %L, 'pid', %L, %L)$ins$,
    current_setting('rs.ver'), pg_temp.vid('vnd', 'panela'), pg_temp.vid('var', 'pid'),
    current_setting('rs.org')),
  '23505', NULL,
  'one row per (vendor, param): two mappings for one query parameter would make which variable it '
  'writes depend on iteration order');

SELECT throws_ok(
  format($ins$INSERT INTO content.vendor_inbound_params
           (survey_version_id, vendor_id, param, variable_id, org_id)
         VALUES (%L, %L, 'a&b', %L, %L)$ins$,
    current_setting('rs.ver'), pg_temp.vid('vnd', 'panela'), pg_temp.vid('var', 'pid'),
    current_setting('rs.org')),
  '23514', NULL,
  'a param name containing & is refused: it would split the signature''s canonical string and make '
  'two different query strings produce one signature');

-- Deleting a variable a panel writes into must FAIL rather than silently orphan the mapping.
RESET ROLE;
SELECT throws_ok(
  format($del$DELETE FROM content.variables WHERE survey_version_id = %L AND id = %L$del$,
    current_setting('rs.ver'), pg_temp.vid('var', 'pid')),
  '23503', NULL,
  'deleting a variable an inbound param targets is RESTRICTed — the alternative is a vendor whose '
  'entry link silently stops carrying a panel id');
SELECT pg_temp.act_as(pg_temp.tid('user_a')::uuid, pg_temp.tid('org_a'));

/* ---------------------------------------------------------------- *
 * 5. Refs, limits, tenancy and the draft boundary
 * ---------------------------------------------------------------- */

SELECT throws_ok(
  format($ins$INSERT INTO content.vendors (survey_version_id, id, org_id, ref, name)
         VALUES (%L, %L, %L, 'PANEL_A', 'Duplicate ref')$ins$,
    current_setting('rs.ver'), pg_temp.vid('vnd', 'dup'), current_setting('rs.org')),
  '23505', NULL,
  'two vendors cannot share a ref within a version — the ref is what ?src= matches, so a duplicate '
  'makes which vendor a link belongs to non-deterministic');

SELECT throws_ok(
  format($ins$INSERT INTO content.vendors
           (survey_version_id, id, org_id, ref, name, max_completes)
         VALUES (%L, %L, %L, 'ZERO', 'Zero ceiling', 0)$ins$,
    current_setting('rs.ver'), pg_temp.vid('vnd', 'zero'), current_setting('rs.org')),
  '23514', NULL,
  'a max_completes of 0 is refused: a vendor that may deliver nothing is a vendor you remove');

-- A vendor limit needs a real plan.
SELECT throws_ok(
  format($ins$INSERT INTO content.vendor_limits
           (survey_version_id, vendor_id, plan_id, max_completes, org_id)
         VALUES (%L, %L, %L, 200, %L)$ins$,
    current_setting('rs.ver'), pg_temp.vid('vnd', 'panela'), pg_temp.vid('qp', 'ghost'),
    current_setting('rs.org')),
  '23503', NULL,
  'a per-plan vendor limit must name a real quota plan');

-- The read floor: programmer, NOT reviewer. The one content table whose read bar is above the
-- review bar, matching the reasoning 0010's redirects route already applies.
SELECT pg_temp.act_as(pg_temp.tid('user_a2')::uuid, pg_temp.tid('org_a'));
SELECT is((SELECT count(*)::int FROM content.vendors), 0,
  'a REVIEWER sees no vendors at all — a vendor row is a commercial relationship plus a pointer '
  'into the secrets store, and a review link is shared outside the programming team');

SELECT pg_temp.act_as(pg_temp.tid('user_b')::uuid, pg_temp.tid('org_b'));
SELECT is((SELECT count(*)::int FROM content.vendors), 0, 'and org B sees none of org A''s');

SELECT pg_temp.act_as(pg_temp.tid('user_a')::uuid, pg_temp.tid('org_a'));
SELECT throws_ok(
  format($ins$INSERT INTO content.vendors (survey_version_id, id, org_id, ref, name)
         VALUES (%L, %L, %L, 'LATE', 'Added to a frozen version')$ins$,
    pg_temp.tid('ver_a_content_frozen'), pg_temp.vid('vnd', 'late'), current_setting('rs.org')),
  '23514', NULL,
  'a vendor cannot be added to a FROZEN version — a wave in field keeps the panels and the signing '
  'configuration it was fielded with, and a draft that adds a panel must not let that panel into a '
  'running wave');

/* ---------------------------------------------------------------- *
 * 6. The clone carries them
 * ---------------------------------------------------------------- */

SELECT set_config('rs.counts',
  content.clone_version(current_setting('rs.ver')::app.ulid,
                        pg_temp.tid('ver_a_clone_target')::app.ulid)::text, true);

SELECT is((current_setting('rs.counts')::jsonb ->> 'vendors'), '3',
  'the clone carries the vendors');
SELECT is((current_setting('rs.counts')::jsonb ->> 'vendor_inbound_params'), '1',
  'and their inbound params — a clone without them is a panel whose entry links stop binding');
SELECT is(
  (SELECT secret_ref FROM content.vendors
    WHERE survey_version_id = pg_temp.tid('ver_a_clone_target')::app.ulid AND ref = 'PANEL_A'),
  'vendor/panel_a/hmac',
  'with the secret REFERENCE intact — the pointer clones, the secret was never here to clone');

SELECT * FROM finish();
ROLLBACK;
