/**
 * Integration test for the machine seam.
 *
 * `packages/runtime-core`'s machine is generic over a narrow structural session type, and
 * `apps/runtime`'s `SessionState` is meant to satisfy it. Unit tests in `runtime-core` prove
 * the machine's behaviour against its own fixtures; this file proves the *seam* — that a real
 * `SessionState` built by `createSession` drives the real `step` against artifact-shaped
 * input, with branded ids intact.
 *
 * Without this, the two halves could drift and only fail at the first respondent.
 */

import { describe, it, expect } from 'vitest';
import type { CompiledArtifact } from '@resscript/schema';
import { createSession, generateSeed, generateULID } from '../entry.js';
import { deriveKey, sfc32Counter } from '@resscript/runtime-core';
import { makeCtx, step, type Cmd } from './index.js';

/**
 * A three-page linear survey.
 *
 * Only `graph` and `pages` are populated: those are the sections the machine reads (E §2.3),
 * and stubbing the other five would assert nothing while making the fixture unreadable. The
 * cast is the honest way to say "this is the subset under test".
 */
function linearArtifact(): CompiledArtifact {
  return {
    graph: {
      page_order: ['pg_1', 'pg_2', 'pg_3'],
      nodes: [
        { id: 'fn_start', type: 'start', next: 'fn_seq' },
        { id: 'fn_seq', type: 'sequence', target_id: 'blk_main', next: 'fn_end' },
        { id: 'fn_end', type: 'end', disposition: 'COMPLETE' },
      ],
      page_entry: { pg_1: 'fn_seq', pg_2: 'fn_seq', pg_3: 'fn_seq' },
    },
    pages: {
      pg_1: { id: 'pg_1', block_path: ['blk_main'] },
      pg_2: { id: 'pg_2', block_path: ['blk_main'] },
      pg_3: { id: 'pg_3', block_path: ['blk_main'] },
    },
  } as unknown as CompiledArtifact;
}

/** A screener that branches on one condition, then completes or screens out. */
function screenerArtifact(): CompiledArtifact {
  return {
    graph: {
      page_order: ['pg_screen', 'pg_main'],
      nodes: [
        { id: 'fn_start', type: 'start', next: 'fn_seq_screen' },
        { id: 'fn_seq_screen', type: 'sequence', target_id: 'pg_screen', next: 'fn_br' },
        {
          id: 'fn_br',
          type: 'branch',
          branches: [
            { condition: { k: 'qualified' }, next: 'fn_seq_main' },
            { condition: null, next: 'fn_so' },
          ],
        },
        { id: 'fn_seq_main', type: 'sequence', target_id: 'pg_main', next: 'fn_end' },
        { id: 'fn_so', type: 'termination', disposition: 'SCREENOUT' },
        { id: 'fn_end', type: 'end', disposition: 'COMPLETE' },
      ],
      page_entry: { pg_screen: 'fn_seq_screen', pg_main: 'fn_seq_main' },
    },
    pages: {
      pg_screen: { id: 'pg_screen', block_path: [] },
      pg_main: { id: 'pg_main', block_path: [] },
    },
  } as unknown as CompiledArtifact;
}

function newSession(seed = 'a'.repeat(32)) {
  return createSession({
    session_id: generateULID(),
    respondent_id: generateULID(),
    survey_id: generateULID(),
    artifact_hash: 'deadbeef',
    random_seed: seed,
    language: 'en',
  });
}

/** The context the runtime builds per request: seeded PRNG, injected clock. */
function requestCtx(seed: string, opts: { now_ms?: number; qualified?: boolean } = {}) {
  return makeCtx({
    now_ms: opts.now_ms ?? 1_000,
    random: salt => sfc32Counter(deriveKey(seed, salt), 0),
    evalCondition: () => opts.qualified ?? true,
  });
}

function renders(cmds: Cmd[]): string[] {
  return cmds.filter(c => c.c === 'render').map(c => (c as { page_id: string }).page_id);
}

describe('machine seam', () => {
  it('a real SessionState drives the pure machine', () => {
    const s = newSession();
    const r = step(s, { i: 'enter' }, linearArtifact(), requestCtx(s.random_seed));

    expect(r.next.machine_state.state).toBe('PAGE_LOOP');
    expect(r.next.current_page_id).toBe('pg_1');
    expect(renders(r.cmds)).toEqual(['pg_1']);
  });

  it('preserves every field createSession set', () => {
    const s = newSession();
    const r = step(s, { i: 'enter' }, linearArtifact(), requestCtx(s.random_seed));

    expect(r.next.session_id).toBe(s.session_id);
    expect(r.next.respondent_id).toBe(s.respondent_id);
    expect(r.next.artifact_hash).toBe(s.artifact_hash);
    expect(r.next.random_seed).toBe(s.random_seed);
    expect(r.next.language).toBe('en');
  });

  it('drives a full linear session to COMPLETE', () => {
    const art = linearArtifact();
    const s0 = newSession();
    const ctx = requestCtx(s0.random_seed);

    let s = step(s0, { i: 'enter' }, art, ctx).next;
    const seen: string[] = [];
    for (let i = 0; i < 10 && s.current_page_id && s.machine_state.state !== 'FINALIZED'; i++) {
      seen.push(s.current_page_id);
      s = step(s, { i: 'submitted', page_id: s.current_page_id }, art, ctx).next;
    }

    expect(seen).toEqual(['pg_1', 'pg_2', 'pg_3']);
    expect(s.machine_state.state).toBe('FINALIZED');
    expect(s.disposition).toBe('COMPLETE');
  });

  it('records a page visit per page, with submit timestamps', () => {
    const art = linearArtifact();
    const s0 = newSession();

    let s = step(s0, { i: 'enter' }, art, requestCtx(s0.random_seed, { now_ms: 1_000 })).next;
    s = step(
      s,
      { i: 'submitted', page_id: 'pg_1' },
      art,
      requestCtx(s0.random_seed, { now_ms: 2_000 }),
    ).next;

    expect(s.history.map(v => v.page_id)).toEqual(['pg_1', 'pg_2']);
    expect(s.history[0]?.entered_at).toBe(1_000);
    expect(s.history[0]?.submitted_at).toBe(2_000);
    expect(s.history[1]?.submitted_at).toBeNull();
  });

  it('screens out on the else arm', () => {
    const art = screenerArtifact();
    const s0 = newSession();
    const ctx = requestCtx(s0.random_seed, { qualified: false });

    let s = step(s0, { i: 'enter' }, art, ctx).next;
    expect(s.current_page_id).toBe('pg_screen');

    const r = step(s, { i: 'submitted', page_id: 'pg_screen' }, art, ctx);

    expect(r.next.machine_state.state).toBe('FINALIZED');
    expect(r.next.disposition).toBe('SCREENOUT');
    expect(r.cmds.map(c => c.c)).toEqual(['release_quota', 'finalize']);
  });

  it('qualifies through to the main block', () => {
    const art = screenerArtifact();
    const s0 = newSession();
    const ctx = requestCtx(s0.random_seed, { qualified: true });

    let s = step(s0, { i: 'enter' }, art, ctx).next;
    s = step(s, { i: 'submitted', page_id: 'pg_screen' }, art, ctx).next;

    expect(s.current_page_id).toBe('pg_main');
    expect(s.machine_state.state).toBe('PAGE_LOOP');
  });
});

describe('replay (ADR-006)', () => {
  it('the same seed and inputs reproduce the same session', () => {
    const art = linearArtifact();
    const seed = generateSeed();
    const inputs = [
      { i: 'enter' as const },
      { i: 'submitted' as const, page_id: 'pg_1' },
      { i: 'submitted' as const, page_id: 'pg_2' },
      { i: 'submitted' as const, page_id: 'pg_3' },
    ];

    // Fix the identity fields so only seed-and-input-derived state can differ.
    const base = createSession({
      session_id: 'S',
      respondent_id: 'R',
      survey_id: 'V',
      artifact_hash: 'h',
      random_seed: seed,
      language: 'en',
    });
    const run = () =>
      inputs.reduce((s, i) => step(s, i, art, requestCtx(seed)).next, base);

    expect(run()).toEqual(run());
    expect(run().disposition).toBe('COMPLETE');
  });

  it('a different seed leaves the flow identical but the draws different', () => {
    // The flow of a survey with no randomizer must not depend on the seed. If it did, replay
    // would be the only way to know which pages a respondent saw.
    const art = linearArtifact();
    const a = newSession('1'.repeat(32));
    const b = newSession('2'.repeat(32));

    const ra = step(a, { i: 'enter' }, art, requestCtx(a.random_seed));
    const rb = step(b, { i: 'enter' }, art, requestCtx(b.random_seed));

    expect(ra.next.current_page_id).toBe(rb.next.current_page_id);
    expect(sfc32Counter(deriveKey(a.random_seed, 'grp:x'), 0)).not.toBe(
      sfc32Counter(deriveKey(b.random_seed, 'grp:x'), 0),
    );
  });
});
