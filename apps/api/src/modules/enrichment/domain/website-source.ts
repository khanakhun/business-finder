import type { PublishedPageKind, SiteIntel, SourceRecordInput } from '@bf/contracts';
import { getDomain } from 'tldts';
import type { EnrichmentSubject } from './enrichment-step.ts';

// The website as a source (BF-027): what a business's own site says, as a `website` SourceRecord for ingestion
// (BF-016), so its facts merge into the golden record with provenance and never override manual values.

/** Sites that answered: anything else (down, parked, blocked, a social profile) says nothing about the business. */
export const isReadable = (intel: Pick<SiteIntel, 'reachability' | 'socialOnly'>) =>
  (intel.reachability === 'ok' || intel.reachability === 'redirected') && !intel.socialOnly;

export function siteHost(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '') || null;
  } catch {
    return null;
  }
}

const DAYS: Record<string, number> = {
  mo: 0,
  monday: 0,
  tu: 1,
  tuesday: 1,
  we: 2,
  wednesday: 2,
  th: 3,
  thursday: 3,
  fr: 4,
  friday: 4,
  sa: 5,
  saturday: 5,
  su: 6,
  sunday: 6,
};
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * schema.org opening hours as BF-026 flattens them — `Monday,Tuesday 08:00-16:00` (from
 * openingHoursSpecification) or `Mo-Fr 09:00-18:00` (openingHours) — into weekday rows. Anything else is skipped.
 */
export function parseOpeningHours(lines: readonly string[]): SourceRecordInput['hours'] {
  const rows = new Map<string, { weekday: number; opensAt: string; closesAt: string }>();
  for (const line of lines) {
    const match = /^\s*([A-Za-z,\s-]+?)\s+(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})\s*$/.exec(line);
    if (!match) continue;
    const [, dayPart = '', open = '', close = ''] = match;
    const opensAt = open.padStart(5, '0');
    const closesAt = close.padStart(5, '0');
    if (!TIME.test(opensAt) || !TIME.test(closesAt)) continue;
    for (const token of dayPart.split(',')) {
      const [from, to] = token.trim().toLowerCase().split('-');
      const start = from === undefined ? undefined : DAYS[from];
      const end = to === undefined ? start : DAYS[to];
      if (start === undefined || end === undefined) continue;
      for (let day = start; ; day = (day + 1) % 7) {
        rows.set(`${day}:${opensAt}`, { weekday: day, opensAt, closesAt });
        if (day === end) break;
      }
    }
  }
  const hours = [...rows.values()].sort(
    (a, b) => a.weekday - b.weekday || a.opensAt.localeCompare(b.opensAt),
  );
  return hours.length > 0 ? hours.slice(0, 50) : undefined;
}

const fold = (text: string) =>
  text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
const tokens = (text: string) =>
  new Set(
    fold(text)
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 3),
  );

/**
 * The name the site gives itself: its structured name (JSON-LD, a business-type node first), else the first part of
 * the home page title when it names the same business (`Salon Ondine | Coiffure à Gustavia`). Null when the site does
 * not say: the record then repeats the current name (ingestion needs one; survivorship sees the same value).
 */
export function siteName(intel: SiteIntel, subject: Pick<EnrichmentSubject, 'displayName'>): string | null {
  const named = intel.jsonLd.filter((item) => item.name);
  const business = named.find((item) => !/^(organization|website|webpage)$/i.test(item.type)) ?? named[0];
  if (business?.name) return business.name;
  const title = intel.pages.find((page) => page.kind === 'home')?.title;
  const head = title?.split(/\s[|–—·:-]\s|\s[|–—·]|[|–—·]\s/)[0]?.trim();
  if (!head || head.length > 120) return null;
  const known = tokens(subject.displayName);
  return [...tokens(head)].some((token) => known.has(token)) ? head : null;
}

/** Whether the crawl ended on another registrable domain than the one asked for (an expired or sold domain). */
export function leftTheSite(intel: Pick<SiteIntel, 'requestedUrl' | 'finalUrl'>): boolean {
  if (!intel.finalUrl) return false;
  const asked = getDomain(intel.requestedUrl);
  const ended = getDomain(intel.finalUrl);
  return asked !== null && ended !== null && asked !== ended;
}

/**
 * The SourceRecord for a crawled site, or null when the site said nothing usable about this business — unreadable,
 * or redirected to another domain (its facts would not be this business's). `providerRef` is per business: two
 * businesses sharing a site (a chain) keep their own website source.
 */
export function websiteSourceRecord(
  intel: SiteIntel,
  subject: EnrichmentSubject,
  fetchedAt: string,
): SourceRecordInput | null {
  if (!isReadable(intel) || leftTheSite(intel)) return null;
  const site = intel.finalUrl ?? intel.requestedUrl;
  const host = siteHost(site);
  if (!host) return null;
  const named = intel.jsonLd.filter((item) => item.name);
  const business =
    named.find((item) => !/^(organization|website|webpage)$/i.test(item.type)) ?? intel.jsonLd[0];
  const phones = intel.contacts.phones.slice(0, 10);
  const emails = intel.contacts.emails.slice(0, 20);
  const socials = [
    ...new Set(
      [...intel.socials.map((s) => s.url), ...(business?.sameAs ?? [])].filter((u) => u.length <= 500),
    ),
  ].slice(0, 20);
  const hours = parseOpeningHours(business?.openingHours ?? []);
  return {
    provider: 'website',
    providerRef: `${host}/${subject.businessId}`.slice(0, 300),
    fetchedAt,
    name: (siteName(intel, subject) ?? subject.displayName).slice(0, 300),
    website: site,
    phones: phones.map((p) => p.e164),
    emails: emails.map((e) => e.email),
    socials,
    contactPages: [
      ...phones.map((p) => ({ value: p.e164, pageUrl: p.pageUrl })),
      ...emails.map((e) => ({
        value: e.email,
        pageUrl: e.pageUrl,
        pageKind: publishedPageKind(intel, e),
        foundAs: e.source,
      })),
    ],
    ...(business?.geo ? { location: business.geo } : {}),
    ...(business?.address
      ? {
          address: {
            formatted: business.address.slice(0, 400),
            ...(subject.countryCode ? { countryCode: subject.countryCode } : {}),
          },
        }
      : {}),
    ...(hours ? { hours } : {}),
    attributes: {
      reachability: intel.reachability,
      noSolicitation: intel.noSolicitation.detected,
    },
  };
}

/**
 * The kind of page an e-mail was published on (compliance: "published for that purpose", BF-049). Crawled page
 * kinds outside contact/home/legal count as `other`.
 */
export function publishedPageKind(
  intel: Pick<SiteIntel, 'pages'>,
  email: Pick<SiteIntel['contacts']['emails'][number], 'pageUrl' | 'onContactPage'>,
): PublishedPageKind {
  if (email.onContactPage) return 'contact';
  const kind = intel.pages.find((page) => page.url === email.pageUrl)?.kind;
  return kind === 'contact' || kind === 'home' || kind === 'legal' ? kind : 'other';
}

/** Logo and content-image candidates as business media (external URLs; licensed as the owner's site). */
export function websiteMedia(intel: SiteIntel): {
  kind: 'logo' | 'photo' | 'og_image';
  url: string;
  width: number | null;
  height: number | null;
  altText: string | null;
}[] {
  if (!isReadable(intel) || leftTheSite(intel)) return [];
  const logos = intel.logoCandidates.slice(0, 5).map((logo) => ({
    kind: logo.source === 'og:image' ? ('og_image' as const) : ('logo' as const),
    url: logo.url,
    width: logo.width,
    height: logo.height,
    altText: null,
  }));
  const photos = intel.imageCandidates.slice(0, 20).map((image) => ({
    kind: 'photo' as const,
    url: image.url,
    width: image.width,
    height: image.height,
    altText: image.alt,
  }));
  return [...logos, ...photos].filter((m) => /^https?:\/\//.test(m.url));
}
