// Site views (BF-035): counted per site and UTC day (flushed to site_view_daily) and per UTC hour (the hourly
// `site.viewed` events). Unique visitors are a HyperLogLog estimate over a daily-salted hash of IP and user agent:
// neither is ever stored, and a visitor cannot be followed from one day to the next.

/** The UTC day of a moment (`2026-10-14`). */
export const dayOf = (at: Date) => at.toISOString().slice(0, 10);

/** The start of the UTC hour of a moment (`2026-10-14T12:00:00.000Z`). */
export const hourOf = (at: Date) => `${at.toISOString().slice(0, 13)}:00:00.000Z`;

/** The last `days` UTC days ending with today's, as their first day (`2026-10-08` for 7 days to the 14th). */
export const firstDayOf = (now: Date, days: number) =>
  dayOf(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - (days - 1))));
