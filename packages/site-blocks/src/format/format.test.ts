import { describe, expect, it } from 'vitest';
import {
  formatSpan,
  formatTime,
  groupDays,
  localMoment,
  openStatus,
  timeZoneOf,
  type Weekly,
  weekdayName,
} from './hours.ts';
import { formatPhone, whatsappLink } from './phone.ts';
import { formatPrice } from './price.ts';

const day = (spans: { open: string; close: string }[]) => spans;
const week = (spans: Partial<Weekly>): Weekly => ({
  mon: [],
  tue: [],
  wed: [],
  thu: [],
  fri: [],
  sat: [],
  sun: [],
  ...spans,
});
const shop = week({
  mon: day([
    { open: '09:00', close: '12:30' },
    { open: '14:00', close: '19:00' },
  ]),
  tue: day([{ open: '09:00', close: '19:00' }]),
  fri: day([{ open: '22:00', close: '02:00' }]),
});

describe('opening hours', () => {
  it('names weekdays and times in the locale (`9:30` in French, `9:30 AM` in English)', () => {
    expect(weekdayName('mon', 'fr')).toBe('lundi');
    expect(weekdayName('sun', 'en')).toBe('Sunday');
    expect(formatTime('09:30', 'fr')).toBe('9:30');
    expect(formatTime('21:05', 'en')).toMatch(/^9:05\sPM$/);
    expect(formatSpan({ open: '09:00', close: '12:30' }, 'fr')).toBe('9:00–12:30');
  });

  it('groups consecutive days with the same spans', () => {
    const groups = groupDays(week({ mon: shop.tue, tue: shop.tue, wed: shop.tue }));
    expect(groups.map((group) => [group.from, group.to])).toEqual([
      ['mon', 'wed'],
      ['thu', 'sun'],
    ]);
  });

  it('reads the moment in the business time zone', () => {
    // 2026-10-12 is a Monday; 03:30 UTC is still Sunday 23:30 in St Barth (UTC−4).
    expect(localMoment(new Date('2026-10-12T03:30:00Z'), 'America/St_Barthelemy')).toEqual({
      day: 'sun',
      minute: 23 * 60 + 30,
    });
    expect(localMoment(new Date('2026-10-12T03:30:00Z'), 'Europe/Paris')).toEqual({
      day: 'mon',
      minute: 5 * 60 + 30,
    });
  });

  it('is open inside a span and says when it closes', () => {
    // Monday 10:00 in Paris (UTC+2 in October).
    expect(openStatus(shop, new Date('2026-10-12T08:00:00Z'), 'Europe/Paris')).toEqual({
      open: true,
      closesAt: '12:30',
    });
  });

  it('is closed at lunch and opens again the same day', () => {
    expect(openStatus(shop, new Date('2026-10-12T11:00:00Z'), 'Europe/Paris')).toEqual({
      open: false,
      opensAt: { day: 'mon', time: '14:00', today: true },
    });
  });

  it('reaches the next opening days later, and stays open after midnight on an overnight span', () => {
    // Wednesday noon → Friday 22:00.
    expect(openStatus(shop, new Date('2026-10-14T10:00:00Z'), 'Europe/Paris')).toEqual({
      open: false,
      opensAt: { day: 'fri', time: '22:00', today: false },
    });
    // Saturday 01:00 in Paris: Friday's 22:00–02:00 span.
    expect(openStatus(shop, new Date('2026-10-16T23:00:00Z'), 'Europe/Paris')).toEqual({
      open: true,
      closesAt: '02:00',
    });
    // Friday 23:00.
    expect(openStatus(shop, new Date('2026-10-16T21:00:00Z'), 'Europe/Paris')).toEqual({
      open: true,
      closesAt: '02:00',
    });
  });

  it('gives the same answer for the same instant in another visitor zone (it is the business zone that counts)', () => {
    const instant = new Date('2026-10-12T13:30:00Z');
    expect(openStatus(shop, instant, 'America/St_Barthelemy')).toEqual({ open: true, closesAt: '12:30' });
    expect(openStatus(shop, instant, 'Europe/Paris')).toEqual({ open: true, closesAt: '19:00' });
  });

  it('is never open with no hours, and treats 00:00–00:00 as the whole day', () => {
    expect(openStatus(week({}), new Date(), 'Europe/Paris')).toEqual({ open: false });
    const always = week({ mon: day([{ open: '00:00', close: '00:00' }]) });
    expect(openStatus(always, new Date('2026-10-12T16:00:00Z'), 'Europe/Paris').open).toBe(true);
  });

  it('knows single-zone countries only', () => {
    expect(timeZoneOf('BL')).toBe('America/St_Barthelemy');
    expect(timeZoneOf('US')).toBeUndefined();
    expect(timeZoneOf(undefined)).toBeUndefined();
  });
});

describe('prices and phones', () => {
  it('formats prices in the locale, with "from" and the unit', () => {
    expect(formatPrice({ amount: 65, currency: 'EUR' }, 'fr')).toBe('65 €');
    expect(formatPrice({ amount: 65, currency: 'EUR' }, 'en')).toBe('€65');
    expect(formatPrice({ amount: 9.5, currency: 'EUR', from: true }, 'fr')).toBe('à partir de 9,50 €');
    expect(formatPrice({ amount: 450, currency: 'USD', unit: 'per_night' }, 'en')).toBe('$450 per night');
  });

  it('writes phone numbers nationally at home and internationally elsewhere', () => {
    expect(formatPhone('+33261910303', 'FR')).toBe('02 61 91 03 03');
    expect(formatPhone('+33261910303', 'BL')).toBe('+33 2 61 91 03 03');
    expect(formatPhone('not a number')).toBe('not a number');
    expect(whatsappLink('+590 690 00 01 01')).toBe('https://wa.me/590690000101');
  });
});
