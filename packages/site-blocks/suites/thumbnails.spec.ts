import { fileURLToPath } from 'node:url';
import { test } from '@playwright/test';
import { BLOCK_VARIANTS } from './targets.ts';

// Catalog thumbnails (BF-034): one picture of every block variant, written to the catalog of @bf/site-schema
// (generated/catalog/thumbnails/<type>/<variant>.png, the paths its markdown names) for agents and the editor.
// `pnpm --filter @bf/site-blocks thumbnails` (after `prepare:suites`) regenerates them; this project asserts nothing.

const out = fileURLToPath(new URL('../../site-schema/generated/catalog/thumbnails/', import.meta.url));

test.use({ viewport: { width: 1200, height: 800 }, deviceScaleFactor: 0.5 });

for (const { type, variant } of BLOCK_VARIANTS) {
  test(`thumbnail ${type} · ${variant}`, async ({ page }) => {
    await page.goto(`/gallery/blocks/modern/${type}/${variant}.html`);
    await page.evaluate(() => document.fonts.ready);
    await page.waitForLoadState('networkidle');
    await page.locator('main').screenshot({ path: `${out}${type}/${variant}.png`, animations: 'disabled' });
  });
}
