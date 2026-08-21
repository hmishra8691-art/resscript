/**
 * Test suite for the page state machine (tasks 51, 53).
 *
 * The machine is a pure reducer, so the tests are a table of fixtures: build a graph, feed
 * inputs, assert the state and the emitted commands. No Redis, no Postgres, no clock.
 */

import { describe, it, expect } from 'vitest';
import {
  step,
  pagesForNode,
  type Cmd,
  type FlowNodeLike,
  type Input,
  type MachineArtifact,
  type MachineSession,
  type PureCtx,
} from './machine.js';

/* ---------------------------------------------------------------- *
 * Fixture builders
 * ---------------------------------------------------------------- */

/**
 * Build an artifact from flow nodes plus a page list.
 *
 * `entry` is the flow node that owns the page — the compiler's `page_entry` index, which is what
 * the machine routes on. Defaults to `fn_seq` because most fixtures have one sequence node.
 */
function artifact(
  nodes: FlowNodeLike[],
  pages: Array<{ id: string; entry?: string }>,
): MachineArtifact {
  return {
    graph: {
      page_order: pages.map(p => p.id),
      nodes,
      page_entry: Object.fromEntries(pages.map(p => [p.id, p.entry ?? 'fn_seq'])),
    },
  };
}

function session(overrides: Partial<MachineSession> = {}): MachineSession {
  return {
    machine_state: { state: 'CREATED' },
    current_page_id: null,
    flow_cursor: { node_id: 'fn_start', iteration_stack: [] },
    history: [],
    disposition: null,
    custom_key: null,
    last_activity_at: 0,
    server_time_ms: 0,
    revision: 0,
    ...overrides,
  };
}

function ctx(overrides: Partial<PureCtx> = {}): PureCtx {
  return {
    now_ms: 1_000,
    random: () => 0.5,
    evalCondition: () => true,
    ...overrides,
  };
}

/** A three-page linear survey: start → sequence(blk_main) → end(COMPLETE). */
function linearSurvey() {
  return artifact(
    [
      { id: 'fn_start', type: 'start', next: 'fn_seq' },
      { id: 'fn_seq', type: 'sequence', target_id: 'blk_main', next: 'fn_end' },
      { id: 'fn_end', type: 'end', disposition: 'COMPLETE' },
    ],
    [
      { id: 'pg_1', entry: 'fn_seq' },
      { id: 'pg_2', entry: 'fn_seq' },
      { id: 'pg_3', entry: 'fn_seq' },
    ],
  );
}

function renders(cmds: Cmd[]): string[] {
  return cmds.filter(c => c.c === 'render').map(c => (c as { page_id: string }).page_id);
}

function kinds(cmds: Cmd[]): string[] {
  return cmds.map(c => c.c);
}

/** Drive a survey from entry to finalization, returning every state and command batch. */
function runToCompletion(art: MachineArtifact, c: PureCtx = ctx(), maxSteps = 50) {
  let s = session();
  const log: Array<{ input: Input; cmds: Cmd[]; state: string }> = [];
  let r = step(s, { i: 'enter' }, art, c);
  log.push({ input: { i: 'enter' }, cmds: r.cmds, state: r.next.machine_state.state });
  s = r.next;

  for (let i = 0; i < maxSteps; i++) {
    if (s.machine_state.state === 'FINALIZED') break;
    if (s.current_page_id === null) break;
    const input: Input = { i: 'submitted', page_id: s.current_page_id };
    r = step(s, input, art, c);
    log.push({ input, cmds: r.cmds, state: r.next.machine_state.state });
    s = r.next;
  }
  return { final: s, log };
}

/* ---------------------------------------------------------------- *
 * Graph helpers
 * ---------------------------------------------------------------- */

describe('pagesForNode', () => {
  it('resolves a flow node to the pages it owns, in page_order', () => {
    expect(pagesForNode(linearSurvey(), 'fn_seq')).toEqual(['pg_1', 'pg_2', 'pg_3']);
  });

  it('returns empty for a node that owns no pages', () => {
    expect(pagesForNode(linearSurvey(), 'fn_end')).toEqual([]);
  });

  it('splits pages across two sequence nodes', () => {
    const art = artifact(
      [
        { id: 'fn_start', type: 'start', next: 'fn_a' },
        { id: 'fn_a', type: 'sequence', target_id: 'blk_a', next: 'fn_b' },
        { id: 'fn_b', type: 'sequence', target_id: 'blk_b', next: 'fn_end' },
        { id: 'fn_end', type: 'end', disposition: 'COMPLETE' },
      ],
      [
        { id: 'pg_1', entry: 'fn_a' },
        { id: 'pg_2', entry: 'fn_b' },
        { id: 'pg_3', entry: 'fn_a' },
      ],
    );

    // page_order is respected, not grouping order: fn_a owns pg_1 and pg_3.
    expect(pagesForNode(art, 'fn_a')).toEqual(['pg_1', 'pg_3']);
    expect(pagesForNode(art, 'fn_b')).toEqual(['pg_2']);
  });

  it('needs no page objects at all', () => {
    // C §17: per-page cost must not scale with survey size, so the machine routes on the graph
    // alone. A MachineArtifact has no `pages` field to read.
    const art = artifact([{ id: 'fn_start', type: 'start', next: null }], [{ id: 'pg_x' }]);
    expect(Object.keys(art.graph.page_entry)).toEqual(['pg_x']);
    expect('pages' in art).toBe(false);
  });
});

/* ---------------------------------------------------------------- *
 * Entry
 * ---------------------------------------------------------------- */

describe('entry', () => {
  it('renders the first page and enters PAGE_LOOP', () => {
    const r = step(session(), { i: 'enter' }, linearSurvey(), ctx());

    expect(r.next.machine_state.state).toBe('PAGE_LOOP');
    expect(r.next.current_page_id).toBe('pg_1');
    expect(renders(r.cmds)).toEqual(['pg_1']);
  });

  it('starts from the start node, not the stored cursor', () => {
    // A tampered session claiming to sit on the last page must still enter at page 1.
    const tampered = session({ flow_cursor: { node_id: 'fn_end', iteration_stack: [] } });
    const r = step(tampered, { i: 'enter' }, linearSurvey(), ctx());

    expect(r.next.current_page_id).toBe('pg_1');
    expect(r.next.machine_state.state).toBe('PAGE_LOOP');
  });

  it('records the first visit with attempt 1', () => {
    const r = step(session(), { i: 'enter' }, linearSurvey(), ctx({ now_ms: 5_000 }));

    expect(r.next.history).toHaveLength(1);
    expect(r.next.history[0]).toMatchObject({
      page_id: 'pg_1',
      entered_at: 5_000,
      submitted_at: null,
      attempt: 1,
    });
  });

  it('bumps revision for optimistic concurrency', () => {
    const r = step(session({ revision: 7 }), { i: 'enter' }, linearSurvey(), ctx());
    expect(r.next.revision).toBe(8);
  });

  it('terminates when the graph has no start node', () => {
    const art = artifact([{ id: 'fn_end', type: 'end', disposition: 'COMPLETE' }], []);
    const r = step(session(), { i: 'enter' }, art, ctx());

    expect(r.next.machine_state.state).toBe('FINALIZED');
    expect(r.next.disposition).toBe('TERMINATE');
    expect(kinds(r.cmds)).toContain('emit_event');
  });

  it('skips invisible leading pages', () => {
    const c = ctx({ isPageVisible: id => id !== 'pg_1' });
    const r = step(session(), { i: 'enter' }, linearSurvey(), c);

    expect(r.next.current_page_id).toBe('pg_2');
  });
});

/* ---------------------------------------------------------------- *
 * Page advance
 * ---------------------------------------------------------------- */

describe('submit and advance', () => {
  it('walks a linear survey to COMPLETE', () => {
    const { final, log } = runToCompletion(linearSurvey());

    expect(final.machine_state.state).toBe('FINALIZED');
    expect(final.disposition).toBe('COMPLETE');
    expect(log.flatMap(l => renders(l.cmds))).toEqual(['pg_1', 'pg_2', 'pg_3']);
  });

  it('commits the quota reservation on COMPLETE, does not release it', () => {
    const { log } = runToCompletion(linearSurvey());
    const last = log[log.length - 1]!;

    expect(kinds(last.cmds)).toContain('commit_quota');
    expect(kinds(last.cmds)).not.toContain('release_quota');
    expect(last.cmds).toContainEqual({ c: 'finalize', disposition: 'COMPLETE' });
  });

  it('stamps submitted_at on the visit it leaves', () => {
    const art = linearSurvey();
    const entered = step(session(), { i: 'enter' }, art, ctx({ now_ms: 1_000 })).next;
    const submitted = step(
      entered,
      { i: 'submitted', page_id: 'pg_1' },
      art,
      ctx({ now_ms: 4_000 }),
    ).next;

    const visit = submitted.history.find(v => v.page_id === 'pg_1');
    expect(visit?.submitted_at).toBe(4_000);
  });

  it('re-renders and does not advance on a stale page submit', () => {
    const art = linearSurvey();
    const s = step(session(), { i: 'enter' }, art, ctx()).next;
    const r = step(s, { i: 'submitted', page_id: 'pg_3' }, art, ctx());

    expect(r.next.current_page_id).toBe('pg_1');
    expect(r.next.revision).toBe(s.revision); // no state change
    expect(renders(r.cmds)).toEqual(['pg_1']);
    expect(r.cmds[0]).toMatchObject({ c: 'emit_event', event: { kind: 'submit.stale_page' } });
  });

  it('skips a page that logic hid mid-survey', () => {
    const art = linearSurvey();
    const c = ctx({ isPageVisible: id => id !== 'pg_2' });
    const { log, final } = runToCompletion(art, c);

    expect(log.flatMap(l => renders(l.cmds))).toEqual(['pg_1', 'pg_3']);
    expect(final.disposition).toBe('COMPLETE');
  });

  it('completes immediately when every page is invisible', () => {
    const c = ctx({ isPageVisible: () => false });
    const r = step(session(), { i: 'enter' }, linearSurvey(), c);

    expect(r.next.machine_state.state).toBe('FINALIZED');
    expect(r.next.disposition).toBe('COMPLETE');
    expect(renders(r.cmds)).toEqual([]);
  });

  it('ignores input once finalized', () => {
    const { final } = runToCompletion(linearSurvey());
    const again = step(final, { i: 'submitted', page_id: 'pg_3' }, linearSurvey(), ctx());

    expect(again.next).toBe(final); // identity — no copy, no revision bump
    expect(again.cmds).toEqual([
      { c: 'emit_event', event: { kind: 'session.already_finalized' } },
    ]);
  });
});

/* ---------------------------------------------------------------- *
 * Branches
 * ---------------------------------------------------------------- */

describe('branch nodes', () => {
  function branchSurvey() {
    return artifact(
      [
        { id: 'fn_start', type: 'start', next: 'fn_br' },
        {
          id: 'fn_br',
          type: 'branch',
          branches: [
            { condition: { op: 'yes' }, next: 'fn_seq_a' },
            { condition: null, next: 'fn_seq_b' },
          ],
        },
        { id: 'fn_seq_a', type: 'sequence', target_id: 'blk_a', next: 'fn_end' },
        { id: 'fn_seq_b', type: 'sequence', target_id: 'blk_b', next: 'fn_end' },
        { id: 'fn_end', type: 'end', disposition: 'COMPLETE' },
      ],
      [
        { id: 'pg_a', entry: 'fn_seq_a' },
        { id: 'pg_b', entry: 'fn_seq_b' },
      ],
    );
  }

  it('takes the matching arm', () => {
    const r = step(session(), { i: 'enter' }, branchSurvey(), ctx({ evalCondition: () => true }));
    expect(r.next.current_page_id).toBe('pg_a');
  });

  it('takes the else arm when the condition is false', () => {
    const r = step(session(), { i: 'enter' }, branchSurvey(), ctx({ evalCondition: () => false }));
    expect(r.next.current_page_id).toBe('pg_b');
  });

  it('takes the else arm when the condition is UNKNOWN', () => {
    // Matches the compiler's CMP-0700 treatment: an unknown does not silently pick a branch.
    const r = step(session(), { i: 'enter' }, branchSurvey(), ctx({ evalCondition: () => null }));
    expect(r.next.current_page_id).toBe('pg_b');
  });

  it('terminates when no arm matches and there is no else', () => {
    const art = artifact(
      [
        { id: 'fn_start', type: 'start', next: 'fn_br' },
        {
          id: 'fn_br',
          type: 'branch',
          branches: [{ condition: { op: 'no' }, next: 'fn_end' }],
        },
        { id: 'fn_end', type: 'end', disposition: 'COMPLETE' },
      ],
      [],
    );
    const r = step(session(), { i: 'enter' }, art, ctx({ evalCondition: () => false }));

    expect(r.next.disposition).toBe('TERMINATE');
    expect(r.cmds[0]).toMatchObject({ event: { kind: 'flow.branch_no_arm' } });
  });

  it('evaluates arms in order and stops at the first match', () => {
    const seen: unknown[] = [];
    const art = artifact(
      [
        { id: 'fn_start', type: 'start', next: 'fn_br' },
        {
          id: 'fn_br',
          type: 'branch',
          branches: [
            { condition: { tag: 1 }, next: 'fn_end' },
            { condition: { tag: 2 }, next: 'fn_end' },
            { condition: null, next: 'fn_end' },
          ],
        },
        { id: 'fn_end', type: 'end', disposition: 'COMPLETE' },
      ],
      [],
    );
    step(
      session(),
      { i: 'enter' },
      art,
      ctx({
        evalCondition: cond => {
          seen.push(cond);
          return true;
        },
      }),
    );

    expect(seen).toEqual([{ tag: 1 }]);
  });
});

/* ---------------------------------------------------------------- *
 * Terminations
 * ---------------------------------------------------------------- */

describe('terminations', () => {
  function screenoutSurvey() {
    return artifact(
      [
        { id: 'fn_start', type: 'start', next: 'fn_term' },
        { id: 'fn_term', type: 'termination', disposition: 'SCREENOUT' },
      ],
      [],
    );
  }

  it('a termination node releases the reservation and finalizes', () => {
    const r = step(session(), { i: 'enter' }, screenoutSurvey(), ctx());

    expect(r.next.machine_state.state).toBe('FINALIZED');
    expect(r.next.disposition).toBe('SCREENOUT');
    expect(kinds(r.cmds)).toEqual(['release_quota', 'finalize']);
  });

  it('carries custom_key for a CUSTOM disposition', () => {
    const art = artifact(
      [
        { id: 'fn_start', type: 'start', next: 'fn_term' },
        {
          id: 'fn_term',
          type: 'termination',
          disposition: 'CUSTOM',
          custom_key: 'over_budget',
        },
      ],
      [],
    );
    const r = step(session(), { i: 'enter' }, art, ctx());

    expect(r.next.disposition).toBe('CUSTOM');
    expect(r.next.custom_key).toBe('over_budget');
    expect(r.cmds).toContainEqual({
      c: 'finalize',
      disposition: 'CUSTOM',
      custom_key: 'over_budget',
    });
  });

  it('an end node with a non-COMPLETE disposition releases rather than commits', () => {
    const art = artifact(
      [
        { id: 'fn_start', type: 'start', next: 'fn_end' },
        { id: 'fn_end', type: 'end', disposition: 'SCREENOUT' },
      ],
      [],
    );
    const r = step(session(), { i: 'enter' }, art, ctx());

    expect(kinds(r.cmds)).toContain('release_quota');
    expect(kinds(r.cmds)).not.toContain('commit_quota');
  });

  it('a terminate input finalizes from any state', () => {
    const art = linearSurvey();
    const mid = step(session(), { i: 'enter' }, art, ctx()).next;
    const r = step(mid, { i: 'terminate', disposition: 'QUALITY' }, art, ctx());

    expect(r.next.machine_state.state).toBe('FINALIZED');
    expect(r.next.disposition).toBe('QUALITY');
    expect(kinds(r.cmds)).toEqual(['release_quota', 'finalize']);
  });
});

/* ---------------------------------------------------------------- *
 * Quota gate
 * ---------------------------------------------------------------- */

describe('quota gate', () => {
  function quotaSurvey() {
    return artifact(
      [
        { id: 'fn_start', type: 'start', next: 'fn_q' },
        {
          id: 'fn_q',
          type: 'quota_gate',
          quota_ref: 'GENDER_AGE',
          on_pass: 'fn_seq',
          on_full: 'fn_qf',
        },
        { id: 'fn_seq', type: 'sequence', target_id: 'blk_main', next: 'fn_end' },
        { id: 'fn_qf', type: 'termination', disposition: 'QUOTA_FULL' },
        { id: 'fn_end', type: 'end', disposition: 'COMPLETE' },
      ],
      [{ id: 'pg_1', entry: 'fn_seq' }],
    );
  }

  it('stops at the gate and asks for a reservation', () => {
    const r = step(session(), { i: 'enter' }, quotaSurvey(), ctx());

    expect(r.next.machine_state.state).toBe('QUOTA_GATE');
    expect(r.next.flow_cursor.node_id).toBe('fn_q');
    expect(r.cmds).toEqual([{ c: 'reserve_quota', quota_ref: 'GENDER_AGE', node_id: 'fn_q' }]);
  });

  it('continues to on_pass when the reserve succeeds', () => {
    const art = quotaSurvey();
    const gated = step(session(), { i: 'enter' }, art, ctx()).next;
    const r = step(gated, { i: 'quota_result', passed: true }, art, ctx());

    expect(r.next.machine_state.state).toBe('PAGE_LOOP');
    expect(r.next.current_page_id).toBe('pg_1');
  });

  it('goes to on_full when the reserve fails', () => {
    const art = quotaSurvey();
    const gated = step(session(), { i: 'enter' }, art, ctx()).next;
    const r = step(gated, { i: 'quota_result', passed: false }, art, ctx());

    expect(r.next.machine_state.state).toBe('FINALIZED');
    expect(r.next.disposition).toBe('QUOTA_FULL');
  });

  it('finalizes QUOTA_FULL without a release when on_full is unset', () => {
    // A full hard cell took no reservation, so there is nothing to release.
    const art = artifact(
      [
        { id: 'fn_start', type: 'start', next: 'fn_q' },
        {
          id: 'fn_q',
          type: 'quota_gate',
          quota_ref: 'Q',
          on_pass: 'fn_end',
          on_full: null,
        },
        { id: 'fn_end', type: 'end', disposition: 'COMPLETE' },
      ],
      [],
    );
    const gated = step(session(), { i: 'enter' }, art, ctx()).next;
    const r = step(gated, { i: 'quota_result', passed: false }, art, ctx());

    expect(r.next.disposition).toBe('QUOTA_FULL');
    expect(kinds(r.cmds)).toEqual(['finalize']);
  });

  it('ignores a quota result when the cursor is not on a gate', () => {
    const art = linearSurvey();
    const onPage = step(session(), { i: 'enter' }, art, ctx()).next;
    const r = step(onPage, { i: 'quota_result', passed: true }, art, ctx());

    expect(r.next).toBe(onPage);
    expect(r.cmds[0]).toMatchObject({ event: { kind: 'quota.unexpected_result' } });
  });
});

/* ---------------------------------------------------------------- *
 * api_call and randomizer
 * ---------------------------------------------------------------- */

describe('api_call', () => {
  it('stops and emits call_api', () => {
    const art = artifact(
      [
        { id: 'fn_start', type: 'start', next: 'fn_api' },
        { id: 'fn_api', type: 'api_call', on_success: 'fn_end', on_error: 'fn_end' },
        { id: 'fn_end', type: 'end', disposition: 'COMPLETE' },
      ],
      [],
    );
    const r = step(session(), { i: 'enter' }, art, ctx());

    expect(r.cmds).toEqual([{ c: 'call_api', node_id: 'fn_api' }]);
    expect(r.next.flow_cursor.node_id).toBe('fn_api');
    expect(r.next.machine_state.state).toBe('CREATED'); // not yet advanced
  });
});

describe('randomizer', () => {
  it('passes through to next (seeded modes derive order, store nothing)', () => {
    const art = artifact(
      [
        { id: 'fn_start', type: 'start', next: 'fn_rand' },
        {
          id: 'fn_rand',
          type: 'randomizer',
          targets: ['blk_a', 'blk_b'],
          mode: 'shuffle',
          next: 'fn_seq',
        },
        { id: 'fn_seq', type: 'sequence', target_id: 'blk_a', next: 'fn_end' },
        { id: 'fn_end', type: 'end', disposition: 'COMPLETE' },
      ],
      [{ id: 'pg_a', entry: 'fn_seq' }],
    );
    const r = step(session(), { i: 'enter' }, art, ctx());

    expect(r.next.current_page_id).toBe('pg_a');
  });
});

/* ---------------------------------------------------------------- *
 * Back navigation
 * ---------------------------------------------------------------- */

describe('back navigation', () => {
  it('returns to the previously submitted page', () => {
    const art = linearSurvey();
    let s = step(session(), { i: 'enter' }, art, ctx()).next;
    s = step(s, { i: 'submitted', page_id: 'pg_1' }, art, ctx()).next;
    expect(s.current_page_id).toBe('pg_2');

    const r = step(s, { i: 'back' }, art, ctx());

    expect(r.next.current_page_id).toBe('pg_1');
    expect(renders(r.cmds)).toEqual(['pg_1']);
  });

  it('clears submitted_at and bumps attempt on the revisited page', () => {
    const art = linearSurvey();
    let s = step(session(), { i: 'enter' }, art, ctx()).next;
    s = step(s, { i: 'submitted', page_id: 'pg_1' }, art, ctx()).next;
    const r = step(s, { i: 'back' }, art, ctx());

    const visit = r.next.history[r.next.history.length - 1]!;
    expect(visit.page_id).toBe('pg_1');
    expect(visit.submitted_at).toBeNull();
    expect(visit.attempt).toBe(2);
  });

  it('drops forward history so the next advance recomputes it', () => {
    const art = linearSurvey();
    let s = step(session(), { i: 'enter' }, art, ctx()).next;
    s = step(s, { i: 'submitted', page_id: 'pg_1' }, art, ctx()).next;
    s = step(s, { i: 'submitted', page_id: 'pg_2' }, art, ctx()).next;
    expect(s.current_page_id).toBe('pg_3');

    const r = step(s, { i: 'back' }, art, ctx());

    expect(r.next.current_page_id).toBe('pg_2');
    expect(r.next.history.map(v => v.page_id)).toEqual(['pg_1', 'pg_2']);
  });

  it('re-advancing after back returns to the same forward page', () => {
    const art = linearSurvey();
    let s = step(session(), { i: 'enter' }, art, ctx()).next;
    s = step(s, { i: 'submitted', page_id: 'pg_1' }, art, ctx()).next;
    s = step(s, { i: 'back' }, art, ctx()).next;
    const r = step(s, { i: 'submitted', page_id: 'pg_1' }, art, ctx());

    expect(r.next.current_page_id).toBe('pg_2');
  });

  it('is a no-op with nothing submitted yet', () => {
    const art = linearSurvey();
    const s = step(session(), { i: 'enter' }, art, ctx()).next;
    const r = step(s, { i: 'back' }, art, ctx());

    expect(r.next).toBe(s);
    expect(r.cmds).toEqual([{ c: 'emit_event', event: { kind: 'back.no_target' } }]);
  });
});

/* ---------------------------------------------------------------- *
 * Purity and malformed graphs
 * ---------------------------------------------------------------- */

describe('purity', () => {
  it('identical inputs produce identical output', () => {
    const art = linearSurvey();
    const s = session();
    const a = step(s, { i: 'enter' }, art, ctx());
    const b = step(s, { i: 'enter' }, art, ctx());

    expect(a.next).toEqual(b.next);
    expect(a.cmds).toEqual(b.cmds);
  });

  it('does not mutate the input state', () => {
    const art = linearSurvey();
    const s = session();
    const frozen = JSON.stringify(s);
    step(s, { i: 'enter' }, art, ctx());

    expect(JSON.stringify(s)).toBe(frozen);
  });

  it('a replayed input sequence reproduces the final state', () => {
    const art = linearSurvey();
    const inputs: Input[] = [
      { i: 'enter' },
      { i: 'submitted', page_id: 'pg_1' },
      { i: 'submitted', page_id: 'pg_2' },
      { i: 'submitted', page_id: 'pg_3' },
    ];
    const replay = () => inputs.reduce((s, i) => step(s, i, art, ctx()).next, session());

    expect(replay()).toEqual(replay());
    expect(replay().disposition).toBe('COMPLETE');
  });

  it('takes the clock from ctx, never from Date.now', () => {
    const art = linearSurvey();
    const r = step(session(), { i: 'enter' }, art, ctx({ now_ms: 42 }));

    expect(r.next.server_time_ms).toBe(42);
    expect(r.next.last_activity_at).toBe(42);
  });
});

describe('malformed graphs', () => {
  it('terminates on a missing node rather than throwing', () => {
    const art = artifact([{ id: 'fn_start', type: 'start', next: 'fn_ghost' }], []);
    const r = step(session(), { i: 'enter' }, art, ctx());

    expect(r.next.disposition).toBe('TERMINATE');
    expect(r.cmds[0]).toMatchObject({ event: { kind: 'flow.missing_node' } });
  });

  it('terminates on a dangling edge', () => {
    const art = artifact([{ id: 'fn_start', type: 'start', next: null }], []);
    const r = step(session(), { i: 'enter' }, art, ctx());

    expect(r.next.disposition).toBe('TERMINATE');
    expect(r.cmds[0]).toMatchObject({ event: { kind: 'flow.dangling_edge' } });
  });

  it('breaks a cyclic graph instead of spinning', () => {
    const art = artifact(
      [
        { id: 'fn_start', type: 'start', next: 'fn_a' },
        { id: 'fn_a', type: 'branch', branches: [{ condition: null, next: 'fn_a' }] },
      ],
      [],
    );
    const r = step(session(), { i: 'enter' }, art, ctx());

    expect(r.next.disposition).toBe('TERMINATE');
    expect(r.cmds[0]).toMatchObject({ event: { kind: 'flow.traversal_limit' } });
  });
});
