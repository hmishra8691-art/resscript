/**
 * Task 52: GET /s/{token} entry endpoint.
 *
 * Resolve survey token, create session, render first page.
 * Per Deliverable E §2.1: entry initializes seed, creates SessionState,
 * determines first page, applies masking/randomization/logic.
 */

import { randomBytes } from 'node:crypto';
import { createLogger } from '@resscript/observability';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SessionState, MachineState } from './session/types.js';

const log = createLogger({ service: 'runtime-entry' });

export interface EntryRequest {
  token: string;
  language?: string;
  vendor_ref?: string;
}

export interface EntryResponse {
  session_id: string;
  respondent_id: string;
  survey_id: string;
  artifact_hash: string;
  first_page_id: string | null;
  page: PageRenderData | null;
  disposition?: string; // if immediately terminated
}

export interface PageRenderData {
  page_id: string;
  questions: QuestionRenderData[];
}

export interface QuestionRenderData {
  id: string;
  type: string;
  label: string;
  items?: RenderedItem[];
}

export interface RenderedItem {
  code: string;
  label: string;
}

/**
 * Generate a ULID (128-bit random ID in base36).
 * For P1-09, simplified: uses current timestamp + 80 bits random.
 */
export function generateULID(): string {
  const now = Date.now();
  const random = randomBytes(10);

  // Timestamp: ms since epoch, 48 bits (enough until year 10889)
  const ts = now.toString(36).padStart(10, '0');

  // Random: 80 bits (10 bytes) in base36
  let rnd = '';
  for (let i = 0; i < 10; i++) {
    rnd += random[i]!.toString(36);
  }

  return (ts + rnd).toUpperCase().slice(0, 26);
}

/**
 * Generate a 128-bit random seed in hex.
 * Used to seed the PRNG for all randomization in the session.
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
    survey_version: 0, // stub
    artifact_hash: params.artifact_hash,
    schema_version: 1,

    // Provenance
    vendor_ref: null,
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
      node_id: 'fn_start' as any, // TODO: get from artifact once loaded
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
  };
}

/**
 * Unit test: ULID generation produces valid 26-character strings.
 */
export function testULIDGeneration(): boolean {
  const ulid = generateULID();
  // ULID: 26 alphanumeric (base36)
  return /^[A-Z0-9]{26}$/.test(ulid);
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
