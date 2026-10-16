import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BLOCK_TYPES, blockVariants } from '../spec/blocks/index.ts';
import { CATALOG } from './catalog.ts';
import { blockMarkdown, catalogFiles } from './render-markdown.ts';

describe('block catalog', () => {
  it.each(BLOCK_TYPES)('describes %s and exactly its variants', (type) => {
    const entry = CATALOG[type];
    expect(Object.keys(entry.variants).sort()).toEqual([...blockVariants(type)].sort());
    expect(entry.use.length).toBeGreaterThan(0);
    expect(entry.avoid.length).toBeGreaterThan(0);
    expect(entry.good.en && entry.good.fr && entry.bad.en && entry.bad.fr).toBeTruthy();
  });

  it('documents props from the schema, nested ones included', () => {
    const services = blockMarkdown('services');
    expect(services).toContain('| `items[].price` |');
    expect(services).toContain('A published price');
    expect(blockMarkdown('testimonials')).toContain('never write a testimonial');
  });

  it('matches the committed markdown (run pnpm site-schema:catalog)', () => {
    for (const [file, content] of catalogFiles()) {
      expect(readFileSync(new URL(`../../generated/catalog/${file}`, import.meta.url), 'utf8'), file).toBe(
        content,
      );
    }
    expect(catalogFiles()).toEqual(catalogFiles());
  });
});
