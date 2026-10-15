import { type SourceRecordInput, SourceRecordSchema } from '@bf/contracts';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { blockingLockKeys, businessLockKeys, namePrefix } from './blocking.ts';
import { decideMatch } from './decision.ts';
import {
  addressTokens,
  type CandidateProfile,
  categoryCompatibility,
  distanceDecay,
  scoreMatch,
} from './match-scorer.ts';
import { type NormalizedSource, normalizeSource } from './normalized-source.ts';
import { chooseField, computeGolden, mergeCategories, unionContacts } from './survivorship.ts';

const record = (overrides: Partial<SourceRecordInput> = {}) =>
  SourceRecordSchema.parse({
    provider: 'google_places',
    providerRef: 'g-1',
    fetchedAt: '2026-10-01T10:00:00.000Z',
    name: 'Le Tamarin',
    location: { lat: 17.9, lng: -62.85 },
    address: { line1: 'Route de Saline', city: 'Saint-Jean', postalCode: '97133', countryCode: 'BL' },
    phones: ['0590 27 00 01'],
    website: 'https://www.le-tamarin.com/?utm_source=g',
    ...overrides,
  });

const norm = (
  overrides: Partial<SourceRecordInput> = {},
  classification: NormalizedSource['categories'] = null,
) => normalizeSource(record(overrides), { classification });

const profile = (source: NormalizedSource, overrides: Partial<CandidateProfile> = {}): CandidateProfile => ({
  businessId: '019a0000-0000-7000-8000-000000000001',
  normalizedName: source.name.normalized,
  location: source.location,
  phones: source.phones.map((p) => p.e164),
  siteKeys: source.website ? [source.website.matchKey] : [],
  categoryPath: null,
  addressTokens: addressTokens(source.address?.formatted),
  sources: [{ provider: source.provider, providerRef: source.providerRef }],
  ...overrides,
});

describe('normalizeSource', () => {
  it('canonicalizes every value and keeps provenance facts', () => {
    const n = norm({
      emails: ['Contact@Le-Tamarin.com', 'contact@le-tamarin.com', 'nope'],
      socials: ['https://www.instagram.com/letamarin/', 'https://www.linkedin.com/in/someone/'],
      phones: ['0590 27 00 01', '+590 590 27 00 01', '12'],
      hours: [
        { weekday: 1, opensAt: '12:00', closesAt: '15:00' },
        { weekday: 0, opensAt: '12:00', closesAt: '15:00' },
      ],
      rating: 4.46,
      reviewCount: 120,
    });
    expect(n).toMatchObject({
      provider: 'google_places',
      confidence: 0.85,
      name: { display: 'Le Tamarin', normalized: 'le tamarin' },
      countryCode: 'BL',
      phones: [{ e164: '+590590270001' }],
      website: {
        canonical: 'https://www.le-tamarin.com/',
        registrableDomain: 'le-tamarin.com',
        shared: false,
      },
      emails: [{ value: 'contact@le-tamarin.com', subtype: 'generic' }],
      socials: [{ url: 'https://www.instagram.com/letamarin', network: 'instagram' }],
      rating: { avg: 4.5, count: 120 },
      dropped: ['email', 'phone', 'social'],
    });
    expect(n.hours?.map((h) => h.weekday)).toEqual([0, 1]);
    expect(n.address?.formatted).toBe('Route de Saline, 97133 Saint-Jean, BL');
  });

  it('fails on an unusable name and drops other invalid values', () => {
    expect(() => norm({ name: '   ' })).toThrow();
    const n = norm({ website: 'http://10.0.0.1/', location: { lat: 0, lng: 0 } });
    expect(n.website).toBeNull();
    expect(n.location).toBeNull();
    expect(n.dropped).toEqual(['location', 'website']);
  });
});

describe('blocking', () => {
  it('locks phones, site and the neighbouring cells with a name prefix, sorted', () => {
    const keys = blockingLockKeys(norm());
    expect(keys).toContain('phone:+590590270001');
    expect(keys).toContain('site:le-tamarin.com');
    expect(keys.filter((k) => k.startsWith('cell:'))).toHaveLength(9);
    expect(keys).toContain('name:le tamarin');
    expect(keys).toEqual([...keys].sort());
    expect(blockingLockKeys(norm({ location: undefined }))).toContain('name:le tamarin');
    // Name variants of one place in the same area share their cell locks.
    const variant = blockingLockKeys(norm({ name: 'Paul Restaurant', phones: [], website: undefined }));
    expect(variant.filter((k) => keys.includes(k) && k.startsWith('cell:'))).toHaveLength(9);
    expect(businessLockKeys(['b', 'a', 'b'])).toEqual(['business:a', 'business:b']);
  });

  it('gives decorated variants of a name the same prefix', () => {
    expect(namePrefix('le tamarin')).toBe(namePrefix('tamarin restaurant'));
    expect(namePrefix('chez jo s')).toBe(namePrefix('chez joe'));
  });
});

describe('scoreMatch', () => {
  const restaurant = 'food_drink.restaurant';

  it('matches the same place across providers, with explanations', () => {
    const google = norm({}, null);
    const overture = norm({
      provider: 'overture',
      providerRef: 'o-9',
      name: 'Tamarin Restaurant',
      location: { lat: 17.90005, lng: -62.85003 },
      website: undefined,
    });
    const score = scoreMatch(overture, restaurant, profile(google, { categoryPath: restaurant }));
    expect(score.total).toBeGreaterThanOrEqual(0.85);
    expect(score.reasons).toContain('same phone number');
    expect(score.features.map((f) => f.feature)).toEqual([
      'name',
      'distance',
      'phone',
      'category',
      'address',
    ]);
  });

  it('keeps similar names alone in the possible-duplicate band', () => {
    const a = norm({ phones: [], website: undefined, name: "Chez Jo's" });
    const b = norm({ provider: 'osm', providerRef: 'n/1', phones: [], website: undefined, name: 'Chez Joe' });
    const total = scoreMatch(b, null, profile(a)).total;
    expect(total).toBeGreaterThanOrEqual(0.6);
    expect(total).toBeLessThan(0.85);
  });

  it('penalizes conflicts and a second record from the same provider', () => {
    const a = norm();
    const neighbour = norm({
      providerRef: 'g-2',
      name: 'Le Tamarin Boutique',
      phones: ['0590 27 99 99'],
      website: 'https://tamarin-boutique.com',
    });
    const score = scoreMatch(neighbour, null, profile(a));
    expect(score.features.map((f) => f.feature)).toEqual(
      expect.arrayContaining(['phoneConflict', 'websiteConflict', 'sameProvider']),
    );
    expect(score.total).toBeLessThan(0.6);
  });

  it('scores distance and categories on documented curves', () => {
    expect([10, 25, 262.5, 500, 900].map(distanceDecay)).toEqual([1, 1, 0.5, 0, 0]);
    expect(categoryCompatibility('a.b', 'a.b')).toBe(1);
    expect(categoryCompatibility('a.b', 'a.b.c')).toBe(0.7);
    expect(categoryCompatibility('a.b.c', 'a.b.d')).toBe(0.4);
    expect(categoryCompatibility('a.b', 'a.c')).toBe(0.4);
    expect(categoryCompatibility('a.b.c', 'a.d.e')).toBe(0.2);
    expect(categoryCompatibility('a.b', 'x.y')).toBe(0);
    expect(categoryCompatibility(null, 'x')).toBe(0.5);
  });

  it('is bounded for any pair of records', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 30 }),
        fc.string({ minLength: 1, maxLength: 30 }),
        (x, y) => {
          const a = norm({ name: `A${x}`, phones: [], website: undefined });
          const b = norm({ name: `B${y}`, providerRef: 'g-2', phones: [], website: undefined });
          const { total } = scoreMatch(b, null, profile(a));
          expect(total).toBeGreaterThanOrEqual(0);
          expect(total).toBeLessThanOrEqual(1);
        },
      ),
    );
  });
});

describe('decideMatch', () => {
  const s = (businessId: string, total: number) => ({
    businessId,
    score: { total, features: [], reasons: [] },
  });

  it('matches at 0.85, flags 0.60–0.85, creates below', () => {
    expect(decideMatch([s('b', 0.9), s('a', 0.7), s('c', 0.3)], 'google_places')).toEqual({
      kind: 'match',
      businessId: 'b',
      score: s('b', 0.9).score,
      possible: [s('a', 0.7)],
    });
    expect(decideMatch([s('a', 0.7)], 'osm')).toEqual({ kind: 'create', possible: [s('a', 0.7)] });
    expect(decideMatch([s('a', 0.5)], 'osm')).toEqual({ kind: 'create', possible: [] });
    expect(decideMatch([], 'osm')).toEqual({ kind: 'create', possible: [] });
  });

  it('asks noisier providers for more evidence and breaks ties by id', () => {
    expect(decideMatch([s('a', 0.87)], 'gmaps_scraper').kind).toBe('create');
    expect(decideMatch([s('b', 0.9), s('a', 0.9)], 'osm')).toMatchObject({ businessId: 'a' });
  });
});

describe('survivorship', () => {
  const manual = norm({
    provider: 'manual',
    providerRef: 'm-1',
    name: 'Tamarin (manual)',
    phones: ['0690 11 22 33'],
  });
  const google = norm();
  const website = norm({
    provider: 'website',
    providerRef: 'https://le-tamarin.com',
    name: 'Le Tamarin SBH',
  });
  const osm = norm({
    provider: 'osm',
    providerRef: 'n/1',
    name: 'Tamarin',
    location: { lat: 17.91, lng: -62.86 },
  });

  it('never lets a provider overwrite a manual value', () => {
    expect(chooseField('displayName', [google, osm, manual, website])?.source.provider).toBe('manual');
    expect(chooseField('primaryPhone', [google, manual])?.value.e164).toBe('+590690112233');
  });

  it('applies per-field provider priority, then confidence, recency and ref', () => {
    expect(chooseField('displayName', [google, osm, website])?.source.provider).toBe('website');
    expect(chooseField('location', [osm, website, google])?.source.provider).toBe('google_places');
    const older = norm({ providerRef: 'g-0', fetchedAt: '2026-01-01T00:00:00.000Z', name: 'Old' });
    expect(chooseField('displayName', [older, google])?.value.display).toBe('Le Tamarin');
    const twin = norm({ providerRef: 'g-0', name: 'Twin' });
    expect(chooseField('displayName', [google, twin])?.value.display).toBe('Twin');
    expect(chooseField('rating', [norm({ provider: 'osm', providerRef: 'x', rating: 5 })])).toBeNull();
  });

  it('is independent of source order (property)', () => {
    const pool = [
      manual,
      google,
      website,
      osm,
      norm({ provider: 'foursquare', providerRef: 'f-1', name: 'Tamarin Resto' }),
    ];
    fc.assert(
      fc.property(fc.shuffledSubarray(pool, { minLength: 1 }), (subset) => {
        const reversed = [...subset].reverse();
        expect(JSON.stringify(computeGolden(reversed))).toBe(JSON.stringify(computeGolden(subset)));
      }),
    );
  });

  it('clears fields no source provides and unions contacts with the best credit', () => {
    const golden = computeGolden([
      osm,
      norm({ provider: 'website', providerRef: 'w', emails: ['info@le-tamarin.com'] }),
    ]);
    expect(golden.fields.find((f) => f.value.field === 'rating')).toEqual({
      value: { field: 'rating', value: null },
      provenance: null,
    });
    const contacts = unionContacts([osm, google]);
    expect(contacts.find((c) => c.type === 'phone')).toMatchObject({
      source: 'google_places',
      publishedOnSite: false,
    });
    expect(unionContacts([website, google]).find((c) => c.type === 'phone')).toMatchObject({
      source: 'website',
      publishedOnSite: true,
    });
  });

  it('merges classifications into one primary category', () => {
    const a = { ...google, categories: { primary: 'restaurant', secondary: ['bar'], confidence: 0.9 } };
    const b = { ...osm, categories: { primary: 'bar', secondary: [], confidence: 0.3 } };
    expect(mergeCategories([a, b])).toEqual([
      { slug: 'restaurant', isPrimary: true, confidence: 0.9, source: 'google_places' },
      { slug: 'bar', isPrimary: false, confidence: 0.45, source: 'google_places,osm' },
    ]);
    expect(() => computeGolden([])).toThrow();
  });
});

describe('edge cases', () => {
  it('normalizes sparse records with defaults', () => {
    const n = normalizeSource(
      SourceRecordSchema.parse({
        provider: 'osm',
        providerRef: 'n/9',
        fetchedAt: '2026-10-01T10:00:00Z',
        name: 'Atelier Bleu',
        address: { formatted: '  12 rue X,  Gustavia ' },
        phones: ['0690 11 22 33'],
        operatingStatus: 'unknown',
        priceLevel: 2,
        providerCategories: [{ key: 'shop=art', label: 'Art shop' }, { key: 'craft=painter' }],
      }),
      { defaultRegion: 'bl' },
    );
    expect(n).toMatchObject({
      countryCode: 'BL',
      location: null,
      website: null,
      rating: null,
      hours: null,
      operatingStatus: null,
      priceLevel: 2,
      address: { formatted: '12 rue X, Gustavia' },
      phones: [{ e164: '+590690112233', type: 'mobile' }],
      providerCategories: [{ key: 'shop=art', label: 'Art shop' }, { key: 'craft=painter' }],
      categories: null,
    });
    const bare = normalizeSource(
      SourceRecordSchema.parse({
        provider: 'import',
        providerRef: 'r',
        fetchedAt: '2026-10-01T10:00:00Z',
        name: 'X Co',
      }),
    );
    expect(bare).toMatchObject({ countryCode: null, address: null, phones: [], emails: [], socials: [] });
    expect(blockingLockKeys(bare)).toEqual(['name:x']); // legal form stripped
  });

  it('prefixes names made only of generic words', () => {
    expect(namePrefix('le bar')).toBe('ba');
    expect(namePrefix('')).toBe('');
  });

  it('merges a contact seen by several sources', () => {
    const site = norm({ provider: 'website', providerRef: 'w', emails: ['info@le-tamarin.com'] });
    const google = norm({ emails: ['INFO@le-tamarin.com'] });
    const [email] = unionContacts([google, site]).filter((c) => c.type === 'email');
    expect(email).toMatchObject({ source: 'website', publishedOnSite: true, confidence: 0.9 });
    const fromGoogleFirst = unionContacts([
      norm({ provider: 'manual', providerRef: 'm', emails: ['info@le-tamarin.com'] }),
      site,
    ]);
    expect(fromGoogleFirst.find((c) => c.type === 'email')).toMatchObject({
      source: 'manual',
      publishedOnSite: true,
      sourceUrl: 'https://www.le-tamarin.com/',
      confidence: 1,
    });
    expect(
      mergeCategories([{ ...google, categories: { primary: null, secondary: ['bar'], confidence: 0.8 } }]),
    ).toEqual([{ slug: 'bar', isPrimary: true, confidence: 0.4, source: 'google_places' }]);
  });
});
