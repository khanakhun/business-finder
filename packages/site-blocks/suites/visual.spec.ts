import { expect, type Page, test } from '@playwright/test';
import { BLOCK_STYLES, BLOCK_VARIANTS, FIXTURES, STYLES, VIEWPORTS } from './targets.ts';

// Visual regression (BF-034): the four fixture home pages in every style on mobile and desktop, and every block
// variant in two styles. Fonts are loaded before each capture; nothing on these pages moves.

async function settle(page: Page) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForLoadState('networkidle');
}

for (const fixture of FIXTURES) {
  for (const style of STYLES) {
    for (const [device, viewport] of Object.entries(VIEWPORTS)) {
      test(`${fixture} home · ${style} · ${device}`, async ({ page }) => {
        await page.setViewportSize(viewport);
        await page.goto(`/sites/${fixture}/${style}/`);
        await settle(page);
        await expect(page).toHaveScreenshot(`sites/${fixture}-${style}-${device}.png`, { fullPage: true });
      });
    }
  }
}

for (const style of BLOCK_STYLES) {
  for (const { type, variant } of BLOCK_VARIANTS) {
    test(`block ${type} · ${variant} · ${style}`, async ({ page }) => {
      await page.setViewportSize(VIEWPORTS.desktop);
      await page.goto(`/gallery/blocks/${style}/${type}/${variant}.html`);
      await settle(page);
      await expect(page.locator('main')).toHaveScreenshot(`blocks/${type}-${variant}-${style}.png`);
    });
  }
}
