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

// Each built-in version is immutable once seeded: an edit must bump its version and update its digest here.
const PINNED: Record<string, { version: number; digest: string }> = {
  new_website: { version: 1, digest: '09305d7e5127ef07' },
  website_redesign: { version: 1, digest: '7906e967c53d5c83' },
  ai_receptionist: { version: 1, digest: 'bbd3f46a7d1fe94b' },
  booking_system: { version: 1, digest: 'f8334b27cdbca8de' },
  local_seo: { version: 1, digest: '61745a2709b3106e' },
};

describe('built-in profiles', () => {
  it('are usable (no profile problems) and one per offer', () => {
    for (const offer of OFFERS) {
      expect(BUILTIN_PROFILES[offer].offer).toBe(offer);
      expect(profileProblems(BUILTIN_PROFILES[offer]), offer).toEqual([]);
    }
  });

  it('pin each version to its config (edit a profile → bump its version)', () => {
    const actual = Object.fromEntries(
      OFFERS.map((offer) => [
        offer,
        { version: BUILTIN_PROFILE_VERSIONS[offer], digest: digest(BUILTIN_PROFILES[offer]) },
      ]),
    );
    expect(actual).toEqual(PINNED);
  });
});
