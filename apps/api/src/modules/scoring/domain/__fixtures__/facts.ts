import type { BusinessFacts, SiteFacts } from '../facts.ts';

// Fake businesses for scoring tests (fictional; no real business or person).

export const AS_OF = '2026-10-14T12:00:00.000Z';

export const site = (overrides: Partial<SiteFacts> = {}): SiteFacts => ({
  reachability: 'ok',
  socialOnly: false,
  security: { https: true, hsts: true, mixedContent: false },
  pages: [{ kind: 'home', url: 'https://example.test/' }] as SiteFacts['pages'],
  booking: { providers: [] },
  ordering: { providers: [] },
  contacts: { emails: [], phones: [], whatsappLinks: [], contactForms: [] },
  analytics: { ga4: false, gtm: false, metaPixel: false, tiktokPixel: false, others: [] },
  freshness: { copyrightYear: 2026, httpLastModified: null, sitemapLastmod: null, latestDatedContent: null },
  noSolicitation: { checked: true, detected: false, phrases: [], pageUrl: null, snippet: null },
  ...overrides,
});

type Overrides = {
  [K in keyof BusinessFacts]?: BusinessFacts[K] extends object | null
    ? Partial<NonNullable<BusinessFacts[K]>> | null
    : BusinessFacts[K];
};

/** A reachable, operational restaurant with a decent website; override any part. */
export function facts(overrides: Overrides = {}): BusinessFacts {
  const merge = <T extends object>(base: T, part: Partial<T> | null | undefined): T | null =>
    part === null ? null : { ...base, ...part };
  return {
    businessId: overrides.businessId ?? '01990000-0000-7000-8000-000000000001',
    asOf: overrides.asOf ?? AS_OF,
    business: merge(
      {
        countryCode: 'BL',
        operatingStatus: 'operational',
        priceLevel: 2,
        ratingAvg: 4.3,
        ratingCount: 120,
        websiteUrl: 'https://example.test/',
        sharedWebsiteCount: 1,
      },
      overrides.business,
    ) as BusinessFacts['business'],
    category: merge(
      {
        attributes: { hospitality: true, tourismFacing: true },
        offerRelevance: {
          new_website: 0.8,
          website_redesign: 0.8,
          ai_receptionist: 0.6,
          booking_system: 0.7,
          local_seo: 0.9,
        },
      },
      overrides.category,
    ),
    audit: merge(
      {
        status: 'ok' as const,
        qualityScore: 68,
        psiMobilePerformance: 62,
        lcpMobileMs: 3_200,
        visionOverall: 6,
        findingCodes: [],
      },
      overrides.audit,
    ),
    site: overrides.site === null ? null : site(overrides.site ?? {}),
    reviews: merge(
      { sampleSize: 40, painShare: {}, sentimentAvg: 0.4, ownerResponseRate: 0.3 },
      overrides.reviews,
    ),
    contacts: merge(
      { emails: [{ status: 'valid' as const, generic: true }], phones: 1, whatsapp: 0 },
      overrides.contacts,
    ) as BusinessFacts['contacts'],
    workspace: merge(
      { doNotContact: false, pipelineStatus: 'new' as const, lastContactedAt: null },
      overrides.workspace,
    ) as BusinessFacts['workspace'],
  };
}
