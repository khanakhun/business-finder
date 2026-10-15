import type { ParseSearchIntentOutput } from '@bf/ai';
import { describe, expect, it } from 'vitest';
import { extractLocation, type FallbackCategory, parseIntentFallback } from './fallback-parser.ts';
import { cleanFilters, groundCategories, type IntentCategory, toSearchIntent } from './post-process.ts';
import { detectLanguage, fold, normalizePrompt } from './text.ts';

const cat = (slug: string, en: string, fr: string, synonyms: string[] = []): FallbackCategory => ({
  slug,
  labels: { en, fr },
  synonyms: { en: synonyms, fr: synonyms },
});
const CATEGORIES = [
  cat('hair_salon', 'Hair salon', 'Salon de coiffure', ['hairdresser', 'coiffeur']),
  cat('cafe', 'Café', 'Café', ['coffee shop']),
  cat('restaurant', 'Restaurant', 'Restaurant', ['resto']),
  cat('spa', 'Spa', 'Spa'),
  cat('plumber', 'Plumber', 'Plombier'),
  cat('bakery', 'Bakery', 'Boulangerie'),
];

describe('text', () => {
  it('folds accents, case and punctuation', () => {
    expect(fold('  Cafés à   SAINT-Barthélemy !')).toBe('cafes a saint-barthelemy');
    expect(normalizePrompt('  Cafés  in   Gustavia ')).toBe('cafés in gustavia');
  });

  it.each([
    ['salons de coiffure et cafés à Gustavia sans site web', 'en', 'fr'],
    ['hair salons and cafés in Gustavia without a website', 'fr', 'en'],
    ['mes spas qualifiés', 'en', 'fr'],
    ['my qualified spas', 'fr', 'en'],
    ['spa', 'fr', 'fr'], // nothing to go on: the UI locale
    ['restaurants à Saint-Jean', 'en', 'fr'],
    // False friends no longer count as French; French-only function words outweigh English borrowings.
    ['villa location in Gustavia', 'fr', 'en'],
    ['spas plus cafes near Lorient', 'fr', 'en'],
    ['spas avec rooftop', 'en', 'fr'],
    ['bars sans website', 'en', 'fr'],
  ] as const)('detects the language of %j (UI %s)', (prompt, ui, expected) => {
    expect(detectLanguage(prompt, ui)).toBe(expected);
  });
});

describe('fallback parser', () => {
  it('reads categories, location and filters from a French prompt', () => {
    const output = parseIntentFallback(
      'Salons de coiffure et cafés à Gustavia sans site web',
      'fr',
      CATEGORIES,
    );
    expect(output.categoryIds.sort()).toEqual(['cafe', 'hair_salon']);
    expect(output.locationText).toBe('Gustavia');
    expect(output.filters.website).toBe('none');
    expect(output.mode).toBe('both');
    expect(output.confidence).toBeLessThan(0.5);
    expect(output.warnings[0]).toMatch(/^AI_UNAVAILABLE_FALLBACK/);
  });

  it('reads English ratings, reviews, email and phone', () => {
    const output = parseIntentFallback(
      'restaurants in Saint-Jean rated below 4 with fewer than 20 reviews, with an email and a phone',
      'en',
      CATEGORIES,
    );
    expect(output.categoryIds).toEqual(['restaurant']);
    expect(output.locationText).toBe('Saint-Jean');
    expect(output.filters).toMatchObject({ maxRating: 4, maxReviews: 19, hasEmail: true });
    const phone = parseIntentFallback('plumbers with a phone number', 'en', CATEGORIES);
    expect(phone.filters.hasPhone).toBe(true);
    expect(phone.locationText).toBeNull();
  });

  it('reads French ratings and review counts with decimal commas', () => {
    const output = parseIntentFallback(
      'boulangeries avec au moins 4,5 étoiles et plus de 50 avis',
      'fr',
      CATEGORIES,
    );
    expect(output.categoryIds).toEqual(['bakery']);
    expect(output.filters).toMatchObject({ minRating: 4.5, minReviews: 51 });
  });

  it('treats pipeline words as a listings query', () => {
    const output = parseIntentFallback('mes spas qualifiés ajoutés cette semaine', 'fr', CATEGORIES);
    expect(output).toMatchObject({ mode: 'listings', categoryIds: ['spa'] });
    expect(output.filters).toMatchObject({ pipelineStatuses: ['qualified'], addedWithinDays: 7 });
  });

  it('reads weak and present websites, verified emails, sort and limits', () => {
    expect(parseIntentFallback('spas with a slow website', 'en', CATEGORIES).filters.website).toBe('weak');
    expect(parseIntentFallback('spas avec un site', 'fr', CATEGORIES).filters.website).toBe('has');
    expect(parseIntentFallback('spas with a verified email', 'en', CATEGORIES).filters).toMatchObject({
      hasEmail: true,
      emailVerified: true,
    });
    expect(parseIntentFallback('beauty spas but no email', 'en', CATEGORIES).filters.hasEmail).toBe(false);
    expect(parseIntentFallback('best rated bakeries', 'en', CATEGORIES).sort).toEqual({
      field: 'rating',
      direction: 'desc',
    });
    expect(parseIntentFallback('find 50 cafés in Lorient', 'en', CATEGORIES).limit).toBe(50);
  });

  it.each([
    ['barbers in 1017 AB Amsterdam with no website', '1017 AB Amsterdam'],
    ['rooftop bars in 10001 rated below 4', '10001'],
    ['fleuristes dans le 75011', '75011'],
    ['villas à St Barth avec un e-mail', 'St Barth'],
    ['plombiers près de Saint-Jean', 'Saint-Jean'],
    ['cafés au Grand Cul-de-Sac', 'Grand Cul-de-Sac'],
    ['plumbers with a phone', null],
    ['cafés à la Rochelle', 'la Rochelle'],
    ['cafés à La Rochelle', 'La Rochelle'],
    ['bistros in the Marais', 'Marais'],
    ['bistrots dans le Marais', 'Marais'],
    ['Cafés In Gustavia', 'Gustavia'],
    ['Spas À Lorient', 'Lorient'],
    ['cafés in Gustavia Sans Site Web', 'Gustavia'],
    ['spas in St Barth With Email', 'St Barth'],
    ['Spas At Least 4 Stars In Gustavia', 'Gustavia'],
    ['spas with at least 4 stars in Gustavia', 'Gustavia'],
    ['find a Bakery in Lorient', 'Lorient'],
    ['find a Bakery', null],
    ['Spas In Gustavia\nWith Email', 'Gustavia'],
    ['spas in The Marais', 'Marais'],
    ['restaurants avec avis sur Google à Gustavia', 'Gustavia'],
    ['menus in English in Gustavia', 'Gustavia'],
  ])('extracts the location of %j', (prompt, expected) => {
    expect(extractLocation(prompt)).toBe(expected);
  });

  it('reads a bare "a" as a preposition only in French', () => {
    expect(extractLocation('boulangerie a Gustavia', 'fr')).toBe('Gustavia');
    expect(extractLocation('boulangerie a Gustavia', 'en')).toBeNull();
    expect(parseIntentFallback('boulangerie a Gustavia', 'fr', CATEGORIES).locationText).toBe('Gustavia');
  });

  it('does not read star counts as limits or longer numbers as ratings', () => {
    expect(parseIntentFallback('find 5 star hotels', 'en', CATEGORIES).limit).toBeNull();
    expect(parseIntentFallback('find 4.5 star spas', 'en', CATEGORIES).limit).toBeNull();
    expect(parseIntentFallback('trouve 5 étoiles spas', 'fr', CATEGORIES).limit).toBeNull();
    expect(parseIntentFallback('find 20 spas', 'en', CATEGORIES).limit).toBe(20);
    expect(parseIntentFallback('spas rated below 45', 'en', CATEGORIES).filters.maxRating).toBeNull();
    expect(parseIntentFallback('spas rated below 4.5', 'en', CATEGORIES).filters.maxRating).toBe(4.5);
  });

  it('reads a missing phone', () => {
    for (const prompt of [
      'plumbers without a phone',
      'plumbers with no phone number',
      'plombiers sans téléphone',
    ]) {
      expect(parseIntentFallback(prompt, 'en', CATEGORIES).filters.hasPhone).toBe(false);
    }
  });

  it('reads pipeline words only after a possessive', () => {
    const trade = parseIntentFallback('qualified plumbers in Lorient', 'en', CATEGORIES);
    expect(trade.filters.pipelineStatuses).toEqual([]);
    expect(trade.mode).toBe('both');
    const own = parseIntentFallback('our spas contacted last week', 'en', CATEGORIES);
    expect(own.filters.pipelineStatuses).toEqual(['contacted']);
    expect(own.mode).toBe('listings');
    expect(
      parseIntentFallback('contacted spas, not my problem', 'en', CATEGORIES).filters.pipelineStatuses,
    ).toEqual([]);
    expect(
      parseIntentFallback("my spas that won't reply", 'en', CATEGORIES).filters.pipelineStatuses,
    ).toEqual([]);
    expect(parseIntentFallback('Mes spas gagnés', 'fr', CATEGORIES).filters.pipelineStatuses).toEqual([
      'won',
    ]);
  });

  it('does not read place or business names as possessives', () => {
    expect(parseIntentFallback('restaurants près de Notre-Dame', 'fr', CATEGORIES).mode).toBe('both');
    expect(parseIntentFallback('Ma Cuisine restaurants in Lyon', 'en', CATEGORIES).mode).toBe('both');
  });
});

describe('post-processing', () => {
  const candidates = new Map<string, IntentCategory>(
    [
      ['restaurant', 'food_drink.restaurant'],
      ['pizzeria', 'food_drink.restaurant.pizzeria'],
      ['cafe', 'food_drink.cafe'],
    ].map(([slug, path], i) => [
      slug as string,
      { id: `01920000-0000-7000-8000-00000000000${i}`, slug: slug as string, path: path as string },
    ]),
  );

  it('keeps candidates only and collapses descendants into their ancestor', () => {
    const { categories, invalid } = groundCategories(
      ['pizzeria', 'restaurant', 'cafe', 'made_up', 'cafe'],
      candidates,
    );
    expect(categories.map((c) => c.slug)).toEqual(['restaurant', 'cafe']);
    expect(invalid).toBe(1);
  });

  it('clamps and orders numeric filters, implies email from a verified one', () => {
    const filters = cleanFilters({
      website: 'any',
      minRating: 4.84,
      maxRating: 2,
      minReviews: -3,
      maxReviews: null,
      hasEmail: false,
      hasPhone: null,
      emailVerified: true,
      languages: ['EN', 'english', 'fr', 'fr'],
      priceLevels: [4, 9, 1, 4],
      painSignals: ['booking_friction'],
      minScore: 140,
      tiers: ['A', 'A'],
      pipelineStatuses: ['qualified'],
      tags: [' vip ', 'vip', ''],
      addedWithinDays: 0,
    });
    expect(filters).toMatchObject({
      minRating: 2,
      maxRating: 4.8,
      minReviews: 0,
      hasEmail: true,
      emailVerified: true,
      languages: ['en', 'fr'],
      priceLevels: [1, 4],
      minScore: 100,
      tiers: ['A'],
      tags: ['vip'],
      addedWithinDays: 1,
      scoreProfile: null,
    });
  });

  it('treats a zero rating as no rating filter', () => {
    const base = cleanFilters({
      website: 'any',
      minRating: 0,
      maxRating: 0,
      minReviews: null,
      maxReviews: null,
      hasEmail: null,
      hasPhone: null,
      emailVerified: null,
      languages: [],
      priceLevels: [],
      painSignals: [],
      minScore: null,
      tiers: [],
      pipelineStatuses: [],
      tags: [],
      addedWithinDays: null,
    });
    expect(base).toMatchObject({ minRating: null, maxRating: null });
  });

  it('builds a valid intent and flags categories outside the candidates', () => {
    const output = parseIntentFallback('cafés à Gustavia', 'fr', [cat('cafe', 'Café', 'Café')]);
    const intent = toSearchIntent(
      {
        ...output,
        categoryIds: ['cafe', 'nightclub'],
        limit: 99_999,
        needsClarification: { question: '  Lequel ?  ', options: [] },
      } satisfies ParseSearchIntentOutput,
      { candidates, language: 'fr' },
    );
    expect(intent.categories).toEqual({ ids: [candidates.get('cafe')?.id], includeDescendants: true });
    expect(intent.location).toEqual({ text: 'Gustavia', resolution: null });
    expect(intent.limit).toBe(2_000);
    expect(intent.needsClarification).toEqual({ question: 'Lequel ?' });
    expect(intent.warnings[0]).toBe('CATEGORIES_OUTSIDE_CANDIDATES');
    expect(intent.language).toBe('fr');
  });
});
