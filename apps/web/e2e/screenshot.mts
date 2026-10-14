// Ad-hoc screenshots for design review: node e2e/screenshot.mts <outDir>
import { chromium } from '@playwright/test';

const out = process.argv[2] ?? '.';
const browser = await chromium.launch();
for (const scheme of ['light', 'dark'] as const) {
  for (const locale of ['en', 'fr'] as const) {
    const context = await browser.newContext({ colorScheme: scheme, viewport: { width: 1440, height: 900 } });
    await context.addCookies([{ name: 'bf_locale', value: locale, url: 'http://localhost:3010' }]);
    const page = await context.newPage();
    await page.goto('http://localhost:3010/');
    await page
      .getByTestId('api-version')
      .waitFor({ timeout: 15_000 })
      .catch(() => undefined);
    await page.screenshot({ path: `${out}/home-${scheme}-${locale}.png` });
    if (scheme === 'light' && locale === 'en') {
      await page.keyboard.press('Control+k');
      await page.waitForTimeout(300);
      await page.screenshot({ path: `${out}/palette-${scheme}-${locale}.png` });
      await page.keyboard.press('Escape');
      await page.goto('http://localhost:3010/search');
      await page.screenshot({ path: `${out}/search-${scheme}-${locale}.png` });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto('http://localhost:3010/');
      await page.screenshot({ path: `${out}/mobile-${scheme}-${locale}.png` });
    }
    await context.close();
  }
}
await browser.close();
