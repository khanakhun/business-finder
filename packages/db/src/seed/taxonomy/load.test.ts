import { describe, expect, it } from 'vitest';
import { parseTaxonomy, TaxonomyFileError } from './load.ts';

const TREE = `
version: 2
categories:
  - slug: food_drink
    labels: { en: Food & drink, fr: Restauration }
    icon: tools-kitchen-2
    attributes: { hospitality: true }
    offerRelevance: { new_website: 0.8, booking_system: 0.5 }
    children:
      - slug: cafe
        labels: { en: Café, fr: Café }
        synonyms: { en: [coffee shop], fr: [salon de thé] }
        icon: coffee
      - slug: restaurant
        labels: { en: Restaurant, fr: Restaurant }
        offerRelevance: { booking_system: 0.9 }
        attributes: { appointmentBased: true }
        children:
          - slug: seafood_restaurant
            labels: { en: Seafood restaurant, fr: Restaurant de fruits de mer }
  - slug: retail
    labels: { en: Shops, fr: Commerces }
`;

const MAPPINGS = `
provider: google_places
version: 1
mappings:
  - { key: cafe, category: cafe }
  - { key: seafood_restaurant, category: seafood_restaurant, confidence: 0.9 }
`;

const file = (name: string, text: string) => ({ name, text });

describe('parseTaxonomy', () => {
  it('flattens the tree parents first with paths, inheritance and sort order', () => {
    const taxonomy = parseTaxonomy(file('taxonomy.v2.yaml', TREE), [file('google_places.v1.yaml', MAPPINGS)]);
    expect(taxonomy.version).toBe(2);
    expect(taxonomy.categories.map((c) => c.path)).toEqual([
      'food_drink',
      'food_drink.cafe',
      'food_drink.restaurant',
      'food_drink.restaurant.seafood_restaurant',
      'retail',
    ]);
    const seafood = taxonomy.categories.find((c) => c.slug === 'seafood_restaurant');
    expect(seafood).toMatchObject({
      parentSlug: 'restaurant',
      icon: 'tools-kitchen-2',
      attributes: { hospitality: true, appointmentBased: true },
      offerRelevance: { new_website: 0.8, booking_system: 0.9 },
      synonyms: { en: [], fr: [] },
      sortOrder: 0,
    });
    expect(taxonomy.categories.find((c) => c.slug === 'restaurant')?.sortOrder).toBe(1);
    expect(taxonomy.mappings).toEqual([
      { provider: 'google_places', key: 'cafe', label: null, category: 'cafe', confidence: 0.95 },
      {
        provider: 'google_places',
        key: 'seafood_restaurant',
        label: null,
        category: 'seafood_restaurant',
        confidence: 0.9,
      },
    ]);
  });

  it.each([
    ['a duplicate slug', TREE.replace('slug: retail', 'slug: cafe'), /duplicate slug cafe/],
    ['a missing French label', TREE.replace('{ en: Shops, fr: Commerces }', '{ en: Shops }'), /labels\.fr/],
    ['a bad slug', TREE.replace('slug: retail', 'slug: Retail-Shops'), /snake_case/],
    ['an unknown field', TREE.replace('icon: coffee', 'icone: coffee'), /Unrecognized key/],
    [
      'a tree deeper than 4 levels',
      TREE.replace(
        '            labels: { en: Seafood restaurant, fr: Restaurant de fruits de mer }',
        `            labels: { en: Seafood restaurant, fr: Restaurant de fruits de mer }
            children:
              - slug: oyster_bar
                labels: { en: Oyster bar, fr: Bar à huîtres }
                children:
                  - slug: too_deep
                    labels: { en: Too deep, fr: Trop profond }`,
      ),
      /deeper than 4/,
    ],
  ])('rejects %s', (_name, text, message) => {
    expect(() => parseTaxonomy(file('taxonomy.v2.yaml', text), [])).toThrow(message);
  });

  it('rejects mappings to unknown categories and duplicate keys', () => {
    const tree = file('taxonomy.v2.yaml', TREE);
    expect(() =>
      parseTaxonomy(tree, [
        file('osm.v1.yaml', 'provider: osm\nversion: 1\nmappings: [{ key: shop=x, category: nope }]'),
      ]),
    ).toThrow(TaxonomyFileError);
    expect(() =>
      parseTaxonomy(tree, [
        file(
          'osm.v1.yaml',
          'provider: osm\nversion: 1\nmappings: [{ key: amenity=cafe, category: cafe }, { key: amenity=cafe, category: cafe }]',
        ),
      ]),
    ).toThrow(/duplicate key amenity=cafe/);
  });
});
