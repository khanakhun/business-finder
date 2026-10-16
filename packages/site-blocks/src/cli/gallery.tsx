// pnpm --filter @bf/site-blocks gallery — the block gallery (BF-034): every block × variant × style family with
// fixture content, as static pages in dist/gallery/ (an index, one page per style, one isolated page per block
// variant and style for screenshots), served with dist/ on http://127.0.0.1:4410/gallery/. `--no-serve` only writes.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BLOCK_TYPES, type Block, type BlockType, blockVariants, type SiteSpec } from '@bf/site-schema';
import type { CSSProperties } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { BlockRenderer } from '../renderer/block-renderer.tsx';
import { createRenderContext } from '../renderer/resolvers.ts';
import { STYLE_FAMILY_IDS, type StyleFamilyId } from '../styles/families/index.ts';
import { themeDataAttributes, themeToCssVars } from '../styles/theme-vars.ts';
import { FIXTURE_NAMES, readFixture } from './fixtures.ts';
import { placeholderResolver, writePlaceholders } from './placeholders.ts';
import { serve } from './serve.ts';

const dist = fileURLToPath(new URL('../../dist/', import.meta.url));
export const GALLERY_DIR = join(dist, 'gallery');

interface Example {
  readonly block: Block;
  readonly spec: SiteSpec;
  readonly pageId: string;
}

/** The first block of each type in the fixture sites (they cover every type), with its site and page. */
export function galleryExamples(): Map<BlockType, Example> {
  const examples = new Map<BlockType, Example>();
  for (const name of FIXTURE_NAMES) {
    const spec = readFixture(name);
    for (const page of spec.pages)
      for (const block of page.blocks)
        if (!examples.has(block.type)) examples.set(block.type, { block, spec, pageId: page.id });
  }
  return examples;
}

/** One block variant in one style, as markup inside a themed `.bf-site`. */
export function renderVariant(example: Example, variant: string, style: StyleFamilyId): string {
  const spec: SiteSpec = { ...example.spec, theme: { ...example.spec.theme, style } };
  const page = spec.pages.find((candidate) => candidate.id === example.pageId) ?? spec.pages[0];
  if (!page) throw new Error('A fixture has no page');
  const ctx = createRenderContext(spec, page, spec.defaultLocale, {
    assetsResolver: placeholderResolver('/assets/'),
    mode: 'development',
  });
  const block = { ...example.block, variant } as Block;
  return renderToStaticMarkup(
    <div
      className="bf-site"
      lang={spec.defaultLocale}
      style={themeToCssVars(spec.theme) as CSSProperties}
      {...themeDataAttributes(spec.theme)}
    >
      <main>
        <BlockRenderer block={block} ctx={ctx} index={1} tone="base" />
      </main>
    </div>,
  );
}

const page = (title: string, body: string) =>
  [
    '<!doctype html>',
    '<html lang="en">',
    '<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${title}</title><meta name="robots" content="noindex"><link rel="stylesheet" href="/styles.css">`,
    '<style>.gallery-label{font:600 12px/1.4 system-ui,sans-serif;letter-spacing:.06em;text-transform:uppercase;padding:24px 24px 8px;color:#555;background:#f3f3f3;border-top:1px solid #ddd}</style>',
    `</head><body>${body}</body></html>`,
    '',
  ].join('\n');

/** Every gallery page: index.html, <style>/index.html and blocks/<style>/<type>/<variant>.html. */
export function galleryFiles(): Map<string, string> {
  const files = new Map<string, string>();
  const examples = galleryExamples();
  for (const style of STYLE_FAMILY_IDS) {
    const sections: string[] = [];
    for (const type of BLOCK_TYPES) {
      const example = examples.get(type);
      if (!example) throw new Error(`No fixture has a ${type} block`);
      for (const variant of blockVariants(type)) {
        const markup = renderVariant(example, variant, style);
        sections.push(
          `<div class="gallery-label" id="${type}-${variant}">${type} · ${variant}</div>${markup}`,
        );
        files.set(`blocks/${style}/${type}/${variant}.html`, page(`${type} · ${variant} · ${style}`, markup));
      }
    }
    files.set(`${style}/index.html`, page(`Blocks · ${style}`, sections.join('\n')));
  }
  const links = STYLE_FAMILY_IDS.map((style) => `<li><a href="/gallery/${style}/">${style}</a></li>`).join(
    '',
  );
  files.set(
    'index.html',
    page(
      'Block gallery',
      `<main style="font:16px system-ui;padding:2rem"><h1>Block gallery</h1><ul>${links}</ul></main>`,
    ),
  );
  return files;
}

/** Writes the gallery under dist/gallery/ (the stylesheet, fonts and placeholder photos are dist/'s own). */
export function writeGallery(): void {
  rmSync(GALLERY_DIR, { recursive: true, force: true });
  for (const [path, html] of galleryFiles()) {
    const target = join(GALLERY_DIR, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, html);
  }
  writePlaceholders();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeGallery();
  if (!process.argv.includes('--no-serve')) {
    serve(dist, 4410);
    console.log('Block gallery: http://127.0.0.1:4410/gallery/');
  }
}
