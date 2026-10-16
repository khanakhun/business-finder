import { faker } from '../faker.ts';

// Builders for business-graph rows (BF-014). They return plain objects shaped like the Drizzle insert values of
// `businesses`, `business_contacts` and `business_sources` (`@bf/db` depends on this package, so no import of it).
// All data is fake: `.example` domains, invented names, random numbers.

/** Mirrors `SOURCE_PROVIDERS` in `@bf/contracts` (which depends on this package, so it is not imported). */
export type FakeSourceProvider =
  | 'google_places'
  | 'overture'
  | 'foursquare'
  | 'osm'
  | 'gmaps_scraper'
  | 'website'
  | 'manual'
  | 'import';

export interface Provenance {
  readonly value: unknown;
  readonly source: FakeSourceProvider;
  readonly sourceRef: string | null;
  readonly confidence: number;
  readonly observedAt: string;
}

export interface BusinessFixture {
  readonly id: string;
  readonly displayName: string;
  readonly normalizedName: string;
  readonly operatingStatus: 'operational' | 'closed_temporarily' | 'closed_permanently' | 'unknown';
  readonly websiteUrl: string | null;
  readonly websiteHost: string | null;
  readonly websiteRegistrableDomain: string | null;
  readonly primaryPhoneE164: string | null;
  readonly countryCode: string;
  readonly localeHint: string | null;
  readonly location: { readonly lat: number; readonly lng: number } | null;
  readonly address: {
    readonly line1: string;
    readonly city: string;
    readonly postalCode: string;
    readonly countryCode: string;
  } | null;
  readonly formattedAddress: string | null;
  readonly locality: string | null;
  readonly postalCode: string | null;
  readonly priceLevel: number | null;
  readonly ratingAvg: number | null;
  readonly ratingCount: number | null;
  readonly attributes: Record<string, Provenance>;
  readonly mergedIntoId?: string | null;
  readonly version: number;
  readonly firstSeenAt: Date;
  readonly lastSeenAt: Date;
}

export interface ContactFixture {
  readonly id: string;
  readonly businessId: string;
  readonly type: 'email' | 'phone' | 'whatsapp' | 'website_form' | 'social';
  readonly value: string;
  readonly normalizedValue: string;
  readonly subtype: string;
  readonly personName: string | null;
  readonly source: FakeSourceProvider;
  readonly sourceUrl: string | null;
  readonly publishedOnSite: boolean;
  readonly confidence: number;
}

export interface SourceRecordFixture {
  readonly id: string;
  readonly businessId: string | null;
  readonly provider: FakeSourceProvider;
  readonly providerRef: string;
  readonly payload: Record<string, unknown>;
  readonly normalized: Record<string, unknown> | null;
  readonly contentHash: string;
  readonly fetchedAt: Date;
  readonly expiresAt: Date | null;
  readonly matchConfidence: number | null;
  readonly linkedBy: 'auto' | 'manual';
}

/** A UUIDv7 from faker's seeded randomness (reproducible per test, unlike `newId()`). */
export function fakeUuidV7(at: Date = faker.date.recent({ days: 30 })): string {
  const ms = at.getTime().toString(16).padStart(12, '0');
  const hex = (length: number) => faker.string.hexadecimal({ length, casing: 'lower', prefix: '' });
  const variant = faker.helpers.arrayElement(['8', '9', 'a', 'b']);
  return `${ms.slice(0, 8)}-${ms.slice(8, 12)}-7${hex(3)}-${variant}${hex(3)}-${hex(12)}`;
}

/** Lowercase, unaccented, punctuation collapsed (close to `BusinessName` normalization, without suffix rules). */
export function fakeNormalizedName(name: string): string {
  return name
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

const slug = (name: string) => fakeNormalizedName(name).replace(/ /g, '-');

const ST_BARTH_LOCALITIES = [
  'Gustavia',
  'Saint-Jean',
  'Lorient',
  'Flamands',
  'Colombier',
  'Corossol',
  'Grand Cul-de-Sac',
];
const ST_BARTH_PREFIXES = ['Chez', 'La Case', 'Le Petit', 'Atelier', 'Villa', 'Les Jardins de', 'Ti'];
const ST_BARTH_NICHES = [
  'Café',
  'Boutique',
  'Spa',
  'Plongée',
  'Location',
  'Traiteur',
  'Fleurs',
  'Yacht Services',
];

function provenanceFor(
  fields: Record<string, unknown>,
  source: FakeSourceProvider,
  observedAt: Date,
): Record<string, Provenance> {
  return Object.fromEntries(
    Object.entries(fields)
      .filter(([, value]) => value !== null && value !== undefined)
      .map(([field, value]) => [
        field,
        { value, source, sourceRef: null, confidence: 0.9, observedAt: observedAt.toISOString() },
      ]),
  );
}

function assemble(
  base: Omit<BusinessFixture, 'attributes'>,
  overrides: Partial<BusinessFixture>,
): BusinessFixture {
  const merged = { ...base, ...overrides };
  const attributes =
    overrides.attributes ??
    provenanceFor(
      {
        displayName: merged.displayName,
        websiteUrl: merged.websiteUrl,
        primaryPhone: merged.primaryPhoneE164,
        address: merged.address,
        location: merged.location,
        priceLevel: merged.priceLevel,
        rating: merged.ratingAvg === null ? null : { avg: merged.ratingAvg, count: merged.ratingCount },
        operatingStatus: merged.operatingStatus === 'unknown' ? null : merged.operatingStatus,
      },
      'google_places',
      merged.firstSeenAt,
    );
  return { ...merged, attributes };
}

/** A Saint-Barthélemy-like business (Gustavia, 97133, +590 numbers). */
export function aBusiness(overrides: Partial<BusinessFixture> = {}): BusinessFixture {
  const displayName =
    overrides.displayName ??
    `${faker.helpers.arrayElement(ST_BARTH_PREFIXES)} ${faker.person.lastName()} ${faker.helpers.arrayElement(ST_BARTH_NICHES)}`;
  const host = `www.${slug(displayName)}.example`;
  const locality = faker.helpers.arrayElement(ST_BARTH_LOCALITIES);
  const line1 = `${faker.number.int({ min: 1, max: 99 })} Rue ${faker.person.lastName()}`;
  const seen = faker.date.recent({ days: 90 });
  return assemble(
    {
      id: fakeUuidV7(seen),
      displayName,
      normalizedName: fakeNormalizedName(displayName),
      operatingStatus: 'operational',
      websiteUrl: `https://${host}/`,
      websiteHost: host,
      websiteRegistrableDomain: host.slice('www.'.length),
      primaryPhoneE164: `+590590${faker.string.numeric(6)}`,
      countryCode: 'BL',
      localeHint: 'fr',
      location: {
        lat: faker.number.float({ min: 17.875, max: 17.925, fractionDigits: 5 }),
        lng: faker.number.float({ min: -62.875, max: -62.8, fractionDigits: 5 }),
      },
      address: { line1, city: locality, postalCode: '97133', countryCode: 'BL' },
      formattedAddress: `${line1}, 97133 ${locality}, BL`,
      locality,
      postalCode: '97133',
      priceLevel: faker.number.int({ min: 1, max: 4 }),
      ratingAvg: faker.number.float({ min: 3, max: 5, fractionDigits: 1 }),
      ratingCount: faker.number.int({ min: 1, max: 400 }),
      version: 1,
      firstSeenAt: seen,
      lastSeenAt: seen,
    },
    overrides,
  );
}

/** A generic (US-style) business, for location-agnostic tests. */
export function aGenericBusiness(overrides: Partial<BusinessFixture> = {}): BusinessFixture {
  const displayName = overrides.displayName ?? faker.company.name();
  const host = `${slug(displayName)}.example`;
  const city = faker.location.city();
  const postalCode = faker.location.zipCode('#####');
  const line1 = faker.location.streetAddress();
  const seen = faker.date.recent({ days: 90 });
  return assemble(
    {
      id: fakeUuidV7(seen),
      displayName,
      normalizedName: fakeNormalizedName(displayName),
      operatingStatus: 'operational',
      websiteUrl: `https://${host}/`,
      websiteHost: host,
      websiteRegistrableDomain: host,
      // 555-01xx numbers are reserved for fiction.
      primaryPhoneE164: `+1${faker.helpers.arrayElement(['212', '305', '415'])}55501${faker.string.numeric(2)}`,
      countryCode: 'US',
      localeHint: 'en',
      location: {
        lat: faker.location.latitude({ min: 25, max: 48 }),
        lng: faker.location.longitude({ min: -122, max: -71 }),
      },
      address: { line1, city, postalCode, countryCode: 'US' },
      formattedAddress: `${line1}, ${postalCode} ${city}, US`,
      locality: city,
      postalCode,
      priceLevel: null,
      ratingAvg: null,
      ratingCount: null,
      version: 1,
      firstSeenAt: seen,
      lastSeenAt: seen,
    },
    overrides,
  );
}

/** A contact of `businessId` (a generic email by default). */
export function aContact(
  overrides: Partial<ContactFixture> & Pick<ContactFixture, 'businessId'>,
): ContactFixture {
  const type = overrides.type ?? 'email';
  const defaults: Record<
    ContactFixture['type'],
    { value: string; normalizedValue?: string; subtype: string }
  > = {
    email: { value: `contact@${faker.internet.domainWord()}.example`, subtype: 'generic' },
    phone: { value: `+590690${faker.string.numeric(6)}`, subtype: 'mobile' },
    whatsapp: { value: `+590690${faker.string.numeric(6)}`, subtype: 'mobile' },
    website_form: { value: `https://www.${faker.internet.domainWord()}.example/contact`, subtype: 'unknown' },
    social: { value: `https://www.instagram.com/${faker.internet.domainWord()}/`, subtype: 'instagram' },
  };
  const base = defaults[type];
  const value = overrides.value ?? base.value;
  return {
    id: fakeUuidV7(),
    type,
    value,
    normalizedValue: type === 'email' ? value.toLowerCase() : value,
    subtype: base.subtype,
    personName: null,
    source: 'website',
    sourceUrl: null,
    publishedOnSite: true,
    confidence: 0.9,
    ...overrides,
  };
}

/** A provider record (Google Places-like by default), optionally linked to a business. */
export function aSourceRecord(overrides: Partial<SourceRecordFixture> = {}): SourceRecordFixture {
  const providerRef = overrides.providerRef ?? `fake-${faker.string.alphanumeric(20)}`;
  const fetchedAt = overrides.fetchedAt ?? faker.date.recent({ days: 30 });
  const payload = overrides.payload ?? {
    id: providerRef,
    displayName: { text: `${faker.person.lastName()} ${faker.helpers.arrayElement(ST_BARTH_NICHES)}` },
    rating: faker.number.float({ min: 3, max: 5, fractionDigits: 1 }),
  };
  return {
    id: fakeUuidV7(fetchedAt),
    businessId: null,
    provider: 'google_places',
    providerRef,
    payload,
    normalized: null,
    contentHash: `sha256:${faker.string.hexadecimal({ length: 64, casing: 'lower', prefix: '' })}`,
    fetchedAt,
    expiresAt: new Date(fetchedAt.getTime() + 30 * 24 * 3600 * 1000),
    matchConfidence: null,
    linkedBy: 'auto',
    ...overrides,
  };
}
