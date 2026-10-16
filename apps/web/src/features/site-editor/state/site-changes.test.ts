import { applyAll, type SiteSpec, SiteSpecSchema } from '@bf/site-schema';
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
