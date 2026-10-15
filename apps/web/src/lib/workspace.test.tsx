import { describe, expect, it } from 'vitest';
import { toAddress } from '../components/settings/workspace-settings.tsx';
import { countryOptions, timeZoneOptions } from './countries.ts';

describe('countries and time zones', () => {
  it('names every country in the viewer language, including the overseas collectivities', () => {
    const fr = countryOptions('fr');
    expect(fr).toHaveLength(249);
    expect(fr.find((c) => c.value === 'BL')?.label).toBe('Saint-Barthélemy');
    expect(countryOptions('en').find((c) => c.value === 'MF')?.label).toMatch(/St\.? Martin/);
  });

  it('offers UTC first, then IANA zones', () => {
    const zones = timeZoneOptions();
    expect(zones[0]).toEqual({ value: 'UTC', label: 'UTC' });
    expect(zones.find((z) => z.value === 'America/St_Barthelemy')?.label).toBe('America/St Barthelemy');
    expect(zones.filter((z) => z.value === 'UTC')).toHaveLength(1);
  });
});

describe('postal address form', () => {
  const empty = { line1: '', line2: '', city: '', postalCode: '', region: '', countryCode: '' };

  it('clears the address when every field is empty', () => {
    expect(toAddress(empty)).toBeNull();
    expect(toAddress({ ...empty, city: '   ' })).toBeNull();
  });

  it('needs address, city, postal code and country together', () => {
    expect(toAddress({ ...empty, city: 'Gustavia' })).toBe('incomplete');
    expect(
      toAddress({ ...empty, line1: ' 1 rue ', city: 'Gustavia', postalCode: '97133', countryCode: 'BL' }),
    ).toEqual({ line1: '1 rue', city: 'Gustavia', postalCode: '97133', countryCode: 'BL' });
    expect(
      toAddress({
        line1: '1 rue',
        line2: 'Bât. B',
        city: 'Gustavia',
        postalCode: '97133',
        region: 'X',
        countryCode: 'BL',
      }),
    ).toMatchObject({ line2: 'Bât. B', region: 'X' });
  });
});
