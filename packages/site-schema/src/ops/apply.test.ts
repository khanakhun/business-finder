import { readFileSync } from 'node:fs';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { Block } from '../spec/blocks/index.ts';
import { type SiteSpec, SiteSpecSchema } from '../spec/site.ts';
import { apply, applyAll } from './apply.ts';
import { type Operation, OperationError, OperationSchema } from './operations.ts';

const load = (name: string): SiteSpec =>
  JSON.parse(readFileSync(new URL(`../../fixtures/${name}.json`, import.meta.url), 'utf8'));
const FIXTURES = ['salon-gustavia', 'cafe-saint-jean', 'hardware-store-lorient', 'villa-agency'] as const;
const L = (text: string) => ({ fr: text, en: text });
/** The element, or a failing test when it is not there. */
const at = <T>(value: T | undefined): T => {
  if (value === undefined) throw new Error('missing fixture element');
  return value;
};

const roundTrip = (spec: SiteSpec, operation: Operation) => {
  const done = apply(spec, operation);
  expect(SiteSpecSchema.safeParse(done.spec).success).toBe(true);
  expect(apply(done.spec, done.inverse).spec).toEqual(spec);
  return done.spec;
};

const ctaBanner = (id: string): Block => ({
  id,
  type: 'cta_banner',
  variant: 'solid',
  props: { title: L('Venez'), cta: { kind: 'call', label: L('Appeler') } },
});

describe('operations', () => {
  const salon = load('salon-gustavia');

  it.each<[string, Operation]>([
    [
      'addPage',
      {
        op: 'addPage',
        page: {
          ...structuredClone(at(salon.pages[1])),
          id: 'offers',
          slug: 'offres',
          blocks: [{ ...ctaBanner('cta-offer1') }],
        },
        index: 1,
      },
    ],
    ['removePage', { op: 'removePage', pageId: 'services' }],
    ['renamePage', { op: 'renamePage', pageId: 'services', title: L('Tarifs'), slug: 'tarifs' }],
    ['reorderPages', { op: 'reorderPages', order: ['home', 'contact', 'services'] }],
    ['addBlock', { op: 'addBlock', pageId: 'home', block: ctaBanner('cta-home9'), index: 1 }],
    ['removeBlock', { op: 'removeBlock', pageId: 'home', blockId: 'test-home1' }],
    ['moveBlock', { op: 'moveBlock', pageId: 'home', blockId: 'cta-home1', index: 0 }],
    [
      'moveBlock (to another page)',
      { op: 'moveBlock', pageId: 'home', blockId: 'cta-home1', toPageId: 'contact', index: 2 },
    ],
    [
      'updateBlockProps',
      {
        op: 'updateBlockProps',
        pageId: 'home',
        blockId: 'hero-home1',
        props: { title: { en: 'Hair in Gustavia' }, eyebrow: null },
      },
    ],
    ['setBlockVariant', { op: 'setBlockVariant', pageId: 'home', blockId: 'serv-home1', variant: 'list' }],
    ['setTheme', { op: 'setTheme', theme: { ...salon.theme, radius: 'full' } }],
    [
      'setContact',
      {
        op: 'setContact',
        contact: { ...salon.contact, whatsapp: { value: '+590690000101', factId: 'whatsapp.main' } },
      },
    ],
    ['setNavigation', { op: 'setNavigation', navigation: { items: salon.navigation.items.slice(0, 2) } }],
    [
      'updateText',
      { op: 'updateText', path: ['seo', 'title'], locale: 'en', value: 'Salon Lumière, St Barth' },
    ],
    [
      'updateText (removes)',
      { op: 'updateText', path: ['layout', 'footer', 'tagline'], locale: 'en', value: null },
    ],
    ['addAsset', { op: 'addAsset', asset: { ...at(salon.assets[1]), id: 'img-salon-2' } }],
    [
      'assignAsset',
      {
        op: 'assignAsset',
        path: ['pages', 0, 'blocks', 0, 'props', 'imageAssetId'],
        assetId: 'logo-lumiere',
      },
    ],
    ['assignAsset (clears)', { op: 'assignAsset', path: ['layout', 'header', 'logoAssetId'], assetId: null }],
  ])('%s applies and its inverse restores the site', (_name, operation) => {
    expect(OperationSchema.safeParse(operation).success).toBe(true);
    roundTrip(salon, operation);
  });

  it('merges props deeply and removes a prop given null', () => {
    const { spec } = apply(salon, {
      op: 'updateBlockProps',
      pageId: 'home',
      blockId: 'hero-home1',
      props: { title: { en: 'Hair in Gustavia' }, eyebrow: null },
    });
    const hero = spec.pages[0]?.blocks[0];
    expect(hero?.type === 'hero' && hero.props.title).toEqual({
      fr: 'Coiffure et soins à Gustavia',
      en: 'Hair in Gustavia',
    });
    expect(hero?.type === 'hero' && hero.props.eyebrow).toBeUndefined();
  });

  it('removes an unused asset back to its place', () => {
    const withExtra = apply(salon, {
      op: 'addAsset',
      asset: { ...at(salon.assets[1]), id: 'img-salon-2' },
      index: 0,
    }).spec;
    roundTrip(withExtra, { op: 'removeAsset', assetId: 'img-salon-2' });
  });

  it.each<[string, Operation, string]>([
    ['an unknown page', { op: 'removePage', pageId: 'nowhere' }, 'page_not_found'],
    ['an unknown block', { op: 'removeBlock', pageId: 'home', blockId: 'nope-1234' }, 'block_not_found'],
    ['a taken id', { op: 'addBlock', pageId: 'home', block: ctaBanner('hero-home1') }, 'duplicate_id'],
    ['an incomplete order', { op: 'reorderPages', order: ['home', 'contact'] }, 'invalid_order'],
    ['an asset in use', { op: 'removeAsset', assetId: 'img-salon-1' }, 'asset_in_use'],
    [
      'a missing asset',
      { op: 'assignAsset', path: ['layout', 'header', 'logoAssetId'], assetId: 'nope-1234' },
      'asset_not_found',
    ],
    [
      'a path to nothing',
      { op: 'updateText', path: ['pages', 9, 'title'], locale: 'en', value: 'x' },
      'invalid_path',
    ],
    [
      'a field that is not an asset',
      { op: 'assignAsset', path: ['brand', 'name'], assetId: null },
      'invalid_path',
    ],
    ['a page id that exists', { op: 'addPage', page: structuredClone(at(salon.pages[1])) }, 'duplicate_id'],
    [
      'a block id taken elsewhere',
      { op: 'addPage', page: { ...structuredClone(at(salon.pages[1])), id: 'offers', slug: 'offres' } },
      'duplicate_id',
    ],
    [
      'an asset id that exists',
      { op: 'addAsset', asset: structuredClone(at(salon.assets[0])) },
      'duplicate_id',
    ],
    [
      'a text path that ends in a value',
      { op: 'updateText', path: ['brand', 'name'], locale: 'en', value: 'x' },
      'invalid_path',
    ],
    [
      'a path through a value',
      { op: 'updateText', path: ['brand', 'name', 'en'], locale: 'en', value: 'x' },
      'invalid_path',
    ],
    [
      'a result the schema refuses',
      { op: 'setBlockVariant', pageId: 'home', blockId: 'hero-home1', variant: 'spiral' },
      'invalid_result',
    ],
  ])('refuses %s and changes nothing', (_name, operation, code) => {
    const before = structuredClone(salon);
    expect(() => apply(salon, operation)).toThrow(OperationError);
    try {
      apply(salon, operation);
    } catch (caught) {
      expect((caught as OperationError).code).toBe(code);
    }
    expect(salon).toEqual(before);
  });

  it('clears an entry of an asset list, and puts it back', () => {
    const cafe = load('cafe-saint-jean');
    const gallery = ['pages', 0, 'blocks', 1, 'props', 'assetIds', 2];
    const withFour = apply(cafe, { op: 'addAsset', asset: { ...at(cafe.assets[0]), id: 'img-cafe-4' } }).spec;
    const grown = apply(withFour, {
      op: 'updateBlockProps',
      pageId: 'home',
      blockId: 'gall-cafe1',
      props: { assetIds: ['img-cafe-1', 'img-cafe-2', 'img-cafe-3', 'img-cafe-4'] },
    }).spec;
    const done = apply(grown, { op: 'assignAsset', path: [...gallery.slice(0, -1), 3], assetId: null });
    const block = done.spec.pages[0]?.blocks[1];
    expect(block?.type === 'gallery' && block.props.assetIds).toEqual([
      'img-cafe-1',
      'img-cafe-2',
      'img-cafe-3',
    ]);
    expect(apply(done.spec, done.inverse).spec).toEqual(grown);
  });

  it('applies a batch all or nothing', () => {
    const ok = applyAll(salon, [
      { op: 'addBlock', pageId: 'home', block: ctaBanner('cta-home9') },
      { op: 'moveBlock', pageId: 'home', blockId: 'cta-home9', index: 1 },
    ]);
    expect(apply(ok.spec, ok.inverse).spec).toEqual(salon);
    expect(() =>
      applyAll(salon, [
        { op: 'addBlock', pageId: 'home', block: ctaBanner('cta-home9') },
        { op: 'removePage', pageId: 'nowhere' },
      ]),
    ).toThrow(OperationError);
  });
});

/** An operation for the current spec from three numbers (null when the pick does not fit). */
function pick(spec: SiteSpec, [kind, a, b]: readonly [number, number, number], n: number): Operation | null {
  const page = spec.pages[a % spec.pages.length];
  if (!page) return null;
  const block = page.blocks[b % page.blocks.length];
  switch (kind % 8) {
    case 0:
      return {
        op: 'addBlock',
        pageId: page.id,
        block: ctaBanner(`cta-prop${n}`),
        index: b % (page.blocks.length + 1),
      };
    case 1:
      return block && page.blocks.length > 1
        ? { op: 'removeBlock', pageId: page.id, blockId: block.id }
        : null;
    case 2:
      return block
        ? { op: 'moveBlock', pageId: page.id, blockId: block.id, index: a % page.blocks.length }
        : null;
    case 3:
      return {
        op: 'updateText',
        path: ['pages', spec.pages.indexOf(page), 'title'],
        locale: spec.locales[b % spec.locales.length] ?? 'fr',
        value: `Page ${n}`,
      };
    case 4:
      return {
        op: 'reorderPages',
        order: [...spec.pages.map((p) => p.id)].sort(() => (a % 2 === 0 ? 1 : -1)),
      };
    case 5:
      return block ? { op: 'updateBlockProps', pageId: page.id, blockId: block.id, props: {} } : null;
    case 6:
      return {
        op: 'setTheme',
        theme: { ...spec.theme, density: (['compact', 'comfortable', 'airy'] as const)[b % 3] ?? 'airy' },
      };
    default:
      return spec.pages.length > 1 && page.slug !== '' ? { op: 'removePage', pageId: page.id } : null;
  }
}

describe('operation properties', () => {
  it.each(FIXTURES)('undoes any sequence of operations on %s, staying valid', (name) => {
    const original = load(name);
    fc.assert(
      fc.property(fc.array(fc.tuple(fc.nat(), fc.nat(), fc.nat()), { maxLength: 12 }), (picks) => {
        let spec = original;
        const inverses: Operation[] = [];
        picks.forEach((choice, n) => {
          const operation = pick(spec, choice, n);
          if (!operation) return;
          try {
            const done = apply(spec, operation);
            spec = done.spec;
            inverses.unshift(done.inverse);
          } catch (caught) {
            if (!(caught instanceof OperationError)) throw caught;
          }
        });
        expect(SiteSpecSchema.safeParse(spec).success).toBe(true);
        for (const inverse of inverses) spec = apply(spec, inverse).spec;
        expect(spec).toEqual(original);
      }),
      { numRuns: 150, seed: 20261016 },
    );
  });
});
