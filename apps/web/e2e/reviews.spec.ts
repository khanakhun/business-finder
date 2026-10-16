import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { apiUrl, webUrl } from './env.ts';
import { expect, test } from './fixtures.ts';

// Review mining (BF-029): paste reviews on a business page and read the anonymous insights; enable Google reviews
// through the owner acknowledgement and analyse them (fake sources and classifier, FAKE_REVIEWS); the tab in French.
test.describe.configure({ mode: 'serial' });

const run = `${Date.now().toString(36)}`;
const spot = () => ({ lat: 17.88 + Math.random() * 0.04, lng: -62.87 + Math.random() * 0.06 });

async function createBusiness(page: Page, displayName: string): Promise<string> {
  const response = await page.request.post(`${apiUrl}/v1/businesses`, {
    data: { countryCode: 'BL', displayName, location: spot() },
    headers: { Origin: webUrl },
  });
  expect(response.status(), await response.text()).toBe(201);
  return ((await response.json()) as { id: string }).id;
}

test('pastes reviews and reads aggregated, anonymous insights', async ({ page }) => {
  const id = await createBusiness(page, `Restaurant Avis ${run}`);
  await page.goto(`/businesses/${id}?tab=reviews`);
  await expect(page.getByRole('tab', { name: 'Reviews', selected: true })).toBeVisible();
  await expect(page.getByText('No review insights yet')).toBeVisible();

  await page.getByRole('button', { name: 'Paste reviews' }).click();
  const dialog = page.getByRole('dialog', { name: 'Paste reviews' });
  await dialog
    .getByLabel('Reviews')
    .fill(
      'Impossible to book online, thanks Jordan anyway.\n\nNobody answers the phone.\n\n' +
        'Amazing dinner, best fish on the island, highly recommend!',
    );
  await expect(dialog.getByText('3 reviews to analyse')).toBeVisible();
  await dialog.getByRole('button', { name: 'Analyse', exact: true }).click();
  await expect(page.getByText('Reviews analysed.')).toBeVisible();
  // Axe runs once the dialog has finished closing (its fade-out reads as low contrast).
  await expect(dialog).toBeHidden();

  await expect(page.getByTestId('pain-booking_friction')).toContainText('Booking friction');
  await expect(page.getByTestId('pain-unreachable_by_phone')).toBeVisible();
  await expect(page.getByTestId('pain-positive_strong_reputation')).toBeVisible();
  await expect(page.getByText('3 reviews', { exact: true })).toBeVisible();
  // Evidence is paraphrased: the reviews themselves (and the name in them) are not shown back.
  await expect(page.getByText('Impossible to book online')).toHaveCount(0);
  await expect(page.getByText('Jordan')).toHaveCount(0);

  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa'])
    .exclude('[data-sonner-toaster]')
    .analyze();
  expect(results.violations).toEqual([]);
});

test('enables Google reviews with the owner acknowledgement and analyses them', async ({ page }) => {
  await page.goto('/settings/integrations#review-sources');
  const section = page.getByRole('region', { name: 'Review sources' });
  await expect(section.getByText('Needs an owner’s acknowledgement')).toBeVisible();
  await section.getByRole('button', { name: 'Derive insights from Google reviews…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Derive insights from Google reviews' });
  await expect(dialog.getByText(/§3\.2\.3/)).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Enable' })).toBeDisabled();
  await dialog.getByLabel(/I have read the warning/).check();
  await dialog.getByRole('button', { name: 'Enable' }).click();
  await expect(section.getByText(/Acknowledged on/)).toBeVisible();

  // A Places key (the fake connection test accepts it); then the source is active.
  const secret = await page.request.put(`${apiUrl}/v1/workspace/secrets/google_places`, {
    data: { value: `AIza${'Q'.repeat(31)}Zx9w` },
    headers: { Origin: webUrl },
  });
  expect(secret.ok(), await secret.text()).toBe(true);
  await page.reload();
  await expect(
    page.getByRole('region', { name: 'Review sources' }).getByText('Active').first(),
  ).toBeVisible();

  const id = await createBusiness(page, `Bistrot Google ${run}`);
  await page.goto(`/businesses/${id}?tab=reviews`);
  await page.getByRole('button', { name: 'Analyse reviews' }).click();
  await expect(page.getByText('Review analysis started.')).toBeVisible();
  // The run finishes on the worker; realtime refreshes the tab.
  await expect(page.getByText('Google reviews', { exact: true }).first()).toBeVisible({ timeout: 30_000 });
  await expect(
    page.getByText('Includes insights derived from Google Maps reviews.', { exact: false }),
  ).toBeVisible();
  await expect(page.getByText(/Kept until/).first()).toBeVisible();
});

test.describe('in French', () => {
  test.use({ locale: 'fr-FR' });

  test('shows the tab in French', async ({ page }) => {
    const id = await createBusiness(page, `Boulangerie Avis ${run}`);
    await page.goto(`/businesses/${id}?tab=reviews`);
    await expect(page.getByRole('tab', { name: 'Avis', selected: true })).toBeVisible();
    await expect(page.getByText('Pas encore d’analyse des avis')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Coller des avis' })).toBeVisible();
  });
});
