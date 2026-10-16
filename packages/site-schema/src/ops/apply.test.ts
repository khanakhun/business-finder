import { readFileSync } from 'node:fs';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { Block } from '../spec/blocks/index.ts';
import { type SiteSpec, SiteSpecSchema } from '../spec/site.ts';
import { FactRegistrySchema } from '../validate/facts.ts';
import { apply, applyAll, applyAndValidate } from './apply.ts';
import {
  type BaseOperation,
  MAX_BATCH,
  type Operation,
  OperationError,
  OperationSchema,
} from './operations.ts';

const load = (name: string): SiteSpec =>
  JSON.parse(readFileSync(new URL(`../../fixtures/${name}.json`, import.meta.url), 'utf8'));
const salonFacts = FactRegistrySchema.parse(
  JSON.parse(readFileSync(new URL('../../fixtures/facts/salon-gustavia.json', import.meta.url), 'utf8')),
);
const FIXTURES = ['salon-gustavia', 'cafe-saint-jean', 'hardware-store-lorient', 'villa-agency'] as const;
const L = (text: string) => ({ fr: text, en: text });
const at = <T>(value: T | undefined): T => {
  if (value === undefined) throw new Error('missing fixture element');
  return value;
};

/** Applied, valid, and undone exactly by its inverse (which also survives the wire). */
const roundTrip = (spec: SiteSpec, operation: Operation) => {
  const done = apply(spec, operation);
  expect(SiteSpecSchema.safeParse(done.spec).success).toBe(true);
  const inverse = OperationSchema.parse(JSON.parse(JSON.stringify(done.inverse)));
  expect(apply(done.spec, inverse).spec).toStrictEqual(spec);
  return done.spec;
};

const ctaBanner = (id: string): Block => ({
  id,
  type: 'cta_banner',
  variant: 'solid',
  props: { title: L('Venez'), cta: { kind: 'call', label: L('Appeler') } },
});

const errorCode = (run: () => unknown) => {
  try {
    run();
  } catch (caught) {
    return caught instanceof OperationError ? caught.code : `not an OperationError: ${String(caught)}`;
  }
  return null;
};

describe('operations', () => {
  const salon = load('salon-gustavia');
  const cafe = load('cafe-saint-jean');

  it.each<[string, SiteSpec, Operation]>([
    [
      'addPage',
      salon,
      {
        op: 'addPage',
        page: {
          ...structuredClone(at(salon.pages[1])),
          id: 'offers',
          slug: 'offres',
          blocks: [ctaBanner('cta-offer1')],
        },
        index: 1,
      },
    ],
    [
      'addPage (with a new menu)',
      salon,
      {
        op: 'addPage',
        page: {
          ...structuredClone(at(salon.pages[1])),
          id: 'offers',
          slug: 'offres',
          blocks: [ctaBanner('cta-offer2')],
        },
        navigation: {
          items: [{ pageId: 'offers', label: L('Offres') }, ...[...salon.navigation.items].reverse()],
        },
      },
    ],
    ['removePage (and its menu item)', salon, { op: 'removePage', pageId: 'services' }],
    [
      'removePage (with the menu given)',
      salon,
      {
        op: 'removePage',
        pageId: 'services',
        navigation: { items: salon.navigation.items.filter((item) => item.pageId !== 'services').reverse() },
      },
    ],
    ['renamePage', salon, { op: 'renamePage', pageId: 'services', title: L('Tarifs'), slug: 'tarifs' }],
    ['reorderPages', salon, { op: 'reorderPages', order: ['home', 'contact', 'services'] }],
    ['addBlock', salon, { op: 'addBlock', pageId: 'home', block: ctaBanner('cta-home9'), index: 1 }],
    ['removeBlock', salon, { op: 'removeBlock', pageId: 'home', blockId: 'test-home1' }],
    ['moveBlock', salon, { op: 'moveBlock', pageId: 'home', blockId: 'cta-home1', index: 0 }],
    [
      'moveBlock (to another page)',
      salon,
      { op: 'moveBlock', pageId: 'home', blockId: 'cta-home1', toPageId: 'contact', index: 2 },
    ],
    [
      'updateBlockProps',
      salon,
      {
        op: 'updateBlockProps',
        pageId: 'home',
        blockId: 'hero-home1',
        props: { title: { en: 'Hair in Gustavia' }, eyebrow: null },
      },
    ],
    [
      'setBlockVariant',
      salon,
      { op: 'setBlockVariant', pageId: 'home', blockId: 'serv-home1', variant: 'list' },
    ],
    ['setTheme', salon, { op: 'setTheme', theme: { ...salon.theme, radius: 'full' } }],
    [
      'setContact',
      salon,
      {
        op: 'setContact',
        contact: { ...salon.contact, whatsapp: { value: '+590690000101', factId: 'whatsapp.main' } },
      },
    ],
    [
      'setNavigation',
      salon,
      { op: 'setNavigation', navigation: { items: salon.navigation.items.slice(0, 2) } },
    ],
    [
      'setLayout',
      salon,
      {
        op: 'setLayout',
        layout: { ...salon.layout, footer: { ...salon.layout.footer, variant: 'simple', showHours: false } },
      },
    ],
    [
      'setSettings',
      salon,
      { op: 'setSettings', settings: { ...salon.settings, contactForm: { enabled: false } } },
    ],
    ['setLocales (adds)', salon, { op: 'setLocales', locales: ['fr', 'en', 'de'], defaultLocale: 'fr' }],
    ['setLocales (removes, texts too)', salon, { op: 'setLocales', locales: ['fr'], defaultLocale: 'fr' }],
    ['setLocales (default)', salon, { op: 'setLocales', locales: ['fr', 'en'], defaultLocale: 'en' }],
    [
      'updateText',
      salon,
      { op: 'updateText', path: ['seo', 'title'], locale: 'en', value: 'Salon Lumière, St Barth' },
    ],
    [
      'updateText (removes)',
      salon,
      { op: 'updateText', path: ['layout', 'footer', 'tagline'], locale: 'en', value: null },
    ],
    ['addAsset', salon, { op: 'addAsset', asset: { ...at(salon.assets[1]), id: 'img-salon-2' }, index: 0 }],
    [
      'assignAsset',
      salon,
      {
        op: 'assignAsset',
        path: ['pages', 0, 'blocks', 0, 'props', 'imageAssetId'],
        assetId: 'logo-lumiere',
      },
    ],
    [
      'assignAsset (clears)',
      salon,
      { op: 'assignAsset', path: ['layout', 'header', 'logoAssetId'], assetId: null },
    ],
    [
      'insertAssetRef (mid-list)',
      cafe,
      {
        op: 'insertAssetRef',
        path: ['pages', 0, 'blocks', 1, 'props', 'assetIds'],
        index: 1,
        assetId: 'img-cafe-3',
      },
    ],
    [
      'removeAssetRef (mid-list)',
      load('villa-agency'),
      { op: 'removeAssetRef', path: ['pages', 0, 'blocks', 1, 'props', 'assetIds'], index: 1 },
    ],
    [
      'a batch',
      salon,
      {
        op: 'batch',
        ops: [
          { op: 'addBlock', pageId: 'home', block: ctaBanner('cta-home9') },
          { op: 'removePage', pageId: 'services' },
        ],
      },
    ],
  ])('%s applies and its inverse restores the site exactly', (_name, spec, operation) => {
    expect(OperationSchema.safeParse(operation).success).toBe(true);
    roundTrip(spec, operation);
  });

  it('removes a language with its texts, and refuses what would leave a text in no language', () => {
    const salon = load('salon-gustavia');
    const french = apply(salon, { op: 'setLocales', locales: ['fr'], defaultLocale: 'fr' }).spec;
    expect(french.locales).toEqual(['fr']);
    expect(JSON.stringify(french)).not.toMatch(/"en":/);
    expect(() => apply(salon, { op: 'setLocales', locales: ['en', 'en'], defaultLocale: 'en' })).toThrow(
      expect.objectContaining({ code: 'invalid_order' }),
    );
    expect(() => apply(salon, { op: 'setLocales', locales: ['fr'], defaultLocale: 'en' })).toThrow(
      expect.objectContaining({ code: 'invalid_order' }),
    );
    const onlyEnglish = apply(salon, {
      op: 'updateText',
      path: ['seo', 'title'],
      locale: 'fr',
      value: null,
    }).spec;
    expect(() => apply(onlyEnglish, { op: 'setLocales', locales: ['fr'], defaultLocale: 'fr' })).toThrow(
      expect.objectContaining({ code: 'invalid_result' }),
    );
  });

  it('merges props deeply, replaces arrays and removes a prop given null', () => {
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

  it('returns what the schema stores (trimmed texts)', () => {
    const { spec } = apply(salon, {
      op: 'updateText',
      path: ['seo', 'title'],
      locale: 'en',
      value: '   Salon Lumière, St Barth   ',
    });
    expect(spec.seo.title.en).toBe('Salon Lumière, St Barth');
  });

  it.each<[string, SiteSpec, Operation, string]>([
    ['an unknown page', salon, { op: 'removePage', pageId: 'nowhere' }, 'page_not_found'],
    ['a page still opened by an action', cafe, { op: 'removePage', pageId: 'menu' }, 'page_in_use'],
    [
      'a page the given menu still opens',
      salon,
      { op: 'removePage', pageId: 'services', navigation: salon.navigation },
      'page_in_use',
    ],
    [
      'an unknown block',
      salon,
      { op: 'removeBlock', pageId: 'home', blockId: 'nope-1234' },
      'block_not_found',
    ],
    ['a taken id', salon, { op: 'addBlock', pageId: 'home', block: ctaBanner('hero-home1') }, 'duplicate_id'],
    [
      'a page id that exists',
      salon,
      { op: 'addPage', page: structuredClone(at(salon.pages[1])) },
      'duplicate_id',
    ],
    [
      'a block id taken elsewhere',
      salon,
      { op: 'addPage', page: { ...structuredClone(at(salon.pages[1])), id: 'offers', slug: 'offres' } },
      'duplicate_id',
    ],
    [
      'an asset id that exists',
      salon,
      { op: 'addAsset', asset: structuredClone(at(salon.assets[0])) },
      'duplicate_id',
    ],
    ['an incomplete order', salon, { op: 'reorderPages', order: ['home', 'contact'] }, 'invalid_order'],
    ['an asset in use', salon, { op: 'removeAsset', assetId: 'img-salon-1' }, 'asset_in_use'],
    [
      'a missing asset',
      salon,
      { op: 'assignAsset', path: ['layout', 'header', 'logoAssetId'], assetId: 'nope-1234' },
      'asset_not_found',
    ],
    [
      'a path to nothing',
      salon,
      { op: 'updateText', path: ['pages', 9, 'title'], locale: 'en', value: 'x' },
      'invalid_path',
    ],
    [
      'a text path that ends in a value',
      salon,
      { op: 'updateText', path: ['brand', 'name'], locale: 'en', value: 'x' },
      'invalid_path',
    ],
    [
      'a text path to an object that is not a text',
      salon,
      { op: 'updateText', path: ['pages', 0, 'blocks', 0, 'props'], locale: 'en', value: 'x' },
      'invalid_path',
    ],
    [
      'a field that is not an asset',
      salon,
      { op: 'assignAsset', path: ['brand', 'name'], assetId: null },
      'invalid_path',
    ],
    [
      'an asset list entry past its end',
      cafe,
      { op: 'removeAssetRef', path: ['pages', 0, 'blocks', 1, 'props', 'assetIds'], index: 9 },
      'invalid_path',
    ],
    [
      'an asset list that is not one',
      salon,
      { op: 'removeAssetRef', path: ['pages', 0, 'blocks'], index: 0 },
      'invalid_path',
    ],
    [
      'a result the schema refuses',
      salon,
      { op: 'setBlockVariant', pageId: 'home', blockId: 'hero-home1', variant: 'spiral' },
      'invalid_result',
    ],
  ])('refuses %s and changes nothing', (_name, spec, operation, code) => {
    const before = structuredClone(spec);
    expect(errorCode(() => apply(spec, operation))).toBe(code);
    expect(spec).toStrictEqual(before);
  });

  it.each([
    { op: 'updateText', path: ['__proto__'], locale: 'en', value: 'PWNED' },
    { op: 'updateText', path: ['pages', 0, 'title', '__proto__'], locale: 'fr', value: 'PWNED' },
    { op: 'updateText', path: ['constructor', 'prototype'], locale: 'en', value: 'PWNED' },
    { op: 'assignAsset', path: ['__proto__', 'logoAssetId'], assetId: 'img-salon-1' },
    { op: 'insertAssetRef', path: ['__proto__', 'assetIds'], index: 0, assetId: 'img-salon-1' },
  ] as const)('never reaches a prototype: %j', (operation) => {
    expect(OperationSchema.safeParse(operation).success).toBe(false);
    // Even past the schema, the paths name own fields only.
    expect(errorCode(() => apply(salon, operation as unknown as Operation))).toBe('invalid_path');
    const probe = {} as Record<string, unknown>;
    expect(probe.en).toBeUndefined();
    expect(probe.fr).toBeUndefined();
    expect(probe.logoAssetId).toBeUndefined();
  });

  it('removes a page that only links to itself, and undoes it in one operation', () => {
    const selfLinked = apply(salon, {
      op: 'addBlock',
      pageId: 'services',
      block: {
        id: 'cta-self1',
        type: 'cta_banner',
        variant: 'solid',
        props: { title: L('Haut'), cta: { kind: 'page', label: L('Haut'), pageId: 'services' } },
      },
    }).spec;
    const done = apply(selfLinked, { op: 'removePage', pageId: 'services' });
    expect(done.inverse).toMatchObject({ op: 'addPage', navigation: selfLinked.navigation });
    expect(apply(done.spec, done.inverse).spec).toStrictEqual(selfLinked);
  });

  it('undoes a full batch with an inverse that is a valid batch', () => {
    const page = (n: number) => ({
      ...structuredClone(at(salon.pages[1])),
      id: `bulk-${n}`,
      slug: `bulk-${n}`,
      blocks: [ctaBanner(`cta-bulk${n}`)],
    });
    const ops: BaseOperation[] = Array.from({ length: MAX_BATCH / 2 }, (_, n) => [
      { op: 'addPage', page: page(n) } as const,
      { op: 'removePage', pageId: `bulk-${n}` } as const,
    ]).flat();
    const done = applyAll(salon, ops);
    expect(OperationSchema.safeParse(done.inverse).success).toBe(true);
    expect(apply(done.spec, done.inverse).spec).toStrictEqual(salon);
  });

  it('keeps batches flat and bounded', () => {
    const one: BaseOperation = {
      op: 'updateText',
      path: ['seo', 'title'],
      locale: 'en',
      value: 'Salon Lumière, St Barth',
    };
    expect(OperationSchema.safeParse({ op: 'batch', ops: [{ op: 'batch', ops: [one] }] }).success).toBe(
      false,
    );
    expect(OperationSchema.safeParse({ op: 'batch', ops: Array(MAX_BATCH + 1).fill(one) }).success).toBe(
      false,
    );
    expect(errorCode(() => apply(salon, { op: 'batch', ops: Array(MAX_BATCH + 1).fill(one) }))).toBe(
      'too_many',
    );
    expect(apply(salon, { op: 'batch', ops: [] }).spec).toStrictEqual(salon);
  });

  it('applies a batch all or nothing', () => {
    const ok = applyAll(salon, [
      { op: 'addBlock', pageId: 'home', block: ctaBanner('cta-home9') },
      { op: 'moveBlock', pageId: 'home', blockId: 'cta-home9', index: 1 },
    ]);
    expect(apply(ok.spec, ok.inverse).spec).toStrictEqual(salon);
    expect(
      errorCode(() =>
        applyAll(salon, [
          { op: 'addBlock', pageId: 'home', block: ctaBanner('cta-home9') },
          { op: 'removePage', pageId: 'nowhere' },
        ]),
      ),
    ).toBe('page_not_found');
  });

  it('applies and validates in one call (the editor, chat and sitekit entry point)', () => {
    const { issues } = applyAndValidate(
      salon,
      { op: 'updateText', path: ['seo', 'title'], locale: 'en', value: 'Visit www.evil.example now' },
      { assetHosts: ['assets.bf-sites.test'], registry: salonFacts },
    );
    expect(issues.map((issue) => issue.code)).toContain('external_url');
    // The facts validator runs too: an invented e-mail is refused (the address scan leaves e-mails to it).
    const email = applyAndValidate(
      salon,
      { op: 'updateText', path: ['seo', 'title'], locale: 'en', value: 'Write to evil.com@a.bc' },
      { assetHosts: ['assets.bf-sites.test'], registry: salonFacts },
    );
    expect(email.issues.map((issue) => issue.code)).toContain('unsupported_literal');
  });

  it('points at the menu item that still opens a page being removed', () => {
    const index = salon.navigation.items.findIndex((item) => item.pageId === 'services');
    try {
      apply(salon, { op: 'removePage', pageId: 'services', navigation: salon.navigation });
      expect.unreachable();
    } catch (error) {
      expect((error as OperationError).details).toEqual([
        { path: ['navigation', 'items', index, 'pageId'], message: 'opens this page' },
      ]);
    }
  });
});

/** Every kind of operation, built for the current spec from a few numbers (null when the pick does not fit). */
function pick(spec: SiteSpec, [kind, a, b]: readonly [number, number, number], n: number): Operation | null {
  const pageIndex = a % spec.pages.length;
  const page = spec.pages[pageIndex];
  if (!page) return null;
  const blockIndex = b % page.blocks.length;
  const block = page.blocks[blockIndex];
  const other = spec.pages[(a + 1) % spec.pages.length];
  const locale = spec.locales[b % spec.locales.length] ?? 'fr';
  const gallery = spec.pages.flatMap((p, i) =>
    p.blocks.flatMap((g, j) => (g.type === 'gallery' ? [{ i, j, ids: g.props.assetIds }] : [])),
  )[0];
  const image = spec.assets.find((asset) => asset.kind === 'image');
  switch (kind % 24) {
    case 0:
      return {
        op: 'addBlock',
        pageId: page.id,
        block: ctaBanner(`cta-prop${n}`),
        index: b % (page.blocks.length + 1),
      };
    case 1:
      return block && page.blocks.length > 1 && blockIndex > 0
        ? { op: 'removeBlock', pageId: page.id, blockId: block.id }
        : null;
    case 2:
      return block && blockIndex > 0
        ? { op: 'moveBlock', pageId: page.id, blockId: block.id, index: 1 + (a % page.blocks.length) }
        : null;
    case 3:
      return block && other && blockIndex > 0 && other.id !== page.id
        ? { op: 'moveBlock', pageId: page.id, blockId: block.id, toPageId: other.id, index: 1 }
        : null;
    case 4:
      return { op: 'updateText', path: ['pages', pageIndex, 'title'], locale, value: `Page ${n}` };
    case 5:
      return {
        op: 'updateText',
        path: ['seo', 'title'],
        locale,
        value: b % 3 === 0 ? null : `Titre ${n} du site`,
      };
    case 6: {
      const order = spec.pages.map((p) => p.id);
      const k = a % order.length;
      return { op: 'reorderPages', order: [...order.slice(k), ...order.slice(0, k)] };
    }
    case 7:
      return block?.type === 'hero'
        ? {
            op: 'updateBlockProps',
            pageId: page.id,
            blockId: block.id,
            props: { title: { [locale]: `Titre ${n}` }, eyebrow: b % 2 === 0 ? null : L(`Lieu ${n}`) },
          }
        : null;
    case 8:
      return block
        ? {
            op: 'setBlockProps',
            pageId: page.id,
            blockId: block.id,
            props: structuredClone(block.props) as Record<string, unknown>,
          }
        : null;
    case 9:
      return block?.type === 'cta_banner'
        ? {
            op: 'setBlockVariant',
            pageId: page.id,
            blockId: block.id,
            variant: ['solid', 'outline'][b % 2] ?? 'solid',
          }
        : null;
    case 10:
      return {
        op: 'setTheme',
        theme: { ...spec.theme, density: (['compact', 'comfortable', 'airy'] as const)[b % 3] ?? 'airy' },
      };
    case 11:
      return {
        op: 'setNavigation',
        navigation: {
          items: spec.navigation.items.slice(0, 1 + (a % Math.max(1, spec.navigation.items.length))),
        },
      };
    case 12:
      return {
        op: 'setLayout',
        layout: {
          ...spec.layout,
          footer: { ...spec.layout.footer, variant: b % 2 === 0 ? 'simple' : 'columns' },
        },
      };
    case 13:
      return {
        op: 'renamePage',
        pageId: page.id,
        title: L(`Nom ${n}`),
        ...(page.slug !== '' ? { slug: `page-${n}` } : {}),
      };
    case 14:
      return {
        op: 'addPage',
        page: {
          id: `prop-${n}`,
          slug: `prop-${n}`,
          title: L('Prop'),
          seo: { title: L('Prop page of the site'), description: L('x'.repeat(130)) },
          blocks: [{ id: `hero-prop${n}`, type: 'hero', variant: 'minimal', props: { title: L('Prop') } }],
        },
        index: a % (spec.pages.length + 1),
        // Sometimes with a new menu (reversed, the new page first): its inverse must restore the old one.
        ...(b % 2 === 0
          ? {
              navigation: {
                items: [
                  { pageId: `prop-${n}`, label: L('Prop') },
                  ...[...spec.navigation.items].reverse(),
                ].slice(0, 7),
              },
            }
          : {}),
      };
    case 15:
      return image
        ? { op: 'addAsset', asset: { ...image, id: `img-prop${n}` }, index: a % (spec.assets.length + 1) }
        : null;
    case 16:
      return gallery && image
        ? {
            op: 'insertAssetRef',
            path: ['pages', gallery.i, 'blocks', gallery.j, 'props', 'assetIds'],
            index: a % (gallery.ids.length + 1),
            assetId: image.id,
          }
        : null;
    case 17:
      return gallery && gallery.ids.length > 3
        ? {
            op: 'removeAssetRef',
            path: ['pages', gallery.i, 'blocks', gallery.j, 'props', 'assetIds'],
            index: a % gallery.ids.length,
          }
        : null;
    case 18: {
      const added = spec.pages.find((p) => p.id.startsWith('prop-'));
      return added ? { op: 'removePage', pageId: added.id } : null;
    }
    case 19: {
      const added = spec.assets.find((asset) => asset.id.startsWith('img-prop'));
      return added ? { op: 'removeAsset', assetId: added.id } : null;
    }
    case 20: {
      const logo = spec.assets.find((asset) => asset.kind === 'logo');
      return {
        op: 'assignAsset',
        path: ['layout', 'header', 'logoAssetId'],
        assetId: logo && b % 2 === 0 ? logo.id : null,
      };
    }
    case 21:
      return { op: 'setContact', contact: { ...spec.contact } };
    case 22:
      return {
        op: 'setSettings',
        settings: { ...spec.settings, analytics: b % 2 === 0 ? 'none' : 'cookieless' },
      };
    default: {
      // A small batch of the simple edits above.
      const ops = [4, 5, 10, 12].slice(0, 2 + (a % 3)).flatMap((k) => {
        const one = pick(spec, [k, a, b], n);
        return one && one.op !== 'batch' ? [one] : [];
      });
      return ops.length > 0 ? { op: 'batch', ops } : null;
    }
  }
}

describe('operation properties', () => {
  it.each(FIXTURES)(
    'undoes any sequence of operations on %s exactly, staying valid',
    (name) => {
      const original = load(name);
      let applied = 0;
      fc.assert(
        fc.property(
          fc.array(fc.tuple(fc.nat(), fc.nat(), fc.nat()), { minLength: 1, maxLength: 12 }),
          (picks) => {
            let spec = original;
            const inverses: Operation[] = [];
            picks.forEach((choice, n) => {
              const operation = pick(spec, choice, n);
              if (!operation) return;
              try {
                const done = apply(spec, operation);
                spec = done.spec;
                inverses.unshift(OperationSchema.parse(JSON.parse(JSON.stringify(done.inverse))));
                applied += 1;
              } catch (caught) {
                if (!(caught instanceof OperationError)) throw caught;
              }
            });
            expect(SiteSpecSchema.safeParse(spec).success).toBe(true);
            for (const inverse of inverses) spec = apply(spec, inverse).spec;
            expect(spec).toStrictEqual(original);
          },
        ),
        { numRuns: 150, seed: 20261016 },
      );
      // Most picks apply: the property is about operations, not refusals.
      expect(applied).toBeGreaterThan(500);
      // 150 seeded runs validate the whole site each time: about 2 s locally, more on a shared CI runner.
    },
    30_000,
  );
});
