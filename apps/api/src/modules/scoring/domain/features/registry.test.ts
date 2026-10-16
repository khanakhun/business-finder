import { FEATURE_DEFINITIONS, FEATURE_KEYS } from '@bf/contracts';
import { describe, expect, it } from 'vitest';
import { AS_OF, facts, site } from '../__fixtures__/facts.ts';
import { computeFeatures, FEATURES } from './registry.ts';

const vector = (input = facts(), offer: 'new_website' | 'booking_system' = 'new_website') =>
  computeFeatures(input, { offer });

describe('feature registry', () => {
  it('has a compute function for each of its 25+ definitions, in registry order', () => {
    expect(FEATURES.map((feature) => feature.key)).toEqual(FEATURE_KEYS);
    expect(FEATURE_KEYS.length).toBeGreaterThanOrEqual(25);
    for (const key of FEATURE_KEYS) {
      const definition = FEATURE_DEFINITIONS[key];
      expect(definition.description.en.length, key).toBeGreaterThan(0);
      expect(definition.description.fr.length, key).toBeGreaterThan(0);
      if (definition.type === 'enum') expect(definition.values?.length, key).toBeGreaterThan(0);
    }
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
          pages: [{ kind: 'menu', url: 'https://example.test/menu' }] as never,
          freshness: {
            copyrightYear: 2021,
            httpLastModified: null,
            sitemapLastmod: '2024-04-14T00:00:00Z',
            latestDatedContent: null,
          },
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
      // Sitemap 2024-04-14 → 2.5 years before the facts.
      site_freshness_years: 2.5,
      has_booking_tool: true,
      has_online_menu: true,
      has_contact_form: true,
      has_language_gap_for_market: true,
      ad_pixels_present: true,
      no_solicitation_notice: false,
    });
  });

  it('tells "no website" from "not audited yet", and reads nothing from an unreadable crawl', () => {
    const none = vector(facts({ business: { websiteUrl: null }, audit: null, site: null }));
    expect(none).toMatchObject({
      has_website: false,
      website_status: 'none',
      has_https: null,
      has_booking_tool: null,
    });
    expect(vector(facts({ audit: null })).website_status).toBeNull();
    const blocked = vector(
      facts({
        site: {
          reachability: 'blocked',
          noSolicitation: { checked: false, detected: false, phrases: [], pageUrl: null, snippet: null },
        },
      }),
    );
    expect(blocked).toMatchObject({
      has_https: null,
      has_contact_form: null,
      ad_pixels_present: null,
      has_language_gap_for_market: null,
    });
    // Not checked: the default (false) stands in; a detected notice is true.
    expect(blocked.no_solicitation_notice).toBe(false);
    const notice = vector(
      facts({
        site: site({
          noSolicitation: { checked: true, detected: true, phrases: ['no'], pageUrl: null, snippet: null },
        }),
      }),
    );
    expect(notice.no_solicitation_notice).toBe(true);
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
          lastContactedAt: '2026-10-04T12:00:00.000Z',
        },
      }),
      'booking_system',
    );
    expect(v).toMatchObject({
      category_offer_relevance: 0.95,
      appointment_based: true,
      // Not set on the category: false stands in.
      tourism_facing: false,
      review_count_log: 3,
      multi_location: true,
      owner_response_rate: 0.1,
      'pain_share.booking_friction': 0.2,
      // Analysed reviews and no mention: 0, not missing.
      'pain_share.long_wait_times': 0,
      sentiment_avg: -0.2,
      has_verified_email: false,
      // The invalid personal address does not count: only a generic one is usable.
      has_generic_email_only: true,
      has_phone: false,
      has_whatsapp: true,
      do_not_contact: true,
      pipeline_status: 'contacted',
      days_since_last_contact: 10,
    });
    const unknown = vector(facts({ reviews: null, category: null, business: { ratingCount: null } }));
    expect(unknown).toMatchObject({
      'pain_share.booking_friction': null,
      sentiment_avg: null,
      category_offer_relevance: null,
      appointment_based: false,
      review_count_log: null,
      days_since_last_contact: null,
    });
  });

  it('is a pure function of the facts', () => {
    const input = facts();
    expect(vector(input)).toEqual(vector(structuredClone(input)));
    expect(AS_OF).toBe(input.asOf);
  });

  it('refuses a value outside its definition (a bug, never a silent score)', () => {
    expect(() => vector(facts({ business: { operatingStatus: 'bankrupt' as never } }))).toThrow(TypeError);
  });
});
