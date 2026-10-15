import {
  type Clock,
  ExternalServiceError,
  type SiteIntel,
  SiteIntelRequestSchema,
  SiteIntelSchema,
} from '@bf/contracts';
import { Injectable } from '@nestjs/common';
import { BrokenCircuitError, TaskCancelledError } from 'cockatiel';
import { IntelClient } from '../../platform/intel/intel-client.ts';
import type { SiteIntelPort } from '../application/ports.ts';

/** Seconds intel may spend on one site (its own deadline; the HTTP policy waits a little longer). */
const CRAWL_SECONDS = 90;

/** `POST /v1/site-intel` on services/intel (BF-026): signed, validated, with the `intel-site` policy. */
@Injectable()
export class IntelSiteIntel implements SiteIntelPort {
  constructor(private readonly intel: IntelClient) {}

  async analyse(request: Parameters<SiteIntelPort['analyse']>[0], signal: AbortSignal): Promise<SiteIntel> {
    const body = SiteIntelRequestSchema.parse({
      url: request.url,
      artifactPrefix: request.artifactPrefix,
      maxPages: 6,
      localesHint: [...request.localesHint],
      ...(request.countryHint ? { countryHint: request.countryHint } : {}),
      screenshots: { desktop: true, mobile: true, fullPage: false },
      timeoutSeconds: CRAWL_SECONDS,
    });
    try {
      return await this.intel.post('/v1/site-intel', body, SiteIntelSchema, { policy: 'intel-site', signal });
    } catch (error) {
      // Resilience outcomes as typed, transient errors the engine understands (it does not know cockatiel).
      if (error instanceof BrokenCircuitError) {
        throw new ExternalServiceError('intel', 'Website analysis is unavailable', {
          details: { reason: 'circuit_open', retryable: true },
        });
      }
      if (error instanceof TaskCancelledError && !signal.aborted) {
        throw new ExternalServiceError('intel', 'Website analysis timed out', {
          details: { reason: 'timeout', retryable: true },
        });
      }
      throw error;
    }
  }
}

/**
 * A site-intel answer without crawling (tests and E2E, `FAKE_SITE_INTEL`; refused in production): a readable
 * site with a contact page, an e-mail on it and a few detected tools, derived from the URL. Hosts starting with
 * `down.` are unreachable; `nosolicit.` sites carry a no-solicitation statement; `named.` sites declare a name in
 * JSON-LD ("Named On The Site").
 */
export class FakeSiteIntel implements SiteIntelPort {
  constructor(private readonly clock: Clock) {}

  async analyse(request: Parameters<SiteIntelPort['analyse']>[0]): Promise<SiteIntel> {
    const url = new URL(request.url);
    const host = url.hostname.replace(/^www\./, '');
    const home = `${url.origin}/`;
    const contact = `${url.origin}/contact`;
    const down = host.startsWith('down.');
    const noSolicitation = host.startsWith('nosolicit.');
    const named = host.startsWith('named.');
    return SiteIntelSchema.parse({
      requestedUrl: request.url,
      finalUrl: down ? null : home,
      httpStatus: down ? null : 200,
      fetchedAt: this.clock.now().toISOString(),
      reachability: down ? 'dns_error' : 'ok',
      socialOnly: false,
      tls: { valid: url.protocol === 'https:' ? true : null, expiresAt: null, issuer: null },
      security: { https: url.protocol === 'https:', hsts: false, mixedContent: false },
      pages: down
        ? []
        : [
            {
              url: home,
              kind: 'home',
              title: 'Home',
              metaDescription: null,
              lang: request.localesHint[0] ?? 'en',
              h1: 'Welcome',
              wordCount: 240,
              markdownKey: null,
            },
            {
              url: contact,
              kind: 'contact',
              title: 'Contact',
              metaDescription: null,
              lang: request.localesHint[0] ?? 'en',
              h1: 'Contact',
              wordCount: 80,
              markdownKey: null,
            },
          ],
      languages: {
        declared: down ? [] : [request.localesHint[0] ?? 'en'],
        detected: down ? [] : [request.localesHint[0] ?? 'en'],
        hreflang: [],
        hasLanguageSwitcher: false,
      },
      jsonLd: named
        ? [
            {
              type: 'LocalBusiness',
              name: 'Named On The Site',
              telephone: null,
              email: null,
              address: null,
              geo: null,
              openingHours: [],
              priceRange: null,
              sameAs: [],
              servesCuisine: [],
            },
          ]
        : [],
      contacts: {
        emails: down
          ? []
          : [{ email: `hello@${host}`, source: 'mailto', pageUrl: contact, onContactPage: true }],
        phones: [],
        whatsappLinks: [],
        contactForms: [],
      },
      socials: [],
      booking: { providers: down ? [] : [{ name: 'Planity', evidence: 'planity.com/widget.js' }] },
      ordering: { providers: [] },
      chat: { providers: [] },
      analytics: { ga4: !down, gtm: false, metaPixel: false, tiktokPixel: false, others: [] },
      tech: down ? [] : [{ name: 'WordPress', version: '6.4', categories: ['CMS'], confidence: 100 }],
      freshness: {
        copyrightYear: down ? null : 2021,
        httpLastModified: null,
        sitemapLastmod: null,
        latestDatedContent: null,
      },
      mobile: { hasViewportMeta: !down, fontSizeIssues: down ? null : false },
      performanceHints: {
        pageWeightKb: down ? null : 850,
        requestCount: down ? null : 42,
        domContentLoadedMs: null,
      },
      links: { internalCount: down ? 0 : 6, brokenCount: 0 },
      noSolicitation: noSolicitation
        ? {
            checked: true,
            detected: true,
            phrases: ['no solicitation'],
            pageUrl: contact,
            snippet: 'no solicitation please',
          }
        : { checked: !down, detected: false, phrases: [], pageUrl: null, snippet: null },
      logoCandidates: down
        ? []
        : [{ url: `${url.origin}/logo.png`, source: 'img-logo', width: 200, height: 80 }],
      imageCandidates: [],
      screenshots: { desktopKey: null, mobileKey: null, fullPageKey: null },
      warnings: [],
      durationMs: 1200,
    });
  }
}
