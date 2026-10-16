// @vitest-environment node
import { BLOCK_TYPES, blockVariants } from '@bf/site-schema';
import { describe, expect, it } from 'vitest';
import { galleryExamples, galleryFiles, renderVariant } from './gallery.tsx';

/** The markup without what names the variant: two variants must still differ. */
const shape = (markup: string) =>
  markup
    .replace(/ data-variant="[^"]*"/g, '')
    .replace(/ (?:id|aria-labelledby|aria-controls|popovertarget|for|href)="[^"]*"/g, '');

describe('block gallery', () => {
  const examples = galleryExamples();

  it.each(BLOCK_TYPES)('shows every %s variant as itself (no two render the same)', (type) => {
    const example = examples.get(type);
    if (!example) throw new Error(`no ${type} example`);
    const markups = blockVariants(type).map((variant) => shape(renderVariant(example, variant, 'modern')));
    expect(new Set(markups).size).toBe(markups.length);
  });

  it('never repeats an element id on a style page, and has one main landmark', () => {
    const html = galleryFiles().get('modern/index.html') ?? '';
    const ids = [...html.matchAll(/ id="([^"]+)"/g)].map((match) => match[1]);
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([]);
    expect(html.match(/<main/g)).toHaveLength(1);
  });
});
