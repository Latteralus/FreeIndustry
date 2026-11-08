import fc from 'fast-check';
import {
  calendarAt,
  civilFromDays,
  daysFromCivil,
  isValidCivilDate,
  MS_PER_DAY,
  MS_PER_HOUR,
  MS_PER_MINUTE,
  startOfNextDay,
  startOfNextWeek,
  weekdayFromDays,
} from '../../../src/domain/time';

// The JavaScript Date is used only here, in tests, as an independent oracle.
const DAY_MS = 86_400_000;
const oracle = (days: number) => {
  const date = new Date(days * DAY_MS);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    weekday: ((date.getUTCDay() + 6) % 7) + 1,
  };
};

const EPOCH = { year: 1996, month: 1, day: 1 };

describe('civil calendar arithmetic', () => {
  it('anchors on known dates', () => {
    expect(daysFromCivil({ year: 1970, month: 1, day: 1 })).toBe(0);
    expect(daysFromCivil({ year: 1996, month: 1, day: 1 })).toBe(9_496);
    expect(daysFromCivil({ year: 2000, month: 3, day: 1 })).toBe(11_017);
    expect(weekdayFromDays(0)).toBe(4); // 1970-01-01 was a Thursday
    expect(weekdayFromDays(daysFromCivil(EPOCH))).toBe(1); // 1996-01-01 was a Monday
  });

  it('property: agrees with an independent calendar for years 1–9999', () => {
    const minDays = daysFromCivil({ year: 1, month: 1, day: 1 });
    const maxDays = daysFromCivil({ year: 9999, month: 12, day: 31 });
    fc.assert(
      fc.property(fc.integer({ min: minDays, max: maxDays }), (days) => {
        const date = civilFromDays(days);
        const expected = oracle(days);
        expect({ ...date, weekday: weekdayFromDays(days) }).toEqual(expected);
        expect(daysFromCivil(date)).toBe(days);
      }),
      { numRuns: 2_000 },
    );
  });

  it('handles leap days, including century rules', () => {
    expect(isValidCivilDate({ year: 1996, month: 2, day: 29 })).toBe(true);
    expect(isValidCivilDate({ year: 1900, month: 2, day: 29 })).toBe(false);
    expect(isValidCivilDate({ year: 2000, month: 2, day: 29 })).toBe(true);
    expect(isValidCivilDate({ year: 1997, month: 2, day: 29 })).toBe(false);
    expect(isValidCivilDate({ year: 1996, month: 4, day: 31 })).toBe(false);
    expect(isValidCivilDate({ year: 0, month: 1, day: 1 })).toBe(false);
    expect(isValidCivilDate({ year: 1996, month: 1.5, day: 1 })).toBe(false);
    expect(() => daysFromCivil({ year: 1996, month: 13, day: 1 })).toThrow(RangeError);
  });
});

describe('calendarAt', () => {
  it('reads time 0 as midnight on the epoch date', () => {
    expect(calendarAt(EPOCH, 0n)).toEqual({
      year: 1996,
      month: 1,
      day: 1,
      weekday: 1,
      hour: 0,
      minute: 0,
      second: 0,
      millisecond: 0,
      dayIndex: 0,
    });
  });

  it('reads hours, minutes, seconds and milliseconds exactly', () => {
    const time = 59n * MS_PER_DAY + 13n * MS_PER_HOUR + 7n * MS_PER_MINUTE + 9_123n;
    expect(calendarAt(EPOCH, time)).toEqual({
      year: 1996,
      month: 2,
      day: 29, // 1996 is a leap year
      weekday: 4,
      hour: 13,
      minute: 7,
      second: 9,
      millisecond: 123,
      dayIndex: 59,
    });
  });

  it('refuses negative time', () => {
    expect(() => calendarAt(EPOCH, -1n)).toThrow(RangeError);
  });
});

describe('advance targets', () => {
  it('end of day is the next midnight, strictly after now', () => {
    expect(startOfNextDay(0n)).toBe(MS_PER_DAY);
    expect(startOfNextDay(MS_PER_DAY - 1n)).toBe(MS_PER_DAY);
    expect(startOfNextDay(MS_PER_DAY)).toBe(2n * MS_PER_DAY);
  });

  it('end of week is the next Monday 00:00, strictly after now', () => {
    // Epoch is a Monday: from any time in the first week, the next week starts on day 7.
    expect(startOfNextWeek(EPOCH, 0n)).toBe(7n * MS_PER_DAY);
    expect(startOfNextWeek(EPOCH, 6n * MS_PER_DAY + 5n)).toBe(7n * MS_PER_DAY);
    expect(startOfNextWeek(EPOCH, 7n * MS_PER_DAY)).toBe(14n * MS_PER_DAY);
    // A Thursday epoch: the first Monday is day 4.
    expect(startOfNextWeek({ year: 1970, month: 1, day: 1 }, 0n)).toBe(4n * MS_PER_DAY);
  });

  it('property: the week target is a Monday midnight within seven days', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 3_650n * MS_PER_DAY }), (time) => {
        const target = startOfNextWeek(EPOCH, time);
        expect(target > time).toBe(true);
        expect(target - time <= 7n * MS_PER_DAY).toBe(true);
        expect(target % MS_PER_DAY).toBe(0n);
        expect(calendarAt(EPOCH, target).weekday).toBe(1);
      }),
    );
  });
});
