import { describe, expect, it } from 'vitest';
import { composeEmbeddingText, type EmbeddingSource } from './embedding-text.ts';

const source: EmbeddingSource = {
  id: '0192a1b2-0000-7000-8000-000000000001',
  displayName: '  Pizzeria   Lulu ',
  categories: [
    {
      slug: 'wine_bar',
      isPrimary: false,
      labels: [
        { en: 'Bar', fr: 'Bar' },
        { en: 'Wine bar', fr: 'Bar à vin' },
      ],
    },
    {
      slug: 'pizzeria',
      isPrimary: true,
      labels: [
        { en: 'Food & drink', fr: 'Restauration' },
        { en: 'Restaurant', fr: 'Restaurant' },
        { en: 'Pizzeria', fr: 'Pizzeria' },
      ],
    },
  ],
  locality: 'Lorient',
  countryCode: 'BL',
  shortDescription: 'Wood-fired pizzas\nby the beach.',
  priceLevel: 2,
};

describe('composeEmbeddingText', () => {
  it('writes name, categories (primary first, EN / FR paths), place, description and price', () => {
    expect(composeEmbeddingText(source)).toBe(
      [
        'Pizzeria Lulu',
        'Categories: Food & drink > Restaurant > Pizzeria / Restauration > Restaurant > Pizzeria; Bar > Wine bar / Bar > Bar à vin',
        'Location: Lorient, BL',
        'Wood-fired pizzas by the beach.',
        'Price: moderate',
      ].join('\n'),
    );
  });

  it('is deterministic whatever the category order, and skips missing facts', () => {
    const reversed = { ...source, categories: [...source.categories].reverse() };
    expect(composeEmbeddingText(reversed)).toBe(composeEmbeddingText(source));
    expect(
      composeEmbeddingText({
        ...source,
        categories: [],
        locality: null,
        countryCode: null,
        shortDescription: null,
        priceLevel: null,
      }),
    ).toBe('Pizzeria Lulu');
  });
});
