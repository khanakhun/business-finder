import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { diffSpecs } from './diff.ts';
import { apply, type SiteSpec, SiteSpecSchema } from './index.ts';

const fixtures = fileURLToPath(new URL('../fixtures/', import.meta.url));
const salon = (): SiteSpec =>
  SiteSpecSchema.parse(JSON.parse(readFileSync(join(fixtures, 'salon-gustavia.json'), 'utf8')));

describe('diffSpecs', () => {
  it('says there is no change between equal specs', () => {
    const diff = diffSpecs(salon(), salon());
    expect(diff.summary).toBe('No change');
    expect(diff.blocks).toEqual({ added: [], removed: [], moved: [], changed: [] });
  });

  it('reports a moved block as a move, not as edits, and only it', () => {
    const before = salon();
    const last = before.pages[0]?.blocks.at(-1);
    if (!last) throw new Error('no block');
    const after = apply(before, { op: 'moveBlock', pageId: 'home', blockId: last.id, index: 1 }).spec;
    const diff = diffSpecs(before, after);
    expect(diff.blocks.moved).toEqual([
      expect.objectContaining({
        blockId: last.id,
        fromPageId: 'home',
        fromIndex: (before.pages[0]?.blocks.length ?? 0) - 1,
        toIndex: 1,
      }),
    ]);
    expect(diff.texts).toEqual([]);
    expect(diff.summary).toBe('1 block moved');
  });

  it('lists added and removed pages and blocks, changed fields and edited texts per locale', () => {
    const before = salon();
    const hero = before.pages[0]?.blocks[0];
    if (hero?.type !== 'hero') throw new Error('no hero');
    let after = apply(before, {
      op: 'updateBlockProps',
      pageId: 'home',
      blockId: hero.id,
      props: { title: { fr: 'Nouveau titre', en: hero.props.title.en } },
    }).spec;
    after = apply(after, { op: 'removePage', pageId: 'services' }).spec;
    const diff = diffSpecs(before, after);
    expect(diff.pages.removed).toEqual(['services']);
    expect(diff.blocks.changed).toEqual([
      { pageId: 'home', blockId: hero.id, type: 'hero', fields: ['title'] },
    ]);
    expect(diff.texts).toContainEqual({
      path: ['blocks', hero.id, 'title'],
      locale: 'fr',
      before: hero.props.title.fr,
      after: 'Nouveau titre',
    });
    // The removed page's texts belong to its removal, not to the edits.
    expect(diff.texts.some((text) => text.path[1] === 'services')).toBe(false);
    expect(diff.sections).toContain('navigation');
    expect(diff.summary).toMatch(/^1 page removed, .*1 block changed, \d+ texts edited, navigation updated$/);
  });

  it('notes site-wide sections and keeps excerpts short', () => {
    const before = salon();
    const after = apply(before, { op: 'setTheme', theme: { ...before.theme, radius: 'full' } }).spec;
    expect(diffSpecs(before, after).sections).toEqual(['theme']);
    const long = apply(before, {
      op: 'updateText',
      path: ['seo', 'description'],
      locale: 'fr',
      value: 'x'.repeat(190),
    }).spec;
    const [edit] = diffSpecs(before, long).texts;
    expect(edit?.after).toHaveLength(120);
    expect(edit?.after?.endsWith('…')).toBe(true);
  });

  it('ignores key order (stored specs come back from jsonb with their keys reordered)', () => {
    const sortKeys = (value: unknown): unknown =>
      Array.isArray(value)
        ? value.map(sortKeys)
        : value && typeof value === 'object'
          ? Object.fromEntries(
              Object.entries(value)
                .sort(([a], [b]) => a.length - b.length || (a < b ? -1 : 1))
                .map(([key, item]) => [key, sortKeys(item)]),
            )
          : value;
    const reordered = sortKeys(salon()) as SiteSpec;
    const diff = diffSpecs(reordered, salon());
    expect(diff.summary).toBe('No change');
    expect(diff.sections).toEqual([]);
  });

  it('lists added pages and blocks, and a block moved to another page', () => {
    const before = salon();
    const services = before.pages[1];
    const hero = services?.blocks[0];
    if (!services || !hero) throw new Error('no page');
    let after = apply(before, {
      op: 'addPage',
      page: {
        ...structuredClone(services),
        id: 'offers',
        slug: 'offres',
        blocks: [{ ...structuredClone(hero), id: 'hero-offers1' }],
      },
    }).spec;
    const cta = before.pages[0]?.blocks.at(-1);
    if (!cta) throw new Error('no block');
    after = apply(after, {
      op: 'moveBlock',
      pageId: 'home',
      blockId: cta.id,
      toPageId: 'contact',
      index: 1,
    }).spec;
    const diff = diffSpecs(before, after);
    expect(diff.pages.added).toEqual(['offers']);
    expect(diff.blocks.added).toEqual([{ pageId: 'offers', blockId: 'hero-offers1', type: 'hero' }]);
    expect(diff.blocks.moved).toEqual([
      expect.objectContaining({ blockId: cta.id, pageId: 'contact', fromPageId: 'home', toIndex: 1 }),
    ]);
    // The new page's texts are part of the addition, not edits.
    expect(diff.texts).toEqual([]);
    expect(diff.summary).toBe('1 page added, 1 block added, 1 block moved');
  });
});
