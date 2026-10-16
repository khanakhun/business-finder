import type { FeatureUnit, FeatureValue } from '@bf/contracts';
import { describe, expect, it } from 'vitest';
import { formatValue } from './reasons.ts';

describe('formatValue', () => {
  it.each([
    ['score100', 42, 'en', '42/100'],
    ['score10', 6.5, 'fr', '6,5/10'],
    ['rating', 4.25, 'en', '4.3/5'],
    ['seconds', 3.25, 'fr', '3,3 s'],
    ['share', 0.354, 'en', '35%'],
    ['share', 0.354, 'fr', '35 %'],
    // English: singular for exactly one; French: below two.
    ['years', 1, 'en', '1 year'],
    ['years', 1.5, 'en', '1.5 years'],
    ['years', 0, 'en', '0 years'],
    ['years', 1.04, 'en', '1 year'],
    ['years', 1.5, 'fr', '1,5 an'],
    ['years', 3.5, 'fr', '3,5 ans'],
    ['days', 1, 'en', '1 day'],
    ['days', 0, 'fr', '0 jour'],
    ['days', 12, 'fr', '12 jours'],
    // log10(1 + n) shown as n.
    ['log_count', 2, 'en', '99'],
    ['log_count', 3, 'fr', '999'],
    ['count', 1234.5, 'fr', '1 234,5'],
    ['none', 'weak', 'en', 'weak'],
  ] as [FeatureUnit, FeatureValue, 'en' | 'fr', string][])(
    'formats %s %s in %s as %s',
    (unit, value, locale, text) => {
      expect(formatValue(unit, value, locale)).toBe(text);
    },
  );
});
