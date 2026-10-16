import AxeBuilder from '@axe-core/playwright';
import { apiUrl, webUrl } from './env.ts';
import { expect, test } from './fixtures.ts';

// Scores (BF-032): a tracked business is scored for every built-in offer; the Scores tab explains each score and
// recomputes on demand; the listing shows the primary profile's badge.
test.describe.configure({ mode: 'serial' });

const run = `${Date.now().toString(36)}`;

test('explains the scores of a business and recomputes them', async ({ page }) => {
  const displayName = `Boutique Score ${run}`;
  const response = await page.request.post(`${apiUrl}/v1/businesses`, {
    data: {
      countryCode: 'BL',
      displayName,
      location: { lat: 17.88 + Math.random() * 0.04, lng: -62.87 + Math.random() * 0.06 },
    },
    headers: { Origin: webUrl },
  });
  expect(response.status(), await response.text()).toBe(201);
  const id = ((await response.json()) as { id: string }).id;

  await page.goto(`/businesses/${id}?tab=scores`);
  await expect(page.getByRole('tab', { name: 'Scores', selected: true })).toBeVisible();
  await page.getByRole('button', { name: 'Recompute' }).first().click();
  await expect(page.getByText('Scores recomputed.')).toBeVisible();

  const primary = page.getByTestId('score-card-new_website');
  await expect(primary.getByText('Primary')).toBeVisible();
  for (const offer of ['website_redesign', 'ai_receptionist', 'booking_system', 'local_seo'])
    await expect(page.getByTestId(`score-card-${offer}`)).toBeVisible();
  await primary.getByText('All contributions').click();
  await expect(primary.getByTestId('score-contributions').getByRole('row').nth(1)).toBeVisible();

  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa'])
    .exclude('[data-sonner-toaster]')
    .analyze();
  expect(results.violations).toEqual([]);
});
