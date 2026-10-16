import { describe, expect, it } from 'vitest';
import { LocalizedTextSchema, pickLocale } from './i18n.ts';

describe('LocalizedTextSchema', () => {
  it('accepts one or more locales', () => {
    expect(LocalizedTextSchema.parse({ fr: 'Boulangerie' })).toEqual({ fr: 'Boulangerie' });
    expect(LocalizedTextSchema.parse({ fr: 'Boulangerie', en: 'Bakery' })).toEqual({
      fr: 'Boulangerie',
      en: 'Bakery',
    });
  });

  it.each([{}, { fr: '' }, { en: '   ' }])('rejects %j (no text)', (value) => {
    expect(LocalizedTextSchema.safeParse(value).success).toBe(false);
  });

  it('rejects unknown locales', () => {
    expect(LocalizedTextSchema.safeParse({ de: 'Bäckerei' }).success).toBe(false);
  });
});

describe('pickLocale', () => {
  const text = { fr: 'Boulangerie', en: 'Bakery' };

  it('prefers the first available preferred locale', () => {
    expect(pickLocale(text, ['fr', 'en'])).toBe('Boulangerie');
    expect(pickLocale({ en: 'Bakery' }, ['fr'])).toBe('Bakery');
  });

  it('falls back to the fallback locale, then any locale', () => {
    expect(pickLocale({ fr: 'Boulangerie', en: '' }, [], 'en')).toBe('Boulangerie');
    expect(pickLocale({ en: 'Bakery' }, [], 'fr')).toBe('Bakery');
  });

  it('returns undefined when nothing has text', () => {
    expect(pickLocale({ fr: ' ' }, ['fr'])).toBeUndefined();
  });
});
