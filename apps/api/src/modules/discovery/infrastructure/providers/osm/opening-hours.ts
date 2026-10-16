// OSM `opening_hours` → weekly hours (BF-019). Covers the common forms ("Mo-Fr 09:00-18:00; Sa 10:00-12:00",
// "Mo-Fr 08:00-12:00,14:00-18:00", "Su off", "24/7"); anything else (months, holidays, sunrise, comments…)
// returns undefined rather than guessing.
// DECISION(BF-019): own parser instead of the `opening_hours` npm package, which is LGPL-3.0-only.

export interface WeeklyHours {
  readonly weekday: number; // 0 = Monday
  readonly opensAt: string;
  readonly closesAt: string;
}

const DAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
const TIME = /^([01]?\d|2[0-4]):([0-5]\d)$/;

function parseDays(spec: string): number[] | null {
  const days = new Set<number>();
  for (const part of spec.split(',')) {
    if (part === 'PH' || part === 'SH') continue; // holidays: not representable weekly
    const [from, to] = part.split('-');
    const start = DAYS.indexOf(from ?? '');
    const end = to === undefined ? start : DAYS.indexOf(to);
    if (start < 0 || end < 0) return null;
    for (let d = start; ; d = (d + 1) % 7) {
      days.add(d);
      if (d === end) break;
    }
  }
  return [...days];
}

function parseTime(value: string): string | null {
  const m = TIME.exec(value);
  if (!m) return null;
  const hours = Number(m[1]);
  if (hours === 24) return m[2] === '00' ? '23:59' : null;
  return `${String(hours).padStart(2, '0')}:${m[2]}`;
}

function parseRanges(spec: string): Array<[string, string]> | null {
  const ranges: Array<[string, string]> = [];
  for (const part of spec.split(',')) {
    const [from, to] = part.split('-');
    const opens = parseTime(from ?? '');
    const closes = parseTime(to ?? '');
    if (!opens || !closes) return null;
    ranges.push([opens, closes]);
  }
  return ranges;
}

export function parseOpeningHours(raw: string | undefined): WeeklyHours[] | undefined {
  const value = raw?.trim();
  if (!value || value.length > 500) return undefined;
  if (value === '24/7') {
    return DAYS.map((_, weekday) => ({ weekday, opensAt: '00:00', closesAt: '23:59' }));
  }
  const byDay = new Map<number, Array<[string, string]>>();
  // Rules are separated by ";" (and often ", " before a weekday: "Mo-Fr 09:00-18:00, Sa 10:00-12:00").
  const rules = value.replace(/,\s+(?=(?:Mo|Tu|We|Th|Fr|Sa|Su|PH)\b)/g, ';').split(';');
  for (const rule of rules.map((r) => r.trim()).filter(Boolean)) {
    const tokens = rule.split(/\s+/);
    const [first, second, ...rest] = tokens;
    if (rest.length > 0 || !first) return undefined;
    const hasDays = /^[A-Z]/.test(first);
    const days = hasDays ? parseDays(first) : [0, 1, 2, 3, 4, 5, 6];
    const timeSpec = hasDays ? second : first;
    if (!days || (hasDays ? false : second !== undefined)) return undefined;
    if (timeSpec === undefined) {
      if (first === 'PH') continue;
      return undefined;
    }
    // Later rules replace earlier ones for the days they name (OSM semantics).
    if (timeSpec === 'off' || timeSpec === 'closed') {
      for (const d of days) byDay.set(d, []);
      continue;
    }
    const ranges = parseRanges(timeSpec);
    if (!ranges) return undefined;
    for (const d of days) byDay.set(d, ranges);
  }
  const hours = [...byDay]
    .sort(([a], [b]) => a - b)
    .flatMap(([weekday, ranges]) => ranges.map(([opensAt, closesAt]) => ({ weekday, opensAt, closesAt })));
  return hours.length > 0 ? hours.slice(0, 50) : undefined;
}
