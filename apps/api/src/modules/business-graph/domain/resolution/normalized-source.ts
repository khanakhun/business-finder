import {
  type OperatingStatus,
  type PostalAddress as PostalAddressShape,
  PROVIDER_CONFIDENCE,
  type SourceProvider,
  type SourceRecord,
} from '@bf/contracts';
import { normalizeContact } from '../business-contact.ts';
import { InvalidValueError } from '../errors.ts';
import { BusinessName } from '../value-objects/business-name.ts';
import { EmailAddress, type EmailSubtype } from '../value-objects/email-address.ts';
import { GeoPoint } from '../value-objects/geo-point.ts';
import { PhoneNumber, type PhoneType } from '../value-objects/phone-number.ts';
import { PostalAddress } from '../value-objects/postal-address.ts';
import { WebsiteUrl } from '../value-objects/website-url.ts';

// Stage 1 of ingestion (BF-016): a provider's raw record → canonical values. Pure. The result is JSON (stored in
// `business_sources.normalized`) so golden records can be recomputed from all sources at any time.

export interface CategoryClassificationSnapshot {
  /** Category slugs. */
  readonly primary: string | null;
  readonly secondary: readonly string[];
  readonly confidence: number;
}

export interface NormalizedSource {
  readonly provider: SourceProvider;
  readonly providerRef: string;
  /** When the provider observed these values (ISO-8601). */
  readonly observedAt: string;
  readonly confidence: number;
  readonly name: { readonly display: string; readonly normalized: string };
  readonly countryCode: string | null;
  readonly location: { readonly lat: number; readonly lng: number } | null;
  readonly address: { readonly components: Partial<PostalAddressShape>; readonly formatted: string } | null;
  /** `pageUrl`: where a crawled website shows the contact (BF-027); absent for other sources. */
  readonly phones: ReadonlyArray<{
    readonly e164: string;
    readonly type: PhoneType;
    readonly pageUrl?: string;
  }>;
  readonly website: {
    readonly canonical: string;
    readonly host: string;
    readonly registrableDomain: string;
    readonly shared: boolean;
    readonly matchKey: string;
  } | null;
  readonly emails: ReadonlyArray<{
    readonly value: string;
    readonly subtype: EmailSubtype;
    readonly pageUrl?: string;
  }>;
  readonly socials: ReadonlyArray<{
    readonly url: string;
    readonly network: string;
    readonly pageUrl?: string;
  }>;
  readonly hours: ReadonlyArray<{
    readonly weekday: number;
    readonly opensAt: string;
    readonly closesAt: string;
  }> | null;
  readonly rating: { readonly avg: number; readonly count: number } | null;
  readonly priceLevel: number | null;
  readonly operatingStatus: OperatingStatus | null;
  readonly providerCategories: ReadonlyArray<{ readonly key: string; readonly label?: string }>;
  readonly categories: CategoryClassificationSnapshot | null;
  /** Kinds of values dropped as invalid (`phone`, `website`…), for metrics — never the values themselves. */
  readonly dropped: readonly string[];
  /** The workspace that entered a `manual` record (attribution of the contacts it brings). */
  readonly submittedByOrgId?: string | null;
}

const attempt = <T>(dropped: string[], kind: string, parse: () => T): T | null => {
  try {
    return parse();
  } catch (error) {
    if (!(error instanceof InvalidValueError)) throw error;
    dropped.push(kind);
    return null;
  }
};

/**
 * Normalizes a validated source record. An unusable name fails the record (`InvalidValueError`); other invalid
 * values are dropped and counted in `dropped`.
 */
export function normalizeSource(
  record: SourceRecord,
  options: {
    readonly classification?: CategoryClassificationSnapshot | null;
    readonly defaultRegion?: string;
  } = {},
): NormalizedSource {
  const dropped: string[] = [];
  const name = BusinessName.parse(record.name);
  const countryCode =
    record.address?.countryCode?.toUpperCase() ?? options.defaultRegion?.toUpperCase() ?? null;
  const location = record.location
    ? attempt(dropped, 'location', () =>
        GeoPoint.of(record.location?.lat ?? 0, record.location?.lng ?? 0).toJSON(),
      )
    : null;
  const { formatted, countryCode: _ignored, ...parts } = record.address ?? {};
  const address =
    record.address && (Object.keys(parts).length > 0 || formatted)
      ? attempt(dropped, 'address', () => {
          const defined = Object.fromEntries(Object.entries(parts).filter(([, v]) => v !== undefined));
          const value = PostalAddress.of({ ...defined, ...(countryCode ? { countryCode } : {}) }, formatted);
          return { components: { ...value.components }, formatted: value.formatted };
        })
      : null;
  const pages = new Map((record.contactPages ?? []).map((c) => [c.value, c.pageUrl]));
  const onPage = (raw: string) => {
    const pageUrl = pages.get(raw);
    return pageUrl ? { pageUrl } : {};
  };
  const phones = uniqueBy(
    record.phones.flatMap((raw) => {
      const phone = attempt(dropped, 'phone', () => PhoneNumber.parse(raw, countryCode ?? undefined));
      return phone ? [{ e164: phone.e164, type: phone.type, ...onPage(raw) }] : [];
    }),
    (p) => p.e164,
  );
  const site = record.website
    ? attempt(dropped, 'website', () => WebsiteUrl.parse(record.website ?? ''))
    : null;
  const emails = uniqueBy(
    record.emails.flatMap((raw) => {
      const email = attempt(dropped, 'email', () => EmailAddress.parse(raw));
      return email ? [{ value: email.value, subtype: email.subtype, ...onPage(raw) }] : [];
    }),
    (e) => e.value,
  );
  const socials = uniqueBy(
    record.socials.flatMap((raw) => {
      const social = attempt(dropped, 'social', () => normalizeContact('social', raw, countryCode));
      return social ? [{ url: social.normalizedValue, network: social.subtype, ...onPage(raw) }] : [];
    }),
    (s) => s.url,
  );
  return {
    provider: record.provider,
    providerRef: record.providerRef,
    observedAt: new Date(record.fetchedAt).toISOString(),
    confidence: PROVIDER_CONFIDENCE[record.provider],
    name: { display: name.display, normalized: name.normalized },
    countryCode,
    location,
    address,
    phones,
    website: site
      ? {
          canonical: site.canonical,
          host: site.host,
          registrableDomain: site.registrableDomain,
          shared: site.isSharedHost,
          matchKey: site.matchKey,
        }
      : null,
    emails,
    socials,
    hours: record.hours && record.hours.length > 0 ? sortHours(record.hours) : null,
    rating:
      record.rating !== undefined
        ? { avg: Math.round(record.rating * 10) / 10, count: record.reviewCount ?? 0 }
        : null,
    priceLevel: record.priceLevel ?? null,
    operatingStatus:
      record.operatingStatus && record.operatingStatus !== 'unknown' ? record.operatingStatus : null,
    providerCategories: record.providerCategories.map((c) => ({
      key: c.key,
      ...(c.label ? { label: c.label } : {}),
    })),
    categories: options.classification ?? null,
    dropped: [...new Set(dropped)].sort(),
  };
}

function uniqueBy<T>(items: readonly T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const k = key(item);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function sortHours<T extends { weekday: number; opensAt: string; closesAt: string }>(hours: readonly T[]) {
  return uniqueBy(
    [...hours]
      .map((h) => ({ weekday: h.weekday, opensAt: h.opensAt, closesAt: h.closesAt }))
      .sort((a, b) => a.weekday - b.weekday || a.opensAt.localeCompare(b.opensAt)),
    (h) => `${h.weekday}-${h.opensAt}`,
  );
}
