import { createHash } from 'node:crypto';
import { type FeatureVector, OFFERS, profileProblems } from '@bf/contracts';
import { describe, expect, it } from 'vitest';
import { facts, site } from './__fixtures__/facts.ts';
import { BUILTIN_PROFILE_VERSIONS, BUILTIN_PROFILES } from './builtin-profiles.ts';
import { scoreBusiness, scoreVector } from './engine.ts';

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

// The digest of every released version of each built-in, in order (index + 1 = version). Released = merged to main
// (then seeded somewhere): from then on an edit appends the new digest and bumps the version, never edits an entry.
const RELEASED: Record<string, readonly string[]> = {
  new_website: ['8dc3cf88813cc6ac'],
  website_redesign: ['efa2848249582362'],
  ai_receptionist: ['bbd3f46a7d1fe94b'],
  booking_system: ['b933f0fc4b3194d0'],
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

describe('booking_not_checked', () => {
  // A booking prospect that scores above the cap when its booking tool is known to be missing.
  const prospect: FeatureVector = {
    has_website: true,
    appointment_based: true,
    category_offer_relevance: 1,
    'pain_share.booking_friction': 0.3,
    review_count_log: 3,
    has_verified_email: true,
    has_phone: true,
  };
  const gateOf = (vector: FeatureVector) =>
    scoreVector(BUILTIN_PROFILES.booking_system, vector).gated?.gate ?? null;

  it.each([
    ['not audited yet', { website_status: null, has_booking_tool: null }, 'booking_not_checked'],
    [
      'blocked (audited ok, nothing read)',
      { website_status: 'ok', has_booking_tool: null },
      'booking_not_checked',
    ],
    ['broken', { website_status: 'broken', has_booking_tool: null }, 'booking_not_checked'],
    ['social page only', { website_status: 'social_only', has_booking_tool: null }, null],
    ['parked domain', { website_status: 'parked', has_booking_tool: null }, null],
    ['known: no booking tool', { website_status: 'ok', has_booking_tool: false }, null],
    ['no website', { has_website: false, website_status: 'none', has_booking_tool: null }, null],
  ] as [string, FeatureVector, string | null][])('%s → %s', (_, vector, gate) => {
    expect(gateOf({ ...prospect, ...vector })).toBe(gate);
  });
});

describe('blocked crawls', () => {
  it('are no sales argument: no measured or filled-in website reason, no redesign prospect', () => {
    const blocked = facts({
      audit: {
        status: 'ok',
        qualityScore: null,
        psiMobilePerformance: null,
        lcpMobileMs: null,
        visionOverall: null,
        findingCodes: [],
      },
      site: site({
        reachability: 'blocked',
        noSolicitation: { checked: false, detected: false, phrases: [], pageUrl: null, snippet: null },
      }),
    });
    const redesign = scoreBusiness(BUILTIN_PROFILES.website_redesign, blocked);
    expect(redesign.tier).toBe('C');
    expect(redesign.contributions.filter((c) => c.imputed === 'profile')).toEqual([]);
    const presence = [
      'website_quality_score',
      'vision_overall',
      'psi_mobile_performance',
      'lcp_mobile_seconds',
    ];
    expect(
      redesign.reasons.map((reason) => reason.feature).filter((feature) => presence.includes(feature)),
    ).toEqual([]);
    // The new website offer's gate makes no claim about it either.
    expect(scoreBusiness(BUILTIN_PROFILES.new_website, blocked).gated).toMatchObject({
      gate: 'has_working_website',
      reason: { en: 'The audit flagged no major problem with its website: see the redesign offer.' },
    });
    // Its status is `ok` by convention (never measured): the text claims no assessment.
    expect(
      redesign.reasons
        .filter((reason) => reason.feature === 'website_status')
        .map((reason) => reason.text.en),
    ).toEqual(['The audit flagged no major problem.']);
  });
});
