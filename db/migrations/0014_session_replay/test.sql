-- 0014_session_replay/test.sql — pgTAP. The replay read: who may call it, and what it answers.
--
-- What this file has to prove:
--   * THE GRANT IS ONE ROLE. runtime_writer holds EXECUTE and nobody else does — not PUBLIC (0006's
--     standing invariant), not authoring (no USAGE on schema runtime at all, ADR-001), not
--     analytics_reader. This is the whole access-control story for replay, because the runtime is
--     the only process that holds the artifact manifest and can therefore redact pii (security
--     §8.1) before a human sees a value;
--   * the tail comes back in SEQ ORDER, every event of the session and nothing else. A replay is a
--     reduction over an ordered input list, so an out-of-order or short tail is not a degraded
--     answer, it is a wrong one;
--   * A SESSION IN ANOTHER VERSION IS NOT CONFUSED WITH IT. The read joins on
--     (survey_version_id, session_id) for partition pruning, and the test proves the prune did not
--     become a filter that leaks: org B's session in org B's version returns org B's events only,
--     and a session id that does not exist returns zero rows rather than another session's tail;
--   * PRODUCTION SESSIONS ARE RETURNED, DELIBERATELY (the migration header's decision): is_test =
--     false comes back with its events, and is_test rides on every row so the runtime can label the
--     replay. There is no refusal to assert here BY DESIGN — the honest position is redaction in
--     the runtime, not exclusion in the database, and asserting the absence of a restriction is how
--     that decision stops being quietly reversible;
--   * the definer posture: SECURITY DEFINER, STABLE, search_path pinned, statement_timeout pinned.
BEGIN;
SELECT plan(28);

GRANT USAGE ON SCHEMA public TO authoring, runtime_writer, analytics_reader, runtime_rpc_owner;

SELECT set_config('rs.ids', ops.test_seed_two_orgs()::text, true);
CREATE FUNCTION pg_temp.tid(k text) RETURNS text LANGUAGE sql STABLE AS
$$ SELECT current_setting('rs.ids', true)::jsonb ->> k $$;

-- Crockford-safe tags only (no i/l/o/u): the app.ulid domain rejects those characters.
CREATE FUNCTION pg_temp.sid(p_tag text) RETURNS app.ulid LANGUAGE sql IMMUTABLE AS
$$ SELECT ('ses_0' || rpad(upper(p_tag), 25, '0'))::app.ulid $$;
CREATE FUNCTION pg_temp.eid(p_tag text) RETURNS app.ulid LANGUAGE sql IMMUTABLE AS
$$ SELECT ('evt_0' || rpad(upper(p_tag), 25, '0'))::app.ulid $$;
CREATE FUNCTION pg_temp.pid(p_tag text) RETURNS app.ulid LANGUAGE sql IMMUTABLE AS
$$ SELECT ('pg_0' || rpad(upper(p_tag), 25, '0'))::app.ulid $$;

-- Two live tokens, one per org's frozen version, seeded as superuser: token minting is 0009's
-- publish transaction and publish-state machinery is not under test here. Two versions is the
-- point — the cross-version assertion below has nothing to say with only one.
INSERT INTO runtime.survey_tokens (token, org_id, survey_id, survey_version_id, artifact_hash,
                                   status, is_test)
SELECT 'abcdefghij0123456789klmnop', pg_temp.tid('org_a')::app.ulid,
       pg_temp.tid('svy_a')::app.ulid, v.id, v.artifact_hash, 'production', false
  FROM app.survey_versions v WHERE v.id = pg_temp.tid('ver_a_frozen')::app.ulid;
INSERT INTO runtime.survey_tokens (token, org_id, survey_id, survey_version_id, artifact_hash,
                                   status, is_test)
SELECT 'bbcdefghij0123456789klmnop', pg_temp.tid('org_b')::app.ulid,
       pg_temp.tid('svy_b')::app.ulid, v.id, v.artifact_hash, 'production', false
  FROM app.survey_versions v WHERE v.id = pg_temp.tid('ver_b_frozen')::app.ulid;

SELECT set_config('rs.pin_a',
  (SELECT artifact_hash::text FROM runtime.survey_tokens
    WHERE token = 'abcdefghij0123456789klmnop'), true);

-- ---------------------------------------------------------------------------
-- 1. Structure and posture
-- ---------------------------------------------------------------------------
SELECT has_function('runtime', 'replay_session', ARRAY['app.ulid'],
  'runtime.replay_session(app.ulid) exists with the signature this migration defines');
SELECT is_definer('runtime', 'replay_session', ARRAY['app.ulid'],
  'it is SECURITY DEFINER: runtime_writer holds no privilege on sessions or response_events '
  '(ADR-001), so a definer function is the only shape this read can have');
SELECT volatility_is('runtime', 'replay_session', ARRAY['app.ulid'], 'stable',
  'and STABLE — replay reads history and must never be mistaken for something that writes it');
SELECT is_empty($$
  SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'runtime' AND p.proname = 'replay_session'
     AND NOT EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig, '{}')) c
                      WHERE c LIKE 'search\_path=%')
$$, 'search_path is pinned — a definer whose caller picks the schema is an escalation primitive, '
    'whatever the body says (0001''s standing assertion, restated for this function by name)');
SELECT is_empty($$
  SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'runtime' AND p.proname = 'replay_session'
     AND NOT ('statement_timeout=5s' = ANY (coalesce(p.proconfig, '{}')))
$$, 'and statement_timeout is pinned at 5s: a debugging read gets more room than the 3s '
    'respondent RPCs and still cannot hold a connection open on a crafted id');

-- ---------------------------------------------------------------------------
-- 2. THE GRANT: exactly one role
-- ---------------------------------------------------------------------------
SELECT ok(has_function_privilege('runtime_writer', 'runtime.replay_session(app.ulid)', 'EXECUTE'),
  'runtime_writer holds EXECUTE — the runtime is the process that can redact pii (security §8.1)');
SELECT ok(NOT has_function_privilege('public', 'runtime.replay_session(app.ulid)', 'EXECUTE'),
  'PUBLIC does NOT — 0006''s invariant, asserted here for this function by name as well as by '
  'ops.functions_executable_by_public()');
SELECT is_empty($$ SELECT ops.functions_executable_by_public() $$,
  'and the standing catalog check agrees: nothing new is executable by PUBLIC');
SELECT ok(NOT has_function_privilege('authoring', 'runtime.replay_session(app.ulid)', 'EXECUTE'),
  'authoring does NOT — the studio reaches replay through the runtime''s signed preview token, '
  'never through the database (ADR-001''s plane boundary)');
SELECT ok(NOT has_function_privilege('analytics_reader',
  'runtime.replay_session(app.ulid)', 'EXECUTE'),
  'analytics_reader does NOT — its plane is schema export (B §11), and a replay is not analysis');
SELECT ok(NOT has_table_privilege('runtime_writer', 'runtime.response_events', 'SELECT'),
  'and the grant is still the ONLY thing runtime_writer holds: it cannot SELECT response_events '
  'directly, so replay reads exactly the columns this function names and no others');

-- ---------------------------------------------------------------------------
-- 3. The round trip: one session's tail, in seq order
-- ---------------------------------------------------------------------------
-- A PRODUCTION session (is_test = false), because that is the case the header decided to allow.
SET LOCAL ROLE runtime_writer;
SELECT lives_ok(
  format('SELECT runtime.start_session(%L, %L, %L, %L, false)',
         'abcdefghij0123456789klmnop', pg_temp.sid('ra'), repeat('deadbeef', 4), 'en'),
  'a production session starts (seq 1 = its session_start event)');
SELECT is(
  runtime.submit_page(
    pg_temp.sid('ra'), 2, pg_temp.eid('ra2'), 'page_submit', pg_temp.pid('p1'),
    '{"var_q1": 3}', '{"var_q1": 3}', NULL, '{"shown": ["qst_1"]}', NULL, 1200,
    'active', NULL, pg_temp.pid('p2'), '{}', 1),
  2, 'the first page submit lands at seq 2');
SELECT is(
  runtime.submit_page(
    pg_temp.sid('ra'), 3, pg_temp.eid('ra3'), 'page_submit', pg_temp.pid('p2'),
    '{"var_q1": 3, "var_q2": "why"}', '{"var_q2": "why"}', NULL, '{"shown": ["qst_2"]}',
    NULL, 900, 'completed', 'COMPLETE', NULL, '{}', 2),
  3, 'the second lands at seq 3 and completes the session');

-- Everything replay needs, off the first row.
SELECT row_eq(
  format('SELECT session_id, random_seed, language, is_test, survey_version_id '
         'FROM runtime.replay_session(%L) ORDER BY seq LIMIT 1', pg_temp.sid('ra')),
  ROW(pg_temp.sid('ra'), repeat('deadbeef', 4), 'en'::text, false,
      pg_temp.tid('ver_a_frozen')::app.ulid)::record,
  'the seed, language, is_test flag and version come back on the row — ADR-006''s replay key '
  'survives the read, and a replay without it would be a re-simulation with fresh randomness');
SELECT is((SELECT artifact_hash::text FROM runtime.replay_session(pg_temp.sid('ra')) LIMIT 1),
  current_setting('rs.pin_a', true),
  'and the PIN comes back: replaying a session against a different artifact is a category error, '
  'so the runtime compares this to the hash in the replay URL and 404s on a mismatch (E §3.3)');

SELECT is(
  (SELECT array_agg(r.seq ORDER BY r.seq) FROM runtime.replay_session(pg_temp.sid('ra')) r),
  ARRAY[1, 2, 3],
  'every event of the session comes back — birth, submit, submit — and nothing is dropped');
SELECT is(
  (SELECT array_agg(r.event_type) FROM runtime.replay_session(pg_temp.sid('ra')) r),
  ARRAY['session_start', 'page_submit', 'page_submit'],
  'IN SEQ ORDER, without the caller sorting: a reducer over a reordered input list produces a '
  'session that never happened');
SELECT is(
  (SELECT r."values" ->> 'var_q1' FROM runtime.replay_session(pg_temp.sid('ra')) r
    WHERE r.seq = 2),
  '3', 'the recorded INPUT is the accepted values of that submit — what replay re-drives with');
SELECT is(
  (SELECT r.page_id FROM runtime.replay_session(pg_temp.sid('ra')) r WHERE r.seq = 2),
  pg_temp.pid('p1'), 'with the page it was submitted against');
SELECT is(
  (SELECT r.payload -> 'shown' ->> 0 FROM runtime.replay_session(pg_temp.sid('ra')) r
    WHERE r.seq = 2),
  'qst_1', 'and the payload, which carries the shown set the original evaluation produced');

-- An is_test session replays the same way. Both are returned on purpose: see the header.
SELECT lives_ok(
  format('SELECT runtime.start_session(%L, %L, %L, %L, true)',
         'abcdefghij0123456789klmnop', pg_temp.sid('rt'), repeat('cafebabe', 4), 'en'),
  'a test session starts too');
SELECT is((SELECT r.is_test FROM runtime.replay_session(pg_temp.sid('rt')) r LIMIT 1), true,
  'is_test rides on every row, so the runtime can band the panel amber (UI §9.4) — the flag is '
  'reported, never a precondition for reading');

-- ---------------------------------------------------------------------------
-- 4. One session is not another, and not another VERSION's
-- ---------------------------------------------------------------------------
SELECT lives_ok(
  format('SELECT runtime.start_session(%L, %L, %L, %L, false)',
         'bbcdefghij0123456789klmnop', pg_temp.sid('rb'), repeat('0123abcd', 4), 'en'),
  'org B starts a session in org B''s version');
SELECT is(
  runtime.submit_page(
    pg_temp.sid('rb'), 2, pg_temp.eid('rb2'), 'page_submit', NULL,
    '{"var_x": 1}', '{"var_x": 1}', NULL, '{}', NULL, 100,
    'active', NULL, NULL, '{}', 1),
  2, 'and submits a page');

SELECT is(
  (SELECT count(*) FROM runtime.replay_session(pg_temp.sid('ra'))), 3::bigint,
  'session A''s tail is still exactly three events — the join is keyed on the session''s OWN '
  'version, so a same-named event in another partition cannot join into it');
SELECT is(
  (SELECT array_agg(DISTINCT r.survey_version_id::text)
     FROM runtime.replay_session(pg_temp.sid('rb')) r),
  ARRAY[pg_temp.tid('ver_b_frozen')],
  'and session B replays under version B alone — the cross-version read is not merely filtered '
  'later, it never joins');
SELECT is_empty(
  format('SELECT * FROM runtime.replay_session(%L)', pg_temp.sid('nxx')),
  'an unknown session replays as ZERO ROWS, not an error — the id reached through a signed '
  'replay token IS the capability, exactly as in load_session');

RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
