import { BusinessCreated, BusinessMerged, BusinessUpdated } from '@bf/contracts';
import { describe, expect, it } from 'vitest';
import { Business, type BusinessState, defaultSurvivorship } from './business.entity.ts';
import { BusinessMergedError, InvalidValueError } from './errors.ts';
import { BusinessName } from './value-objects/business-name.ts';
import { GeoPoint } from './value-objects/geo-point.ts';
import { PhoneNumber } from './value-objects/phone-number.ts';
import { PostalAddress } from './value-objects/postal-address.ts';
import { WebsiteUrl } from './value-objects/website-url.ts';

const T0 = new Date('2026-10-01T10:00:00.000Z');
const T1 = new Date('2026-10-02T10:00:00.000Z');
const ID = '0199e1b2-0000-7000-8000-000000000001';
const OTHER = '0199e1b2-0000-7000-8000-000000000002';

const manual = (observedAt = T0) => ({
  source: 'manual' as const,
  sourceRef: null,
  confidence: 1,
  observedAt,
});
const google = (confidence: number, observedAt = T1) => ({
  source: 'google_places' as const,
  sourceRef: 'ChIJ-fake',
  confidence,
  observedAt,
});

function newBusiness() {
  return Business.create({
    id: ID,
    name: BusinessName.parse('Le Petit Café SARL'),
    countryCode: 'bl',
    website: WebsiteUrl.parse('HTTP://WWW.Example.COM/?utm_source=x'),
    phone: PhoneNumber.parse('0590 27 00 00', 'BL'),
    address: PostalAddress.of({
      line1: '1 Rue de la Plage',
      city: 'Gustavia',
      postalCode: '97133',
      countryCode: 'BL',
    }),
    location: GeoPoint.of(17.8962, -62.8498),
    provenance: google(0.8, T0),
  });
}

describe('Business.create', () => {
  it('normalizes values into golden columns with provenance for each', () => {
    const state = newBusiness().snapshot();
    expect(state).toMatchObject({
      displayName: 'Le Petit Café SARL',
      normalizedName: 'le petit cafe',
      countryCode: 'BL',
      websiteUrl: 'http://www.example.com/',
      websiteRegistrableDomain: 'example.com',
      primaryPhoneE164: '+590590270000',
      locality: 'Gustavia',
      postalCode: '97133',
      location: { lat: 17.8962, lng: -62.8498 },
      version: 0,
      mergedIntoId: null,
      firstSeenAt: T0,
      lastSeenAt: T0,
    });
    expect(Object.keys(state.attributes).sort()).toEqual([
      'address',
      'displayName',
      'location',
      'primaryPhone',
      'websiteUrl',
    ]);
    expect(state.attributes.primaryPhone).toEqual({
      value: '+590590270000',
      source: 'google_places',
      sourceRef: 'ChIJ-fake',
      confidence: 0.8,
      observedAt: T0.toISOString(),
    });
  });

  it('does not use a shared host as the registrable domain', () => {
    const business = Business.create({
      id: ID,
      name: BusinessName.parse('Villa Agency'),
      countryCode: null,
      website: WebsiteUrl.parse('https://villa-agency.wixsite.com/home'),
      provenance: manual(),
    });
    expect(business.snapshot()).toMatchObject({
      websiteHost: 'villa-agency.wixsite.com',
      websiteRegistrableDomain: null,
    });
  });

  it('folds changes made before the first save into business.created', () => {
    const business = newBusiness();
    business.addContact({
      id: OTHER,
      type: 'email',
      value: 'info@example.com',
      source: 'manual',
      confidence: 1,
    });
    business.updateField({ field: 'priceLevel', value: 2 }, manual(T1));
    expect(business.pullEvents().map((e) => e.type)).toEqual(['business.created']);
  });

  it('records business.created only', () => {
    const events = newBusiness().pullEvents();
    expect(events).toEqual([
      {
        type: 'business.created',
        definition: BusinessCreated,
        payload: { businessId: ID, source: 'google_places' },
      },
    ]);
  });
});

describe('Business.updateField', () => {
  it('applies a preferred value, refreshes provenance and records the changed field', () => {
    const business = newBusiness();
    business.pullEvents();
    const changed = business.updateField(
      { field: 'primaryPhone', value: PhoneNumber.parse('+590 690 12 34 56') },
      google(0.9),
    );
    expect(changed).toBe(true);
    expect(business.snapshot()).toMatchObject({ primaryPhoneE164: '+590690123456', lastSeenAt: T1 });
    expect(business.snapshot().attributes.primaryPhone?.confidence).toBe(0.9);
    expect(business.pullEvents()).toEqual([
      {
        type: 'business.updated',
        definition: BusinessUpdated,
        payload: { businessId: ID, fields: ['primaryPhone'] },
      },
    ]);
  });

  it('keeps manual values against provider data, and lets manual edits win', () => {
    const business = Business.create({
      id: ID,
      name: BusinessName.parse('Chez Rosemond'),
      countryCode: 'BL',
      provenance: manual(),
    });
    expect(
      business.updateField({ field: 'displayName', value: BusinessName.parse('Rosemond Bar') }, google(1)),
    ).toBe(false);
    expect(business.snapshot().displayName).toBe('Chez Rosemond');
    expect(
      business.updateField({ field: 'displayName', value: BusinessName.parse('Rosemond') }, manual(T1)),
    ).toBe(true);
    expect(business.snapshot()).toMatchObject({ displayName: 'Rosemond', normalizedName: 'rosemond' });
  });

  it('accepts an injected survivorship strategy', () => {
    const business = newBusiness();
    const never = () => false;
    expect(business.updateField({ field: 'priceLevel', value: 2 }, google(1), never)).toBe(false);
    expect(business.snapshot().priceLevel).toBeNull();
  });

  it('reports no change (and no event) when the value is the same', () => {
    const business = newBusiness();
    business.pullEvents();
    expect(
      business.updateField(
        { field: 'primaryPhone', value: PhoneNumber.parse('+590590270000') },
        google(0.95),
      ),
    ).toBe(false);
    expect(business.pullEvents()).toEqual([]);
    expect(business.snapshot().attributes.primaryPhone?.confidence).toBe(0.95);
  });

  it('clearing a value removes its provenance', () => {
    const business = newBusiness();
    business.updateField({ field: 'websiteUrl', value: null }, manual(T1));
    const state = business.snapshot();
    expect(state).toMatchObject({ websiteUrl: null, websiteHost: null, websiteRegistrableDomain: null });
    expect(state.attributes.websiteUrl).toBeUndefined();
  });

  it('validates price level and rating ranges', () => {
    const business = newBusiness();
    expect(() => business.updateField({ field: 'priceLevel', value: 5 }, manual(T1))).toThrow(
      InvalidValueError,
    );
    expect(() =>
      business.updateField({ field: 'rating', value: { avg: 5.5, count: 3 } }, manual(T1)),
    ).toThrow(InvalidValueError);
    business.updateField({ field: 'rating', value: { avg: 4.6, count: 120 } }, manual(T1));
    expect(business.snapshot()).toMatchObject({ ratingAvg: 4.6, ratingCount: 120 });
    expect(business.snapshot().attributes.rating?.value).toEqual({ avg: 4.6, count: 120 });
  });

  it('merges several updates into one business.updated per pull', () => {
    const business = newBusiness();
    business.pullEvents();
    business.updateField({ field: 'priceLevel', value: 2 }, manual(T1));
    business.updateField({ field: 'operatingStatus', value: 'operational' }, manual(T1));
    business.updateField({ field: 'priceLevel', value: 3 }, manual(T1));
    expect(business.pullEvents()).toEqual([
      {
        type: 'business.updated',
        definition: BusinessUpdated,
        payload: { businessId: ID, fields: ['priceLevel', 'operatingStatus'] },
      },
    ]);
  });
});

describe('Business.addContact', () => {
  it('normalizes by type with the business country as region hint', () => {
    const business = newBusiness();
    const phone = business.addContact({
      id: OTHER,
      type: 'phone',
      value: '0690 12 34 56',
      source: 'manual',
      confidence: 1,
    });
    expect(phone).toMatchObject({ normalizedValue: '+590690123456', subtype: 'mobile', businessId: ID });
    const email = business.addContact({
      id: OTHER,
      type: 'email',
      value: ' Contact@Example.com ',
      source: 'website',
      confidence: 0.9,
    });
    expect(email).toMatchObject({
      value: 'Contact@Example.com',
      normalizedValue: 'contact@example.com',
      subtype: 'generic',
      isFreeMail: false,
      publishedContext: null,
    });
    expect(phone.isFreeMail).toBeNull();
    const webmail = business.addContact({
      id: OTHER,
      type: 'email',
      value: 'salon.ondine@orange.fr',
      source: 'website',
      publishedContext: {
        pageUrl: 'https://www.example.com/contact',
        pageKind: 'contact',
        foundAs: 'mailto',
      },
      confidence: 0.9,
    });
    expect(webmail).toMatchObject({ isFreeMail: true, publishedContext: { pageKind: 'contact' } });
    expect(business.pullNewContacts()).toHaveLength(3);
    expect(business.pullNewContacts()).toHaveLength(0);
  });

  it('accepts social profiles on known networks only', () => {
    const business = newBusiness();
    const social = business.addContact({
      id: OTHER,
      type: 'social',
      value: 'https://www.instagram.com/lepetitcafe/',
      source: 'website',
      confidence: 0.8,
    });
    expect(social.subtype).toBe('instagram');
    expect(() =>
      business.addContact({
        id: OTHER,
        type: 'social',
        value: 'https://example.org/me',
        source: 'website',
        confidence: 0.8,
      }),
    ).toThrow(InvalidValueError);
  });

  it('rejects invalid values and confidences', () => {
    const business = newBusiness();
    expect(() =>
      business.addContact({ id: OTHER, type: 'email', value: 'nope', source: 'manual', confidence: 1 }),
    ).toThrow(InvalidValueError);
    expect(() =>
      business.addContact({
        id: OTHER,
        type: 'phone',
        value: '+590690123456',
        source: 'manual',
        confidence: 2,
      }),
    ).toThrow(InvalidValueError);
  });
});

describe('Business.markMerged', () => {
  it('records business.merged and makes the record read-only', () => {
    const business = newBusiness();
    business.pullEvents();
    business.markMerged(OTHER);
    expect(business.isMerged).toBe(true);
    expect(business.pullEvents()).toEqual([
      { type: 'business.merged', definition: BusinessMerged, payload: { businessId: ID, intoId: OTHER } },
    ]);
    expect(() => business.updateField({ field: 'priceLevel', value: 1 }, manual(T1))).toThrow(
      BusinessMergedError,
    );
    expect(() =>
      business.addContact({
        id: OTHER,
        type: 'phone',
        value: '+590690123456',
        source: 'manual',
        confidence: 1,
      }),
    ).toThrow(BusinessMergedError);
    expect(() => business.markMerged(OTHER)).toThrow(BusinessMergedError);
  });

  it('cannot merge into itself', () => {
    expect(() => newBusiness().markMerged(ID)).toThrow(InvalidValueError);
  });
});

describe('Business.rehydrate', () => {
  it('round-trips a snapshot', () => {
    const state = newBusiness().snapshot();
    expect(Business.rehydrate(state).snapshot()).toEqual(state);
  });

  it('rejects golden values without provenance', () => {
    const state: BusinessState = { ...newBusiness().snapshot(), attributes: {} };
    expect(() => Business.rehydrate(state)).toThrow(/without provenance: displayName, websiteUrl/);
  });
});

describe('defaultSurvivorship', () => {
  const at = (iso: string) => new Date(iso).toISOString();
  const p = (source: 'manual' | 'osm', confidence: number, observedAt: string) => ({
    value: null,
    source,
    sourceRef: null,
    confidence,
    observedAt: at(observedAt),
  });

  it('prefers higher confidence, then the newer observation', () => {
    expect(defaultSurvivorship(undefined, p('osm', 0.1, '2026-01-01'))).toBe(true);
    expect(defaultSurvivorship(p('osm', 0.9, '2026-01-01'), p('osm', 0.5, '2026-02-01'))).toBe(false);
    expect(defaultSurvivorship(p('osm', 0.5, '2026-02-01'), p('osm', 0.5, '2026-01-01'))).toBe(false);
    expect(defaultSurvivorship(p('osm', 0.5, '2026-01-01'), p('osm', 0.5, '2026-02-01'))).toBe(true);
    expect(defaultSurvivorship(p('osm', 0.9, '2026-01-01'), p('manual', 0.1, '2026-01-01'))).toBe(true);
  });
});

describe('persistence flags and review fixes', () => {
  it('is new until saved; only row changes (not contacts) need a row write', () => {
    const business = newBusiness();
    expect(business.isNew).toBe(true);
    business.markSaved(1);
    expect(business.isNew).toBe(false);
    expect(business.hasRowChanges).toBe(false);
    business.addContact({
      id: OTHER,
      type: 'email',
      value: 'info@example.com',
      source: 'manual',
      confidence: 1,
    });
    expect(business.hasRowChanges).toBe(false);
    business.updateField({ field: 'priceLevel', value: 2 }, manual(T1));
    expect(business.hasRowChanges).toBe(true);
  });

  it('rehydrated records are not new, whatever their version', () => {
    const business = Business.rehydrate({ ...newBusiness().snapshot(), version: 0 });
    expect(business.isNew).toBe(false);
    expect(business.hasRowChanges).toBe(false);
  });

  it('counts a losing observation as a sighting', () => {
    const business = Business.create({
      id: ID,
      name: BusinessName.parse('Chez Rosemond'),
      countryCode: 'BL',
      provenance: manual(),
    });
    business.markSaved(1);
    expect(
      business.updateField({ field: 'displayName', value: BusinessName.parse('Other') }, google(1)),
    ).toBe(false);
    expect(business.snapshot().lastSeenAt).toEqual(T1);
    expect(business.hasRowChanges).toBe(true);
  });

  it('rounds ratings to the stored precision and requires whole counts', () => {
    const business = newBusiness();
    business.updateField({ field: 'rating', value: { avg: 4.25, count: 10 } }, manual(T1));
    expect(business.snapshot().ratingAvg).toBe(4.3);
    expect(business.snapshot().attributes.rating?.value).toEqual({ avg: 4.3, count: 10 });
    expect(() =>
      business.updateField({ field: 'rating', value: { avg: 4, count: 1.5 } }, manual(T1)),
    ).toThrow(InvalidValueError);
  });

  it('accepts business pages on social networks only, never personal profiles', () => {
    const business = newBusiness();
    const add = (value: string) =>
      business.addContact({ id: OTHER, type: 'social', value, source: 'website', confidence: 0.8 });
    expect(add('https://www.linkedin.com/company/case-gourmande/').subtype).toBe('linkedin');
    expect(add('https://x.com/casegourmande').subtype).toBe('x');
    for (const value of [
      'https://www.linkedin.com/in/jane-doe/',
      'https://www.facebook.com/profile.php?id=123',
      'https://www.booking.com/hotel/bl/x.html',
      'https://www.instagram.com/',
    ]) {
      expect(() => add(value)).toThrow(InvalidValueError);
    }
  });
});

describe('side data changes', () => {
  it('clears the primary category and notes external changes in business.updated', () => {
    const business = newBusiness();
    business.markSaved(1);
    business.pullEvents();
    business.setPrimaryCategory('0199e1b2-0000-7000-8000-0000000000c1');
    business.setPrimaryCategory(null);
    business.noteChanged([]);
    business.noteChanged(['hours', 'categories']);
    expect(business.snapshot().primaryCategoryId).toBeNull();
    expect(business.pullEvents()).toEqual([
      {
        type: 'business.updated',
        definition: BusinessUpdated,
        payload: { businessId: ID, fields: ['primaryCategoryId', 'hours', 'categories'] },
      },
    ]);
  });
});
