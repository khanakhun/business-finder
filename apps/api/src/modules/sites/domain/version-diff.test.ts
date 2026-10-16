import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { apply, type SiteSpec, SiteSpecSchema } from '@bf/site-schema';
import { describe, expect, it } from 'vitest';
import { diffSpecs } from './version-diff.ts';

const fixtures = join(
  dirname(createRequire(import.meta.url).resolve('@bf/site-schema/package.json')),
  'fixtures',
);
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
    expect(
      diff.texts.some(
        (text) => text.path[0] === 'pages' && text.path[1] === 'services' && text.after === null,
      ),
    ).toBe(true);
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
});
