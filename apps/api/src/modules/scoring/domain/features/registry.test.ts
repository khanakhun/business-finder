import { FEATURE_DEFINITIONS, FEATURE_KEYS, type FeatureVector } from '@bf/contracts';
import { describe, expect, it } from 'vitest';
import { AS_OF, facts, site } from '../__fixtures__/facts.ts';
import type { BusinessFacts, SiteFacts } from '../facts.ts';
import { computeFeatures, FEATURES, withDefaults } from './registry.ts';

const vector = (input: BusinessFacts = facts(), offer: 'new_website' | 'booking_system' = 'new_website') =>
  computeFeatures(input, { offer });
const feature = <K extends keyof FeatureVector>(key: K, input: BusinessFacts) => vector(input)[key];

const NO_DATES: SiteFacts['freshness'] = {
  copyrightYear: null,
  httpLastModified: null,
  sitemapLastmod: null,
  latestDatedContent: null,
};
const unchecked = { checked: false, detected: false, phrases: [], pageUrl: null, snippet: null };

describe('feature registry', () => {
  it('has a compute function for each of its 25+ definitions, in registry order', () => {
    expect(FEATURES.map((entry) => entry.key)).toEqual(FEATURE_KEYS);
    expect(FEATURE_KEYS.length).toBeGreaterThanOrEqual(25);
  });

  it('reads presence from the business, the latest audit and the crawl', () => {
    const v = vector(
      facts({
        audit: {
          status: 'weak',
          qualityScore: 41,
          psiMobilePerformance: 30,
          lcpMobileMs: 6_250,
          visionOverall: 3,
          findingCodes: ['missing_english'],
        },
        site: {
          security: { https: false, hsts: false, mixedContent: false },
          booking: { providers: [{ name: 'Booky', evidence: 'booky.test' }] },
          pages: [{ kind: 'menu', url: 'https://example.test/menu' }] as SiteFacts['pages'],
          contacts: {
            emails: [],
            phones: [],
            whatsappLinks: [],
            contactForms: [{ pageUrl: 'https://example.test/c', action: null }],
          },
          analytics: { ga4: true, gtm: false, metaPixel: true, tiktokPixel: false, others: [] },
        },
      }),
    );
    expect(v).toMatchObject({
      has_website: true,
      website_status: 'weak',
      website_quality_score: 41,
      psi_mobile_performance: 30,
      lcp_mobile_seconds: 6.25,
      vision_overall: 3,
      has_https: false,
      has_booking_tool: true,
      has_online_menu: true,
      has_contact_form: true,
      has_language_gap_for_market: true,
      ad_pixels_present: true,
      no_solicitation_notice: false,
    });
  });

  it.each([
    ['the copyright year (its last day)', { copyrightYear: 2021 }, 4.8],
    ['dated content', { latestDatedContent: '2025-04-14' }, 1.5],
    ['the sitemap', { sitemapLastmod: '2024-04-14T00:00:00Z' }, 2.5],
    ['Last-Modified', { httpLastModified: '2020-10-14T12:00:00Z' }, 6],
    ['the most recent of several', { copyrightYear: 2019, latestDatedContent: '2025-04-14' }, 1.5],
    ['a future date (never negative)', { sitemapLastmod: '2030-01-01T00:00:00Z' }, 0],
    ['no parseable date', { sitemapLastmod: 'not a date' }, null],
  ])('measures freshness from %s', (_, dates, years) => {
    expect(feature('site_freshness_years', facts({ site: { freshness: { ...NO_DATES, ...dates } } }))).toBe(
      years,
    );
  });

  it('reads the other branch of booking and menu, and both ad pixels', () => {
    const bookingPage = site({
      pages: [{ kind: 'booking', url: 'https://example.test/book' }] as SiteFacts['pages'],
    });
    expect(feature('has_booking_tool', facts({ site: bookingPage }))).toBe(true);
    const ordering = site({ ordering: { providers: [{ name: 'Orderly', evidence: 'orderly.test' }] } });
    expect(feature('has_online_menu', facts({ site: ordering }))).toBe(true);
    expect(feature('has_booking_tool', facts())).toBe(false);
    expect(feature('has_online_menu', facts())).toBe(false);
    const tiktok = site({
      analytics: { ga4: false, gtm: false, metaPixel: false, tiktokPixel: true, others: [] },
    });
    expect(feature('ad_pixels_present', facts({ site: tiktok }))).toBe(true);
    expect(feature('ad_pixels_present', facts())).toBe(false);
  });

  it('reads the market language gap from the audit', () => {
    expect(
      feature('has_language_gap_for_market', facts({ audit: { findingCodes: ['missing_french'] } })),
    ).toBe(true);
    expect(feature('has_language_gap_for_market', facts())).toBe(false);
    expect(feature('has_language_gap_for_market', facts({ audit: null }))).toBeNull();
  });

  it('tells "no website" from "not audited yet", even with a stale audit', () => {
    const none = vector(facts({ business: { websiteUrl: null }, audit: null, site: null }));
    expect(none).toMatchObject({
      has_website: false,
      website_status: 'none',
      has_https: null,
      has_booking_tool: null,
    });
    expect(feature('website_status', facts({ audit: null }))).toBeNull();
    expect(
      feature('website_status', facts({ business: { websiteUrl: null }, audit: { status: 'ok' } })),
    ).toBe('none');
  });

  it.each([
    ['redirected', { reachability: 'redirected' as const }, true],
    ['blocked', { reachability: 'blocked' as const, noSolicitation: unchecked }, null],
    ['parked', { reachability: 'parked' as const, noSolicitation: unchecked }, null],
    ['server error', { reachability: 'server_error' as const, noSolicitation: unchecked }, null],
    ['social profile', { socialOnly: true, noSolicitation: unchecked }, null],
  ])('reads a %s crawl only when it is a live page', (_, crawl, https) => {
    const v = vector(facts({ site: crawl }));
    expect(v.has_https).toBe(https);
    expect(v.has_contact_form).toBe(https === null ? null : false);
    expect(v.ad_pixels_present).toBe(https === null ? null : false);
  });

  it('knows a no-solicitation notice only from a page that was read', () => {
    expect(feature('no_solicitation_notice', facts({ site: { noSolicitation: unchecked } }))).toBeNull();
    const detected = { checked: true, detected: true, phrases: ['no'], pageUrl: null, snippet: null };
    expect(feature('no_solicitation_notice', facts({ site: { noSolicitation: detected } }))).toBe(true);
    expect(feature('no_solicitation_notice', facts())).toBe(false);
  });

  it('reads business, pain, reachability and workspace facts', () => {
    const v = vector(
      facts({
        business: { ratingCount: 999, sharedWebsiteCount: 3 },
        category: { attributes: { appointmentBased: true }, offerRelevance: { booking_system: 0.95 } },
        reviews: {
          sampleSize: 25,
          painShare: { booking_friction: 0.2 },
          sentimentAvg: -0.2,
          ownerResponseRate: 0.1,
        },
        contacts: {
          emails: [
            { status: 'invalid', generic: false },
            { status: 'unknown', generic: true },
          ],
          phones: 0,
          whatsapp: 2,
        },
        workspace: {
          doNotContact: true,
          pipelineStatus: 'contacted',
          lastContactedAt: '2026-10-04T13:00:00.000Z',
        },
      }),
      'booking_system',
    );
    expect(v).toMatchObject({
      category_offer_relevance: 0.95,
      appointment_based: true,
      // Not set on the category: missing (scoring applies the default).
      tourism_facing: null,
      review_count_log: 3,
      multi_location: true,
      owner_response_rate: 0.1,
      'pain_share.booking_friction': 0.2,
      // Analysed reviews and no mention: 0, not missing.
      'pain_share.long_wait_times': 0,
      sentiment_avg: -0.2,
      has_verified_email: false,
      has_usable_email: true,
      // The invalid personal address does not count: only a generic one is usable.
      has_generic_email_only: true,
      has_phone: false,
      has_whatsapp: true,
      do_not_contact: true,
      pipeline_status: 'contacted',
      // 9 days and 23 hours: whole days.
      days_since_last_contact: 9,
    });
  });

  it.each([
    ['no e-mail', [], { has_usable_email: false, has_generic_email_only: null, has_verified_email: false }],
    [
      'only an invalid one',
      [{ status: 'invalid', generic: true }],
      { has_usable_email: false, has_generic_email_only: null },
    ],
    [
      'a generic and a personal one',
      [
        { status: 'valid', generic: true },
        { status: 'risky', generic: false },
      ],
      { has_usable_email: true, has_generic_email_only: false, has_verified_email: true },
    ],
    [
      'a disposable personal and an accept-all generic one',
      [
        { status: 'disposable', generic: false },
        { status: 'catch_all', generic: true },
      ],
      { has_usable_email: true, has_generic_email_only: true, has_verified_email: false },
    ],
  ] as const)('reads reachability with %s', (_, emails, expected) => {
    expect(vector(facts({ contacts: { emails } }))).toMatchObject(expected);
  });

  it('keeps unknowns missing: pains without analysed reviews, categories, counts, contacts', () => {
    expect(vector(facts({ reviews: null, category: null, business: { ratingCount: null } }))).toMatchObject({
      'pain_share.booking_friction': null,
      sentiment_avg: null,
      category_offer_relevance: null,
      appointment_based: null,
      review_count_log: null,
      days_since_last_contact: null,
    });
    const noReviews = facts({
      reviews: { sampleSize: 0, painShare: { booking_friction: 0.5 }, sentimentAvg: null },
    });
    expect(vector(noReviews)['pain_share.booking_friction']).toBeNull();
    expect(feature('sentiment_avg', facts({ reviews: { sentimentAvg: null } }))).toBeNull();
    expect(feature('category_offer_relevance', facts({ category: { offerRelevance: {} } }))).toBeNull();
    expect(feature('review_count_log', facts({ business: { ratingCount: 0 } }))).toBe(0);
    expect(feature('review_count_log', facts({ business: { ratingCount: -5 } }))).toBe(0);
    expect(
      feature('days_since_last_contact', facts({ workspace: { lastContactedAt: '2030-01-01T00:00:00Z' } })),
    ).toBe(0);
  });

  it('counts several locations from two businesses on one domain, never without a website', () => {
    expect(feature('multi_location', facts({ business: { sharedWebsiteCount: 2 } }))).toBe(true);
    expect(feature('multi_location', facts({ business: { sharedWebsiteCount: 1 } }))).toBe(false);
    expect(feature('multi_location', facts({ business: { websiteUrl: null, sharedWebsiteCount: 3 } }))).toBe(
      false,
    );
  });

  it('applies the registry defaults only when scoring reads the vector', () => {
    const stored = vector(facts({ category: null, site: { noSolicitation: unchecked } }));
    expect(stored.tourism_facing).toBeNull();
    expect(stored.no_solicitation_notice).toBeNull();
    const effective = withDefaults(stored);
    expect(effective.tourism_facing).toBe(false);
    expect(effective.no_solicitation_notice).toBe(false);
    // A missing value without a default stays missing; known values are untouched.
    expect(effective.category_offer_relevance).toBeUndefined();
    expect(effective.has_website).toBe(true);
    const defaults = Object.fromEntries(
      FEATURE_KEYS.flatMap((key) => {
        const fallback = FEATURE_DEFINITIONS[key].missingDefault;
        return fallback === undefined ? [] : [[key, fallback]];
      }),
    );
    expect(Object.keys(defaults).length).toBeGreaterThan(5);
    expect(withDefaults({})).toEqual(defaults);
  });

  it('is a pure function of the facts', () => {
    const input = facts();
    expect(vector(input)).toEqual(vector(structuredClone(input)));
    expect(input.asOf).toBe(AS_OF);
  });

  it('refuses a value outside its definition (a bug, never a silent score)', () => {
    expect(() => vector(facts({ business: { operatingStatus: 'bankrupt' as never } }))).toThrow(TypeError);
    expect(() => vector(facts({ business: { ratingAvg: Number.NaN } }))).toThrow(TypeError);
  });
});
