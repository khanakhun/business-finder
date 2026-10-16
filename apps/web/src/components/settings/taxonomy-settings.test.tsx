import type { CategoryNode } from '@bf/contracts';
import { describe, expect, it } from 'vitest';
import { toPickerTree } from './taxonomy-settings.tsx';

const node = (slug: string, en: string, fr: string, children: CategoryNode[] = []): CategoryNode => ({
  id: `id-${slug}`,
  slug,
  path: slug,
  label: fr,
  labels: { en, fr },
  icon: null,
  attributes: {},
  children,
});

describe('toPickerTree', () => {
  it('keeps the tree and adds the other language and the slug as search keywords', () => {
    const tree = [
      node('retail_shopping', 'Shops', 'Commerces', [
        node('hardware_store', 'Hardware store', 'Quincaillerie'),
      ]),
    ];
    expect(toPickerTree(tree, 'fr')).toEqual([
      {
        id: 'id-retail_shopping',
        label: 'Commerces',
        keywords: ['Shops', 'retail shopping'],
        children: [
          {
            id: 'id-hardware_store',
            label: 'Quincaillerie',
            keywords: ['Hardware store', 'hardware store'],
            children: [],
          },
        ],
      },
    ]);
  });
});
