import { createHash } from 'node:crypto';
import { OFFERS, profileProblems } from '@bf/contracts';
import { describe, expect, it } from 'vitest';
import { BUILTIN_PROFILE_VERSIONS, BUILTIN_PROFILES } from './builtin-profiles.ts';

/** A stable digest of a config (keys sorted at every level). */
const digest = (value: unknown): string => {
  const stable = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(stable)
      : v && typeof v === 'object'
        ? Object.fromEntries(
            Object.entries(v)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, x]) => [k, stable(x)]),
          )
        : v;
  return createHash('sha256')
    .update(JSON.stringify(stable(value)))
    .digest('hex')
    .slice(0, 16);
};

// The digest of every released version of each built-in, in order (index + 1 = version), append-only: an edit
// appends the new digest and bumps the version; released entries never change.
const RELEASED: Record<string, readonly string[]> = {
  new_website: ['09305d7e5127ef07'],
  website_redesign: ['2ab63c3a9b11f626'],
  ai_receptionist: ['bbd3f46a7d1fe94b'],
  booking_system: ['54148beed33d29de'],
  local_seo: ['61745a2709b3106e'],
};

describe('built-in profiles', () => {
  it('are usable (no profile problems) and one per offer', () => {
    for (const offer of OFFERS) {
      expect(BUILTIN_PROFILES[offer].offer).toBe(offer);
      expect(profileProblems(BUILTIN_PROFILES[offer]), offer).toEqual([]);
    }
  });

  it('pin each version to its config (edit a profile → append its digest and bump its version)', () => {
    for (const offer of OFFERS) {
      const released = RELEASED[offer] ?? [];
      expect(BUILTIN_PROFILE_VERSIONS[offer], offer).toBe(released.length);
      expect(digest(BUILTIN_PROFILES[offer]), offer).toBe(released.at(-1));
    }
  });
});
