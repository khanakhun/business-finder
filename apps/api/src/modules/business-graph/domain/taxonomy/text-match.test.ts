import { describe, expect, it } from 'vitest';
import { buildSynonymIndex, matchSynonyms, normalizeText, stem, tokens } from './text-match.ts';

const index = buildSynonymIndex([
  { slug: 'hardware_store', phrases: ['Hardware store', 'Quincaillerie', 'ironmonger', 'droguerie'] },
  { slug: 'hair_salon', phrases: ['Hair salon', 'Salon de coiffure', 'coiffeur', 'hairdresser'] },
  { slug: 'beauty_salon', phrases: ['Beauty salon', 'Institut de beauté', 'esthéticienne'] },
  { slug: 'pharmacy', phrases: ['Pharmacy', 'Pharmacie', 'drugstore'] },
  { slug: 'jewelry_store', phrases: ['Jewelry store', 'Bijouterie', 'bijoux'] },
  { slug: 'spa', phrases: ['Spa', 'day spa'] },
  { slug: 'bar', phrases: ['Bar', 'Le', 'de la'] },
]);

describe('normalization', () => {
  it('folds case, accents and punctuation, and FR/EN plurals', () => {
    expect(normalizeText("L'Épicerie-Fine & Co")).toBe('l epicerie fine and co');
    expect(['salons', 'pharmacies', 'bijoux', 'chevaux', 'glass', 'bus', 'press'].map(stem)).toEqual([
      'salon',
      'pharmacie',
      'bijou',
      'cheval',
      'glass',
      'bus',
      'press',
    ]);
    expect(tokens('Coiffeurs  Réunis')).toEqual(['coiffeur', 'reuni']);
    expect(stem('pharmacy')).toBe(stem('pharmacies'));
    expect(['bureaux', 'gateaux', 'taxis', 'tennis', 'devis'].map(stem)).toEqual([
      'bureau',
      'gateau',
      'taxi',
      'tennis',
      'devis',
    ]);
  });
});

describe('matchSynonyms', () => {
  it.each([
    ['Quincaillerie du Port', 'hardware_store'],
    ['QUINCAILLERIES SBH', 'hardware_store'],
    ['Salon de Coiffure Karine', 'hair_salon'],
    ['Les Coiffeurs de Gustavia', 'hair_salon'],
    ['Institut de Beauté Lagon', 'beauty_salon'],
    ['Pharmacie de l’Aéroport', 'pharmacy'],
    ['Bijoux Créoles', 'jewelry_store'],
  ])('%s → %s', (name, slug) => {
    expect(matchSynonyms(index, [name])[0]?.slug).toBe(slug);
  });

  it('prefers multi-word phrases and ignores stopword-only phrases', () => {
    const matches = matchSynonyms(index, ['Le Day Spa', 'Bar de la Plage']);
    expect(matches.map((m) => m.slug)).toEqual(['spa', 'bar']);
    expect(matches[0]?.score).toBeGreaterThan(matches[1]?.score ?? 1);
    expect(matchSynonyms(index, ['Chez Jo'])).toEqual([]);
  });

  it('matches whole words only', () => {
    expect(matchSynonyms(index, ['Barbara Boutique', 'Spartan Gym'])).toEqual([]);
  });

  it('searches every text and keeps the best score per category', () => {
    const matches = matchSynonyms(index, ['Le Comptoir', 'Hardware store']);
    expect(matches).toEqual([expect.objectContaining({ slug: 'hardware_store', phrase: 'hardware store' })]);
  });
});
