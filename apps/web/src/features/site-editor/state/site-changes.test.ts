import { applyAll, type Block, type SiteSpec, SiteSpecSchema } from '@bf/site-schema';
import salon from '@bf/site-schema/fixtures/salon-gustavia.json' with { type: 'json' };
import { describe, expect, it } from 'vitest';
import { change, rebase, redo, startChanges, undo } from './site-changes.ts';

const spec = SiteSpecSchema.parse(salon) as SiteSpec;

describe('site changes', () => {
  it('applies a change, undoes and redoes it, and keeps every step for the save', () => {
    const changed = change(startChanges(spec), {
      op: 'setTheme',
      theme: { ...spec.theme, radius: 'none' },
    });
    expect(changed.working.theme.radius).toBe('none');
    const undone = undo(changed);
    expect(undone.working.theme.radius).toBe(spec.theme.radius);
    expect(undone.redo).toHaveLength(1);
    const redone = redo(undone);
    expect(redone.working.theme.radius).toBe('none');
    // The save replays the whole story from the base and reaches the same site.
    expect(applyAll(spec, redone.pending).spec).toEqual(redone.working);
    expect(redo(redone)).toBe(redone);
    expect(undo(startChanges(spec))).toEqual(startChanges(spec));
  });

  it('undoes a removed language with its texts', () => {
    const french = change(startChanges(spec), { op: 'setLocales', locales: ['fr'], defaultLocale: 'fr' });
    expect(french.working.seo.title.en).toBeUndefined();
    const back = undo(french);
    expect(back.working.seo.title).toEqual(spec.seo.title);
    expect(applyAll(spec, back.pending).spec).toEqual(back.working);
  });

  it('a new change clears what could be redone', () => {
    const a = change(startChanges(spec), { op: 'setTheme', theme: { ...spec.theme, radius: 'none' } });
    const b = change(undo(a), { op: 'setTheme', theme: { ...spec.theme, density: 'airy' } });
    expect(b.redo).toEqual([]);
  });
});

describe('rebase', () => {
  it('replays what still applies on the latest version and sets aside the rest, with reasons', () => {
    const page = spec.pages[0];
    const block = page?.blocks[1];
    if (!page || !block) throw new Error('fixture');
    // Someone else removed a block and retitled the site meanwhile.
    const latest = applyAll(spec, [
      { op: 'removeBlock', pageId: page.id, blockId: block.id },
      { op: 'updateText', path: ['seo', 'title'], locale: 'en', value: 'Their title' },
    ]).spec;
    const result = rebase(latest, [
      {
        op: 'updateText',
        path: ['seo', 'description'],
        locale: 'en',
        value: 'Our description of the salon.',
      },
      { op: 'setBlockVariant', pageId: page.id, blockId: block.id, variant: 'cards' },
    ]);
    expect(result.applied).toHaveLength(1);
    expect(result.failed).toEqual([
      expect.objectContaining({
        op: expect.objectContaining({ op: 'setBlockVariant' }),
        reason: expect.any(String),
      }),
    ]);
    expect(result.spec.seo.title.en).toBe('Their title');
    expect(result.spec.seo.description.en).toBe('Our description of the salon.');
    expect(rebase(latest, [])).toEqual({ spec: latest, applied: [], failed: [] });
  });
});

describe('site changes (limits and batches)', () => {
  it('keeps a batch flat in what is saved, as one undo step', () => {
    const changed = change(startChanges(spec), {
      op: 'batch',
      ops: [
        { op: 'updateText', path: ['seo', 'title'], locale: 'en', value: 'A' + 'b'.repeat(20) },
        { op: 'updateText', path: ['seo', 'title'], locale: 'fr', value: 'C' + 'd'.repeat(20) },
      ],
    });
    expect(changed.pending.map((op) => op.op)).toEqual(['updateText', 'updateText']);
    expect(undo(changed).working.seo.title).toEqual(spec.seo.title);
  });

  it('undoes removing a language with more texts than one batch holds', () => {
    // Many English texts: a gallery of pages, each with its own texts.
    let site = spec;
    const page = spec.pages[0];
    if (!page) throw new Error('fixture');
    for (let n = 0; n < 8 - spec.pages.length; n += 1) {
      const faq = {
        id: `faq-extra-${n}`,
        type: 'faq',
        variant: 'accordion',
        props: {
          heading: { fr: 'Questions', en: 'Questions' },
          items: Array.from({ length: 10 }, (_, i) => ({
            question: { fr: `Question ${i} ?`, en: `Question ${i}?` },
            answer: { fr: `Réponse ${i}.`, en: `Answer ${i}.` },
          })),
        },
      } as unknown as Block;
      const blocks = [
        ...page.blocks
          .filter((block) => block.type !== 'testimonials')
          .map((block) => ({ ...block, id: `${block.id.slice(0, 20)}-p${n}` })),
        faq,
      ];
      site = applyAll(site, [
        { op: 'addPage', page: { ...page, id: `extra${n}`, slug: `extra-${n}`, blocks } },
      ]).spec;
    }
    const english = JSON.stringify(site).match(/"en":/g)?.length ?? 0;
    expect(english).toBeGreaterThan(200);
    const removed = change(startChanges(site), { op: 'setLocales', locales: ['fr'], defaultLocale: 'fr' });
    expect(undo(removed).working).toEqual(site);
  });
});

describe('rebase (against the local base)', () => {
  it('sets aside a section someone else changed, and follows a page that moved', () => {
    const local = spec;
    const [home, second] = spec.pages;
    if (!home || !second) throw new Error('fixture');
    // Someone else changed the theme and moved the second page first.
    const latest = applyAll(spec, [
      { op: 'setTheme', theme: { ...spec.theme, palette: { ...spec.theme.palette, accent: '#123456' } } },
      {
        op: 'reorderPages',
        order: [second.id, home.id, ...spec.pages.slice(2).map((page) => page.id)],
      },
    ]).spec;
    const result = rebase(
      latest,
      [
        { op: 'setTheme', theme: { ...spec.theme, radius: 'none' } },
        {
          op: 'updateText',
          path: ['pages', 1, 'seo', 'title'],
          locale: 'en',
          value: 'Our second page title',
        },
      ],
      local,
    );
    expect(result.failed.map((entry) => entry.op.op)).toEqual(['setTheme']);
    // Their theme stays; the text lands on the page it was written for.
    expect(result.spec.theme.palette.accent).toBe('#123456');
    expect(result.spec.pages.find((page) => page.id === second.id)?.seo.title.en).toBe(
      'Our second page title',
    );
  });
});
