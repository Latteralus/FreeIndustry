/**
 * Simulated time and the world calendar (spec §9.1, §9.4).
 *
 * Simulation time is a `bigint` count of simulated milliseconds since the
 * world's epoch, which is midnight at the start of the scenario's first day
 * (spec §9.3 `timeMs: bigint`). It never comes from the wall clock, a frame
 * counter or the operating system. All calendar arithmetic here is integer
 * arithmetic on the proleptic Gregorian calendar; there are no time zones and
 * no daylight saving.
 */

/** Simulated milliseconds since the world epoch (00:00 on the epoch date). */
export type SimTimeMs = bigint;

export const MS_PER_SECOND = 1_000n;
export const MS_PER_MINUTE = 60n * MS_PER_SECOND;
export const MS_PER_HOUR = 60n * MS_PER_MINUTE;
export const MS_PER_DAY = 24n * MS_PER_HOUR;

/** A date on the proleptic Gregorian calendar. `month` is 1–12. */
export interface CivilDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

/** ISO weekday: 1 = Monday … 7 = Sunday. */
export type IsoWeekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;

/** The calendar reading of one simulated instant. */
export interface CalendarInstant extends CivilDate {
  readonly weekday: IsoWeekday;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  readonly millisecond: number;
  /** Whole days since the epoch: 0 on the first day. */
  readonly dayIndex: number;
}

/** Supported calendar years (keeps every day count far inside safe-integer range). */
const MIN_YEAR = 1;
const MAX_YEAR = 9999;

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    return isLeapYear(year) ? 29 : 28;
  }
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

export function isValidCivilDate(date: CivilDate): boolean {
  const { year, month, day } = date;
  return (
    Number.isInteger(year) &&
    Number.isInteger(month) &&
    Number.isInteger(day) &&
    year >= MIN_YEAR &&
    year <= MAX_YEAR &&
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysInMonth(year, month)
  );
}

/**
 * Days from 1970-01-01 to `date` (negative before it). Howard Hinnant's
 * `days_from_civil`, all integer arithmetic.
 */
export function daysFromCivil(date: CivilDate): number {
  if (!isValidCivilDate(date)) {
    throw new RangeError(`Invalid calendar date ${date.year}-${date.month}-${date.day}`);
  }
  const year = date.month <= 2 ? date.year - 1 : date.year;
  const era = Math.floor(year / 400);
  const yearOfEra = year - era * 400;
  const shiftedMonth = date.month > 2 ? date.month - 3 : date.month + 9;
  const dayOfYear = Math.floor((153 * shiftedMonth + 2) / 5) + date.day - 1;
  const dayOfEra =
    yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  return era * 146_097 + dayOfEra - 719_468;
}

/** Inverse of {@link daysFromCivil} (Hinnant's `civil_from_days`). */
export function civilFromDays(days: number): CivilDate {
  if (!Number.isSafeInteger(days)) {
    throw new RangeError(`Day count must be a safe integer, got ${days}`);
  }
  const shifted = days + 719_468;
  const era = Math.floor(shifted / 146_097);
  const dayOfEra = shifted - era * 146_097;
  const yearOfEra = Math.floor(
    (dayOfEra -
      Math.floor(dayOfEra / 1460) +
      Math.floor(dayOfEra / 36_524) -
      Math.floor(dayOfEra / 146_096)) /
      365,
  );
  const dayOfYear =
    dayOfEra - (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100));
  const shiftedMonth = Math.floor((5 * dayOfYear + 2) / 153);
  const day = dayOfYear - Math.floor((153 * shiftedMonth + 2) / 5) + 1;
  const month = shiftedMonth < 10 ? shiftedMonth + 3 : shiftedMonth - 9;
  const year = yearOfEra + era * 400 + (month <= 2 ? 1 : 0);
  return { year, month, day };
}

/** ISO weekday of a day counted from 1970-01-01 (which was a Thursday). */
export function weekdayFromDays(days: number): IsoWeekday {
  return (((((days + 3) % 7) + 7) % 7) + 1) as IsoWeekday;
}

function assertNonNegative(time: SimTimeMs): void {
  if (time < 0n) {
    throw new RangeError(`Simulation time cannot be negative (${time} ms)`);
  }
}

/** Calendar reading of `time` in a world whose epoch is midnight on `epoch`. */
export function calendarAt(epoch: CivilDate, time: SimTimeMs): CalendarInstant {
  assertNonNegative(time);
  const dayIndex = Number(time / MS_PER_DAY);
  const days = daysFromCivil(epoch) + dayIndex;
  const date = civilFromDays(days);
  if (date.year > MAX_YEAR) {
    throw new RangeError(`Simulation time ${time} ms is beyond year ${MAX_YEAR}`);
  }
  const msOfDay = Number(time % MS_PER_DAY);
  return {
    ...date,
    weekday: weekdayFromDays(days),
    hour: Math.floor(msOfDay / 3_600_000),
    minute: Math.floor(msOfDay / 60_000) % 60,
    second: Math.floor(msOfDay / 1_000) % 60,
    millisecond: msOfDay % 1_000,
    dayIndex,
  };
}

/**
 * The same day of the month and time of day as `time`, `months` calendar
 * months later (`months` ≥ 0). A day that the target month lacks is clamped
 * to its last day, so a monthly date of the 31st falls on 29 February 1996,
 * then 31 March. Used for monthly obligations such as rent.
 */
export function addCalendarMonths(epoch: CivilDate, time: SimTimeMs, months: number): SimTimeMs {
  assertNonNegative(time);
  if (!Number.isSafeInteger(months) || months < 0) {
    throw new RangeError(`Month offset must be a non-negative safe integer, got ${months}`);
  }
  const start = calendarAt(epoch, time);
  const monthIndex = start.month - 1 + months;
  const year = start.year + Math.floor(monthIndex / 12);
  const month = (monthIndex % 12) + 1;
  if (year > MAX_YEAR) {
    throw new RangeError(`${months} months after ${time} ms is beyond year ${MAX_YEAR}`);
  }
  const day = Math.min(start.day, daysInMonth(year, month));
  const dayIndex = daysFromCivil({ year, month, day }) - daysFromCivil(epoch);
  return BigInt(dayIndex) * MS_PER_DAY + (time % MS_PER_DAY);
}

/** "1996-02-29" — the calendar date of `time`, for read models and messages. */
export function isoDateAt(epoch: CivilDate, time: SimTimeMs): string {
  const { year, month, day } = calendarAt(epoch, time);
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Midnight at the start of the next calendar day, strictly after `time`. */
export function startOfNextDay(time: SimTimeMs): SimTimeMs {
  assertNonNegative(time);
  return (time / MS_PER_DAY + 1n) * MS_PER_DAY;
}

/**
 * Midnight at the start of the next Monday, strictly after `time` — the end
 * of the current ISO week (Monday–Sunday).
 */
export function startOfNextWeek(epoch: CivilDate, time: SimTimeMs): SimTimeMs {
  assertNonNegative(time);
  const dayIndex = time / MS_PER_DAY;
  const weekday = weekdayFromDays(daysFromCivil(epoch) + Number(dayIndex));
  return (dayIndex + BigInt(8 - weekday)) * MS_PER_DAY;
}
