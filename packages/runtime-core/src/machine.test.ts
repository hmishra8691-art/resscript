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
  pages: Array<{ id: string; entry?: string; authored?: string; group?: string }>,
): MachineArtifact {
  const authored = pages.filter(p => p.authored !== undefined);
  const grouped = pages.filter(p => p.group !== undefined);
  return {
    graph: {
      page_order: pages.map(p => p.id),
      nodes,
      page_entry: Object.fromEntries(pages.map(p => [p.id, p.entry ?? 'fn_seq'])),
      ...(authored.length === 0
        ? {}
        : {
            page_authored: Object.fromEntries(
              authored.map(p => [p.id, p.authored as string]),
            ),
          }),
      ...(grouped.length === 0
        ? {}
        : { page_group: Object.fromEntries(grouped.map(p => [p.id, p.group as string])) }),
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


/* ------------------------------------------------------------------ *
 * Loop iterations (P2-02)
 * ------------------------------------------------------------------ */

describe('a loop node walks its unrolled iterations', () => {
  /**
   * The compiler unrolls a looped page into one page per iteration and gives each the same
   * `page_entry`. The claim P2-02 rests on is that this needs NO machine change — so it is verified
   * here rather than asserted in a comment.
   *
   * Two pages under one loop, two iterations, in the iteration-major order `unrollPageOrder`
   * produces: A1, B1, A2, B2.
   */
  function loopedSurvey() {
    return artifact(
      [
        { id: 'fn_start', type: 'start', next: 'fn_loop' },
        { id: 'fn_loop', type: 'loop', target_id: 'blk_loop', next: 'fn_end' },
        { id: 'fn_end', type: 'end', disposition: 'COMPLETE' },
      ],
      [
        { id: 'pg_a_i1', entry: 'fn_loop', authored: 'pg_a' },
        { id: 'pg_b_i1', entry: 'fn_loop', authored: 'pg_b' },
        { id: 'pg_a_i2', entry: 'fn_loop', authored: 'pg_a' },
        { id: 'pg_b_i2', entry: 'fn_loop', authored: 'pg_b' },
      ],
    );
  }

  /** Walk from entry to finalization, collecting every page rendered. */
  function walk(art: MachineArtifact, c: PureCtx = ctx()): string[] {
    let s = session();
    const seen: string[] = [];
    let out = step(s, { i: 'enter' }, art, c);
    s = out.next;
    for (const cmd of out.cmds) if (cmd.c === 'render') seen.push(cmd.page_id);

    // Bounded, so a machine that looped forever fails the test instead of hanging it.
    for (let guard = 0; guard < 20; guard += 1) {
      const current = s.current_page_id;
      if (current === null) break;
      out = step(s, { i: 'submitted', page_id: current }, art, c);
      s = out.next;
      let rendered = false;
      for (const cmd of out.cmds) {
        if (cmd.c === 'render') {
          seen.push(cmd.page_id);
          rendered = true;
        }
      }
      if (!rendered) break;
    }
    return seen;
  }

  it('renders every iteration of every page, in iteration-major order', () => {
    // Before P2-02 a loop node ran its target ONCE. This is the behaviour change, observed through
    // the machine rather than inferred from the compiler.
    expect(walk(loopedSurvey())).toEqual(['pg_a_i1', 'pg_b_i1', 'pg_a_i2', 'pg_b_i2']);
  });

  it('finalizes after the last iteration rather than looping forever', () => {
    let s = session();
    const art = loopedSurvey();
    let out = step(s, { i: 'enter' }, art, ctx());
    s = out.next;
    for (let i = 0; i < 4; i += 1) {
      out = step(s, { i: 'submitted', page_id: s.current_page_id as string }, art, ctx());
      s = out.next;
    }
    expect(out.cmds.some(c => c.c === 'finalize')).toBe(true);
  });

  it('resolves page visibility through the AUTHORED id, so a rule hides every iteration', () => {
    // The one place the machine had to change. A derived id the logic program has never seen falls
    // through to `baseVisible`, which is `true` — so without the mapping a rule hiding a looped page
    // would hide none of its iterations, which is the failure that looks like "the rule does
    // nothing" and is impossible to debug from the outside.
    const asked: string[] = [];
    const c = ctx({
      isPageVisible: (id: string) => {
        asked.push(id);
        return id !== 'pg_a';
      },
    });

    expect(walk(loopedSurvey(), c)).toEqual(['pg_b_i1', 'pg_b_i2']);
    // The hook was asked with AUTHORED ids only — never a derived one.
    expect(asked.every(id => id === 'pg_a' || id === 'pg_b')).toBe(true);
  });

  it('asks with the page id itself when there is no mapping', () => {
    // A survey with no loops emits no `page_authored`, and must behave exactly as before.
    const asked: string[] = [];
    const c = ctx({
      isPageVisible: (id: string) => {
        asked.push(id);
        return true;
      },
    });
    walk(linearSurvey(), c);
    expect(asked).toContain('pg_1');
  });
});


/* ------------------------------------------------------------------ *
 * A randomizer PRESENTS its targets (P2-03)
 * ------------------------------------------------------------------ */

describe('a randomizer renders the pages it owns', () => {
  /**
   * THE DEFECT. `case 'randomizer'` used to set `cursor = node.next` and nothing else, with a
   * comment saying the seeded modes "derive order, store nothing". Order was never derived and the
   * pages were never rendered — and because the compiler gives a randomizer ownership of EVERY page
   * of every target (`layoutSitesOf` returns one site per target), every page under a randomizer
   * was unreachable. A survey shuffling three blocks showed none of them.
   *
   * The old test in `describe('randomizer')` above did not catch it because its fixture puts the
   * pages under a SEPARATE `sequence` node — the one arrangement where passing through is correct.
   * It is kept, because that arrangement is still correct and still worth pinning.
   */
  function shuffledSurvey(mode: string, extra: Record<string, unknown> = {}) {
    return artifact(
      [
        { id: 'fn_start', type: 'start', next: 'fn_rand' },
        {
          id: 'fn_rand',
          type: 'randomizer',
          targets: ['blk_a', 'blk_b', 'blk_c'],
          mode,
          next: 'fn_end',
          ...extra,
        } as never,
        { id: 'fn_end', type: 'end', disposition: 'COMPLETE' },
      ],
      [
        { id: 'pg_a1', entry: 'fn_rand', group: 'blk_a' },
        { id: 'pg_a2', entry: 'fn_rand', group: 'blk_a' },
        { id: 'pg_b1', entry: 'fn_rand', group: 'blk_b' },
        { id: 'pg_c1', entry: 'fn_rand', group: 'blk_c' },
      ],
    );
  }

  function walkAll(art: MachineArtifact, c: PureCtx): string[] {
    let s = session();
    const seen: string[] = [];
    let out = step(s, { i: 'enter' }, art, c);
    s = out.next;
    for (const cmd of out.cmds) if (cmd.c === 'render') seen.push(cmd.page_id);
    for (let guard = 0; guard < 20; guard += 1) {
      if (s.current_page_id === null) break;
      out = step(s, { i: 'submitted', page_id: s.current_page_id }, art, c);
      s = out.next;
      let rendered = false;
      for (const cmd of out.cmds) {
        if (cmd.c === 'render') {
          seen.push(cmd.page_id);
          rendered = true;
        }
      }
      if (!rendered) break;
    }
    return seen;
  }

  it('renders EVERY page it owns, which it previously rendered none of', () => {
    const seen = walkAll(shuffledSurvey('shuffle'), ctx({ random: (s: string) => (s.length % 7) / 7 }));
    expect(seen).toHaveLength(4);
    expect([...seen].sort()).toEqual(['pg_a1', 'pg_a2', 'pg_b1', 'pg_c1']);
  });

  it('keeps each target pages TOGETHER and in authored order', () => {
    // `shuffle` on a randomizer reorders the blocks the author listed; each block's pages stay put.
    // Permuting the flat page list would interleave pages from different blocks — a different
    // feature nobody asked for, and one that reads as correct in a diff.
    const seen = walkAll(shuffledSurvey('shuffle'), ctx({ random: (s: string) => (s.length % 7) / 7 }));
    expect(seen.indexOf('pg_a2')).toBe(seen.indexOf('pg_a1') + 1);
  });

  it('permutes the TARGET order from the seed', () => {
    // Two different draws must be able to produce two different orders, or the "randomizer" is a
    // sequence with extra steps.
    const orders = new Set<string>();
    for (const bias of [0.1, 0.9]) {
      for (const flip of [1, -1]) {
        const seen = walkAll(
          shuffledSurvey('shuffle'),
          ctx({ random: (s: string) => bias + flip * ((s.charCodeAt(s.length - 1) % 5) / 20) }),
        );
        orders.add(seen.join(','));
      }
    }
    expect(orders.size).toBeGreaterThan(1);
  });

  it('is STABLE within a session — the same draws give the same order every step', () => {
    // The machine is a pure reducer with nowhere to store a permutation, and does not need one:
    // ctx.random is the seeded counter-based PRNG (ADR-006), so the same salt yields the same draw
    // all session. An unstable order would re-shuffle mid-survey and re-ask pages.
    const c = ctx({ random: (s: string) => (s.charCodeAt(s.length - 1) % 11) / 11 });
    expect(walkAll(shuffledSurvey('shuffle'), c)).toEqual(walkAll(shuffledSurvey('shuffle'), c));
  });

  it('takes the first n of the permuted targets for `subset`', () => {
    // The first n of ONE permutation, not n independent draws — which would over-represent whatever
    // the tie-break favours.
    const seen = walkAll(
      shuffledSurvey('subset', { n: 2 }),
      ctx({ random: (s: string) => (s.charCodeAt(s.length - 1) % 11) / 11 }),
    );
    const groups = new Set(seen.map(p => p.slice(0, 4)));
    expect(groups.size).toBe(2);
  });

  it('leaves `fixed_order` in authored order', () => {
    const seen = walkAll(shuffledSurvey('fixed_order'), ctx({ random: () => 0.99 }));
    expect(seen).toEqual(['pg_a1', 'pg_a2', 'pg_b1', 'pg_c1']);
  });

  it('falls back to the seeded order for the counter-backed modes rather than dropping pages', () => {
    // `rotate` and `even_distribution` need the cross-session counter of ADR-008, which a pure
    // reducer cannot reach. A seeded permutation is a valid order — just not an evenly distributed
    // one — and rendering nothing would be strictly worse than rendering an unevenly ordered
    // survey. randomize.ts reports the same situation as `needs_counter` rather than pretending.
    const seen = walkAll(shuffledSurvey('rotate'), ctx({ random: () => 0.5 }));
    expect(seen).toHaveLength(4);
  });

  it('advances to `next` once its pages are exhausted', () => {
    let s = session();
    const art = shuffledSurvey('shuffle');
    const c = ctx({ random: () => 0.5 });
    let out = step(s, { i: 'enter' }, art, c);
    s = out.next;
    for (let i = 0; i < 4; i += 1) {
      out = step(s, { i: 'submitted', page_id: s.current_page_id as string }, art, c);
      s = out.next;
    }
    expect(out.cmds.some(cmd => cmd.c === 'finalize')).toBe(true);
  });

  it('skips an invisible page without abandoning the rest of the target', () => {
    const c = ctx({ random: () => 0.5, isPageVisible: (id: string) => id !== 'pg_a1' });
    const seen = walkAll(shuffledSurvey('shuffle'), c);
    expect(seen).not.toContain('pg_a1');
    expect(seen).toContain('pg_a2');
  });

  it('degrades to per-page ordering when the graph carries no page_group', () => {
    // An artifact compiled before `page_group` existed, or a hand-built graph. Each page becomes its
    // own group, which orders pages rather than blocks — not ideal, and far better than rendering
    // nothing, which is what the old code did.
    const art = artifact(
      [
        { id: 'fn_start', type: 'start', next: 'fn_rand' },
        {
          id: 'fn_rand',
          type: 'randomizer',
          targets: ['blk_a', 'blk_b'],
          mode: 'shuffle',
          next: 'fn_end',
        } as never,
        { id: 'fn_end', type: 'end', disposition: 'COMPLETE' },
      ],
      [{ id: 'pg_a1', entry: 'fn_rand' }, { id: 'pg_b1', entry: 'fn_rand' }],
    );
    expect(walkAll(art, ctx({ random: () => 0.5 }))).toHaveLength(2);
  });
});
