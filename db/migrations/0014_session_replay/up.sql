-- 0014_session_replay — runtime.replay_session, the read that makes E §12.3's `preview.replay`
-- real: one session's seed, its pin, and its recorded inputs in seq order (roadmap P1-11).
--
-- P1-11's last open acceptance line, verbatim: "A programmer takes a session id from a completed
-- test response, pastes it into the debug panel, and steps through the exact pages, option orders
-- and rule verdicts that respondent saw." E §12.3 calls `preview.replay` "the highest-value
-- message in the list", because it turns "the client says the rotation is wrong" (ADR-006) into a
-- five-minute investigation. Three earlier decisions are what make it a READ rather than a
-- simulation, and this function returns exactly what they make sufficient: ADR-006 (every
-- randomization decision is a pure function of random_seed), ADR-007 (response_events is the
-- source of truth, so the inputs are still on disk), E §2.3 (the machine is a pure reducer, so
-- seed + recorded inputs re-drive it). Nothing here re-simulates with fresh values and nothing
-- here is a new randomness source.
--
-- ADR-001 is why replay needs a migration at all: runtime_writer holds NO table privilege in
-- schema runtime, so a new read is a new SECURITY DEFINER function or it is nothing.
--
-- THE DECISION THIS FILE HAD TO MAKE — is_test only, or production too? PRODUCTION TOO, with the
-- events returned to the runtime and the redaction done there:
--   * E §12.3 asks for precisely that: "Take a real PRODUCTION session id, load its seed and its
--     recorded inputs". The dispute replay exists to settle is always about a production
--     respondent, and API §2.14 already mints the capability for it —
--     `POST /v1/sessions/{id}/replay-token`, PRG+, scope `responses:read`.
--   * A production session's `"values"` DO carry pii variables. Security §8.1's answer to that is
--     not exclusion but REDACTION AT TRACE CONSTRUCTION, inside the runtime, for everyone
--     including Owners — "a trace is a debugging artifact and there is no debugging reason to see
--     a respondent's email" (security §7's "Reviewer and debug traces" bullet). The runtime holds
--     the artifact manifest that carries the pii flags; this function does not, and giving it one
--     would mean joining content.variables out of schema runtime — a plane crossing for a policy
--     the runtime already enforces better.
--   * So: the DATABASE decides WHO may read (runtime_writer alone, §2), the RUNTIME decides WHAT
--     a human sees (pii values as ●●●● per E §14.2, and the artifact_hash in the replay URL must
--     equal the session's pin or the request is a 404). Recorded here because the alternative —
--     is_test only — READS safer and is not: it would leave the pii path untested while making
--     the debug panel useless for the one dispute it exists to settle.
--
-- SHAPE: RETURNS TABLE, the session's columns repeated on every event row, ordered by seq. A
-- session with no events cannot exist — 0011 §6 writes the session row and its session_start
-- event in one transaction — so the join never loses a session, and the caller reads the session
-- fields off the first row. load_session's jsonb was the alternative precedent, but replay's
-- payload is a TAIL (one row per submit, hundreds for a long interview) and a jsonb_agg of the
-- whole tail is one value the server must materialize whole before the caller sees a byte.
--
-- Migration header first (B §14, read by tools/ci/lint-migrations.mjs from the first 60 lines).
-- Everything here is expand-only: one read function and its grants. No tables, no policies, no
-- renames, no in-place type changes, no defaults materialized over existing rows.
SET lock_timeout = '3s';
SET statement_timeout = '120s';

-- ---------------------------------------------------------------------------
-- 0. What this migration deliberately does NOT return, and does not create
-- ---------------------------------------------------------------------------
--   * rejected_values, client_trace, duration_ms. Replay re-drives the pipeline with what the
--     server ACCEPTED, because that is what the respondent's state was built from; the rejections
--     are E §5 step 3's anti-tamper record — a different question, with a different reader (API
--     §2.14's GET /v1/sessions/{id}/events). Feeding them back in would replay values the server
--     discarded and produce a session no respondent ever had.
--   * A LIMIT or a keyset. A truncated replay is not a shorter replay, it is a WRONG one: the
--     machine is a reducer over the whole input list, so dropping the tail silently changes every
--     verdict after the cut. The bound is one session's own history, and statement_timeout below
--     is the backstop for a pathological one.
--   * An event_type filter. Which events DRIVE the machine (page_submit) and which are context
--     (resume, answers_invalidated, disposition_set, logic_divergence) is the runtime's reading of
--     its own log; deciding it here would make every future replay refinement a new migration.
--   * An index on response_events. 0011 §0 rules secondary indexes off that table by name — an
--     index probe per insert on the hottest write path in the system, multiplied by partition —
--     and this read does not need one: see §1's prune.
--   * An is_test restriction. See the header; the position is deliberate and enforced by returning
--     the events to the one role that can redact them.

-- ---------------------------------------------------------------------------
-- 1. runtime.replay_session (roadmap P1-11, E §12.3)
-- ---------------------------------------------------------------------------
-- LANGUAGE sql STABLE, like load_session and find_session_by_resume: one query, no branches, and
-- no plpgsql variable that would have to be named `values` — a quoted reserved word is bearable in
-- a column list and intolerable as an identifier a body assigns to (0011 §4's erratum note).
--
-- THE PRUNE, which is the whole performance story: response_events is RANGE(created_at) monthly,
-- sub-partitioned HASH(survey_version_id) 8 ways, with no secondary index. A read keyed on
-- session_id ALONE therefore scans every leaf of every month. The join carries two more facts from
-- the session row — its survey_version_id (one hash leaf per month) and its started_at (the months
-- an event can possibly be in) — so the executor prunes to a handful of leaves instead. The
-- created_at bound is sound rather than approximate: start_session writes both rows in ONE
-- transaction and both timestamps default to now(), which is transaction time, so the birth event's
-- created_at equals the session's started_at exactly, and every later event is later.
CREATE FUNCTION runtime.replay_session(p_session_id app.ulid)
RETURNS TABLE (
  session_id        app.ulid,
  survey_version_id app.ulid,
  random_seed       text,
  artifact_hash     app.sha256,
  language          text,
  is_test           boolean,
  started_at        timestamptz,
  seq               int,
  event_type        text,
  page_id           app.ulid,
  "values"          jsonb,
  payload           jsonb
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = '' SET statement_timeout = '5s' AS $$
  SELECT s.id, s.survey_version_id, s.random_seed, s.artifact_hash, s.language, s.is_test,
         s.started_at, e.seq, e.event_type::text, e.page_id, e."values", e.payload
    FROM runtime.sessions s
    JOIN runtime.response_events e
      ON e.survey_version_id = s.survey_version_id
     AND e.session_id        = s.id
     AND e.created_at       >= s.started_at
   WHERE s.id = p_session_id
   ORDER BY e.seq
$$;
-- 5s rather than the 3s every other runtime RPC carries: those are single-row writes on the
-- respondent hot path, and this is a multi-row read on a debugging path where a programmer is
-- watching a spinner. Still a ceiling, because a definer function with no timeout is a way to hold
-- a connection open with a crafted id.

COMMENT ON FUNCTION runtime.replay_session(app.ulid) IS
  'E §12.3''s preview.replay, server side (roadmap P1-11): one session''s seed, pin, language, '
  'is_test flag and version, plus its event tail in seq order — the exact inputs needed to '
  're-drive the pure reducer over the pinned artifact and render what that respondent saw. '
  'PRODUCTION sessions included on purpose (see the migration header): the database decides who '
  'may read, the runtime redacts pii values before anything leaves it (security §8.1, E §14.2). '
  'Returns zero rows for an unknown session rather than raising — the session id, reached through '
  'a signed replay token, IS the capability, exactly as in load_session. Ordered by seq, which is '
  'unique per session because submit_page''s last_event_seq guard makes it so.';

ALTER FUNCTION runtime.replay_session(app.ulid) OWNER TO runtime_rpc_owner;
-- 0006's invariant: no function is executable by PUBLIC. The grant list is ONE role — not
-- authoring, which has no USAGE on schema runtime at all (ADR-001), and not analytics_reader,
-- whose plane is schema export (B §11). The runtime is the only process that can redact.
REVOKE EXECUTE ON FUNCTION runtime.replay_session(app.ulid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION runtime.replay_session(app.ulid) TO runtime_writer;
