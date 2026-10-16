// Opening hours (BF-034): weekday names and times in the visitor's language, and whether the business is open now in
// its own time zone. Pure functions: the "open now" island calls them in the browser with the current time.

/**
 * The weekdays as the SiteSpec keys them (same as `WEEKDAYS` in @bf/site-schema, tested). Declared here so the "open
 * now" island does not bundle the schema and zod.
 */
export const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export type Weekday = (typeof WEEKDAYS)[number];
export interface Span {
  readonly open: string;
  readonly close: string;
}
export type Weekly = Readonly<Record<Weekday, readonly Span[]>>;

/** A Monday in UTC: weekday names are read from the week starting there (deterministic). */
const MONDAY = Date.UTC(2024, 0, 1);

/** The weekday's name in the locale (`lundi`, `Monday`). */
export function weekdayName(day: Weekday, locale: string, width: 'long' | 'short' = 'long'): string {
  const date = new Date(MONDAY + WEEKDAYS.indexOf(day) * 86_400_000);
  return new Intl.DateTimeFormat(locale, { weekday: width, timeZone: 'UTC' }).format(date);
}

/** A time (HH:MM) as the locale writes it: `9:30` in French, `9:30 AM` in English. */
export function formatTime(time: string, locale: string): string {
  const [hours, minutes] = time.split(':').map(Number) as [number, number];
  const date = new Date(Date.UTC(2024, 0, 1, hours, minutes));
  return new Intl.DateTimeFormat(locale, {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'UTC',
  }).format(date);
}

/** A span as the locale writes it (`09:00–12:30`). */
export const formatSpan = (span: Span, locale: string) =>
  `${formatTime(span.open, locale)}–${formatTime(span.close, locale)}`;

/**
 * Days with the same spans, grouped for a compact display: `[['mon','fri'], spans]` reads "Monday–Friday".
 * Consecutive days only, in week order.
 */
export function groupDays(weekly: Weekly): { from: Weekday; to: Weekday; spans: readonly Span[] }[] {
  const groups: { from: Weekday; to: Weekday; spans: readonly Span[] }[] = [];
  const key = (spans: readonly Span[]) => spans.map((span) => `${span.open}-${span.close}`).join(',');
  for (const day of WEEKDAYS) {
    const last = groups.at(-1);
    if (last && key(last.spans) === key(weekly[day])) last.to = day;
    else groups.push({ from: day, to: day, spans: weekly[day] });
  }
  return groups;
}

const minutes = (time: string) => {
  const [hours, mins] = time.split(':').map(Number) as [number, number];
  return hours * 60 + mins;
};

/** Where a moment falls in a time zone: its weekday and minute of the day. */
export function localMoment(now: Date, timeZone: string): { day: Weekday; minute: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const part = (type: string) => parts.find((candidate) => candidate.type === type)?.value ?? '';
  const day = part('weekday').toLowerCase().slice(0, 3) as Weekday;
  return { day, minute: (Number(part('hour')) % 24) * 60 + Number(part('minute')) };
}

export type OpenStatus =
  | { readonly open: true; readonly closesAt: string }
  | {
      readonly open: false;
      readonly opensAt?: { readonly day: Weekday; readonly time: string; readonly today: boolean };
    };

const next = (day: Weekday, offset: number) => WEEKDAYS[(WEEKDAYS.indexOf(day) + offset) % 7] as Weekday;

/**
 * Is the business open at `now` in `timeZone`? A span whose close is not after its open ends the next day
 * (`22:00–02:00`; `00:00–00:00` is the whole day). When closed, the next opening within a week.
 */
export function openStatus(weekly: Weekly, now: Date, timeZone: string): OpenStatus {
  const { day, minute } = localMoment(now, timeZone);
  const yesterday = next(day, 6);
  for (const span of weekly[yesterday]) {
    const [open, close] = [minutes(span.open), minutes(span.close)];
    if (close <= open && minute < close) return { open: true, closesAt: span.close };
  }
  for (const span of weekly[day]) {
    const [open, close] = [minutes(span.open), minutes(span.close)];
    const overnight = close <= open;
    if (minute >= open && (overnight || minute < close)) return { open: true, closesAt: span.close };
  }
  // Today (later), the next six days, then today next week (a business open one day a week).
  for (let offset = 0; offset <= 7; offset += 1) {
    const candidate = next(day, offset);
    const spans = [...weekly[candidate]].sort((a, b) => minutes(a.open) - minutes(b.open));
    const upcoming = spans.find((span) => offset > 0 || minutes(span.open) > minute);
    if (upcoming)
      return { open: false, opensAt: { day: candidate, time: upcoming.open, today: offset === 0 } };
  }
  return { open: false };
}

/**
 * The business's time zone from its country, where the country has one (the spec has no time zone yet).
 * DECISION(BF-034): countries with several zones (US, CA, BR, AU…) get none, so "open now" is not shown for them.
 */
const COUNTRY_TIME_ZONES: Readonly<Record<string, string>> = {
  BL: 'America/St_Barthelemy',
  MF: 'America/Marigot',
  SX: 'America/Lower_Princes',
  GP: 'America/Guadeloupe',
  MQ: 'America/Martinique',
  GF: 'America/Cayenne',
  RE: 'Indian/Reunion',
  YT: 'Indian/Mayotte',
  PM: 'America/Miquelon',
  FR: 'Europe/Paris',
  MC: 'Europe/Monaco',
  BE: 'Europe/Brussels',
  LU: 'Europe/Luxembourg',
  CH: 'Europe/Zurich',
  NL: 'Europe/Amsterdam',
  DE: 'Europe/Berlin',
  AT: 'Europe/Vienna',
  IT: 'Europe/Rome',
  ES: 'Europe/Madrid',
  PT: 'Europe/Lisbon',
  GB: 'Europe/London',
  IE: 'Europe/Dublin',
  AG: 'America/Antigua',
  AI: 'America/Anguilla',
  KN: 'America/St_Kitts',
  VG: 'America/Tortola',
  VI: 'America/St_Thomas',
  PR: 'America/Puerto_Rico',
  BB: 'America/Barbados',
  LC: 'America/St_Lucia',
  DM: 'America/Dominica',
};

export const timeZoneOf = (country: string | undefined): string | undefined =>
  country ? COUNTRY_TIME_ZONES[country] : undefined;
