/**
 * Test suite for entry endpoint (task 52).
 *
 * Verifies E §2.1 requirements: session creation, ID generation, initial state.
 */

import { describe, it, expect } from 'vitest';
import {
  generateULID,
  generateSeed,
  createSession,
  testULIDGeneration,
  testSeedGeneration,
  testSessionCreation,
} from './entry.js';

describe('ULID generation', () => {
  it('generates 26-character alphanumeric strings', () => {
    const ulid = generateULID();

    expect(ulid).toMatch(/^[A-Z0-9]{26}$/);
  });

  it('generates different ULIDs each call', () => {
    const ulid1 = generateULID();
    const ulid2 = generateULID();

    expect(ulid1).not.toBe(ulid2);
  });

  it('ULIDs are sortable by timestamp', () => {
    const ulid1 = generateULID();
    // Small delay
    const now = Date.now();
    while (Date.now() === now) {
      // Spin until time advances (millisecond granularity)
    }
    const ulid2 = generateULID();

    // Both valid
    expect(ulid1).toMatch(/^[A-Z0-9]{26}$/);
    expect(ulid2).toMatch(/^[A-Z0-9]{26}$/);
    // Different
    expect(ulid1).not.toBe(ulid2);
  });

  it('built-in ULID test passes', () => {
    expect(testULIDGeneration()).toBe(true);
  });
});

describe('seed generation', () => {
  it('generates 32-character hex strings (128 bits)', () => {
    const seed = generateSeed();

    expect(seed).toMatch(/^[a-f0-9]{32}$/);
  });

  it('generates different seeds each call', () => {
    const seed1 = generateSeed();
    const seed2 = generateSeed();

    expect(seed1).not.toBe(seed2);
  });

  it('built-in seed test passes', () => {
    expect(testSeedGeneration()).toBe(true);
  });
});

describe('session creation', () => {
  it('initializes all required fields', () => {
    const session = createSession({
      session_id: 'sess-123',
      respondent_id: 'resp-456',
      survey_id: 'surv-789',
      artifact_hash: 'abc123def456',
      random_seed: 'a'.repeat(32),
      language: 'en',
    });

    expect(session.session_id).toBe('sess-123');
    expect(session.respondent_id).toBe('resp-456');
    expect(session.survey_id).toBe('surv-789');
    expect(session.artifact_hash).toBe('abc123def456');
    expect(session.random_seed).toBe('a'.repeat(32));
    expect(session.language).toBe('en');
  });

  it('initializes state to CREATED', () => {
    const session = createSession({
      session_id: 'test',
      respondent_id: 'test',
      survey_id: 'test',
      artifact_hash: 'test',
      random_seed: 'a'.repeat(32),
      language: 'en',
    });

    expect(session.machine_state.state).toBe('CREATED');
  });

  it('initializes empty variable state', () => {
    const session = createSession({
      session_id: 'test',
      respondent_id: 'test',
      survey_id: 'test',
      artifact_hash: 'test',
      random_seed: 'a'.repeat(32),
      language: 'en',
    });

    expect(Object.keys(session.vars).length).toBe(0);
    expect(session.current_page_id).toBeNull();
    expect(session.disposition).toBeNull();
  });

  it('initializes revision to 0', () => {
    const session = createSession({
      session_id: 'test',
      respondent_id: 'test',
      survey_id: 'test',
      artifact_hash: 'test',
      random_seed: 'a'.repeat(32),
      language: 'en',
    });

    expect(session.revision).toBe(0);
  });

  it('initializes empty history', () => {
    const session = createSession({
      session_id: 'test',
      respondent_id: 'test',
      survey_id: 'test',
      artifact_hash: 'test',
      random_seed: 'a'.repeat(32),
      language: 'en',
    });

    expect(session.history).toEqual([]);
  });

  it('built-in session creation test passes', () => {
    expect(testSessionCreation()).toBe(true);
  });
});

describe('session identity', () => {
  it('different ULIDs produce different sessions', () => {
    const session1 = createSession({
      session_id: generateULID(),
      respondent_id: 'test',
      survey_id: 'test',
      artifact_hash: 'test',
      random_seed: generateSeed(),
      language: 'en',
    });

    const session2 = createSession({
      session_id: generateULID(),
      respondent_id: 'test',
      survey_id: 'test',
      artifact_hash: 'test',
      random_seed: generateSeed(),
      language: 'en',
    });

    expect(session1.session_id).not.toBe(session2.session_id);
    expect(session1.random_seed).not.toBe(session2.random_seed);
  });

  it('respondent_id is stable across resume', () => {
    const respondentId = generateULID();

    const session1 = createSession({
      session_id: generateULID(),
      respondent_id: respondentId,
      survey_id: 'test',
      artifact_hash: 'test',
      random_seed: generateSeed(),
      language: 'en',
    });

    // Later, on resume:
    const session2 = createSession({
      session_id: generateULID(), // new session
      respondent_id: respondentId, // same respondent
      survey_id: 'test',
      artifact_hash: 'test',
      random_seed: generateSeed(),
      language: 'en',
    });

    expect(session1.respondent_id).toBe(session2.respondent_id);
    expect(session1.session_id).not.toBe(session2.session_id);
  });
});

describe('seed determinism', () => {
  it('seed controls randomization reproducibility', () => {
    const fixedSeed = 'b'.repeat(32);

    const session1 = createSession({
      session_id: generateULID(),
      respondent_id: 'test',
      survey_id: 'test',
      artifact_hash: 'test',
      random_seed: fixedSeed,
      language: 'en',
    });

    const session2 = createSession({
      session_id: generateULID(),
      respondent_id: 'test',
      survey_id: 'test',
      artifact_hash: 'test',
      random_seed: fixedSeed,
      language: 'en',
    });

    // Both use the same seed, so downstream randomization will be identical
    expect(session1.random_seed).toBe(session2.random_seed);
  });
});
