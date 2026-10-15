import AxeBuilder from '@axe-core/playwright';
import { expect, test } from './fixtures.ts';

// The search journey (BF-023) on the fake discovery provider (fixture businesses in Saint-Barthélemy, no cost) and
// the rule-based intent reading (no model key in e2e): prompt → chips → discovery → results → save → list → map.
test.describe.configure({ mode: 'serial' });

const PROMPT = 'restaurants à Saint-Barthélemy';

test('turns a French prompt into chips, discovers businesses live and lists them', async ({ page }) => {
  // A fresh worker may first wait out stalled jobs of earlier local runs (BullMQ lock expiry).
  test.setTimeout(120_000);
  await page.goto('/search');
  const prompt = page.getByLabel('Describe the businesses you are looking for');
  await prompt.fill(PROMPT);
  await prompt.press('Enter');
  const chips = page.getByRole('region', { name: 'Search filters' });
  await expect(chips.getByRole('button', { name: /Restaurant/ })).toBeVisible();
  await expect(chips.getByRole('button', { name: /^in Saint.Barth/ })).toBeVisible();
  await expect(page).toHaveURL(/prompt=restaurants/);

  // Discovery: only the fake provider, estimate, start, live progress, completion.
  await page.getByRole('button', { name: 'Find more businesses' }).click();
  const panel = page.getByRole('dialog', { name: 'Find new businesses' });
  for (const box of await panel.getByRole('checkbox').all()) {
    const label = await panel.locator(`label[for="${await box.getAttribute('id')}"]`).textContent();
    if (!/fake|fictif|test/i.test(label ?? '') && (await box.getAttribute('data-state')) === 'checked')
      await box.click();
  }
  await panel.getByRole('button', { name: 'Estimate cost' }).click();
  await expect(panel.getByText(/requests/)).toBeVisible();
  await panel.getByRole('button', { name: 'Start discovery' }).click();
  await expect(page.getByText(/Discovery finished: \d+ new businesses/)).toBeVisible({ timeout: 90_000 });
  await panel.getByRole('button', { name: 'Close' }).first().click();

  // The table follows the run.
  await expect(chips.getByRole('button', { name: 'Remove found by this discovery run' })).toBeVisible();
  await expect(page.getByRole('row').filter({ hasText: 'Restaurant Fictif La Plage' })).toBeVisible();
});

test('edits a chip without re-reading the prompt, saves the search and restores it', async ({ page }) => {
  await page.goto(`/search?prompt=${encodeURIComponent(PROMPT)}`);
  await page.getByLabel('Describe the businesses you are looking for').press('Enter');
  const chips = page.getByRole('region', { name: 'Search filters' });
  await chips
    .getByRole('button', { name: /^Remove place/ })
    .first()
    .click();
  await expect(page).not.toHaveURL(/area=/);
  await expect(page.getByRole('row').filter({ hasText: 'Pizzeria Imaginaire' })).toBeVisible();

  await page.keyboard.press('s');
  const dialog = page.getByRole('dialog', { name: 'Save search' });
  await dialog.getByLabel('Name').fill('Restaurants e2e');
  await dialog.getByRole('button', { name: 'Save search' }).click();
  await expect(page.getByText('Search saved')).toBeVisible();

  await page.goto('/search/saved');
  await page
    .getByRole('listitem')
    .filter({ hasText: 'Restaurants e2e' })
    .getByRole('link', { name: 'Open' })
    .click();
  await expect(page).toHaveURL(/category=/);
  await expect(
    page.getByRole('region', { name: 'Search filters' }).getByRole('button', { name: /Restaurant/ }),
  ).toBeVisible();
});

test('selects rows with the keyboard and adds them to a list; toggles the map', async ({ page }) => {
  await page.goto(`/search?prompt=${encodeURIComponent(PROMPT)}`);
  await page.getByLabel('Describe the businesses you are looking for').press('Enter');
  await expect(page.getByRole('row').nth(1)).toBeVisible();
  await page
    .getByRole('heading', { level: 1 })
    .click({ force: true })
    .catch(() => undefined);
  await page.locator('body').click();
  for (let i = 0; i < 2; i++) {
    await page.keyboard.press('j');
    await page.keyboard.press('x');
  }
  const bar = page.getByRole('toolbar');
  await expect(bar.getByText('2 selected')).toBeVisible();
  await bar.getByRole('button', { name: 'Add to list' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add to a list' });
  const name = `E2E list ${Date.now()}`;
  await dialog.getByLabel('New list').fill(name);
  await dialog.getByRole('button', { name: 'Create list' }).click();
  await expect(page.getByText(new RegExp(`2 businesses added to ${name}`))).toBeVisible();
  await page.goto('/lists');
  await expect(page.getByRole('listitem').filter({ hasText: name })).toContainText('2 businesses');

  await page.goto(`/search?prompt=${encodeURIComponent(PROMPT)}&view=map`);
  await expect(page.getByRole('region', { name: 'Map of the results' })).toBeVisible();
  await page.keyboard.press('m');
  await expect(page).not.toHaveURL(/view=map/); // table is the default view (not in the URL)
});

test('has no detectable accessibility violations', async ({ page }) => {
  await page.goto(`/search?prompt=${encodeURIComponent(PROMPT)}`);
  await expect(page.getByLabel('Describe the businesses you are looking for')).toBeVisible();
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  expect(results.violations).toEqual([]);
});
