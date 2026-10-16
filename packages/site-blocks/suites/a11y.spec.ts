import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { FIXTURES, PAGES, VIEWPORTS } from './targets.ts';

// Accessibility (BF-034): axe on every page of every fixture site, in two styles, on desktop and with the mobile
// menu open. No serious or critical violation is allowed.

const serious = (violations: { id: string; impact?: string | null; nodes: { target: unknown }[] }[]) =>
  violations
    .filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
    .map(
      (violation) =>
        `${violation.id}: ${violation.nodes.map((node) => JSON.stringify(node.target)).join(', ')}`,
    );

const scan = (page: Page) =>
  new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .analyze();

for (const fixture of FIXTURES) {
  for (const style of ['luxe', 'modern'] as const) {
    for (const path of PAGES[fixture]) {
      test(`${fixture}/${path || 'home'} · ${style}`, async ({ page }) => {
        await page.setViewportSize(VIEWPORTS.desktop);
        await page.goto(`/sites/${fixture}/${style}/${path}`);
        const results = await scan(page);
        expect(serious(results.violations)).toEqual([]);
      });
    }
  }

  test(`${fixture} mobile menu open`, async ({ page }) => {
    await page.setViewportSize(VIEWPORTS.mobile);
    await page.goto(`/sites/${fixture}/coastal/`);
    const toggle = page.locator('button[popovertarget="bf-mobile-menu"]:not([popovertargetaction])');
    if ((await toggle.count()) === 0) return;
    await toggle.click();
    await expect(page.locator('#bf-mobile-menu')).toBeVisible();
    const results = await scan(page);
    expect(serious(results.violations)).toEqual([]);
    await page.keyboard.press('Escape');
    await expect(page.locator('#bf-mobile-menu')).toBeHidden();
  });
}

test('the skip link is the first stop and lands on the content', async ({ page }) => {
  await page.goto('/sites/salon-gustavia/luxe/');
  await page.keyboard.press('Tab');
  const skip = page.getByRole('link', { name: 'Aller au contenu' });
  await expect(skip).toBeFocused();
  await expect(skip).toBeInViewport();
  await page.keyboard.press('Enter');
  await expect(page.locator('#main')).toBeFocused();
});
