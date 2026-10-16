import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BLOCK_TYPES, BlockSchema, blockVariants } from '../spec/blocks/index.ts';
import { SiteSpecSchema } from '../spec/site.ts';
import { CATALOG, thumbnailPath } from './catalog.ts';
import { blockMarkdown, catalogFiles, examplesFrom } from './render-markdown.ts';

const sites = ['salon-gustavia', 'cafe-saint-jean', 'hardware-store-lorient', 'villa-agency'].map((name) =>
  SiteSpecSchema.parse(
    JSON.parse(readFileSync(new URL(`../../fixtures/${name}.json`, import.meta.url), 'utf8')),
  ),
);
const examples = examplesFrom(sites);

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

  it('shows actions by kind and a valid example of every block', () => {
    expect(blockMarkdown('hero')).toContain(
      'action, one of `call`, `email`, `whatsapp`, `booking`, `directions`, `page`, `url`',
    );
    for (const type of BLOCK_TYPES) {
      const example = examples[type];
      expect(example, type).toBeDefined();
      expect(BlockSchema.safeParse(example).success, type).toBe(true);
      expect(blockMarkdown(type, example)).toContain('```json');
    }
  });

  it('has a thumbnail for every block variant and none other (pnpm --filter @bf/site-blocks thumbnails)', () => {
    const expected = BLOCK_TYPES.flatMap((type) =>
      blockVariants(type).map((variant) => thumbnailPath(type, variant)),
    );
    for (const path of expected)
      expect(existsSync(new URL(`../../generated/catalog/${path}`, import.meta.url)), path).toBe(true);
    // No thumbnail of a removed or renamed variant is left behind.
    const thumbnails = new URL('../../generated/catalog/thumbnails/', import.meta.url);
    const found = readdirSync(thumbnails, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map(
        (entry) => `thumbnails/${relative(fileURLToPath(thumbnails), join(entry.parentPath, entry.name))}`,
      );
    expect(found.sort()).toEqual([...expected].sort());
  });

  it('matches the committed markdown, with no stale file (run pnpm site-schema:catalog)', () => {
    const files = catalogFiles(examples);
    // The markdown files (the thumbnails/ folder next to them is the block library's, BF-034).
    const entries = readdirSync(new URL('../../generated/catalog/', import.meta.url));
    // Only the markdown files and the thumbnails folder: no stray file.
    expect(entries.sort()).toEqual([...files.keys(), 'thumbnails'].sort());
    for (const [file, content] of files) {
      expect(readFileSync(new URL(`../../generated/catalog/${file}`, import.meta.url), 'utf8'), file).toBe(
        content,
      );
    }
    expect(catalogFiles()).toEqual(catalogFiles());
  });
});
