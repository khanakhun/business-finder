import AxeBuilder from '@axe-core/playwright';
import { expect, test } from './fixtures.ts';

// Fake value in the provider's format; the E2E API runs with FAKE_CONNECTION_TESTS=true (no provider is called).
const GOOGLE_KEY = `AIza${'E'.repeat(31)}2e2e`;

test('stores a provider key: status, last four characters and a connection test', async ({ page }) => {
  await page.goto('/settings/integrations');
  await expect(page.getByRole('heading', { level: 1, name: 'Integrations' })).toBeVisible();
  await page
    .getByRole('button', { name: /— Google Places API key$/ })
    .first()
    .click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Key', { exact: true }).fill(GOOGLE_KEY);
  await dialog.getByRole('button', { name: 'Save key' }).click();
  await expect(dialog).toBeHidden();

  await expect(page.getByTestId('secret-status-google_places')).toHaveText('Set for this workspace');
  await expect(page.getByText('ending in 2e2e')).toBeVisible();
  // The key itself is never shown again.
  await expect(page.getByText(GOOGLE_KEY)).toHaveCount(0);

  const row = page.getByRole('listitem').filter({ hasText: 'Google Places API key' });
  await row.getByRole('button', { name: 'Test — Google Places API key' }).click();
  await expect(page.getByText('Google Places API key: connection works.')).toBeVisible();

  await page.goto('/settings/audit');
  await expect(page.getByRole('cell', { name: 'Key added' }).first()).toBeVisible();
});

test('workspace identity and address make outreach ready', async ({ page }) => {
  await page.goto('/settings/workspace');
  await expect(page.getByRole('heading', { level: 1, name: 'Workspace' })).toBeVisible();
  await page.getByLabel('Agency name').fill('Agence SBH');
  await page.getByLabel('Address', { exact: true }).fill('1 rue de la République');
  await page.getByLabel('City').fill('Gustavia');
  await page.getByLabel('Postal code').fill('97133');
  await page.getByRole('combobox', { name: 'Country' }).click();
  await page.getByPlaceholder('Search countries…').fill('Barth');
  await page.getByRole('option', { name: 'St. Barthélemy' }).click();
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Workspace settings saved.')).toBeVisible();
  await expect(page.getByText('Outreach is not ready yet')).toHaveCount(0);
  await page.reload();
  await expect(page.getByLabel('City')).toHaveValue('Gustavia');
});

test('feature flags: deployment-disabled ones cannot be switched on', async ({ page }) => {
  await page.goto('/settings/features');
  await expect(page.getByRole('switch', { name: 'Automatic sending' })).toBeDisabled();
  // Semantic search has no deployment switch (always available).
  const semantic = page.getByRole('switch', { name: 'Semantic search' });
  await expect(semantic).toBeEnabled();
  const before = await semantic.getAttribute('aria-checked');
  await semantic.click();
  await expect(page.getByText('Feature updated.')).toBeVisible();
  await expect(semantic).not.toHaveAttribute('aria-checked', before ?? '');
});

for (const path of ['/settings/workspace', '/settings/integrations', '/settings/audit']) {
  test(`${path} has no serious or critical axe violations`, async ({ page }) => {
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await page.waitForLoadState('networkidle');
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')).toEqual([]);
  });
}
