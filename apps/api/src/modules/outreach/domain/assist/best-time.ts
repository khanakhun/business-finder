import { localParts } from '../mailbox/zoned-time.ts';

// When to call a business (BF-057, Strategy by category): inside its opening hours (minus the first and last half
// hour), outside the rush of its trade — restaurants and cafés serve 11:30–14:30 and 18:30–21:30, salons are full on
// Saturdays, shops prefer mornings — or, without hours, on weekday mornings and afternoons. The answer is "good now"
// or the next good quarter of an hour within a week, in the business's time zone.

export interface OpeningHours {
  /** 0 = Monday. */
  readonly weekday: number;
  readonly opensAt: string;
  readonly closesAt: string;
}

type Range = readonly [number, number];

interface Profile {
  readonly rush: (weekday: number) => readonly Range[];
  readonly preferred: readonly Range[] | null;
}

const minutes = (time: string) => {
  const [h = 0, m = 0] = time.split(':').map(Number);
  return h * 60 + m;
};

const FOOD: Profile = {
  rush: () => [
    [11 * 60 + 30, 14 * 60 + 30],
    [18 * 60 + 30, 21 * 60 + 30],
  ],
  preferred: null,
};
const BEAUTY: Profile = { rush: (weekday) => (weekday === 5 ? [[0, 24 * 60]] : []), preferred: null };
const RETAIL: Profile = { rush: () => [], preferred: [[9 * 60 + 30, 11 * 60 + 30]] };
const DEFAULT: Profile = { rush: () => [], preferred: null };

function profileOf(categoryPath: string | null): Profile {
  const path = categoryPath ?? '';
  if (/food|restaurant|cafe|bar|bakery|catering/.test(path)) return FOOD;
  if (/beauty|hair|salon|spa|nail|barber/.test(path)) return BEAUTY;
  if (/shop|retail|store|boutique/.test(path)) return RETAIL;
  return DEFAULT;
}

/** Weekday opening windows without hours: 09:30–12:00 and 14:00–17:00, Monday to Friday. */
const DEFAULT_HOURS: OpeningHours[] = [0, 1, 2, 3, 4].flatMap((weekday) => [
  { weekday, opensAt: '09:30', closesAt: '12:00' },
  { weekday, opensAt: '14:00', closesAt: '17:00' },
]);

const WEEKDAY: Record<string, number> = { mon: 0, tue: 1, wed: 2, thu: 3, fri: 4, sat: 5, sun: 6 };
const STEP_MS = 15 * 60_000;
const MARGIN = 30;

export interface BestTimeResult {
  readonly goodNow: boolean;
  readonly nextAt: Date | null;
  readonly reason: 'open_hours' | 'default_hours' | 'rush' | 'closed';
}

export function bestTimeToCall(input: {
  readonly hours: readonly OpeningHours[];
  readonly categoryPath: string | null;
  readonly timeZone: string;
  readonly now: Date;
}): BestTimeResult {
  const profile = profileOf(input.categoryPath);
  const hours = input.hours.length > 0 ? input.hours : DEFAULT_HOURS;
  const fromDefaults = input.hours.length === 0;
  const good = (at: Date): 'good' | 'rush' | 'closed' => {
    const parts = localParts(at, input.timeZone);
    const weekday = WEEKDAY[parts.weekday] ?? 0;
    const minute = parts.hour * 60 + parts.minute;
    const margin = fromDefaults ? 0 : MARGIN;
    const open = hours.some((range) => {
      const opens = minutes(range.opensAt);
      const closes = minutes(range.closesAt);
      // `closes <= opens` runs past midnight: the evening on its weekday, the early hours on the next.
      if (closes > opens)
        return range.weekday === weekday && minute >= opens + margin && minute < closes - margin;
      if (range.weekday === weekday) return minute >= opens + margin;
      return (range.weekday + 1) % 7 === weekday && minute < closes - margin;
    });
    if (!open) return 'closed';
    if (profile.rush(weekday).some(([from, to]) => minute >= from && minute < to)) return 'rush';
    if (profile.preferred && !profile.preferred.some(([from, to]) => minute >= from && minute < to))
      return 'rush';
    return 'good';
  };
  const now = good(input.now);
  if (now === 'good')
    return { goodNow: true, nextAt: input.now, reason: fromDefaults ? 'default_hours' : 'open_hours' };
  // The next good quarter hour within a week.
  const start = Math.ceil(input.now.getTime() / STEP_MS) * STEP_MS;
  for (let at = start; at < input.now.getTime() + 7 * 86_400_000; at += STEP_MS)
    if (good(new Date(at)) === 'good')
      return { goodNow: false, nextAt: new Date(at), reason: now === 'rush' ? 'rush' : 'closed' };
  return { goodNow: false, nextAt: null, reason: 'closed' };
}
