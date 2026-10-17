import type { SendWindow } from '@bf/contracts';
import { isHoliday } from './holidays.ts';
import { addDays, localDate, localParts, zonedInstant } from './zoned-time.ts';

// Sending windows (BF-050): the next instant a mailbox may send to a recipient — inside the window's days and hours
// (in the recipient's timezone by default, else the mailbox's), outside holidays, at least `minIntervalSec` (±30 %
// jitter) after the mailbox's previous send.

const LOOKAHEAD_DAYS = 21;

export interface SlotInput {
  readonly window: SendWindow;
  /** The recipient's zone; the mailbox's zone is used when unknown or when the window follows the mailbox. */
  readonly recipientTimeZone: string | null;
  readonly now: Date;
  readonly lastSentAt: Date | null;
  readonly minIntervalSec: number;
  /** In [0, 1): injected for deterministic tests. */
  readonly random: () => number;
}

export const windowZone = (window: SendWindow, recipientTimeZone: string | null) =>
  window.timezoneMode === 'recipient' && recipientTimeZone ? recipientTimeZone : window.mailboxTimezone;

/** The interval after the previous send, with ±30 % jitter. */
export function jitteredIntervalMs(minIntervalSec: number, random: () => number): number {
  return Math.round(minIntervalSec * 1000 * (0.7 + 0.6 * random()));
}

/** The first instant at or after `from` inside the window, or null when none within three weeks. */
export function nextWindowOpening(window: SendWindow, timeZone: string, from: Date): Date | null {
  let date = localDate(from, timeZone);
  for (let i = 0; i < LOOKAHEAD_DAYS; i++, date = addDays(date, 1)) {
    const noon = zonedInstant(date, '12:00', timeZone);
    const weekday = localParts(noon, timeZone).weekday;
    if (!window.days.includes(weekday) || isHoliday(date, window.holidayCalendars)) continue;
    const start = zonedInstant(date, window.start, timeZone);
    const end = zonedInstant(date, window.end, timeZone);
    if (from.getTime() < end.getTime()) return from.getTime() > start.getTime() ? from : start;
  }
  return null;
}

export function nextSendSlot(input: SlotInput): Date | null {
  const spacing = input.lastSentAt
    ? input.lastSentAt.getTime() + jitteredIntervalMs(input.minIntervalSec, input.random)
    : 0;
  const earliest = new Date(Math.max(input.now.getTime(), spacing));
  return nextWindowOpening(input.window, windowZone(input.window, input.recipientTimeZone), earliest);
}

/** Whether `at` is inside the window (in `timeZone`). */
export function isInsideWindow(window: SendWindow, timeZone: string, at: Date): boolean {
  return nextWindowOpening(window, timeZone, at)?.getTime() === at.getTime();
}
