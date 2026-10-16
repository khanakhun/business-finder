import {
  applyAll,
  BLOCK_SCHEMAS,
  BLOCK_TYPES,
  blockVariants,
  type SiteSpec,
  SiteSpecSchema,
} from '@bf/site-schema';
import cafe from '@bf/site-schema/fixtures/cafe-saint-jean.json' with { type: 'json' };
import hardware from '@bf/site-schema/fixtures/hardware-store-lorient.json' with { type: 'json' };
import salon from '@bf/site-schema/fixtures/salon-gustavia.json' with { type: 'json' };
import villa from '@bf/site-schema/fixtures/villa-agency.json' with { type: 'json' };
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { defaultBlockProps } from '../puck/field-registry.ts';
import { applyPuckDataToSpec, blockIdOf, deepEqual, itemToBlock, propsPatch } from './puck-to-ops.ts';
import { type BlockItem, type EditorData, ITEM_KEYS, specPageToPuckData } from './spec-to-puck.ts';

const FIXTURES: Record<string, SiteSpec> = Object.fromEntries(
  Object.entries({ salon, cafe, hardware, villa }).map(([name, spec]) => [name, SiteSpecSchema.parse(spec)]),
);
const PAGES = Object.entries(FIXTURES).flatMap(([name, spec]) =>
  spec.pages.map((page) => [name, page.id] as const),
);

/** A text as the schema stores it (trimmed, blank languages absent). */
const trim = (text: Record<string, string | undefined>) =>
  Object.fromEntries(
    Object.entries(text)
      .map(([locale, value]) => [locale, value?.trim()])
      .filter(([, value]) => value),
  );

/** The data the editor would show after applying `ops`, ids mapped as a save maps them. */
const normalized = (data: EditorData): EditorData => ({
  root: {
    props: {
      ...data.root.props,
      title: trim(data.root.props.title),
      seoTitle: trim(data.root.props.seoTitle),
      seoDescription: trim(data.root.props.seoDescription),
    },
  },
  content: data.content.map((item) => {
    const block = itemToBlock(item);
    return { type: block.type, props: { ...block.props, id: block.id, variant: block.variant } } as BlockItem;
  }),
});

describe('specPageToPuckData / applyPuckDataToSpec', () => {
  it.each(PAGES)('round-trips %s / %s with no operation', (name, pageId) => {
    const spec = FIXTURES[name] as SiteSpec;
    expect(applyPuckDataToSpec(spec, pageId, specPageToPuckData(spec, pageId))).toEqual([]);
  });

  it('keeps block ids as item ids, and no block prop is named like an item key', () => {
    const spec = FIXTURES.salon as SiteSpec;
    const page = spec.pages[0];
    expect(specPageToPuckData(spec, page?.id ?? '').content.map((item) => item.props.id)).toEqual(
      page?.blocks.map((block) => block.id),
    );
    for (const type of BLOCK_TYPES) {
      const keys = Object.keys(BLOCK_SCHEMAS[type].shape.props.shape);
      for (const key of ITEM_KEYS) expect(keys, type).not.toContain(key);
    }
  });

  it('maps a Puck-made item id to a stable, valid block id', () => {
    const id = blockIdOf('hero-1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed');
    expect(id).toMatch(/^[A-Za-z0-9_-]{6,32}$/);
    expect(blockIdOf('hero-1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed')).toBe(id);
    expect(blockIdOf('hero-1a2b')).toBe('hero-1a2b');
  });

  it('turns removals, a new block, moves, a variant and a text into operations, in that order', () => {
    const spec = FIXTURES.salon as SiteSpec;
    const page = spec.pages[0];
    if (!page) throw new Error('fixture');
    const data = specPageToPuckData(spec, page.id);
    const [hero, second, ...rest] = data.content as BlockItem[];
    if (!hero || !second) throw new Error('fixture');
    const added: BlockItem = {
      type: 'faq',
      props: {
        id: 'faq-0b6f5a2e-1111-4c2d-9e3f-1234567890ab',
        variant: blockVariants('faq')[0] as string,
        heading: { fr: 'Questions', en: 'Questions' },
        items: [
          {
            question: { fr: 'Prix ?', en: 'Prices?' },
            answer: { fr: 'Voir la carte.', en: 'See the menu.' },
          },
        ],
      },
    };
    const otherVariant = blockVariants('hero').find((variant) => variant !== hero.props.variant) as string;
    const edited: EditorData = {
      root: {
        props: { ...data.root.props, seoTitle: { ...data.root.props.seoTitle, en: 'New title here' } },
      },
      content: [
        {
          ...hero,
          props: {
            ...hero.props,
            variant: otherVariant,
            title: { ...(hero.props.title as object), en: 'Hi' },
          },
        },
        ...rest.slice(1),
        added,
        rest[0] as BlockItem,
      ],
    };
    const ops = applyPuckDataToSpec(spec, page.id, edited);
    expect(ops.map((op) => op.op)).toEqual([
      'removeBlock',
      ...ops
        .slice(1)
        .map((op) => op.op)
        .filter((op) => op === 'moveBlock' || op === 'addBlock'),
      'setBlockVariant',
      'updateBlockProps',
      'updateText',
    ]);
    expect(ops[0]).toEqual({ op: 'removeBlock', pageId: page.id, blockId: second.props.id });
    expect(ops).toContainEqual({
      op: 'updateBlockProps',
      pageId: page.id,
      blockId: hero.props.id,
      props: { title: { en: 'Hi' } },
    });
    const result = applyAll(spec, ops).spec;
    expect(specPageToPuckData(result, page.id)).toEqual(normalized(edited));
  });

  it('removes a cleared optional prop and a dropped translation with null', () => {
    expect(
      propsPatch({ title: { fr: 'A', en: 'B' }, subtitle: { fr: 'S' }, n: 1 }, { title: { fr: 'A' }, n: 1 }),
    ).toEqual({ title: { en: null }, subtitle: null });
    expect(propsPatch({ items: [1, 2] }, { items: [2, 1] })).toEqual({ items: [2, 1] });
    expect(propsPatch({ a: { b: 1 } }, { a: { b: 1 } })).toBeUndefined();
    expect(deepEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBe(true);
  });

  it('renames the page and changes its slug through the root', () => {
    const spec = FIXTURES.cafe as SiteSpec;
    const page = spec.pages[1];
    if (!page) throw new Error('fixture');
    const data = specPageToPuckData(spec, page.id);
    const ops = applyPuckDataToSpec(spec, page.id, {
      ...data,
      root: {
        props: {
          ...data.root.props,
          title: { ...data.root.props.title, fr: 'Notre carte' },
          slug: 'notre-carte',
        },
      },
    });
    expect(ops).toEqual([
      { op: 'renamePage', pageId: page.id, title: { ...page.title, fr: 'Notre carte' }, slug: 'notre-carte' },
    ]);
  });
});

/** Random editor sessions on a fixture page: moves, removals, duplicates, variants and texts. */
const edit = fc.record({
  fixture: fc.constantFrom(...PAGES),
  steps: fc.array(
    fc.oneof(
      fc.record({ kind: fc.constant('move' as const), from: fc.nat(30), to: fc.nat(30) }),
      fc.record({ kind: fc.constant('remove' as const), at: fc.nat(30) }),
      fc.record({ kind: fc.constant('duplicate' as const), at: fc.nat(30), uuid: fc.uuid() }),
      fc.record({ kind: fc.constant('variant' as const), at: fc.nat(30), pick: fc.nat(10) }),
      fc.record({
        kind: fc.constant('text' as const),
        at: fc.nat(30),
        value: fc.stringMatching(/^[A-Za-z][A-Za-z ]{0,18}[A-Za-z]$/),
      }),
      // A text typed with spaces around it (the schema stores it trimmed: nothing is left to save after).
      fc.record({
        kind: fc.constant('spaced' as const),
        at: fc.nat(30),
        value: fc.stringMatching(/^[A-Za-z]{1,10}$/),
      }),
      // A translation dropped, an optional prop cleared (both are `null` in the patch).
      fc.record({ kind: fc.constant('dropTranslation' as const), at: fc.nat(30) }),
      fc.record({ kind: fc.constant('clearOptional' as const), at: fc.nat(30) }),
      // A nested list item's text (an array replaced as a whole).
      fc.record({
        kind: fc.constant('nested' as const),
        at: fc.nat(30),
        value: fc.stringMatching(/^[A-Za-z][A-Za-z ]{0,18}[A-Za-z]$/),
      }),
      // A new block from the drawer (its defaults for this site), at a position.
      fc.record({ kind: fc.constant('add' as const), at: fc.nat(30), uuid: fc.uuid() }),
      // The page's own settings: title, address, search texts.
      fc.record({
        kind: fc.constant('root' as const),
        title: fc.stringMatching(/^[A-Za-z][A-Za-z ]{0,18}[A-Za-z]$/),
        slug: fc.stringMatching(/^[a-z][a-z0-9]{2,10}$/),
        seo: fc.stringMatching(/^[A-Za-z][A-Za-z ]{20,40}[A-Za-z]$/),
      }),
    ),
    { maxLength: 8 },
  ),
});

type Session = typeof edit extends fc.Arbitrary<infer T> ? T : never;

function play(data: EditorData, steps: Session['steps'], spec: SiteSpec): EditorData {
  const content = [...data.content];
  let root = data.root.props;
  for (const step of steps) {
    const index = 'at' in step ? step.at % content.length : 0;
    const item = content[index] as BlockItem;
    if (step.kind === 'move') {
      const [moved] = content.splice(step.from % content.length, 1);
      content.splice(step.to % (content.length + 1), 0, moved as BlockItem);
    } else if (step.kind === 'remove' && content.length > 1) {
      content.splice(index, 1);
    } else if (step.kind === 'duplicate') {
      content.splice(index + 1, 0, {
        ...structuredClone(item),
        props: { ...structuredClone(item.props), id: `${item.type}-${step.uuid}` },
      });
    } else if (step.kind === 'variant') {
      const variants = blockVariants(item.type);
      content[index] = {
        ...item,
        props: { ...item.props, variant: variants[step.pick % variants.length] as string },
      };
    } else if (step.kind === 'text' && 'heading' in item.props && item.props.heading) {
      content[index] = {
        ...item,
        props: { ...item.props, heading: { ...(item.props.heading as object), fr: step.value } },
      };
    } else if (step.kind === 'spaced' && 'heading' in item.props && item.props.heading) {
      content[index] = {
        ...item,
        props: { ...item.props, heading: { ...(item.props.heading as object), fr: ` ${step.value} ` } },
      };
      root = { ...root, seoTitle: { ...root.seoTitle, fr: `${root.seoTitle.fr ?? 'Title'} ` } };
    } else if (step.kind === 'dropTranslation') {
      const heading = item.props.heading as Record<string, string> | undefined;
      if (heading && Object.keys(heading).length > 1) {
        const { en: _dropped, ...rest } = heading;
        content[index] = { ...item, props: { ...item.props, heading: rest } };
      }
    } else if (step.kind === 'clearOptional') {
      const optional = ['subtitle', 'eyebrow', 'intro', 'secondaryCta'].find((key) => key in item.props);
      if (optional) {
        const { [optional]: _cleared, ...rest } = item.props;
        content[index] = { ...item, props: rest as BlockItem['props'] };
      }
    } else if (step.kind === 'nested' && Array.isArray(item.props.items) && item.props.items.length > 0) {
      const items = structuredClone(item.props.items) as Record<string, unknown>[];
      const first = items[0] as Record<string, unknown>;
      const textKey = ['title', 'question', 'quote'].find((key) => key in first);
      if (textKey) first[textKey] = { ...(first[textKey] as object), fr: step.value };
      content[index] = { ...item, props: { ...item.props, items } };
    } else if (step.kind === 'add') {
      const props = defaultBlockProps('faq', { spec, placeholder: () => 'New text' });
      if (props) {
        const added = {
          type: 'faq',
          props: { ...props, id: `faq-${step.uuid}`, variant: 'accordion' },
        } as BlockItem;
        content.splice(step.at % (content.length + 1), 0, added);
      }
    } else if (step.kind === 'root') {
      root = {
        ...root,
        title: { ...root.title, fr: step.title },
        slug: root.slug === '' ? '' : step.slug,
        seoTitle: { ...root.seoTitle, en: step.seo },
      };
    }
  }
  return { root: { props: root }, content };
}

describe('editor sessions (property)', () => {
  // A property test over every fixture: seconds of CPU, more when `pnpm verify` runs every package at once.
  it('give operations that reproduce the canvas exactly, and none once saved', () => {
    fc.assert(
      fc.property(edit, ({ fixture: [name, pageId], steps }) => {
        const spec = FIXTURES[name] as SiteSpec;
        const edited = play(specPageToPuckData(spec, pageId), steps, spec);
        const ids = edited.content.map((item) => blockIdOf(item.props.id));
        fc.pre(new Set(ids).size === ids.length);
        const ops = applyPuckDataToSpec(spec, pageId, edited);
        const saved = applyAll(spec, ops).spec;
        expect(specPageToPuckData(saved, pageId)).toEqual(normalized(edited));
        expect(applyPuckDataToSpec(saved, pageId, edited)).toEqual([]);
      }),
      { numRuns: 300 },
    );
  }, 30_000);
});
