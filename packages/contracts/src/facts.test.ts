import { describe, expect, it } from 'vitest';
import { RegistryFactSchema, registryFactId, toSiteFactKind } from './facts.ts';

const base = {
  source: 'owner_site' as const,
  sourceRef: 'https://salon.example/contact',
  confidence: 0.9,
  observedAt: '2026-10-16T12:00:00.000Z',
  usage: 'display' as const,
};

describe('registry facts (BF-040)', () => {
  it('derives stable ids from kind, value and source, in the site schema’s fact id format', async () => {
    const a = await registryFactId('phone', '+590 590 00 01 01', 'https://salon.example/contact');
    const b = await registryFactId('phone', '+590 590 00 01 01', 'https://salon.example/contact');
    const c = await registryFactId('phone', '+590 590 00 01 02', 'https://salon.example/contact');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^fact_phone_[0-9a-f]{12}$/);
    // BF-033's FactIdSchema: /^[a-z][a-z0-9_.:-]{1,79}$/.
    expect(a).toMatch(/^[a-z][a-z0-9_.:-]{1,79}$/);
    // Object key order does not change the id.
    expect(await registryFactId('geo', { lat: 1, lng: 2 }, null)).toBe(
      await registryFactId('geo', { lng: 2, lat: 1 }, null),
    );
  });

  it('types structured values per kind and keeps text kinds as text', () => {
    const id = 'fact_price_0123456789ab';
    expect(
      RegistryFactSchema.safeParse({
        ...base,
        id,
        kind: 'price',
        value: { amount: 45, currency: 'EUR', serviceRef: 'Coupe' },
      }).success,
    ).toBe(true);
    expect(RegistryFactSchema.safeParse({ ...base, id, kind: 'price', value: '45 €' }).success).toBe(false);
    expect(
      RegistryFactSchema.safeParse({
        ...base,
        id: 'fact_hours_0123456789ab',
        kind: 'hours',
        value: { weekly: [{ day: 'mon', opens: '09:00', closes: '18:00' }] },
      }).success,
    ).toBe(true);
    expect(
      RegistryFactSchema.safeParse({
        ...base,
        id: 'fact_tagline_0123456789ab',
        kind: 'tagline',
        value: 'Coiffure à Gustavia',
      }).success,
    ).toBe(true);
    expect(
      RegistryFactSchema.safeParse({ ...base, id: 'phone.main', kind: 'phone', value: '+590' }).success,
    ).toBe(false);
  });

  it('maps registry kinds onto the site schema’s kinds', () => {
    expect(toSiteFactKind('name')).toBe('business_name');
    expect(toSiteFactKind('booking_provider')).toBe('booking_url');
    expect(toSiteFactKind('year_founded')).toBe('year');
    expect(toSiteFactKind('brand_color')).toBeUndefined();
  });
});
