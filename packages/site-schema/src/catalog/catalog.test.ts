import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BLOCK_TYPES, BlockSchema, blockVariants } from '../spec/blocks/index.ts';
import { SiteSpecSchema } from '../spec/site.ts';
import { CATALOG } from './catalog.ts';
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

  it('matches the committed markdown, with no stale file (run pnpm site-schema:catalog)', () => {
    const files = catalogFiles(examples);
    expect(readdirSync(new URL('../../generated/catalog/', import.meta.url)).sort()).toEqual(
      [...files.keys()].sort(),
    );
    for (const [file, content] of files) {
      expect(readFileSync(new URL(`../../generated/catalog/${file}`, import.meta.url), 'utf8'), file).toBe(
        content,
      );
    }
    expect(catalogFiles()).toEqual(catalogFiles());
  });
});
