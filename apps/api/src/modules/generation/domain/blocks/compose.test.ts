import type { SiteSpec } from '@bf/site-schema';
import { describe, expect, it } from 'vitest';
import { applyCopy, copyPaths, fieldProblems, restoreBlocks } from './compose.ts';

// The repair helpers of the blocks engine (BF-041): which issues the copy can fix, which blocks go back to the
// starter's, and which paths a re-ask may change.

const site = (heading: string, phone: string) =>
  ({
    locales: ['fr'],
    pages: [
      {
        id: 'home',
        seo: { title: { fr: 'Accueil' }, description: { fr: 'Description' } },
        blocks: [
          { id: 'hero', type: 'hero', variant: 'centered', props: { title: { fr: 'Bienvenue' } } },
          { id: 'svc', type: 'services', variant: 'list', props: { heading: { fr: heading }, items: [] } },
          { id: 'contact', type: 'contact', variant: 'simple', props: { phone } },
        ],
      },
    ],
  }) as unknown as SiteSpec;

const answer = (heading: string, title: string) => ({
  blocks: [
    { blockId: 'svc', fields: [{ key: 'heading', texts: { fr: heading }, factsUsed: [] }] },
    { blockId: 'hero', fields: [{ key: 'title', texts: { fr: title }, factsUsed: [] }] },
  ],
  seo: { title: { fr: 'Nouveau titre' }, description: { fr: 'Nouvelle description' } },
});

describe('blocks repair helpers', () => {
  it('keeps the issues inside rewritable fields, one per field', () => {
    const spec = site('Le meilleur', '+590590000000');
    const problems = fieldProblems(spec, [
      { at: 'pages[0].blocks[1].props.heading.fr', message: 'Remove the superlative.' },
      { at: 'pages[0].blocks[1].props.heading', message: 'Second message, same field.' },
      { at: 'pages[0].blocks[1].props.items[0].name', message: 'Not a rewritable field.' },
      { at: 'pages[0].blocks[2].props.phone', message: 'A fact.' },
      { at: 'pages[3].blocks[0].props.heading', message: 'No such page.' },
      { at: 'pages[0].blocks[1].props.headingX', message: 'Prefix only.' },
    ]);
    expect(problems).toEqual([
      {
        path: 'pages[0].blocks[1].props.heading',
        pageId: 'home',
        blockId: 'svc',
        key: 'heading',
        message: 'Remove the superlative.',
      },
    ]);
  });

  it('restores the starter block where an issue is outside the rewritable fields', () => {
    const starter = site('Nos services', '+590590000001');
    const spec = site('Le meilleur', '+590590000999');
    const restored = restoreBlocks(spec, starter, [
      { at: 'pages[0].blocks[2].props.phone', message: 'Unknown phone.' },
      { at: 'pages[0].blocks[2]', message: 'Same block again.' },
      { at: 'pages[0].blocks[1].props.heading.fr', message: 'The copy fixes this one.' },
      { at: 'pages', message: 'Not a block.' },
    ]);
    expect(restored).toEqual(['contact']);
    const blocks = spec.pages[0]?.blocks as unknown as { props: Record<string, unknown> }[];
    expect(blocks[2]?.props.phone).toBe('+590590000001');
    expect(blocks[1]?.props.heading).toEqual({ fr: 'Le meilleur' });
  });

  it('lists every rewritable path and applies a copy only within the allowed ones', () => {
    const spec = site('Le meilleur', '+590590000000');
    expect(copyPaths(spec)).toEqual([
      'pages[0].blocks[0].props.title',
      'pages[0].blocks[1].props.heading',
      'pages[0].seo.title',
      'pages[0].seo.description',
    ]);
    const only = new Set(['pages[0].blocks[1].props.heading']);
    const { changed } = applyCopy(spec, 'home', answer('Nos prestations', 'Autre titre'), new Set(), only);
    expect(changed).toEqual(['pages[0].blocks[1].props.heading']);
    const page = spec.pages[0] as unknown as {
      seo: { title: unknown };
      blocks: { props: Record<string, unknown> }[];
    };
    expect(page.blocks[0]?.props.title).toEqual({ fr: 'Bienvenue' });
    expect(page.seo.title).toEqual({ fr: 'Accueil' });
  });
});
