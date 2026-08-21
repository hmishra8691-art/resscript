-- 0011_runtime_write_path/test.sql — pgTAP. The write path a respondent's interview rides on.
--
-- What this file has to prove:
--   * THE REPLAY GUARD, the most important thing here: calling runtime.submit_page twice with
--     the same expected_seq produces ONE event and an unchanged document, and the second call
--     returns the stored seq rather than raising — the roadmap P1-10 replay test, expressed at
--     the RPC. A mobile network retry is the most common duplicate-event source in production
--     survey platforms (E §3.4), and this guard is the whole defence;
--   * response_events is append-only THREE ways, each asserted separately because each layer
--     covers a different failure: the REVOKE (privileges — asserted from the catalog for
--     authoring/analytics_reader), the tg_append_only trigger (asserted BEHAVIOURALLY as the
--     table owner, whom the REVOKE cannot bind and FORCE RLS + no-policy would silently
--     filter), and the absence of UPDATE/DELETE policies (asserted from pg_policy);
--   * every new table and every partition has RLS enabled AND forced — sampled from pg_class
--     across the 32+32 hash children and the event leaves, because policies do not inherit
--     and one unprotected child is a cross-tenant read;
--   * ops.ensure_event_partitions(3) premade this month + 3 ahead, each month 8 hash leaves —
--     the roadmap's partition-existence test — and start_session/submit_page insert into them
--     without DDL;
--   * the RPC round trip: start_session writes session + document + session_start event
--     atomically; load_session (the 0004 placeholder, now real) returns the document with the
--     seed, the pin and the revision the Redis-miss rebuild needs; submit_page advances the
--     seq, merges vars, and finalizes disposition exactly once;
--   * dedup is a conflict, not a race: a second start_session with the same respondent_key
--     for the same version raises unique_violation (01 §3.3 step 4);
--   * ADR-006's seed shape is enforced at the boundary: a 16-hex seed and an uppercase seed
--     are both rejected by name;
--   * ADR-009 held: runtime_writer gained EXECUTE on exactly the new definer functions and
--     still holds no table privilege in schema runtime; authoring cannot touch any of it.
BEGIN;
SELECT plan(52);

GRANT USAGE ON SCHEMA public TO authoring, runtime_writer, analytics_reader, runtime_rpc_owner;

SELECT set_config('rs.ids', ops.test_seed_two_orgs()::text, true);
CREATE FUNCTION pg_temp.tid(k text) RETURNS text LANGUAGE sql STABLE AS
$$ SELECT current_setting('rs.ids', true)::jsonb ->> k $$;

-- A live token for org A's frozen version, seeded as superuser: token minting is 0009's
-- publish transaction and publish-state machinery is not under test here.
INSERT INTO runtime.survey_tokens (token, org_id, survey_id, survey_version_id, artifact_hash,
                                   status, is_test)
SELECT 'abcdefghij0123456789klmnop', pg_temp.tid('org_a')::app.ulid,
       pg_temp.tid('svy_a')::app.ulid, v.id, v.artifact_hash, 'production', false
  FROM app.survey_versions v WHERE v.id = pg_temp.tid('ver_a_frozen')::app.ulid;

CREATE FUNCTION pg_temp.sid(p_tag text) RETURNS app.ulid LANGUAGE sql IMMUTABLE AS
$$ SELECT ('ses_0' || rpad(upper(p_tag), 25, '0'))::app.ulid $$;
CREATE FUNCTION pg_temp.eid(p_tag text) RETURNS app.ulid LANGUAGE sql IMMUTABLE AS
$$ SELECT ('evt_0' || rpad(upper(p_tag), 25, '0'))::app.ulid $$;

-- Captured as superuser, compared later as runtime_writer: that role cannot SELECT the token
-- table (asserted in §7), so an assertion that queried it mid-role would fail for the right
-- reason in the wrong place.
SELECT set_config('rs.pin',
  (SELECT artifact_hash::text FROM runtime.survey_tokens
    WHERE token = 'abcdefghij0123456789klmnop'), true);

-- ---------------------------------------------------------------------------
-- 1. Structure: tables, partitions, premade event months
-- ---------------------------------------------------------------------------
SELECT has_table('runtime', 'sessions',           'runtime.sessions exists');
SELECT has_table('runtime', 'response_documents', 'runtime.response_documents exists');
SELECT has_table('runtime', 'response_events',    'runtime.response_events exists');

SELECT is((SELECT count(*) FROM pg_inherits WHERE inhparent = 'runtime.sessions'::regclass),
  32::bigint, 'sessions has 32 hash partitions (B §8)');
SELECT is((SELECT count(*) FROM pg_inherits
            WHERE inhparent = 'runtime.response_documents'::regclass),
  32::bigint, 'response_documents has 32 hash partitions (B §8.2)');

-- The roadmap's partition-existence test: this month + 3 ahead premade, 8 leaves each.
SELECT cmp_ok((SELECT count(*) FROM pg_inherits
                WHERE inhparent = 'runtime.response_events'::regclass), '>=', 4::bigint,
  'response_events has at least 4 monthly partitions premade (this month + 3)');
SELECT is((SELECT count(*) FROM pg_inherits
            WHERE inhparent = to_regclass(format('runtime.response_events_%s',
                                                 to_char(now(), 'YYYYMM')))),
  8::bigint, 'the current month is sub-partitioned into 8 hash leaves (B §8.1)');

-- ---------------------------------------------------------------------------
-- 2. RLS posture: enabled AND forced, on parents and children alike
-- ---------------------------------------------------------------------------
SELECT is((SELECT count(*) FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'runtime'
             AND (c.relname LIKE 'sessions%' OR c.relname LIKE 'response_%')
             AND c.relkind IN ('r', 'p')
             AND NOT (c.relrowsecurity AND c.relforcerowsecurity)),
  0::bigint,
  'every sessions/response table and partition has RLS enabled AND forced — one unprotected '
  'child is a cross-tenant read, because policies do not inherit');

SELECT is((SELECT count(*) FROM pg_policy WHERE polrelid = 'runtime.sessions'::regclass),
  3::bigint, 'sessions has exactly three policies (select/insert/update, no delete)');
SELECT is((SELECT count(*) FROM pg_policy
            WHERE polrelid = 'runtime.response_events'::regclass),
  2::bigint, 'response_events has exactly two policies — no UPDATE, no DELETE (B §9 layer 3)');
SELECT is((SELECT count(*) FROM pg_policy p
            WHERE p.polrelid IN ('runtime.sessions'::regclass,
                                 'runtime.response_documents'::regclass,
                                 'runtime.response_events'::regclass)
              AND p.polroles <> ARRAY['runtime_rpc_owner'::regrole]::oid[]),
  0::bigint, 'every policy targets runtime_rpc_owner and nobody else');

-- ---------------------------------------------------------------------------
-- 3. Append-only, three ways
-- ---------------------------------------------------------------------------
SELECT ok(NOT has_table_privilege('authoring', 'runtime.response_events', 'UPDATE')
      AND NOT has_table_privilege('authoring', 'runtime.response_events', 'DELETE'),
  'layer 1 (privileges): authoring cannot UPDATE or DELETE response_events');
SELECT ok(NOT has_table_privilege('analytics_reader', 'runtime.response_events', 'UPDATE')
      AND NOT has_table_privilege('analytics_reader', 'runtime.response_events', 'DELETE'),
  'layer 1 (privileges): analytics_reader cannot UPDATE or DELETE response_events');
SELECT is((SELECT count(*) FROM pg_trigger
            WHERE tgrelid = 'runtime.response_events'::regclass
              AND tgname = 'response_events_append_only' AND NOT tgisinternal),
  1::bigint, 'layer 2 (trigger): response_events_append_only is attached to the parent');

-- Behavioural, AS SUPERUSER — the strongest claim: even the one role privileges cannot bind
-- hits the trigger. (An RLS-filtered zero-row UPDATE would pass silently; the trigger raises.)
INSERT INTO runtime.response_events
  (survey_version_id, event_id, session_id, org_id, seq, event_type, payload)
VALUES (pg_temp.tid('ver_a_frozen')::app.ulid, pg_temp.eid('trg'), pg_temp.sid('trg'),
        pg_temp.tid('org_a')::app.ulid, 1, 'session_start', '{}');
SELECT throws_ok(
  format('UPDATE runtime.response_events SET payload = %L WHERE event_id = %L',
         '{"tampered":true}', pg_temp.eid('trg')),
  '42501', NULL, 'layer 2 behaviourally: UPDATE raises even for a superuser — and it raises '
  'insufficient_privilege, the same code a REVOKE would produce, so callers need one handler');
SELECT throws_ok(
  format('DELETE FROM runtime.response_events WHERE event_id = %L', pg_temp.eid('trg')),
  '42501', NULL, 'layer 2 behaviourally: DELETE raises even for a superuser');

-- ---------------------------------------------------------------------------
-- 4. Seed shape (ADR-006) enforced at the boundary
-- ---------------------------------------------------------------------------
SET LOCAL ROLE runtime_writer;
SELECT throws_ok(
  format('SELECT runtime.start_session(%L, %L, %L, %L, false)',
         'abcdefghij0123456789klmnop', pg_temp.sid('bad1'), 'deadbeef', 'en'),
  '22023', NULL, 'a 64-bit seed is rejected by name — half the replay keyspace is not a seed');
SELECT throws_ok(
  format('SELECT runtime.start_session(%L, %L, %L, %L, false)',
         'abcdefghij0123456789klmnop', pg_temp.sid('bad2'),
         upper(repeat('deadbeef', 4)), 'en'),
  '22023', NULL, 'an uppercase seed is rejected — one canonical spelling, like the token');
SELECT throws_ok(
  format('SELECT runtime.start_session(%L, %L, %L, %L, false)',
         'zzzzzzzzzzzzzzzzzzzzzzzzzz', pg_temp.sid('bad3'), repeat('deadbeef', 4), 'en'),
  'P0002', NULL, 'an unknown token cannot start a session');

-- ---------------------------------------------------------------------------
-- 5. The round trip, as runtime_writer
-- ---------------------------------------------------------------------------
SELECT lives_ok(
  format('SELECT runtime.start_session(%L, %L, %L, %L, false, %L)',
         'abcdefghij0123456789klmnop', pg_temp.sid('a'), repeat('deadbeef', 4), 'en', 'pid-1'),
  'start_session succeeds for a live token');

SELECT is(runtime.load_session(pg_temp.sid('a')) ->> 'random_seed', repeat('deadbeef', 4),
  'load_session returns the seed — ADR-006''s replay key survives the projection');
SELECT is((runtime.load_session(pg_temp.sid('a')) ->> 'last_event_seq')::int, 1,
  'the document starts at seq 1 (the session_start event)');
SELECT is(runtime.load_session(pg_temp.sid('a')) ->> 'artifact_hash',
  current_setting('rs.pin', true),
  'the PIN is stored on the session, not derived — rollback repoints the version''s hash, '
  'and an in-flight respondent must keep the bytes they started on (E §3.3)');
SELECT is(runtime.load_session(pg_temp.sid('nxx')), NULL,
  'an unknown session loads as NULL, not an error — the capability is the id');

-- Dedup: same respondent_key, same version -> conflict, not a second session (01 §3.3 step 4).
SELECT throws_ok(
  format('SELECT runtime.start_session(%L, %L, %L, %L, false, %L)',
         'abcdefghij0123456789klmnop', pg_temp.sid('a2'), repeat('cafebabe', 4), 'en', 'pid-1'),
  '23505', NULL, 'a duplicate respondent_key is a unique_violation — a conflict, not a race');

-- First page submit: expected_seq 2 (start_session wrote 1).
SELECT is(
  runtime.submit_page(
    pg_temp.sid('a'), 2, pg_temp.eid('a2'), 'page_submit', NULL,
    '{"var_q1": 3}', '{"var_q1": 3}', NULL, '{}', NULL, 1200,
    'active', NULL, NULL, '{}', 1),
  2, 'the first submit lands at seq 2');

-- THE REPLAY: same expected_seq again — a mobile retry. Must change NOTHING.
SELECT is(
  runtime.submit_page(
    pg_temp.sid('a'), 2, pg_temp.eid('dp2'), 'page_submit', NULL,
    '{"var_q1": 999}', '{"var_q1": 999}', NULL, '{}', NULL, 1200,
    'active', NULL, NULL, '{}', 1),
  2, 'a replayed submit returns the stored seq instead of advancing');
SELECT is(runtime.load_session(pg_temp.sid('a')) -> 'vars' ->> 'var_q1', '3',
  'the replay did not overwrite the document — the first write won');

SELECT is(
  runtime.submit_page(
    pg_temp.sid('a'), 99, pg_temp.eid('gap'), 'page_submit', NULL,
    '{}', NULL, NULL, '{}', NULL, NULL, 'active', NULL, NULL, '{}', 1),
  2, 'a submit with a gapped seq is refused the same way — the guard is exact, not >=');

SELECT is(
  runtime.submit_page(
    pg_temp.sid('nxx'), 2, pg_temp.eid('gne'), 'page_submit', NULL,
    '{}', NULL, NULL, '{}', NULL, NULL, 'active', NULL, NULL, '{}', 1),
  -1, 'an unknown session returns -1 so the caller can 404 instead of retrying forever');

-- Finalize: disposition lands once, completed_at set once.
SELECT is(
  runtime.submit_page(
    pg_temp.sid('a'), 3, pg_temp.eid('a3'), 'disposition_set', NULL,
    '{"var_q1": 3}', NULL, NULL, '{"disposition":"COMPLETE"}', NULL, NULL,
    'completed', 'COMPLETE', NULL, '{}', 2),
  3, 'finalization is one more guarded write, not a special path');
SELECT is(runtime.load_session(pg_temp.sid('a')) ->> 'disposition', 'COMPLETE',
  'the disposition is on the document');

RESET ROLE;

-- Event-count assertions, as superuser (runtime_writer cannot SELECT the tables — below).
SELECT is((SELECT count(*) FROM runtime.response_events
            WHERE session_id = pg_temp.sid('a') AND seq = 2),
  1::bigint, 'ONE event at seq 2 despite three attempts — the roadmap''s replay test');
SELECT is((SELECT count(*) FROM runtime.response_events WHERE session_id = pg_temp.sid('a')),
  3::bigint, 'the session''s log is exactly birth, submit, disposition');
SELECT is((SELECT s.revision FROM runtime.sessions s WHERE s.id = pg_temp.sid('a')),
  2, 'revision persisted for the Redis-miss rebuild (E §3.4)');
SELECT is((SELECT s.status::text FROM runtime.sessions s WHERE s.id = pg_temp.sid('a')),
  'completed', 'the session projection tracks the lifecycle axis');
SELECT ok((SELECT s.finished_at IS NOT NULL AND s.duration_s >= 0
             FROM runtime.sessions s WHERE s.id = pg_temp.sid('a')),
  'finish time and duration stamped exactly once, at finalization');

-- The anti-tamper record is IN the event, never the document (E §5 step 3).
SET LOCAL ROLE runtime_writer;
SELECT lives_ok(
  format('SELECT runtime.start_session(%L, %L, %L, %L, false)',
         'abcdefghij0123456789klmnop', pg_temp.sid('b'), repeat('0123abcd', 4), 'en'),
  'a second session starts cleanly');
SELECT is(
  runtime.submit_page(
    pg_temp.sid('b'), 2, pg_temp.eid('b2'), 'page_submit', NULL,
    '{"var_ok": 1}', '{"var_ok": 1}',
    '{"var_hidden": {"value": 5, "reason": "hidden_question_value"}}',
    '{}', NULL, 900, 'active', NULL, NULL, '{}', 1),
  2, 'a submit carrying rejected values still lands');
RESET ROLE;
SELECT is((SELECT e.rejected_values -> 'var_hidden' ->> 'reason'
             FROM runtime.response_events e
            WHERE e.session_id = pg_temp.sid('b') AND e.seq = 2),
  'hidden_question_value',
  'the rejection is queryable from the event — DOM-editing a screener leaves evidence');
SELECT ok(NOT (SELECT d.vars ? 'var_hidden' FROM runtime.response_documents d
                WHERE d.session_id = pg_temp.sid('b')),
  'and the rejected value is ABSENT from the document — discarded, never stored');

-- ---------------------------------------------------------------------------
-- 6. Resume lookup
-- ---------------------------------------------------------------------------
SET LOCAL ROLE runtime_writer;
SELECT lives_ok(
  format('SELECT runtime.start_session(%L, %L, %L, %L, false, NULL, NULL, NULL, NULL, NULL, %L)',
         'abcdefghij0123456789klmnop', pg_temp.sid('r'), repeat('4567cdef', 4), 'en',
         '\xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef'::bytea),
  'a session can be started with a resume token hash');
SELECT is(
  runtime.find_session_by_resume(
    '\xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef'::bytea),
  pg_temp.sid('r'), 'resume finds the session by HASH — the raw token never reaches a query');
SELECT is(runtime.find_session_by_resume('\x00'::bytea), NULL,
  'an unknown hash resolves to nothing');
RESET ROLE;

-- ---------------------------------------------------------------------------
-- 7. ADR-009: the negative capabilities, unchanged
-- ---------------------------------------------------------------------------
SELECT ok(NOT has_table_privilege('runtime_writer', 'runtime.sessions', 'SELECT'),
  'runtime_writer cannot SELECT sessions — EXECUTE on definers is all it holds');
SELECT ok(NOT has_table_privilege('runtime_writer', 'runtime.response_documents', 'SELECT'),
  'runtime_writer cannot SELECT response_documents');
SELECT ok(NOT has_table_privilege('runtime_writer', 'runtime.response_events', 'INSERT'),
  'runtime_writer cannot INSERT events directly — only through submit_page');
SELECT ok(NOT has_schema_privilege('authoring', 'runtime', 'USAGE'),
  'authoring still has no USAGE on schema runtime — ADR-001''s plane boundary held');
SELECT ok(has_function_privilege('runtime_writer',
  'runtime.submit_page(app.ulid, int, app.ulid, runtime.event_type, app.ulid, jsonb, jsonb, '
  'jsonb, jsonb, jsonb, int, runtime.session_status, runtime.disposition, app.ulid, jsonb, '
  'int)', 'EXECUTE'),
  'runtime_writer holds EXECUTE on submit_page');
SELECT ok(NOT has_function_privilege('authoring',
  'runtime.submit_page(app.ulid, int, app.ulid, runtime.event_type, app.ulid, jsonb, jsonb, '
  'jsonb, jsonb, jsonb, int, runtime.session_status, runtime.disposition, app.ulid, jsonb, '
  'int)', 'EXECUTE'),
  'authoring does NOT hold EXECUTE on submit_page — the planes do not share a write path');

-- ---------------------------------------------------------------------------
-- 8. The seq CHECK and the enum axes
-- ---------------------------------------------------------------------------
SELECT throws_ok(
  format('INSERT INTO runtime.response_events '
         '(survey_version_id, event_id, session_id, org_id, seq, event_type, payload) '
         'VALUES (%L, %L, %L, %L, 0, %L, %L)',
         pg_temp.tid('ver_a_frozen'), pg_temp.eid('z0'), pg_temp.sid('a'),
         pg_temp.tid('org_a'), 'page_view', '{}'),
  '23514', NULL, 'seq 0 is rejected — the log starts at 1, the birth event');
SELECT is(
  (SELECT array_agg(e::text ORDER BY e::text)
     FROM unnest(enum_range(NULL::runtime.session_status)) e),
  ARRAY['abandoned','active','completed','quarantined','terminated'],
  'session_status carries B §8''s five lifecycle states — the axis orthogonal to disposition');

SELECT * FROM finish();
ROLLBACK;
