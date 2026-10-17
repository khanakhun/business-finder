import type { HolidayCalendar } from '@bf/contracts';
import { isHoliday } from '../mailbox/holidays.ts';
import { addDays, localDate, localParts, zonedInstant } from '../mailbox/zoned-time.ts';

// Business days (BF-053): weekends and the calendars' public holidays are skipped; waits are counted in the
// recipient's time zone and land at the preferred local time (DST-safe: the instant is computed from the local date
// and time in that zone).

export function isBusinessDay(date: string, calendars: readonly HolidayCalendar[]): boolean {
  const day = new Date(`${date}T12:00:00Z`).getUTCDay();
  return day !== 0 && day !== 6 && !isHoliday(date, calendars);
}

/** The local date `businessDays` business days after `date` (0: the date itself, or the next business day). */
export function addBusinessDays(
  date: string,
  businessDays: number,
  calendars: readonly HolidayCalendar[],
): string {
  let current = date;
  while (!isBusinessDay(current, calendars)) current = addDays(current, 1);
  let left = businessDays;
  while (left > 0) {
    current = addDays(current, 1);
    if (isBusinessDay(current, calendars)) left--;
  }
  return current;
}

/**
 * When a step waiting `businessDays` from `from` runs: that business day at the preferred local time (or at the
 * time of day `from` had, never in the past).
 */
export function nextRunAt(input: {
  readonly from: Date;
  readonly businessDays: number;
  readonly preferredLocalTime: string | null;
  readonly timeZone: string;
  readonly calendars: readonly HolidayCalendar[];
}): Date {
  const start = localDate(input.from, input.timeZone);
  const parts = localParts(input.from, input.timeZone);
  const time =
    input.preferredLocalTime ??
    `${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`;
  let date = addBusinessDays(start, input.businessDays, input.calendars);
  let at = zonedInstant(date, time, input.timeZone);
  // Today's preferred time already passed: the next business day.
  while (at.getTime() < input.from.getTime()) {
    date = addBusinessDays(addDays(date, 1), 0, input.calendars);
    at = zonedInstant(date, time, input.timeZone);
  }
  return at;
}
