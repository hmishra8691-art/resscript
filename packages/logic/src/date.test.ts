/**
 * The hand-rolled ISO-8601 calendar — see date.ts for why it exists rather than `Date`.
 *
 * These are the cases that produce wrong screener ages in production: month-end arithmetic, leap
 * years, and a "days since" that divides milliseconds instead of counting calendar days.
 */

import { describe, expect, it } from 'vitest';
import {
  civilFromDays,
  compareCivil,
  dateAdd,
  dateDiff,
  dateTrunc,
  dayOfWeek,
  daysFromCivil,
  daysInMonth,
  formatIso,
  isLeapYear,
  parseIso,
  type CivilTime,
} from './date.js';

function at(iso: string): CivilTime {
  const parsed = parseIso(iso);
  if (parsed === undefined) throw new Error(`fixture is not ISO-8601: ${iso}`);
  return parsed;
}

describe('parsing', () => {
  it('accepts a bare date and a UTC instant', () => {
    expect(parseIso('2024-03-10')).toMatchObject({ year: 2024, month: 3, day: 10, dateOnly: true });
    expect(parseIso('2024-03-10T13:45:07.250Z')).toMatchObject({ hour: 13, minute: 45, second: 7, ms: 250 });
    expect(parseIso('2024-03-10T13:45+00:00')).toMatchObject({ hour: 13, minute: 45 });
  });

  it('rejects anything that is not a UTC instant, rather than guessing a timezone', () => {
    // `new Date('2024-03-10T00:00:00')` is *local* midnight per ECMA-262, so the same answer would
    // yield different date_part('dow') values on a server in UTC and a browser in Auckland, and
    // ADR-004's divergence detector would fire on every date rule forever.
    expect(parseIso('2024-03-10T00:00:00+05:30')).toBeUndefined();
    expect(parseIso('10/03/2024')).toBeUndefined();
    expect(parseIso('2024-13-01')).toBeUndefined();
    expect(parseIso('2024-02-30')).toBeUndefined();
    expect(parseIso('2023-02-29')).toBeUndefined();
    expect(parseIso('2024-03-10T25:00:00Z')).toBeUndefined();
    expect(parseIso('')).toBeUndefined();
  });

  it('accepts 29 February in a leap year and rejects it otherwise', () => {
    expect(parseIso('2024-02-29')).toBeDefined();
    expect(isLeapYear(2024)).toBe(true);
    expect(isLeapYear(1900)).toBe(false);
    expect(isLeapYear(2000)).toBe(true);
    expect(daysInMonth(2024, 2)).toBe(29);
    expect(daysInMonth(2023, 2)).toBe(28);
  });

  it('round-trips through formatIso', () => {
    for (const iso of ['2024-03-10', '2024-03-10T13:45:07Z', '2024-03-10T13:45:07.250Z']) {
      expect(formatIso(at(iso))).toBe(iso);
    }
  });
});

describe('the civil calendar', () => {
  it('agrees with known epoch offsets', () => {
    expect(daysFromCivil(1970, 1, 1)).toBe(0);
    expect(daysFromCivil(1969, 12, 31)).toBe(-1);
    expect(daysFromCivil(2000, 3, 1)).toBe(11017);
    expect(civilFromDays(0)).toEqual({ year: 1970, month: 1, day: 1 });
    expect(civilFromDays(11017)).toEqual({ year: 2000, month: 3, day: 1 });
  });

  it('is a bijection over a long span, including every leap-year boundary', () => {
    for (let days = -30000; days < 30000; days += 1) {
      const civil = civilFromDays(days);
      expect(daysFromCivil(civil.year, civil.month, civil.day)).toBe(days);
    }
  });

  it('knows the day of the week', () => {
    expect(dayOfWeek(at('1970-01-01'))).toBe(4); // a Thursday
    expect(dayOfWeek(at('2024-03-10'))).toBe(0); // a Sunday
    expect(dayOfWeek(at('1969-12-31'))).toBe(3); // a Wednesday
  });
});

describe('date_diff counts calendar units, not milliseconds', () => {
  it('counts one day across a 23-hour boundary', () => {
    // Dividing elapsed milliseconds would answer 0 here, and a "days since purchase" question
    // would be off by one for every respondent who answered in the morning.
    expect(dateDiff('day', at('2024-02-29T23:00:00Z'), at('2024-03-01T22:00:00Z'))).toBe(0);
    expect(dateDiff('day', at('2024-02-29T23:00:00Z'), at('2024-03-01T23:00:00Z'))).toBe(1);
    expect(dateDiff('day', at('2024-02-29'), at('2024-03-01'))).toBe(1);
  });

  it('truncates toward zero, the way a stated age does', () => {
    expect(dateDiff('year', at('1990-06-15'), at('2026-06-14'))).toBe(35);
    expect(dateDiff('year', at('1990-06-15'), at('2026-06-15'))).toBe(36);
    // Consistent with `date_add`'s clamping: 31 January plus one month *is* 29 February, so one
    // whole month has elapsed between them. `date_add` and `date_diff` are inverses, which is the
    // property an author relies on when they compute a cutoff one way and test it the other.
    expect(dateDiff('month', at('2024-01-31'), at('2024-02-29'))).toBe(1);
    expect(dateDiff('month', at('2024-01-31'), at('2024-02-28'))).toBe(0);
    expect(dateDiff('month', at('2024-01-31'), at('2024-03-31'))).toBe(2);
  });

  it('is antisymmetric', () => {
    const pairs: readonly (readonly [string, string])[] = [
      ['2020-01-01', '2024-06-15'],
      ['2024-02-29', '2024-03-01'],
      ['1999-12-31T23:59:59Z', '2000-01-01T00:00:00Z'],
    ];
    for (const [a, bIso] of pairs) {
      for (const unit of ['day', 'month', 'year', 'hour', 'minute', 'second'] as const) {
        // Summed rather than negated, so a legitimate zero does not fail on `-0 !== 0`.
        expect(dateDiff(unit, at(a), at(bIso)) + dateDiff(unit, at(bIso), at(a))).toBe(0);
      }
    }
  });

  it('counts hours, minutes and seconds', () => {
    expect(dateDiff('hour', at('2024-03-10T00:00:00Z'), at('2024-03-10T05:30:00Z'))).toBe(5);
    expect(dateDiff('minute', at('2024-03-10T00:00:00Z'), at('2024-03-10T05:30:00Z'))).toBe(330);
    expect(dateDiff('second', at('2024-03-10T00:00:00Z'), at('2024-03-10T00:00:59Z'))).toBe(59);
  });
});

describe('date_add clamps rather than overflowing', () => {
  it('31 January plus one month is the end of February, not early March', () => {
    expect(formatIso(dateAdd('month', at('2024-01-31'), 1))).toBe('2024-02-29');
    expect(formatIso(dateAdd('month', at('2023-01-31'), 1))).toBe('2023-02-28');
    expect(formatIso(dateAdd('year', at('2024-02-29'), 1))).toBe('2025-02-28');
  });

  it('adds and subtracts days across a year boundary', () => {
    expect(formatIso(dateAdd('day', at('2023-12-31'), 1))).toBe('2024-01-01');
    expect(formatIso(dateAdd('day', at('2024-01-01'), -1))).toBe('2023-12-31');
    expect(formatIso(dateAdd('month', at('2024-01-15'), -13))).toBe('2022-12-15');
  });

  it('preserves the time component', () => {
    expect(formatIso(dateAdd('day', at('2024-03-10T13:45:07Z'), 2))).toBe('2024-03-12T13:45:07Z');
  });
});

describe('date_trunc', () => {
  it('truncates to day, month and year, dropping the time', () => {
    expect(formatIso(dateTrunc('day', at('2024-03-10T13:45:07Z')))).toBe('2024-03-10');
    expect(formatIso(dateTrunc('month', at('2024-03-10T13:45:07Z')))).toBe('2024-03-01');
    expect(formatIso(dateTrunc('year', at('2024-03-10T13:45:07Z')))).toBe('2024-01-01');
  });
});

describe('ordering', () => {
  it('compares instants', () => {
    expect(compareCivil(at('2024-01-01'), at('2024-01-02'))).toBeLessThan(0);
    expect(compareCivil(at('2024-01-02T00:00:01Z'), at('2024-01-02'))).toBeGreaterThan(0);
    expect(compareCivil(at('2024-01-02'), at('2024-01-02'))).toBe(0);
  });
});
