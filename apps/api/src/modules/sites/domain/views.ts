// Site views (BF-035): counted per site and UTC day (flushed to site_view_daily) and per UTC hour (the hourly
// `site.viewed` events). Unique visitors are a HyperLogLog estimate over a hash of the visitor's network address
// with a random salt of the day (kept in Valkey for two days): no address is stored, and a day's hashes cannot be
// linked to another day's.

/** The UTC day of a moment (`2026-10-14`). */
export const dayOf = (at: Date) => at.toISOString().slice(0, 10);

/** The start of the UTC hour of a moment (`2026-10-14T12:00:00.000Z`). */
export const hourOf = (at: Date) => `${at.toISOString().slice(0, 13)}:00:00.000Z`;

/** The last `days` UTC days ending with today's, as their first day (`2026-10-08` for 7 days to the 14th). */
export const firstDayOf = (now: Date, days: number) =>
  dayOf(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - (days - 1))));
