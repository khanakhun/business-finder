import type { HolidayCalendar } from '@bf/contracts';

// Public holidays as data (BF-050): no sending on them when the mailbox's window lists the calendar.
// DECISION(BF-050): FR = the 11 national public holidays (Easter Monday, Ascension and Whit Monday computed);
// BL adds 9 October (abolition of slavery in Saint-Barthélemy), MF adds 28 May (abolition in Saint-Martin);
// US = the 11 federal holidays on their calendar dates (observed Friday/Monday shifts are not applied).

const pad = (n: number) => String(n).padStart(2, '0');
const iso = (year: number, month: number, day: number) => `${year}-${pad(month)}-${pad(day)}`;

/** Easter Sunday (Gregorian, anonymous algorithm). */
function easter(year: number): Date {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(year, month - 1, day));
}

const plusDays = (date: Date, days: number) =>
  new Date(date.getTime() + days * 86_400_000).toISOString().slice(0, 10);

/** The `n`th (1-based; -1 = last) `weekday` (0 = Sunday) of a month. */
function nthWeekday(year: number, month: number, weekday: number, n: number): string {
  if (n > 0) {
    const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
    return iso(year, month, 1 + ((weekday - first + 7) % 7) + (n - 1) * 7);
  }
  const lastDay = new Date(Date.UTC(year, month, 0));
  const back = (lastDay.getUTCDay() - weekday + 7) % 7;
  return iso(year, month, lastDay.getUTCDate() - back);
}

function france(year: number): string[] {
  const sunday = easter(year);
  return [
    iso(year, 1, 1),
    plusDays(sunday, 1),
    iso(year, 5, 1),
    iso(year, 5, 8),
    plusDays(sunday, 39),
    plusDays(sunday, 50),
    iso(year, 7, 14),
    iso(year, 8, 15),
    iso(year, 11, 1),
    iso(year, 11, 11),
    iso(year, 12, 25),
  ];
}

function unitedStates(year: number): string[] {
  return [
    iso(year, 1, 1),
    nthWeekday(year, 1, 1, 3),
    nthWeekday(year, 2, 1, 3),
    nthWeekday(year, 5, 1, -1),
    iso(year, 6, 19),
    iso(year, 7, 4),
    nthWeekday(year, 9, 1, 1),
    nthWeekday(year, 10, 1, 2),
    iso(year, 11, 11),
    nthWeekday(year, 11, 4, 4),
    iso(year, 12, 25),
  ];
}

const CALENDARS: Record<HolidayCalendar, (year: number) => string[]> = {
  FR: france,
  BL: (year) => [...france(year), iso(year, 10, 9)],
  MF: (year) => [...france(year), iso(year, 5, 28)],
  US: unitedStates,
};

const cache = new Map<string, ReadonlySet<string>>();

export function holidaysOf(calendar: HolidayCalendar, year: number): ReadonlySet<string> {
  const key = `${calendar}:${year}`;
  let days = cache.get(key);
  if (!days) {
    days = new Set(CALENDARS[calendar](year));
    cache.set(key, days);
  }
  return days;
}

/** Whether the local date `YYYY-MM-DD` is a holiday in any of the calendars. */
export function isHoliday(date: string, calendars: readonly HolidayCalendar[]): boolean {
  const year = Number(date.slice(0, 4));
  return calendars.some((calendar) => holidaysOf(calendar, year).has(date));
}
