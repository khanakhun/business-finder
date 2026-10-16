import { z } from 'zod';
import { EMAIL_FOUND_AS } from './email-verification.ts';

// Website intelligence on services/intel (BF-026): a polite, SSRF-guarded crawl of a business's own site (home page
// plus key pages) returning extracted facts and signals. Large artifacts (screenshots, per-page markdown) go to object
// storage under the caller's prefix; the response carries their keys. Everything here comes from untrusted pages:
// values are data, never instructions.

const text = (max: number) => z.string().max(max);
const url = text(2_000);

/** Phrases that mean "do not solicit us" (compliance, outreach-compliance.md §3). Matched case-insensitively. */
export const NO_SOLICITATION_PHRASES = {
  fr: [
    'pas de démarchage',
    'démarchage interdit',
    'pas de prospection',
    'merci de ne pas démarcher',
    'refusons tout démarchage',
    'stop démarchage',
  ],
  nl: [
    'acquisitie wordt niet op prijs gesteld',
    'acquisitie naar aanleiding van deze vacature wordt niet op prijs gesteld',
    'geen acquisitie',
  ],
  en: ['no solicitation', 'no solicitors', 'we do not accept unsolicited', 'no unsolicited'],
} as const satisfies Record<string, readonly string[]>;

export const SITE_REACHABILITY = [
  'ok',
  'redirected',
  'not_found',
  'server_error',
  'timeout',
  'dns_error',
  'tls_error',
  'parked',
  'blocked',
] as const;
export const SitePageKindSchema = z.enum([
  'home',
  'contact',
  'about',
  'services',
  'menu',
  'booking',
  'legal',
  'other',
]);
export const EMAIL_SOURCES = EMAIL_FOUND_AS;

export const SiteIntelRequestSchema = z
  .object({
    url: url.describe('The website to analyse (http or https).'),
    artifactPrefix: z
      .string()
      .max(200)
      // Segments of [a-z0-9_-] separated by single slashes: no `..`, no leading or trailing slash (also in Python).
      .regex(/^[a-z0-9][a-z0-9_-]*(\/[a-z0-9][a-z0-9_-]*)*$/)
      .describe('Object-storage key prefix chosen by the caller (in the artifacts bucket).'),
    maxPages: z.number().int().min(1).max(12).default(6),
    localesHint: z
      .array(z.string().regex(/^[a-z]{2}$/))
      .max(5)
      .default([]),
    countryHint: z
      .string()
      .regex(/^[A-Z]{2}$/)
      .optional()
      .describe('ISO 3166-1 alpha-2 country of the business (reads national phone formats: BL, FR…).'),
    screenshots: z
      .object({ desktop: z.boolean(), mobile: z.boolean(), fullPage: z.boolean() })
      .default({ desktop: true, mobile: true, fullPage: false }),
    timeoutSeconds: z.number().int().min(10).max(120).default(60),
    userAgent: text(200).optional().describe('Overrides the configured crawler user agent.'),
  })
  .meta({ id: 'SiteIntelRequest' });
export type SiteIntelRequest = z.input<typeof SiteIntelRequestSchema>;

/** The largest image services/intel downloads for the API (BF-038 owner-site images). */
export const IMAGE_FETCH_MAX_BYTES = 15 * 1024 * 1024;

/**
 * `POST /v1/image-fetch` on services/intel: downloads one image of a crawled site through the SSRF guard and returns
 * its bytes (`application/octet-stream`); the API sniffs, checks and stores them. Errors are problem+json.
 */
export const ImageFetchRequestSchema = z
  .object({
    url: url.describe('The image URL (http or https), as found on the business website.'),
    maxBytes: z.number().int().min(1).max(IMAGE_FETCH_MAX_BYTES).default(IMAGE_FETCH_MAX_BYTES),
    timeoutSeconds: z.number().int().min(5).max(60).default(20),
  })
  .meta({ id: 'ImageFetchRequest' });
export type ImageFetchRequest = z.input<typeof ImageFetchRequestSchema>;

const SitePageSchema = z.object({
  url,
  kind: SitePageKindSchema,
  title: text(500).nullable(),
  metaDescription: text(1_000).nullable(),
  lang: text(35).nullable(),
  h1: text(500).nullable(),
  wordCount: z.number().int().nonnegative(),
  markdownKey: text(500).nullable(),
});

const JsonLdBusinessSchema = z.object({
  type: text(100).describe('schema.org @type (first one when several).'),
  name: text(300).nullable(),
  telephone: text(60).nullable(),
  email: text(254).nullable(),
  address: text(500).nullable().describe('Postal address flattened to one line.'),
  geo: z.object({ lat: z.number(), lng: z.number() }).nullable(),
  openingHours: z
    .array(text(200))
    .max(30)
    .describe('openingHoursSpecification / openingHours, one line each.'),
  priceRange: text(50).nullable(),
  sameAs: z.array(url).max(30),
  servesCuisine: z.array(text(100)).max(20),
});

const SiteEmailSchema = z.object({
  email: text(254),
  source: z.enum(EMAIL_SOURCES),
  pageUrl: url,
  onContactPage: z.boolean(),
});

const SitePhoneSchema = z.object({
  e164: text(20),
  raw: text(60),
  pageUrl: url,
  isWhatsApp: z.boolean(),
});

const ProviderSchema = z.object({
  name: text(100),
  evidence: text(300).describe('What matched (a host, a script, a link) — never page text.'),
});

const TechSchema = z.object({
  name: text(200),
  version: text(50).nullable(),
  categories: z.array(text(100)).max(10),
  confidence: z.number().int().min(0).max(100),
});

export const SiteIntelSchema = z
  .object({
    requestedUrl: url,
    finalUrl: url.nullable(),
    httpStatus: z.number().int().nullable(),
    fetchedAt: z.iso.datetime(),
    reachability: z.enum(SITE_REACHABILITY),
    socialOnly: z.boolean().describe('The "website" is a social profile or link page; it was not crawled.'),
    tls: z.object({
      valid: z.boolean().nullable(),
      expiresAt: z.iso.datetime().nullable(),
      issuer: text(300).nullable(),
    }),
    security: z.object({ https: z.boolean(), hsts: z.boolean(), mixedContent: z.boolean() }),
    pages: z.array(SitePageSchema).max(12),
    languages: z.object({
      declared: z.array(text(35)).max(10),
      detected: z.array(text(5)).max(5),
      hreflang: z.array(z.object({ lang: text(35), url })).max(30),
      hasLanguageSwitcher: z.boolean(),
    }),
    jsonLd: z.array(JsonLdBusinessSchema).max(10),
    contacts: z.object({
      emails: z.array(SiteEmailSchema).max(50),
      phones: z.array(SitePhoneSchema).max(30),
      whatsappLinks: z.array(url).max(20),
      contactForms: z.array(z.object({ pageUrl: url, action: url.nullable() })).max(20),
    }),
    socials: z.array(z.object({ network: text(40), url, handle: text(200).nullable() })).max(30),
    booking: z.object({ providers: z.array(ProviderSchema).max(20) }),
    ordering: z.object({ providers: z.array(ProviderSchema).max(20) }),
    chat: z.object({ providers: z.array(ProviderSchema).max(20) }),
    analytics: z.object({
      ga4: z.boolean(),
      gtm: z.boolean(),
      metaPixel: z.boolean(),
      tiktokPixel: z.boolean(),
      others: z.array(text(100)).max(20),
    }),
    tech: z.array(TechSchema).max(100),
    freshness: z.object({
      copyrightYear: z.number().int().nullable(),
      httpLastModified: z.iso.datetime().nullable(),
      sitemapLastmod: z.iso.datetime().nullable(),
      latestDatedContent: z.iso.date().nullable(),
    }),
    mobile: z.object({ hasViewportMeta: z.boolean(), fontSizeIssues: z.boolean().nullable() }),
    performanceHints: z.object({
      pageWeightKb: z.number().int().nonnegative().nullable(),
      requestCount: z.number().int().nonnegative().nullable(),
      domContentLoadedMs: z.number().int().nonnegative().nullable(),
    }),
    links: z.object({
      internalCount: z.number().int().nonnegative(),
      brokenCount: z.number().int().nonnegative().describe('Among a bounded sample of internal links.'),
    }),
    noSolicitation: z.object({
      checked: z
        .boolean()
        .describe(
          'A live page of the business (2xx, reachability ok or redirected) was read. `false` — blocked, bot ' +
            'wall, error page, parked, unreachable, social-only — means nothing is known: outreach must treat ' +
            'the business as not checked (manual review), never as "no statement".',
        ),
      detected: z.boolean(),
      phrases: z.array(text(200)).max(20),
      pageUrl: url.nullable(),
      snippet: text(400).nullable().describe('At most 30 words around the first match.'),
    }),
    logoCandidates: z
      .array(
        z.object({
          url,
          source: z.enum(['link-icon', 'og:image', 'img-logo']),
          width: z.number().int().nullable(),
          height: z.number().int().nullable(),
        }),
      )
      .max(10),
    imageCandidates: z
      .array(
        z.object({
          url,
          alt: text(300).nullable(),
          width: z.number().int().nullable(),
          height: z.number().int().nullable(),
        }),
      )
      .max(20),
    screenshots: z.object({
      desktopKey: text(500).nullable(),
      mobileKey: text(500).nullable(),
      fullPageKey: text(500).nullable(),
    }),
    warnings: z.array(text(300)).max(50),
    durationMs: z.number().int().nonnegative(),
  })
  .meta({ id: 'SiteIntel' });
export type SiteIntel = z.infer<typeof SiteIntelSchema>;
