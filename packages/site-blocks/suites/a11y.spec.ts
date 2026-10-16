import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { BLOCK_VARIANTS, FIXTURES, PAGES, VIEWPORTS } from './targets.ts';

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
    await expect(toggle).toHaveCount(1);
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

test('the gallery viewer opens from the keyboard, passes axe, and gives focus back on Escape', async ({
  page,
}) => {
  await page.setViewportSize(VIEWPORTS.desktop);
  await page.goto('/gallery/blocks/modern/gallery/grid.html');
  const photo = page.locator('button.bf-zoom').first();
  await photo.focus();
  await page.keyboard.press('Enter');
  const viewer = page.locator('.bf-lightbox:popover-open');
  await expect(viewer).toBeVisible();
  await expect(viewer.getByRole('button')).toBeFocused();
  expect(serious((await scan(page)).violations)).toEqual([]);
  await page.keyboard.press('Escape');
  await expect(viewer).toHaveCount(0);
  await expect(photo).toBeFocused();
});

// Every variant, including those no fixture page uses (one style: the markup is the same in every style).
for (const { type, variant } of BLOCK_VARIANTS) {
  test(`block ${type} · ${variant}`, async ({ page }) => {
    await page.setViewportSize(VIEWPORTS.desktop);
    await page.goto(`/gallery/blocks/modern/${type}/${variant}.html`);
    expect(serious((await scan(page)).violations)).toEqual([]);
  });
}
