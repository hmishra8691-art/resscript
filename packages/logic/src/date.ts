/**
 * ISO-8601 date arithmetic, implemented from scratch.
 *
 * WHY not `Date`: two independent reasons, and either alone would be enough.
 *
 *  1. D §5.5 bans `Date` in this package outright, because the ban is what keeps a `Date.now()`
 *     from ever appearing on this path. There is no `now` in the AST (D §2.6) and there must be
 *     no way to reach one.
 *  2. `Date`'s parsing is *not* deterministic across engines for the inputs that matter.
 *     `new Date('2024-03-10')` is UTC midnight but `new Date('2024-03-10T00:00:00')` is *local*
 *     midnight per ECMA-262, so the same survey answer yields different `date_part(dow)` values
 *     on a server in UTC and a browser in Auckland. ADR-004's divergence detector would fire on
 *     every date rule forever, and the fix would be to mute it. A hand-rolled parser that only
 *     accepts UTC is the only way the two sides can agree.
 *
 * All values are treated as UTC, per D §2.2: "ISO-8601, always UTC, no local dates".
 */

import { LogicInvariant } from './ids.js';

export interface CivilTime {
  readonly year: number;
  readonly month: number; // 1-12
  readonly day: number; // 1-31
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  readonly ms: number;
  /** True when the source carried no time component, so `date_trunc` can round-trip it. */
  readonly dateOnly: boolean;
}

const ISO = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(?:Z|\+00:?00)?)?$/;

/** `undefined` for anything that is not an ISO-8601 UTC instant. Never throws. */
export function parseIso(text: string): CivilTime | undefined {
  const m = ISO.exec(text);
  if (m === null) return undefined;
  const year = int(m[1]);
  const month = int(m[2]);
  const day = int(m[3]);
  if (month < 1 || month > 12) return undefined;
  if (day < 1 || day > daysInMonth(year, month)) return undefined;
  const dateOnly = m[4] === undefined;
  const hour = m[4] === undefined ? 0 : int(m[4]);
  const minute = m[5] === undefined ? 0 : int(m[5]);
  const second = m[6] === undefined ? 0 : int(m[6]);
  const ms = m[7] === undefined ? 0 : int(m[7].padEnd(3, '0'));
  if (hour > 23 || minute > 59 || second > 59) return undefined;
  return { year, month, day, hour, minute, second, ms, dateOnly };
}

function int(text: string | undefined): number {
  if (text === undefined) throw new LogicInvariant('regex group missing after a successful match');
  return Number.parseInt(text, 10);
}

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

const MONTH_LENGTHS: readonly number[] = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

export function daysInMonth(year: number, month: number): number {
  if (month === 2 && isLeapYear(year)) return 29;
  const length = MONTH_LENGTHS[month - 1];
  if (length === undefined) throw new LogicInvariant(`month out of range: ${String(month)}`);
  return length;
}

/**
 * Days from 1970-01-01. Hinnant's `days_from_civil`: exact for the whole proleptic Gregorian
 * calendar in integer arithmetic, which is what keeps `date_diff('day', …)` from picking up a
 * floating-point rounding error on a leap-second-free but very long interval.
 */
export function daysFromCivil(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const mp = (month + 9) % 12;
  const doy = Math.floor((153 * mp + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

export function civilFromDays(days: number): { year: number; month: number; day: number } {
  const z = days + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9;
  return { year: month <= 2 ? y + 1 : y, month, day };
}

export function epochMs(t: CivilTime): number {
  return (
    daysFromCivil(t.year, t.month, t.day) * 86_400_000 +
    t.hour * 3_600_000 +
    t.minute * 60_000 +
    t.second * 1000 +
    t.ms
  );
}

/** 0 = Sunday, matching `date_part('dow')` in Postgres so exports and logic agree. */
export function dayOfWeek(t: CivilTime): number {
  const days = daysFromCivil(t.year, t.month, t.day);
  // 1970-01-01 was a Thursday (4).
  return ((days % 7) + 7 + 4) % 7;
}

export function formatIso(t: CivilTime): string {
  const date = `${pad(t.year, 4)}-${pad(t.month, 2)}-${pad(t.day, 2)}`;
  if (t.dateOnly) return date;
  const time = `${pad(t.hour, 2)}:${pad(t.minute, 2)}:${pad(t.second, 2)}`;
  return t.ms === 0 ? `${date}T${time}Z` : `${date}T${time}.${pad(t.ms, 3)}Z`;
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

/**
 * Calendar-aware difference. `'day'` and coarser units are counted on the *calendar*, not by
 * dividing elapsed milliseconds: 2024-03-01 minus 2024-02-29 is one day, and a survey that
 * asks "how many days since X" must not answer 0 because of a 23-hour offset.
 *
 * Truncated toward zero, so `date_diff('year', 2000-06-01, 2010-05-31)` is 9, not 10 — the
 * same convention a respondent's stated age follows.
 */
export function dateDiff(unit: 'day' | 'month' | 'year' | 'hour' | 'minute' | 'second', from: CivilTime, to: CivilTime): number {
  switch (unit) {
    case 'year':
    case 'month': {
      const whole = wholeMonths(from, to);
      return unit === 'month' ? whole : Math.trunc(whole / 12);
    }
    case 'day': {
      const days = daysFromCivil(to.year, to.month, to.day) - daysFromCivil(from.year, from.month, from.day);
      if (days > 0 && timeOfDayMs(to) < timeOfDayMs(from)) return days - 1;
      if (days < 0 && timeOfDayMs(to) > timeOfDayMs(from)) return days + 1;
      return days;
    }
    case 'hour':
      return Math.trunc((epochMs(to) - epochMs(from)) / 3_600_000);
    case 'minute':
      return Math.trunc((epochMs(to) - epochMs(from)) / 60_000);
    case 'second':
      return Math.trunc((epochMs(to) - epochMs(from)) / 1000);
    default: {
      const never: never = unit;
      throw new LogicInvariant(`unhandled date unit ${JSON.stringify(never)}`);
    }
  }
}

function timeOfDayMs(t: CivilTime): number {
  return t.hour * 3_600_000 + t.minute * 60_000 + t.second * 1000 + t.ms;
}

export function compareCivil(a: CivilTime, b: CivilTime): number {
  return epochMs(a) - epochMs(b);
}

/**
 * Signed count of whole calendar months between two instants: the naive month delta, walked
 * back by one if adding it would overshoot. Stated as "add and check" rather than as a
 * day-comparison, because the day comparison has to special-case month-end (31 January to 28
 * February is one whole month) and gets it wrong in exactly the cases screener ages depend on.
 */
function wholeMonths(from: CivilTime, to: CivilTime): number {
  if (compareCivil(to, from) < 0) return -wholeMonths(to, from);
  const naive = (to.year - from.year) * 12 + (to.month - from.month);
  const anchor = dateAdd('month', from, naive);
  return compareCivil(anchor, to) > 0 ? naive - 1 : naive;
}

/**
 * Add whole days/months/years. Month and year arithmetic clamps the day to the target month's
 * length — 2024-01-31 plus one month is 2024-02-29, not 2024-03-02. Overflowing into the next
 * month is the behaviour that produces off-by-one screener ages at the end of January.
 */
export function dateAdd(unit: 'day' | 'month' | 'year', t: CivilTime, amount: number): CivilTime {
  const n = Math.trunc(amount);
  if (unit === 'day') {
    const civil = civilFromDays(daysFromCivil(t.year, t.month, t.day) + n);
    return { ...t, year: civil.year, month: civil.month, day: civil.day };
  }
  const months = unit === 'year' ? n * 12 : n;
  const total = (t.year * 12 + (t.month - 1)) + months;
  const year = Math.floor(total / 12);
  const month = (total % 12) + 1;
  const day = Math.min(t.day, daysInMonth(year, month));
  return { ...t, year, month, day };
}

export function dateTrunc(unit: 'day' | 'month' | 'year', t: CivilTime): CivilTime {
  const day = unit === 'day' ? t.day : 1;
  const month = unit === 'year' ? 1 : t.month;
  return { year: t.year, month, day, hour: 0, minute: 0, second: 0, ms: 0, dateOnly: true };
}
