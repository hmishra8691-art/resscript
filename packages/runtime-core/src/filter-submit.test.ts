/**
 * Tests for the anti-tamper filter (E §5 step 3).
 *
 * The test that carries the milestone is the roadmap's own: a value for a question the
 * server's evaluation says was hidden must be absent from `accepted` and present in
 * `rejected` with its reason — the DOM-edited screener leaves evidence and no data.
 */

import { describe, expect, it } from 'vitest';
import { filterSubmit, type FilterInput, type ManifestVariableLike } from './filter-submit.js';

const MANIFEST: ManifestVariableLike[] = [
  { id: 'var_q1', name: 'Q1', kind: 'response', type: 'enum',
    enum_domain: [{ code: 1 }, { code: 2 }, { code: 3 }, { code: 99 }] },
  { id: 'var_q2', name: 'Q2', kind: 'response', type: 'set',
    enum_domain: [{ code: 1 }, { code: 2 }, { code: 3 }] },
  { id: 'var_age', name: 'AGE', kind: 'response', type: 'number' },
  { id: 'var_open', name: 'OPEN', kind: 'response', type: 'text' },
  { id: 'var_seg', name: 'SEGMENT', kind: 'derived', type: 'enum' },
  { id: 'var_pid', name: 'VENDOR_PID', kind: 'hidden', type: 'text', pii: true },
];

const OWNER: Record<string, string> = {
  var_q1: 'qst_1', var_q2: 'qst_2', var_age: 'qst_3', var_open: 'qst_4',
};

function input(over: Partial<FilterInput> = {}): FilterInput {
  return {
    submitted: {},
    manifest: MANIFEST,
    ownerQuestion: id => OWNER[id],
    pageQuestions: new Set(['qst_1', 'qst_2', 'qst_3', 'qst_4']),
    shown: new Set(['qst_1', 'qst_2', 'qst_3', 'qst_4']),
    itemsFor: () => null,
    ...over,
  };
}

describe('the rejection taxonomy, one reason per check', () => {
  it('accepts a clean submit, keyed by variable id whichever way it was addressed', () => {
    const r = filterSubmit(input({ submitted: { var_q1: 2, AGE: '34' } }));

    expect(r.accepted).toEqual({ var_q1: 2, var_age: 34 });
    expect(r.rejected).toEqual([]);
    expect([...r.wrote].sort()).toEqual(['var_age', 'var_q1']);
  });

  it('rejects a variable the manifest has never heard of', () => {
    // The roadmap's manifest-violation test: injecting `disposition` dies here, because
    // disposition is not a variable at all — the closed world is the manifest.
    const r = filterSubmit(input({ submitted: { disposition: 'COMPLETE' } }));

    expect(r.accepted).toEqual({});
    expect(r.rejected).toEqual([
      { variable: 'disposition', reason: 'unknown_variable', claimed: 'COMPLETE' },
    ]);
  });

  it('rejects a write to a non-response variable', () => {
    // SEGMENT is derived and VENDOR_PID is hidden: both are state the protocol never
    // offered the respondent, whatever the DOM was edited to claim.
    const r = filterSubmit(input({ submitted: { SEGMENT: 3, VENDOR_PID: 'forged' } }));

    expect(r.accepted).toEqual({});
    expect(r.rejected.map(x => x.reason)).toEqual([
      'non_response_write',
      'non_response_write',
    ]);
  });

  it('rejects a value for a question logic hid — THE screener case', () => {
    const r = filterSubmit(
      input({ submitted: { var_q1: 1 }, shown: new Set(['qst_2', 'qst_3']) }),
    );

    expect(r.accepted).toEqual({});
    expect(r.rejected).toEqual([
      { variable: 'var_q1', reason: 'hidden_question_value', claimed: 1 },
    ]);
  });

  it('rejects a cross-page write', () => {
    // E §6: one POST names one page and writes only that page's variables — otherwise a
    // submit could influence the visibility recomputation that is about to judge it.
    const r = filterSubmit(
      input({ submitted: { var_q1: 1 }, pageQuestions: new Set(['qst_2']) }),
    );

    expect(r.rejected[0]?.reason).toBe('not_on_this_page');
  });

  it('rejects a masked-out enum code', () => {
    const r = filterSubmit(
      input({
        submitted: { var_q1: 3 },
        itemsFor: q => (q === 'qst_1' ? [1, 2] : null),
      }),
    );

    expect(r.accepted).toEqual({});
    expect(r.rejected[0]?.reason).toBe('masked_option_value');
  });

  it('rejects a disabled option separately from a masked one', () => {
    const r = filterSubmit(
      input({
        submitted: { var_q1: 2 },
        itemsFor: q => (q === 'qst_1' ? [1, 2] : null),
        optionSelectable: (_q, code) => code !== 2,
      }),
    );

    expect(r.rejected[0]?.reason).toBe('option_not_selectable');
  });

  it('strips a masked code from a set answer rather than discarding the answer', () => {
    // The array IS the answer; the masked member is the tamper. Keeping the valid part and
    // recording the stripped part preserves the honest majority of the response.
    const r = filterSubmit(
      input({
        submitted: { var_q2: [1, 3] },
        itemsFor: q => (q === 'qst_2' ? [1, 2] : null),
      }),
    );

    expect(r.accepted).toEqual({ var_q2: [1] });
    expect(r.rejected[0]).toMatchObject({ reason: 'masked_option_value', claimed: [3] });
  });

  it('rejects type violations by name', () => {
    const r = filterSubmit(
      input({ submitted: { var_age: 'not-a-number', var_q1: 7 } }),
    );

    // 7 is outside var_q1's declared enum domain — a code the codebook lacks is a type
    // violation before masking even enters into it.
    expect(r.accepted).toEqual({});
    expect(r.rejected.map(x => [x.variable, x.reason])).toEqual([
      ['var_age', 'type_violation'],
      ['var_q1', 'type_violation'],
    ]);
  });

  it('coerces transport strings but not structural nonsense', () => {
    const r = filterSubmit(
      input({ submitted: { var_q1: '2', var_q2: ['1', '3'], var_age: {} } }),
    );

    expect(r.accepted).toEqual({ var_q1: 2, var_q2: [1, 3] });
    expect(r.rejected[0]?.reason).toBe('type_violation');
  });

  it('truncates an oversized open-end and records that it did', () => {
    const r = filterSubmit(
      input({
        submitted: { var_open: 'x'.repeat(50) },
        defaultMaxTextLength: 10,
      }),
    );

    expect(r.accepted['var_open']).toBe('x'.repeat(10));
    expect(r.rejected[0]).toMatchObject({ reason: 'text_truncated', claimed: 50 });
    // Truncation is not a discard: the variable is still in wrote.
    expect(r.wrote).toEqual(['var_open']);
  });

  it('bounds the evidence it keeps', () => {
    // A 5 MB claimed value must not become a 5 MB event row.
    const r = filterSubmit(input({ submitted: { ghost: 'y'.repeat(100_000) } }));

    expect(String(r.rejected[0]?.claimed).length).toBeLessThan(300);
  });

  it('deduplicates a set answer from a repeated form field', () => {
    const r = filterSubmit(input({ submitted: { var_q2: [1, 1, 2] } }));
    expect(r.accepted).toEqual({ var_q2: [1, 2] });
  });
});
