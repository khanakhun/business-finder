import { type ContactType, type GoldenFieldName, providerRank, type SourceProvider } from '@bf/contracts';
import type { FieldValue } from '../business.entity.ts';
import { BusinessName } from '../value-objects/business-name.ts';
import { GeoPoint } from '../value-objects/geo-point.ts';
import { PhoneNumber } from '../value-objects/phone-number.ts';
import { PostalAddress } from '../value-objects/postal-address.ts';
import type { ProvenanceInput } from '../value-objects/provenance.ts';
import { WebsiteUrl } from '../value-objects/website-url.ts';
import type { NormalizedSource } from './normalized-source.ts';

// Stage 6 (BF-016): the golden record as a pure function of the set of linked sources (rules documented in
// @bf/contracts `SURVIVORSHIP_PRIORITY`). Recomputing from all sources makes ingestion order-independent and
// lets a split simply recompute both records.

type Valued<T> = { readonly source: NormalizedSource; readonly value: T };

interface FieldValues {
  readonly displayName: NormalizedSource['name'];
  readonly operatingStatus: NormalizedSource['operatingStatus'];
  readonly websiteUrl: NormalizedSource['website'];
  readonly primaryPhone: NormalizedSource['phones'][number] | null;
  readonly address: NormalizedSource['address'];
  readonly location: NormalizedSource['location'];
  readonly priceLevel: NormalizedSource['priceLevel'];
  readonly rating: NormalizedSource['rating'];
  readonly hours: NormalizedSource['hours'];
}

const VALUE_OF: { readonly [F in GoldenFieldName]: (s: NormalizedSource) => FieldValues[F] } = {
  displayName: (s) => s.name,
  operatingStatus: (s) => s.operatingStatus,
  websiteUrl: (s) => s.website,
  primaryPhone: (s) => s.phones[0] ?? null,
  address: (s) => s.address,
  location: (s) => s.location,
  priceLevel: (s) => s.priceLevel,
  rating: (s) => s.rating,
  hours: (s) => s.hours,
};

/** Survivorship order: manual first, then the field's provider priority, confidence, recency, provider ref. */
export function compareForField(field: GoldenFieldName, a: NormalizedSource, b: NormalizedSource): number {
  const manual = Number(b.provider === 'manual') - Number(a.provider === 'manual');
  if (manual !== 0) return manual;
  return (
    providerRank(field, a.provider) - providerRank(field, b.provider) ||
    b.confidence - a.confidence ||
    b.observedAt.localeCompare(a.observedAt) ||
    a.provider.localeCompare(b.provider) ||
    a.providerRef.localeCompare(b.providerRef)
  );
}

/** The winning source for a field, or null when no source has a value. */
export function chooseField<F extends GoldenFieldName>(
  field: F,
  sources: readonly NormalizedSource[],
): Valued<NonNullable<FieldValues[F]>> | null {
  const [winner] = sources
    .filter((s) => VALUE_OF[field](s) !== null && VALUE_OF[field](s) !== undefined)
    .filter((s) => field !== 'rating' || providerRank('rating', s.provider) !== Number.MAX_SAFE_INTEGER)
    .sort((a, b) => compareForField(field, a, b));
  return winner ? { source: winner, value: VALUE_OF[field](winner) as NonNullable<FieldValues[F]> } : null;
}

export const provenanceFrom = (source: NormalizedSource): ProvenanceInput => ({
  source: source.provider,
  sourceRef: source.providerRef,
  confidence: source.confidence,
  observedAt: new Date(source.observedAt),
});

export interface GoldenContact {
  readonly type: ContactType;
  readonly value: string;
  readonly source: SourceProvider;
  readonly sourceUrl: string | null;
  readonly publishedOnSite: boolean;
  readonly confidence: number;
  /** Set for manual contacts: the workspace that entered them. */
  readonly submittedByOrgId: string | null;
}

export interface GoldenCategory {
  readonly slug: string;
  readonly isPrimary: boolean;
  readonly confidence: number;
  /** Providers whose classification contributed. */
  readonly source: string;
}

export interface GoldenRecord {
  /** One entry per aggregate field (null value clears it). */
  readonly fields: ReadonlyArray<{ readonly value: FieldValue; readonly provenance: ProvenanceInput | null }>;
  readonly hours: Valued<NonNullable<NormalizedSource['hours']>> | null;
  readonly contacts: readonly GoldenContact[];
  readonly categories: readonly GoldenCategory[];
}

/** Golden values, contacts and categories from every source linked to one business (needs at least one source). */
export function computeGolden(sources: readonly NormalizedSource[]): GoldenRecord {
  if (sources.length === 0) throw new Error('A golden record needs at least one source');
  const fields: Array<{ value: FieldValue; provenance: ProvenanceInput | null }> = [];
  const push = (value: FieldValue, winner: { source: NormalizedSource } | null) =>
    fields.push({ value, provenance: winner ? provenanceFrom(winner.source) : null });

  const name = chooseField('displayName', sources);
  if (name) push({ field: 'displayName', value: BusinessName.parse(name.value.display) }, name);
  const status = chooseField('operatingStatus', sources);
  push({ field: 'operatingStatus', value: status?.value ?? 'unknown' }, status);
  const site = chooseField('websiteUrl', sources);
  push({ field: 'websiteUrl', value: site ? WebsiteUrl.parse(site.value.canonical) : null }, site);
  const phone = chooseField('primaryPhone', sources);
  push({ field: 'primaryPhone', value: phone ? PhoneNumber.parse(phone.value.e164) : null }, phone);
  const address = chooseField('address', sources);
  push(
    {
      field: 'address',
      value: address ? PostalAddress.of(address.value.components, address.value.formatted) : null,
    },
    address,
  );
  const location = chooseField('location', sources);
  push(
    { field: 'location', value: location ? GeoPoint.of(location.value.lat, location.value.lng) : null },
    location,
  );
  const price = chooseField('priceLevel', sources);
  push({ field: 'priceLevel', value: price?.value ?? null }, price);
  const rating = chooseField('rating', sources);
  push({ field: 'rating', value: rating?.value ?? null }, rating);

  return {
    fields,
    hours: chooseField('hours', sources),
    contacts: unionContacts(sources),
    categories: mergeCategories(sources),
  };
}

/** Every contact of every source, once per (type, value), credited to the best source by display-name priority. */
export function unionContacts(sources: readonly NormalizedSource[]): GoldenContact[] {
  const ordered = [...sources].sort((a, b) => compareForField('displayName', a, b));
  const contacts = new Map<string, GoldenContact>();
  for (const source of ordered) {
    const fromSite = source.provider === 'website';
    const siteUrl = fromSite ? (source.website?.canonical ?? null) : null;
    const entries: Array<[ContactType, string, string | undefined]> = [
      ...source.phones.map((p) => ['phone', p.e164, p.pageUrl] as [ContactType, string, string | undefined]),
      ...source.emails.map((e) => ['email', e.value, e.pageUrl] as [ContactType, string, string | undefined]),
      ...source.socials.map((s) => ['social', s.url, s.pageUrl] as [ContactType, string, string | undefined]),
    ];
    for (const [type, value, pageUrl] of entries) {
      // The page that shows it, when the crawl says (else the site itself).
      const sourceUrl = fromSite ? (pageUrl ?? siteUrl) : null;
      const key = `${type}\u0000${value.toLowerCase()}`;
      const existing = contacts.get(key);
      if (!existing) {
        contacts.set(key, {
          type,
          value,
          source: source.provider,
          sourceUrl,
          publishedOnSite: fromSite,
          confidence: source.confidence,
          submittedByOrgId: source.provider === 'manual' ? (source.submittedByOrgId ?? null) : null,
        });
      } else {
        contacts.set(key, {
          ...existing,
          publishedOnSite: existing.publishedOnSite || fromSite,
          sourceUrl: existing.sourceUrl ?? sourceUrl,
          confidence: Math.max(existing.confidence, source.confidence),
        });
      }
    }
  }
  return [...contacts.values()].sort(
    (a, b) => a.type.localeCompare(b.type) || a.value.localeCompare(b.value),
  );
}

/**
 * Categories from every source's classification: score = Σ provider confidence × classification confidence
 * (secondary picks count half). Highest score is primary; ties go to the smaller slug.
 */
export function mergeCategories(sources: readonly NormalizedSource[]): GoldenCategory[] {
  const scores = new Map<string, { score: number; confidence: number; providers: Set<string> }>();
  for (const source of sources) {
    const classification = source.categories;
    if (!classification) continue;
    const picks: Array<[string, number]> = [
      ...(classification.primary ? [[classification.primary, 1] as [string, number]] : []),
      ...classification.secondary.map((slug) => [slug, 0.5] as [string, number]),
    ];
    for (const [slug, weight] of picks) {
      const entry = scores.get(slug) ?? { score: 0, confidence: 0, providers: new Set<string>() };
      entry.score += source.confidence * classification.confidence * weight;
      entry.confidence = Math.max(entry.confidence, classification.confidence * weight);
      entry.providers.add(source.provider);
      scores.set(slug, entry);
    }
  }
  const ranked = [...scores.entries()].sort((a, b) => b[1].score - a[1].score || a[0].localeCompare(b[0]));
  return ranked.map(([slug, entry], index) => ({
    slug,
    isPrimary: index === 0,
    confidence: Math.round(Math.min(1, entry.confidence) * 1000) / 1000,
    source: [...entry.providers].sort().join(','),
  }));
}
