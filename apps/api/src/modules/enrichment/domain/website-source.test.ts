import { type SiteIntel, SiteIntelSchema, SourceRecordSchema } from '@bf/contracts';
import { describe, expect, it } from 'vitest';
import type { EnrichmentSubject } from './enrichment-step.ts';
import {
  isReadable,
  leftTheSite,
  parseOpeningHours,
  publishedPageKind,
  siteHost,
  siteName,
  websiteMedia,
  websiteSourceRecord,
} from './website-source.ts';

const subject: EnrichmentSubject = {
  businessId: '019a0000-0000-7000-8000-000000000001',
  displayName: 'Café Corail',
  websiteUrl: 'http://cafe.example.com/',
  countryCode: 'BL',
  locales: ['fr', 'en'],
  emails: [],
};

function intel(overrides: Partial<SiteIntel> = {}): SiteIntel {
  return SiteIntelSchema.parse({
    requestedUrl: 'http://cafe.example.com/',
    finalUrl: 'https://www.cafe.example.com/',
    httpStatus: 200,
    fetchedAt: '2026-10-15T12:00:00.000Z',
    reachability: 'redirected',
    socialOnly: false,
    tls: { valid: true, expiresAt: null, issuer: null },
    security: { https: true, hsts: false, mixedContent: false },
    pages: [],
    languages: { declared: [], detected: [], hreflang: [], hasLanguageSwitcher: false },
    jsonLd: [
      {
        type: 'CafeOrCoffeeShop',
        name: 'Café Corail (site)',
        telephone: '+590 590 27 00 00',
        email: null,
        address: '1 rue de la Plage, 97133, Gustavia',
        geo: { lat: 17.8962, lng: -62.8498 },
        openingHours: ['Monday,Tuesday 08:00-16:00', 'Sa-Su 9:00-12:00', 'Closed on holidays'],
        priceRange: null,
        sameAs: ['https://www.instagram.com/cafe.corail/'],
        servesCuisine: [],
      },
    ],
    contacts: {
      emails: [
        {
          email: 'hello@cafe.example.com',
          source: 'jsonld',
          pageUrl: 'https://www.cafe.example.com/contact',
          onContactPage: true,
        },
      ],
      phones: [
        {
          e164: '+590590270000',
          raw: '0590 27 00 00',
          pageUrl: 'https://www.cafe.example.com/',
          isWhatsApp: false,
        },
      ],
      whatsappLinks: [],
      contactForms: [],
    },
    socials: [{ network: 'facebook', url: 'https://www.facebook.com/cafecorail', handle: 'cafecorail' }],
    booking: { providers: [] },
    ordering: { providers: [] },
    chat: { providers: [] },
    analytics: { ga4: false, gtm: false, metaPixel: false, tiktokPixel: false, others: [] },
    tech: [],
    freshness: {
      copyrightYear: null,
      httpLastModified: null,
      sitemapLastmod: null,
      latestDatedContent: null,
    },
    mobile: { hasViewportMeta: true, fontSizeIssues: null },
    performanceHints: { pageWeightKb: null, requestCount: null, domContentLoadedMs: null },
    links: { internalCount: 0, brokenCount: 0 },
    noSolicitation: { checked: true, detected: false, phrases: [], pageUrl: null, snippet: null },
    logoCandidates: [
      { url: 'https://www.cafe.example.com/logo.png', source: 'img-logo', width: 120, height: 40 },
      { url: 'https://www.cafe.example.com/og.jpg', source: 'og:image', width: null, height: null },
      { url: 'data:image/png;base64,AAAA', source: 'link-icon', width: null, height: null },
    ],
    imageCandidates: [
      { url: 'https://www.cafe.example.com/terrace.jpg', alt: 'La terrasse', width: 1200, height: 800 },
    ],
    screenshots: { desktopKey: null, mobileKey: null, fullPageKey: null },
    warnings: [],
    durationMs: 900,
    ...overrides,
  });
}

describe('websiteSourceRecord', () => {
  it('maps what the site says to a valid website source record with contact pages', () => {
    const record = websiteSourceRecord(intel(), subject, '2026-10-15T12:00:00.000Z');
    expect(record).toMatchObject({
      provider: 'website',
      providerRef: `cafe.example.com/${subject.businessId}`,
      name: 'Café Corail (site)',
      website: 'https://www.cafe.example.com/',
      phones: ['+590590270000'],
      emails: ['hello@cafe.example.com'],
      socials: ['https://www.facebook.com/cafecorail', 'https://www.instagram.com/cafe.corail/'],
      location: { lat: 17.8962, lng: -62.8498 },
      address: { formatted: '1 rue de la Plage, 97133, Gustavia', countryCode: 'BL' },
      contactPages: [
        { value: '+590590270000', pageUrl: 'https://www.cafe.example.com/' },
        {
          value: 'hello@cafe.example.com',
          pageUrl: 'https://www.cafe.example.com/contact',
          pageKind: 'contact',
          foundAs: 'jsonld',
        },
      ],
    });
    expect(() => SourceRecordSchema.parse(record)).not.toThrow();
  });

  it("falls back to the business's name and says nothing for unreadable sites", () => {
    const anonymous = websiteSourceRecord(intel({ jsonLd: [] }), subject, '2026-10-15T12:00:00.000Z');
    expect(anonymous?.name).toBe('Café Corail');
    expect(anonymous).not.toHaveProperty('hours');
    for (const reachability of ['parked', 'blocked', 'dns_error', 'not_found'] as const) {
      expect(websiteSourceRecord(intel({ reachability }), subject, '2026-10-15T12:00:00.000Z')).toBeNull();
    }
    expect(websiteSourceRecord(intel({ socialOnly: true }), subject, '2026-10-15T12:00:00.000Z')).toBeNull();
    expect(isReadable(intel())).toBe(true);
  });
});

describe('parseOpeningHours', () => {
  it('reads both flattened forms and skips the rest', () => {
    expect(
      parseOpeningHours(['Monday,Tuesday 08:00-16:00', 'Sa-Su 9:00-12:00', 'Closed on holidays']),
    ).toEqual([
      { weekday: 0, opensAt: '08:00', closesAt: '16:00' },
      { weekday: 1, opensAt: '08:00', closesAt: '16:00' },
      { weekday: 5, opensAt: '09:00', closesAt: '12:00' },
      { weekday: 6, opensAt: '09:00', closesAt: '12:00' },
    ]);
    // A range across the week's end, and impossible times.
    expect(parseOpeningHours(['Su-Mo 10:00-14:00'])?.map((h) => h.weekday)).toEqual([0, 6]);
    expect(parseOpeningHours(['Mo 25:00-26:00', 'Xx 10:00-12:00'])).toBeUndefined();
  });
});

describe('websiteMedia', () => {
  it('keeps http(s) logo, og:image and photo candidates', () => {
    expect(websiteMedia(intel()).map((m) => [m.kind, m.url, m.altText])).toEqual([
      ['logo', 'https://www.cafe.example.com/logo.png', null],
      ['og_image', 'https://www.cafe.example.com/og.jpg', null],
      ['photo', 'https://www.cafe.example.com/terrace.jpg', 'La terrasse'],
    ]);
    expect(websiteMedia(intel({ reachability: 'parked' }))).toEqual([]);
  });

  it('reads hosts', () => {
    expect(siteHost('https://WWW.Example.com/x')).toBe('example.com');
    expect(siteHost('not a url')).toBeNull();
  });
});

describe('what the site says about itself', () => {
  const home = (title: string) => [
    {
      url: 'https://www.cafe.example.com/',
      kind: 'home' as const,
      title,
      metaDescription: null,
      lang: 'fr',
      h1: null,
      wordCount: 100,
      markdownKey: null,
    },
  ];

  it('names the business from its business-type JSON-LD, else a title that names the same business', () => {
    const both = intel({
      jsonLd: [
        { ...intel().jsonLd[0], type: 'Organization', name: 'Groupe Corail SAS' },
        { ...intel().jsonLd[0], type: 'CafeOrCoffeeShop', name: 'Café Corail Gustavia' },
      ] as SiteIntel['jsonLd'],
    });
    expect(siteName(both, subject)).toBe('Café Corail Gustavia');
    expect(siteName(intel({ jsonLd: [], pages: home('Café Corail | Brunch à Gustavia') }), subject)).toBe(
      'Café Corail',
    );
    // A title about something else (or a generic one) is not a name for this business.
    expect(siteName(intel({ jsonLd: [], pages: home('Accueil') }), subject)).toBeNull();
    expect(websiteSourceRecord(intel({ jsonLd: [], pages: home('Accueil') }), subject, 'x')?.name).toBe(
      'Café Corail',
    );
  });

  it('says nothing when the site redirected to another domain', () => {
    const sold = intel({ finalUrl: 'https://domains-for-sale.example.net/' });
    expect(leftTheSite(sold)).toBe(true);
    expect(websiteSourceRecord(sold, subject, '2026-10-15T12:00:00.000Z')).toBeNull();
    expect(websiteMedia(sold)).toEqual([]);
    // Same domain, other host or scheme: still the business's site.
    expect(leftTheSite(intel({ finalUrl: 'https://shop.cafe.example.com/' }))).toBe(false);
  });
});

describe('publishedPageKind', () => {
  const page = (url: string, kind: SiteIntel['pages'][number]['kind']) => ({
    url,
    kind,
    title: null,
    metaDescription: null,
    lang: null,
    h1: null,
    wordCount: 10,
    markdownKey: null,
  });
  const pages = [
    page('https://s.example.com/', 'home'),
    page('https://s.example.com/mentions-legales', 'legal'),
    page('https://s.example.com/menu', 'menu'),
    page('https://s.example.com/nous-contacter', 'contact'),
  ];

  it.each([
    ['https://s.example.com/', false, 'home'],
    ['https://s.example.com/mentions-legales', false, 'legal'],
    ['https://s.example.com/nous-contacter', false, 'contact'],
    ['https://s.example.com/menu', false, 'other'],
    ['https://s.example.com/not-crawled', false, 'other'],
    ['https://s.example.com/', true, 'contact'],
  ] as const)('%s (on contact page: %s) → %s', (pageUrl, onContactPage, kind) => {
    expect(publishedPageKind({ pages }, { pageUrl, onContactPage })).toBe(kind);
  });
});
