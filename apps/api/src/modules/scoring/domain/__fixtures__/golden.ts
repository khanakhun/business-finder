import type { BusinessFacts } from '../facts.ts';
import { facts, site } from './facts.ts';

// Twelve fictional businesses for the golden test (expected tier per built-in profile in golden.test.ts and the PR).

const restaurant = {
  attributes: { hospitality: true, tourismFacing: true },
  offerRelevance: {
    new_website: 0.8,
    website_redesign: 0.8,
    ai_receptionist: 0.6,
    booking_system: 0.7,
    local_seo: 0.9,
  },
};
const salon = {
  attributes: { appointmentBased: true },
  offerRelevance: {
    new_website: 0.8,
    website_redesign: 0.7,
    ai_receptionist: 0.9,
    booking_system: 1,
    local_seo: 0.7,
  },
};
const villa = {
  attributes: { hospitality: true, tourismFacing: true, appointmentBased: true },
  offerRelevance: {
    new_website: 0.9,
    website_redesign: 0.9,
    ai_receptionist: 0.7,
    booking_system: 0.9,
    local_seo: 0.8,
  },
};
const shop = {
  attributes: { retail: true },
  offerRelevance: {
    new_website: 0.6,
    website_redesign: 0.6,
    ai_receptionist: 0.3,
    booking_system: 0.1,
    local_seo: 0.7,
  },
};
const noSite = { websiteUrl: null };
const weakAudit = {
  status: 'weak' as const,
  qualityScore: 34,
  psiMobilePerformance: 22,
  lcpMobileMs: 7_400,
  visionOverall: 3,
  findingCodes: ['missing_english' as const],
};
const strongAudit = {
  status: 'strong' as const,
  qualityScore: 91,
  psiMobilePerformance: 94,
  lcpMobileMs: 1_600,
  visionOverall: 9,
  findingCodes: [],
};

export const GOLDEN: Record<string, BusinessFacts> = {
  'Beach bistro, no website, busy': facts({
    business: { ...noSite, ratingCount: 640, ratingAvg: 4.5 },
    category: restaurant,
    audit: null,
    site: null,
    reviews: {
      sampleSize: 50,
      painShare: { hard_to_find_info: 0.2 },
      sentimentAvg: 0.5,
      ownerResponseRate: 0.1,
    },
  }),
  'Salon, Facebook page only, phone pains': facts({
    business: { websiteUrl: 'https://facebook.test/salon', ratingCount: 85 },
    category: salon,
    audit: {
      status: 'social_only',
      qualityScore: null,
      psiMobilePerformance: null,
      lcpMobileMs: null,
      visionOverall: null,
      findingCodes: ['social_only'],
    },
    site: site({ socialOnly: true }),
    reviews: {
      sampleSize: 30,
      painShare: { unreachable_by_phone: 0.3, booking_friction: 0.25 },
      sentimentAvg: 0.1,
      ownerResponseRate: 0.05,
    },
  }),
  'Villa rental, dated slow site': facts({
    business: { ratingCount: 210, ratingAvg: 4.7, priceLevel: 4 },
    category: villa,
    audit: weakAudit,
    site: site({
      freshness: {
        copyrightYear: 2019,
        httpLastModified: null,
        sitemapLastmod: null,
        latestDatedContent: null,
      },
      contacts: { emails: [], phones: [], whatsappLinks: [], contactForms: [] },
    }),
    reviews: {
      sampleSize: 40,
      painShare: { website_broken_or_outdated: 0.15, booking_friction: 0.2 },
      sentimentAvg: 0.6,
      ownerResponseRate: 0.2,
    },
  }),
  'Hotel, strong site, books online': facts({
    business: { ratingCount: 900, ratingAvg: 4.6, priceLevel: 4 },
    category: villa,
    audit: strongAudit,
    site: site({
      booking: { providers: [{ name: 'Booky', evidence: 'booky.test' }] },
      contacts: {
        emails: [],
        phones: [],
        whatsappLinks: [],
        contactForms: [{ pageUrl: 'https://example.test/c', action: null }],
      },
      analytics: { ga4: true, gtm: true, metaPixel: true, tiktokPixel: false, others: [] },
    }),
    reviews: {
      sampleSize: 60,
      painShare: { positive_strong_reputation: 0.5 },
      sentimentAvg: 0.8,
      ownerResponseRate: 0.9,
    },
  }),
  'Dentist, ok site, no booking': facts({
    business: { ratingCount: 60, ratingAvg: 4.1 },
    category: salon,
    audit: {
      ...strongAudit,
      status: 'ok',
      qualityScore: 70,
      visionOverall: 6,
      psiMobilePerformance: 65,
      lcpMobileMs: 3_000,
    },
    reviews: {
      sampleSize: 20,
      painShare: { booking_friction: 0.3, long_wait_times: 0.2, unreachable_by_phone: 0.15 },
      sentimentAvg: 0.2,
      ownerResponseRate: 0.1,
    },
  }),
  'Gift shop, parked domain': facts({
    business: { ratingCount: 15, ratingAvg: 4.0 },
    category: shop,
    audit: {
      status: 'parked',
      qualityScore: null,
      psiMobilePerformance: null,
      lcpMobileMs: null,
      visionOverall: null,
      findingCodes: ['parked_domain'],
    },
    site: site({ reachability: 'parked' }),
    reviews: null,
  }),
  'Permanently closed café': facts({
    business: { ...noSite, operatingStatus: 'closed_permanently' },
    category: restaurant,
    audit: null,
    site: null,
  }),
  'Do-not-contact bakery': facts({
    business: noSite,
    category: restaurant,
    audit: null,
    site: null,
    workspace: { doNotContact: true },
  }),
  'Garage, unreachable': facts({
    business: { ...noSite, ratingCount: 30 },
    category: shop,
    audit: null,
    site: null,
    reviews: null,
    contacts: { emails: [], phones: 0, whatsapp: 0 },
  }),
  'Spa, broken site, many complaints': facts({
    business: { ratingCount: 140, ratingAvg: 3.6 },
    category: salon,
    audit: {
      status: 'broken',
      qualityScore: null,
      psiMobilePerformance: null,
      lcpMobileMs: null,
      visionOverall: null,
      findingCodes: ['site_broken'],
    },
    site: site({ reachability: 'server_error' }),
    reviews: {
      sampleSize: 35,
      painShare: {
        website_broken_or_outdated: 0.3,
        unreachable_by_phone: 0.25,
        slow_or_no_reply: 0.2,
        booking_friction: 0.2,
      },
      sentimentAvg: -0.3,
      ownerResponseRate: 0,
    },
  }),
  'Chain boutique, shared website': facts({
    business: { ratingCount: 400, sharedWebsiteCount: 12 },
    category: shop,
    audit: { ...strongAudit, status: 'ok', qualityScore: 75 },
    reviews: { sampleSize: 30, painShare: {}, sentimentAvg: 0.4, ownerResponseRate: 0.6 },
  }),
  'Won customer, no website': facts({
    business: noSite,
    category: restaurant,
    audit: null,
    site: null,
    workspace: { pipelineStatus: 'won' },
  }),
};
