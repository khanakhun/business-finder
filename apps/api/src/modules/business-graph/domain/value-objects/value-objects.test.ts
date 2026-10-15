import { describe, expect, it } from 'vitest';
import { InvalidValueError } from '../errors.ts';
import { BusinessName } from './business-name.ts';
import { EmailAddress } from './email-address.ts';
import { GeoPoint } from './geo-point.ts';
import { PhoneNumber } from './phone-number.ts';
import { PostalAddress } from './postal-address.ts';
import { provenanceOf } from './provenance.ts';
import { WebsiteUrl } from './website-url.ts';

describe('PhoneNumber', () => {
  it.each([
    // Saint-Barthélemy shares +590 with Guadeloupe and Saint-Martin; the region hint reads national formats.
    ['+590 590 27 12 34', undefined, '+590590271234', 'BL', 'landline'],
    ['0590 27 12 34', 'BL', '+590590271234', 'BL', 'landline'],
    ['0690 50 12 34', 'BL', '+590690501234', null, 'mobile'],
    ['06 12 34 56 78', 'FR', '+33612345678', 'FR', 'mobile'],
    ['01 42 68 53 00', 'FR', '+33142685300', 'FR', 'landline'],
    ['+31 20 123 4567', undefined, '+31201234567', 'NL', 'landline'],
    ['(201) 555-0123', 'US', '+12015550123', 'US', 'unknown'],
  ])('%s (%s) → %s', (raw, region, e164, country, type) => {
    const phone = PhoneNumber.parse(raw, region);
    expect(phone.e164).toBe(e164);
    if (country) expect(phone.country).toBe(country);
    expect(phone.type).toBe(type);
  });

  it.each(['', 'call us', '+590 12', '0690 50 12', '+33 1', '1'.repeat(41)])('rejects %j', (raw) => {
    expect(() => PhoneNumber.parse(raw, 'BL')).toThrow(InvalidValueError);
  });

  it('compares by E.164', () => {
    expect(PhoneNumber.parse('0590 27 12 34', 'BL').equals(PhoneNumber.parse('+590590271234'))).toBe(true);
  });
});

describe('WebsiteUrl', () => {
  it('canonicalizes scheme, host, tracking parameters and trailing slashes', () => {
    const url = WebsiteUrl.parse('HTTP://WWW.Example.COM/?utm_source=x&utm_medium=y');
    expect(url.canonical).toBe('http://www.example.com/');
    expect(url.host).toBe('www.example.com');
    expect(url.registrableDomain).toBe('example.com');
    expect(url.matchKey).toBe('example.com');
    expect(WebsiteUrl.parse('boulangerie.example.fr/menu/?fbclid=1&p=2#top').canonical).toBe(
      'https://boulangerie.example.fr/menu?p=2',
    );
    expect(WebsiteUrl.parse('https://shop.example.co.uk:443/a/').canonical).toBe(
      'https://shop.example.co.uk/a',
    );
    expect(WebsiteUrl.parse('https://shop.example.co.uk').registrableDomain).toBe('example.co.uk');
  });

  it('flags shared hosts, whose registrable domain must not match businesses', () => {
    const wix = WebsiteUrl.parse('https://lebistrot.wixsite.com/menu');
    expect(wix.isSharedHost).toBe(true);
    expect(wix.matchKey).toBe('lebistrot.wixsite.com/menu');
    expect(WebsiteUrl.parse('https://www.facebook.com/LeBistrotSBH').matchKey).toBe(
      'facebook.com/lebistrotsbh',
    );
    expect(WebsiteUrl.parse('https://linktr.ee/bistrot').isSharedHost).toBe(true);
  });

  it.each([
    '',
    'not a url',
    'ftp://example.com',
    'javascript:alert(1)',
    'https://user:pw@example.com',
    'https://localhost',
    'https://example.invalidtld',
    'http://127.0.0.1/',
    'http://169.254.169.254/latest/meta-data',
    'http://10.0.0.5/',
    'http://[::1]/',
    'http://2130706433/',
    'https://example.com:8443/',
  ])('rejects %j', (raw) => {
    expect(() => WebsiteUrl.parse(raw)).toThrow(InvalidValueError);
  });
});

describe('EmailAddress', () => {
  it.each([
    ['Info@Boulangerie.example.fr', 'info@boulangerie.example.fr', 'generic'],
    ['mailto:reservations@villa.example.test', 'reservations@villa.example.test', 'generic'],
    ['contact2@example.test', 'contact2@example.test', 'generic'],
    ['compta@example.test', 'compta@example.test', 'department'],
    ['jean.dupont@example.test', 'jean.dupont@example.test', 'personal'],
    ['jd@example.test', 'jd@example.test', 'unknown'],
  ])('%s → %s (%s)', (raw, value, subtype) => {
    const email = EmailAddress.parse(raw);
    expect(email.value).toBe(value);
    expect(email.subtype).toBe(subtype);
  });

  it.each([
    '',
    'no-at-sign',
    'a@b',
    '.a@example.test',
    'a..b@example.test',
    'a@-example.test',
    `${'a'.repeat(65)}@example.test`,
  ])('rejects %j', (raw) => {
    expect(() => EmailAddress.parse(raw)).toThrow(InvalidValueError);
  });
});

describe('BusinessName', () => {
  it.each([
    ['  Le   Bistrot  ', 'Le Bistrot', 'le bistrot'],
    [
      'Boulangerie Pâtisserie Éclair SARL',
      'Boulangerie Pâtisserie Éclair SARL',
      'boulangerie patisserie eclair',
    ],
    ['SAS Hôtel Le Toiny', 'SAS Hôtel Le Toiny', 'hotel le toiny'],
    ['Smith & Sons Ltd.', 'Smith & Sons Ltd.', 'smith and sons'],
    ['SARL', 'SARL', 'sarl'],
    ['Café-Bar "L\'Escale"', 'Café-Bar "L\'Escale"', 'cafe bar l escale'],
  ])('%j → %j / %j', (raw, display, normalized) => {
    const name = BusinessName.parse(raw);
    expect(name.display).toBe(display);
    expect(name.normalized).toBe(normalized);
  });

  it.each(['', '   ', '!!!', 'x'.repeat(201)])('rejects %j', (raw) => {
    expect(() => BusinessName.parse(raw)).toThrow(InvalidValueError);
  });
});

describe('GeoPoint, PostalAddress, provenance', () => {
  it('validates coordinates (and refuses Null Island)', () => {
    expect(GeoPoint.of(17.8962, -62.8498).toJSON()).toEqual({ lat: 17.8962, lng: -62.8498 });
    for (const [lat, lng] of [
      [91, 0],
      [0, 181],
      [Number.NaN, 1],
      [0, 0],
    ] as const) {
      expect(() => GeoPoint.of(lat, lng)).toThrow(InvalidValueError);
    }
  });

  it('cleans address components and formats one line', () => {
    const address = PostalAddress.of({
      line1: ' 12  rue Jeanne d’Arc ',
      city: 'Gustavia',
      postalCode: '97133',
      countryCode: 'bl',
    });
    expect(address.components.countryCode).toBe('BL');
    expect(address.formatted).toBe('12 rue Jeanne d’Arc, 97133 Gustavia, BL');
    expect(() => PostalAddress.of({ countryCode: 'BLX' })).toThrow(InvalidValueError);
    expect(() => PostalAddress.of({ line1: '  ' })).toThrow(InvalidValueError);
  });

  it('builds provenance with a bounded confidence', () => {
    const observedAt = new Date('2026-10-15T00:00:00Z');
    expect(provenanceOf('x', { source: 'manual', sourceRef: null, confidence: 1, observedAt })).toEqual({
      value: 'x',
      source: 'manual',
      sourceRef: null,
      confidence: 1,
      observedAt: '2026-10-15T00:00:00.000Z',
    });
    expect(() =>
      provenanceOf('x', { source: 'manual', sourceRef: null, confidence: 1.2, observedAt }),
    ).toThrow(InvalidValueError);
    expect(() =>
      provenanceOf('x', { source: 'manual', sourceRef: null, confidence: 1, observedAt: new Date('nope') }),
    ).toThrow(InvalidValueError);
  });
});

describe('legal forms and addresses (review fixes)', () => {
  it('keeps real words that look like legal forms', () => {
    expect(BusinessName.parse('Beach Club Spa').normalized).toBe('beach club spa');
    expect(BusinessName.parse('Sci Fi Café').normalized).toBe('sci fi cafe');
    expect(BusinessName.parse('SARL Le Bistrot').normalized).toBe('le bistrot');
    expect(BusinessName.parse('Bistrot SA').normalized).toBe('bistrot');
  });

  it('keeps a source-written address line verbatim', () => {
    const address = PostalAddress.of(
      { city: 'Gustavia', postalCode: '97133', countryCode: 'BL' },
      '  Rue du Roi   Oscar II, 97133 Gustavia ',
    );
    expect(address.formatted).toBe('Rue du Roi Oscar II, 97133 Gustavia');
    expect(PostalAddress.of({ city: 'Gustavia', countryCode: 'BL' }).formatted).toBe('Gustavia, BL');
  });
});
