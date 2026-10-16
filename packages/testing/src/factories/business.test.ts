import { describe, expect, it } from 'vitest';
import {
  aBusiness,
  aContact,
  aGenericBusiness,
  aSourceRecord,
  fakeNormalizedName,
  fakeUuidV7,
} from './business.ts';

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('business factories', () => {
  it('builds a Saint-Barthélemy-like business with provenance for its golden fields', () => {
    const business = aBusiness();
    expect(business.id).toMatch(UUID_V7);
    expect(business).toMatchObject({ countryCode: 'BL', postalCode: '97133' });
    expect(business.primaryPhoneE164).toMatch(/^\+590590\d{6}$/);
    expect(business.websiteUrl).toMatch(/\.example\/$/);
    expect(business.location?.lat).toBeGreaterThan(17.8);
    expect(Object.keys(business.attributes)).toEqual(
      expect.arrayContaining(['displayName', 'websiteUrl', 'primaryPhone', 'address', 'location']),
    );
  });

  it('applies overrides and derives provenance from them', () => {
    const business = aBusiness({ displayName: 'Café Élégant', websiteUrl: null, primaryPhoneE164: null });
    expect(business.normalizedName).toBe('cafe elegant');
    expect(business.attributes.websiteUrl).toBeUndefined();
    expect(business.attributes.displayName?.value).toBe('Café Élégant');
  });

  it('builds generic businesses with fictional phone numbers', () => {
    expect(aGenericBusiness().primaryPhoneE164).toMatch(/^\+1\d{3}55501\d{2}$/);
  });

  it('builds contacts and source records', () => {
    const business = aBusiness();
    expect(aContact({ businessId: business.id, value: 'Info@Shop.example' })).toMatchObject({
      type: 'email',
      normalizedValue: 'info@shop.example',
    });
    expect(aContact({ businessId: business.id, type: 'phone' }).subtype).toBe('mobile');
    const source = aSourceRecord({ businessId: business.id });
    expect(source).toMatchObject({ provider: 'google_places', businessId: business.id, linkedBy: 'auto' });
    expect(source.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('helpers are deterministic shapes', () => {
    expect(fakeUuidV7(new Date('2026-01-01T00:00:00Z'))).toMatch(/^019b76da-a800-7/);
    expect(fakeNormalizedName("L'Atelier — Saint-Jean")).toBe('l atelier saint jean');
  });
});
