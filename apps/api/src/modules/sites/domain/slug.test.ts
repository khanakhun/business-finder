import { describe, expect, it } from 'vitest';
import { baseSlug, isValidSlug, previewSlug, SITE_SLUG_MAX, SUFFIX_LENGTH, transliterate } from './slug.ts';

describe('site slugs', () => {
  it('transliterates French accents and ligatures', () => {
    expect(transliterate("Café de l'Église — Œuvre & Cœur")).toBe('cafe-de-l-eglise-oeuvre-coeur');
    expect(transliterate('Straße Ærø Łódź')).toBe('strasse-aero-lodz');
  });

  it('adds the locality unless the name says it (whole words)', () => {
    expect(baseSlug('Salon Lumière', 'Gustavia')).toBe('salon-lumiere-gustavia');
    expect(baseSlug('Café Saint-Jean', 'Saint-Jean')).toBe('cafe-saint-jean');
    expect(baseSlug('Chez Saint-Jeanne', 'Saint-Jean')).toBe('chez-saint-jeanne-saint-jean');
    expect(baseSlug('Quincaillerie', null)).toBe('quincaillerie');
  });

  it('leaves room for the random suffix without cutting a word', () => {
    const base = baseSlug('La Très Grande Boulangerie Pâtisserie Artisanale', 'Saint-Barthélemy');
    expect(base.length).toBeLessThanOrEqual(SITE_SLUG_MAX - SUFFIX_LENGTH - 1);
    expect(base).toBe('la-tres-grande-boulangerie');
    const slug = previewSlug(base, 'k3x9p2');
    expect(slug).toBe('la-tres-grande-boulangerie-k3x9p2');
    expect(slug.length).toBeLessThanOrEqual(SITE_SLUG_MAX);
    expect(isValidSlug(slug)).toBe(true);
  });

  it('drops offensive words (also inside words) and phishing words; nothing left is `site`', () => {
    expect(baseSlug('Merde Alors Bar', 'Lorient')).toBe('alors-bar-lorient');
    expect(baseSlug('Fuckin Bar', null)).toBe('bar');
    expect(baseSlug('PayPal Login Secure', null)).toBe('site');
    expect(baseSlug('Porn', 'Gustavia')).toBe('site-gustavia');
    expect(baseSlug('!!!', null)).toBe('site');
    expect(baseSlug('龍門', 'Gustavia')).toBe('site-gustavia');
  });

  it('never gives one of our hostnames', () => {
    expect(isValidSlug('www')).toBe(false);
    expect(isValidSlug(previewSlug(baseSlug('API', null), 'abc234'))).toBe(true);
  });
});
