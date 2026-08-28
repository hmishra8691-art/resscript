/**
 * Session identity and initialization for survey entry (E §2.1, §3.1).
 *
 * Routing and the response shape live in `handler.ts`; this module owns only what a new session is
 * made of — its ids, its seed, and the initial `SessionState`.
 */

import { randomBytes } from 'node:crypto';
import type { SessionState, MachineState } from './session/types.js';

/**
 * Crockford base32: no I, L, O or U, so a transcribed id cannot be misread.
 *
 * Must match `ULID_BODY_PATTERN` in `@resscript/schema`'s `ids.ts`, which is the alphabet
 * Deliverable B's `app.ulid` domain constrains ids to. Not imported because that module exports the
 * pattern, not the alphabet.
 */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * Generate a ULID: 10 characters of 48-bit millisecond timestamp, then 16 of randomness.
 *
 * Exactly 26 Crockford base32 characters, first in `[0-7]` — the shape `ULID_BODY_PATTERN`
 * requires, and therefore the shape `asId` accepts. The first character cannot exceed 7 because a
 * 48-bit millisecond timestamp does not overflow into the top bits until the year 10889.
 *
 * The previous implementation was base36-uppercased and sliced to 26, which failed twice over:
 *
 *   - **0.81% of ids were 23–25 characters.** Each random byte became `toString(36)`, which is one
 *     character for a byte under 36 and two above it, so the total varied between 20 and 30 and the
 *     slice truncated rather than padded. Measured over 20,000 draws.
 *   - **They were not ULIDs.** Uppercased base36 contains I, L, O and U, so most ids did not match
 *     the schema's own pattern. `session_id` is the export join key (E §3.1) and `respondent_id` is
 *     stable across resume; an id that `asId` would reject is one that cannot be re-parsed by
 *     anything downstream that treats it as an id rather than an opaque string.
 *
 * Lexicographic order still tracks creation time to the millisecond, which is what makes a ULID
 * preferable to a UUID for a primary key.
 */
export function generateULID(): string {
  // 48 bits of timestamp, big-endian, as 10 base32 characters (10 x 5 = 50 bits, so the top 2 are
  // always zero and the first character stays in [0-7]).
  const now = Date.now();
  let out = '';
  for (let i = 9; i >= 0; i--) {
    // Math.floor rather than a shift: `now` exceeds 32 bits, and `>>>` would silently truncate it.
    out += CROCKFORD[Math.floor(now / 32 ** i) % 32];
  }

  // 16 characters of randomness, one per byte. `% 32` is unbiased here because 256 is an exact
  // multiple of 32 — folding a 0-255 byte into a range that did not divide it evenly would skew the
  // low codes, which is the classic modulo-bias bug.
  const bytes = randomBytes(16);
  for (let i = 0; i < 16; i++) {
    out += CROCKFORD[bytes[i]! % 32];
  }

  return out;
}

/**
 * A 128-bit random seed in hex — the session's entire source of randomness (ADR-006).
 *
 * Captured once at entry and never changed, which is what makes every randomization decision in the
 * session re-derivable rather than stored.
 */
export function generateSeed(): string {
  return randomBytes(16).toString('hex');
}

/**
 * Initialize a new session from entry parameters.
 *
 * Returns a SessionState ready for state machine evaluation.
 * For P1-09, this is a stub that initializes state without
 * loading artifact or evaluating logic (those are separate).
 */
export function createSession(params: {
  session_id: string;
  respondent_id: string;
  survey_id: string;
  artifact_hash: string;
  random_seed: string;
  language: string;
}): SessionState {
  const now = Date.now();

  const machineState: MachineState = { state: 'CREATED' };

  return {
    // Identity
    session_id: params.session_id,
    respondent_id: params.respondent_id,
    survey_id: params.survey_id,
    // Overwritten by the caller from the resolved token.
    survey_version_id: '',
    artifact_hash: params.artifact_hash,
    schema_version: 1,

    // Provenance
    vendor_ref: null,
    // Resolved by the entry handler from the rotation counter, once per session (P2-03).
    rotation_index: null,
    entry_params: {},
    language: params.language,
    device: { class: 'desktop', ua_class: 'unknown' }, // parsed from User-Agent later
    geo: { country: 'unknown', region: null },
    is_test: false,

    // The authoritative data
    random_seed: params.random_seed,
    vars: {},
    var_provenance: {},

    // Position
    machine_state: machineState,
    current_page_id: null,
    history: [],
    flow_cursor: {
      // A placeholder: `step(…, { i: 'enter' })` locates the graph's real start node and overwrites
      // this, deliberately ignoring whatever the stored cursor said so a tampered or replayed
      // session cannot enter mid-flow.
      node_id: 'fn_start' as SessionState['flow_cursor']['node_id'],
      iteration_stack: [],
    },

    // Quota
    reservations: [],
    quota_cells: {},
    soft_quota_flags: [],

    // Outcome
    disposition: null,
    custom_key: null,
    quality_flags: [],

    // Timings
    started_at: now,
    last_activity_at: now,
    finalized_at: null,
    page_timings: {},
    server_time_ms: now,

    // Integrity
    revision: 0,
    resume_token_hash: null,
    last_event_seq: 0,
    last_submit: null,
  };
}

/**
 * The shape a ULID body must have — `ULID_BODY_PATTERN` from `@resscript/schema`.
 *
 * Duplicated as a literal rather than imported so this check cannot pass by agreeing with itself:
 * if the schema's pattern changes, `conformance.test.ts` is where the two are reconciled.
 */
const ULID_RE = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

/**
 * Unit test: ULID generation produces ids the schema would accept.
 *
 * Asserts the Crockford pattern, not `[A-Z0-9]{26}` — the looser form passed for the previous
 * implementation, which emitted I, L, O and U and ids as short as 23 characters.
 */
export function testULIDGeneration(): boolean {
  return ULID_RE.test(generateULID());
}

/**
 * Unit test: seed generation produces hex strings.
 */
export function testSeedGeneration(): boolean {
  const seed = generateSeed();
  // 128 bits = 32 hex chars
  return /^[a-f0-9]{32}$/.test(seed);
}

/**
 * Unit test: session creation produces valid state.
 */
export function testSessionCreation(): boolean {
  const session = createSession({
    session_id: 'test-session',
    respondent_id: 'test-respondent',
    survey_id: 'test-survey',
    artifact_hash: 'test-hash',
    random_seed: 'a'.repeat(32),
    language: 'en',
  });

  return (
    session.session_id === 'test-session' &&
    session.artifact_hash === 'test-hash' &&
    session.machine_state.state === 'CREATED' &&
    Object.keys(session.vars).length === 0
  );
}
