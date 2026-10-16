import { z } from 'zod';

/** Inject a Clock instead of calling `Date.now()` in domain code (AGENTS.md §6). */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

/** Clock for tests: returns `at` until advanced. */
export function fixedClock(
  at: Date | string,
): Clock & { advance(ms: number): void; set(to: Date | string): void } {
  let current = new Date(at);
  return {
    now: () => new Date(current),
    advance(ms) {
      current = new Date(current.getTime() + ms);
    },
    set(to) {
      current = new Date(to);
    },
  };
}

/** ISO-8601 timestamp in UTC (`…Z`), the only datetime format in JSON. */
export const IsoDateTimeSchema = z.iso.datetime();
export type IsoDateTime = z.infer<typeof IsoDateTimeSchema>;
