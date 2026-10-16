import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { apiUrl, webUrl } from './env.ts';
import { expect, test } from './fixtures.ts';

// Website audit (BF-030): run the audit from the Website tab and read status, PageSpeed, the visual grade and the
// findings (fake crawl, PageSpeed and grader: a host containing `slow` is slow, `ugly` looks dated); in French too.
test.describe.configure({ mode: 'serial' });

const run = `${Date.now().toString(36)}`;
const spot = () => ({ lat: 17.88 + Math.random() * 0.04, lng: -62.87 + Math.random() * 0.06 });

async function createBusiness(page: Page, displayName: string, websiteUrl: string): Promise<string> {
  const response = await page.request.post(`${apiUrl}/v1/businesses`, {
    data: { countryCode: 'BL', displayName, websiteUrl, location: spot() },
    headers: { Origin: webUrl },
  });
  expect(response.status(), await response.text()).toBe(201);
  return ((await response.json()) as { id: string }).id;
}

test('runs a website audit and explains why the site is weak', async ({ page }) => {
  const id = await createBusiness(page, `Café Audit ${run}`, `https://slow-ugly-audit-${run}.com`);
  await page.goto(`/businesses/${id}?tab=website`);
  await expect(
    page.getByText('No audit yet: run one to measure speed, design and conversion.'),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Run audit' }).click();
  await expect(page.getByText('Audit started.')).toBeVisible();
  // The worker crawls, measures and grades; realtime refreshes the tab.
  await expect(page.getByTestId('website-status')).toHaveText('Weak', { timeout: 30_000 });
  await expect(page.getByRole('img', { name: /Quality score \d+ out of 100/ })).toBeVisible();
  await expect(page.getByText('PageSpeed — mobile')).toBeVisible();
  await expect(page.getByText(/Largest contentful paint/).first()).toBeVisible();
  await expect(page.getByTestId('vision-modernity')).toContainText('3/10');
  await expect(page.getByTestId('finding-slow_lcp_mobile')).toContainText('Slow to load on mobile');
  await expect(page.getByTestId('finding-dated_design')).toContainText('Redesign with a modern look.');
  await expect(page.getByRole('button', { name: 'Re-run audit' })).toBeVisible();
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa'])
    .exclude('[data-sonner-toaster]')
    .analyze();
  expect(results.violations).toEqual([]);
});

test.describe('in French', () => {
  test.use({ locale: 'fr-FR' });

  test('shows the audit in French', async ({ page }) => {
    const id = await createBusiness(page, `Boulangerie Audit ${run}`, `https://fine-audit-${run}.com`);
    await page.goto(`/businesses/${id}?tab=website`);
    await page.getByRole('button', { name: 'Lancer l’audit' }).click();
    // A fast, modern site: strong or OK depending on the findings of its category (a bakery needs a menu online).
    await expect(page.getByTestId('website-status')).toHaveText(/^(Solide|Correct)$/, { timeout: 30_000 });
    await expect(page.getByText('Audit du site')).toBeVisible();
    await expect(page.getByText('Note visuelle')).toBeVisible();
  });
});
