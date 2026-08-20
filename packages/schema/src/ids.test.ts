import { describe, expect, it } from 'vitest';

import {
  ALL_ID_PREFIXES,
  ID_PREFIXES,
  asId,
  createIdFactory,
  idPrefixOf,
  isAnyId,
  isId,
  isValidRef,
  parseId,
} from './ids.js';

/** Deliverable B's `app.ulid` domain, restated here so a drift in either direction fails. */
const APP_ULID = /^[a-z]{2,5}_[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

function fixedFactory(seed = 1): ReturnType<typeof createIdFactory> {
  let a = seed;
  return createIdFactory({
    now: () => 1_700_000_000_000,
    random: () => {
      a = (a * 1103515245 + 12345) % 2147483648;
      return a / 2147483648;
    },
  });
}

describe('id generation', () => {
  it('produces ids matching the canonical app.ulid domain for every prefix', () => {
    const ids = fixedFactory();
    for (const kind of Object.keys(ID_PREFIXES) as (keyof typeof ID_PREFIXES)[]) {
      const id = ids.next(kind);
      expect(id, `${kind} -> ${id}`).toMatch(APP_ULID);
      expect(idPrefixOf(id)).toBe(ID_PREFIXES[kind]);
    }
  });

  it('is deterministic given the same clock and RNG', () => {
    const a = fixedFactory(7);
    const b = fixedFactory(7);
    const left = Array.from({ length: 20 }, () => a.next('question'));
    const right = Array.from({ length: 20 }, () => b.next('question'));
    expect(left).toEqual(right);
  });

  it('is monotonic within one millisecond', () => {
    const ids = fixedFactory(3);
    const generated = Array.from({ length: 500 }, () => ids.nextUlid());
    const sorted = [...generated].sort();
    expect(generated).toEqual(sorted);
    expect(new Set(generated).size).toBe(generated.length);
  });

  it('never emits an id that sorts before one already issued when the clock goes backwards', () => {
    let clock = 1_700_000_000_000;
    const ids = createIdFactory({ now: () => clock, random: () => 0.5 });
    const first = ids.nextUlid();
    clock -= 60_000;
    const second = ids.nextUlid();
    expect(second > first).toBe(true);
  });

  it('tolerates an RNG that returns the extremes', () => {
    for (const value of [0, 0.999999999999, 1]) {
      const ids = createIdFactory({ now: () => 1, random: () => value });
      expect(ids.next('option')).toMatch(APP_ULID);
    }
  });
});

describe('parsers and guards', () => {
  const ids = fixedFactory(11);
  const questionId = ids.next('question');

  it('accepts a well-formed id of the right prefix', () => {
    const parsed = parseId('qst', questionId);
    expect(parsed).toEqual({ ok: true, id: questionId });
    expect(isId('qst', questionId)).toBe(true);
    expect(isAnyId(questionId)).toBe(true);
  });

  it('rejects the right shape with the wrong prefix', () => {
    expect(parseId('opt', questionId)).toEqual({ ok: false, reason: 'wrong_prefix' });
    expect(isId('opt', questionId)).toBe(false);
  });

  it('rejects malformed ids, including Crockford-excluded letters', () => {
    for (const bad of [
      'qst_',
      'qst_01',
      'nope_01H0000000000000000000000',
      'qst_01H000000000000000000000I0', // I is not in Crockford base32
      'qst_91H0000000000000000000000', // first character above 7
      'QST_01H0000000000000000000000',
      42,
      null,
    ]) {
      expect(parseId('qst', bad).ok, String(bad)).toBe(false);
      expect(isAnyId(bad)).toBe(false);
    }
  });

  it('asId throws loudly rather than returning a broken reference', () => {
    expect(() => asId('qst', 'qst_nope')).toThrow(/Not a valid qst_ id/);
    expect(asId('qst', questionId)).toBe(questionId);
  });

  it('knows every prefix it generates', () => {
    expect([...ALL_ID_PREFIXES].sort()).toEqual([...Object.values(ID_PREFIXES)].sort());
  });
});

describe('refs', () => {
  it('accepts handles that can be used as export column names', () => {
    for (const ref of ['Q1', 'S3', 'AGE_GROUP', 'a', 'Q1r2c3']) {
      expect(isValidRef(ref), ref).toBe(true);
    }
  });

  it('rejects handles a spreadsheet or SQL identifier could not carry', () => {
    for (const ref of ['1', '1abc', '_x', 'Q 1', 'Q-1', '', 'Q'.repeat(65), 'ünïcode']) {
      expect(isValidRef(ref), JSON.stringify(ref)).toBe(false);
    }
  });
});
