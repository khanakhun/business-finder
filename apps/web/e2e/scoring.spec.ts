import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { apiUrl, webUrl } from './env.ts';
import { expect, test } from './fixtures.ts';

// Scores (BF-032): a tracked business is scored for every built-in offer; the Scores tab explains each score and
// recomputes on demand; the pipeline card shows the primary profile's tier; the tab reads in French.
test.describe.configure({ mode: 'serial' });

const run = `${Date.now().toString(36)}`;
// A spot of its own per business, derived from the run (the resolver never merges two of them).
let spots = 0;
const spot = () => {
  spots += 1;
  const seed = (Number.parseInt(run, 36) % 997) / 997;
  return {
    lat: 17.88 + ((seed + spots * 0.07) % 1) * 0.04,
    lng: -62.87 + ((seed * 3 + spots * 0.13) % 1) * 0.06,
  };
};

async function createBusiness(page: Page, displayName: string): Promise<string> {
  const response = await page.request.post(`${apiUrl}/v1/businesses`, {
    data: { countryCode: 'BL', displayName, location: spot() },
    headers: { Origin: webUrl },
  });
  expect(response.status(), await response.text()).toBe(201);
  return ((await response.json()) as { id: string }).id;
}

test('explains the scores of a business, recomputes them, and badges the pipeline card', async ({ page }) => {
  const displayName = `Boutique Score ${run}`;
  const id = await createBusiness(page, displayName);

  await page.goto(`/businesses/${id}?tab=scores`);
  await expect(page.getByRole('tab', { name: 'Scores', selected: true })).toBeVisible();
  await page.getByRole('button', { name: 'Recompute' }).first().click();
  await expect(page.getByText('Scores recomputed.')).toBeVisible();

  const primary = page.getByTestId('score-card-new_website');
  await expect(primary.getByText('Primary')).toBeVisible();
  await expect(page.locator('[data-testid^="score-card-"]').first()).toHaveAttribute(
    'data-testid',
    'score-card-new_website',
  );
  for (const offer of ['website_redesign', 'ai_receptionist', 'booking_system', 'local_seo'])
    await expect(page.getByTestId(`score-card-${offer}`)).toBeVisible();
  // Once scored, the recompute button sits above the cards only.
  await expect(page.getByRole('button', { name: 'Recompute' })).toHaveCount(1);
  await primary.getByText('All contributions').click();
  await expect(primary.getByTestId('score-contributions').getByRole('row').nth(1)).toBeVisible();

  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa'])
    .exclude('[data-sonner-toaster]')
    .analyze();
  expect(results.violations).toEqual([]);

  // The board shows the primary profile's tier on the card.
  const label = `score-${run}`;
  const tagged = await page.request.post(`${apiUrl}/v1/businesses/${id}/tags`, {
    data: { add: [label] },
    headers: { Origin: webUrl },
  });
  expect(tagged.ok(), await tagged.text()).toBe(true);
  await page.goto(`/pipeline?tag=${label}`);
  const column = page.locator('section[data-status="new"]');
  await expect(column.getByText(displayName)).toBeVisible();
  await expect(column.getByText(/^Tier [ABCX], score \d+$/)).toBeAttached();
});

test.describe('in French', () => {
  test.use({ locale: 'fr-FR' });

  test('reads the Scores tab in French', async ({ page }) => {
    const id = await createBusiness(page, `Épicerie Score ${run}`);
    await page.goto(`/businesses/${id}?tab=scores`);
    await expect(page.getByRole('tab', { name: 'Scores', selected: true })).toBeVisible();
    await page.getByRole('button', { name: 'Recalculer' }).first().click();
    await expect(page.getByText('Scores recalculés.')).toBeVisible();
    const primary = page.getByTestId('score-card-new_website');
    await expect(primary.getByText('Principal')).toBeVisible();
    await expect(primary.getByText(/^Version \d+ du profil/)).toBeVisible();
    await primary.getByText('Toutes les contributions').click();
    await expect(primary.getByRole('columnheader', { name: 'Critère' })).toBeVisible();
  });
});
