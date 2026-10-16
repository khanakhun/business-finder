import { describe, expect, it } from 'vitest';
import { baseSlug, isValidSlug, SITE_SLUG_MAX, slugCandidate, transliterate } from './slug.ts';

describe('site slugs', () => {
  it('transliterates French accents and ligatures', () => {
    expect(transliterate("Café de l'Église — Œuvre & Cœur")).toBe('cafe-de-l-eglise-oeuvre-coeur');
    expect(transliterate('Straße Ærø Łódź')).toBe('strasse-aero-lodz');
  });

  it('adds the locality unless the name says it', () => {
    expect(baseSlug('Salon Lumière', 'Gustavia')).toBe('salon-lumiere-gustavia');
    expect(baseSlug('Café Saint-Jean', 'Saint-Jean')).toBe('cafe-saint-jean');
    expect(baseSlug('Quincaillerie', null)).toBe('quincaillerie');
  });

  it('stays within 40 characters without cutting a word', () => {
    const slug = baseSlug('La Très Grande Boulangerie Pâtisserie Artisanale', 'Saint-Barthélemy');
    expect(slug.length).toBeLessThanOrEqual(SITE_SLUG_MAX);
    expect(slug).toBe('la-tres-grande-boulangerie-patisserie');
    expect(isValidSlug(slug)).toBe(true);
  });

  it('never gives one of our hostnames, an empty slug or an offensive word', () => {
    expect(baseSlug('API', null)).toBe('api-site');
    expect(baseSlug('!!!', null)).toBe('site');
    expect(baseSlug('Merde Alors Bar', 'Lorient')).toBe('alors-bar-lorient');
    expect(isValidSlug('www')).toBe(false);
  });

  it('numbers candidates and keeps them within 40 characters', () => {
    expect(slugCandidate('salon-gustavia', 1)).toBe('salon-gustavia');
    expect(slugCandidate('salon-gustavia', 2)).toBe('salon-gustavia-2');
    const long = baseSlug('La Très Grande Boulangerie Pâtisserie Artisanale', null);
    const numbered = slugCandidate(long, 12);
    expect(numbered.length).toBeLessThanOrEqual(SITE_SLUG_MAX);
    expect(numbered.endsWith('-12')).toBe(true);
    expect(isValidSlug(numbered)).toBe(true);
  });
});
