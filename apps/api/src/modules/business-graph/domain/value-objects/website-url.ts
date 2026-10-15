import { parse as parseDomain } from 'tldts';
import { InvalidValueError } from '../errors.ts';

/** Query parameters that only track campaigns; dropped from canonical URLs. */
const TRACKING =
  /^(utm_[a-z]+|fbclid|gclid|gbraid|wbraid|msclkid|dclid|mc_cid|mc_eid|igshid|yclid|_ga|_gl|ref_src)$/i;

/**
 * Hosts shared by many unrelated businesses: their registrable domain must never be used to match two businesses
 * (two Wix sites are not the same company).
 */
const SHARED_DOMAINS = new Set([
  'wixsite.com',
  'business.site',
  'linktr.ee',
  'facebook.com',
  'instagram.com',
  'google.com',
  'goo.gl',
  'weebly.com',
  'wordpress.com',
  'blogspot.com',
  'godaddysites.com',
  'carrd.co',
  'jimdosite.com',
  'webnode.page',
  'square.site',
  'squarespace.com',
  'tripadvisor.com',
  'tripadvisor.fr',
  'yelp.com',
  'booking.com',
  'airbnb.com',
  'pagesjaunes.fr',
  'linkedin.com',
  'x.com',
  'twitter.com',
  'tiktok.com',
  'youtube.com',
]);

/** A business website, canonicalized for display, matching and crawling. */
export class WebsiteUrl {
  private constructor(
    /** Canonical form: lowercase host, no fragment/tracking params, no trailing slash (except root). */
    readonly canonical: string,
    readonly host: string,
    /** e.g. `example.co.uk`. */
    readonly registrableDomain: string,
    /** Hosted on a platform shared by many businesses (see `matchKey`). */
    readonly isSharedHost: boolean,
  ) {}

  static parse(raw: string): WebsiteUrl {
    const text = raw.trim();
    if (!text || /\s/.test(text) || text.length > 2000)
      throw new InvalidValueError('website', 'Not a website address.');
    let url: URL;
    try {
      url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
    } catch {
      throw new InvalidValueError('website', 'Not a website address.');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new InvalidValueError('website', 'Websites must use http or https.');
    }
    if (url.username || url.password)
      throw new InvalidValueError('website', 'Website addresses cannot contain credentials.');
    const info = parseDomain(url.hostname);
    // IP literals and custom ports are never a business website, and later crawls must not reach internal hosts
    // (fetches re-check after DNS resolution through SafeHttpClient).
    if (info.isIp || url.hostname.startsWith('[')) {
      throw new InvalidValueError('website', 'Websites need a domain name, not an IP address.');
    }
    if (url.port) throw new InvalidValueError('website', 'Websites use the default port.');
    if (!info.domain || !info.isIcann) {
      throw new InvalidValueError('website', 'Unknown domain.');
    }
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) if (TRACKING.test(key)) url.searchParams.delete(key);
    const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : '/';
    const query = url.searchParams.toString();
    const host = url.host.toLowerCase();
    const canonical = `${url.protocol}//${host}${path}${query ? `?${query}` : ''}`;
    return new WebsiteUrl(canonical, host, info.domain, SHARED_DOMAINS.has(info.domain));
  }

  /** What identifies the site for matching: the registrable domain, or host + first path segment on shared hosts. */
  get matchKey(): string {
    if (!this.isSharedHost) return this.registrableDomain;
    const firstSegment = new URL(this.canonical).pathname.split('/')[1] ?? '';
    return `${this.host.replace(/^www\./, '')}/${firstSegment.toLowerCase()}`;
  }

  toString(): string {
    return this.canonical;
  }
}
