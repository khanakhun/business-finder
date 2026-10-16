import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { apiUrl, webUrl } from './env.ts';
import { expect, test } from './fixtures.ts';

// The scoring profile editor (BF-032): duplicate a built-in profile, change a weight, see the live preview move,
// save a version, activate it (the workspace recomputes, with progress), make it primary: the listing's order follows.
test.describe.configure({ mode: 'serial' });

const run = `${Date.now().toString(36)}`;
const label = `editor-${run}`;
let spots = 0;
const spot = () => {
  spots += 1;
  const seed = (Number.parseInt(run, 36) % 991) / 991;
  return {
    lat: 17.88 + ((seed + spots * 0.11) % 1) * 0.04,
    lng: -62.87 + ((seed * 7 + spots * 0.17) % 1) * 0.06,
  };
};

async function createBusiness(page: Page, body: Record<string, unknown>): Promise<string> {
  const response = await page.request.post(`${apiUrl}/v1/businesses`, {
    data: { countryCode: 'BL', location: spot(), ...body },
    headers: { Origin: webUrl },
  });
  expect(response.status(), await response.text()).toBe(201);
  const id = ((await response.json()) as { id: string }).id;
  const tagged = await page.request.post(`${apiUrl}/v1/businesses/${id}/tags`, {
    data: { add: [label] },
    headers: { Origin: webUrl },
  });
  expect(tagged.ok(), await tagged.text()).toBe(true);
  // Scored now (the tracked event scores it too, a little later).
  const scored = await page.request.post(`${apiUrl}/v1/businesses/${id}/scores/recompute`, {
    headers: { Origin: webUrl },
  });
  expect(scored.ok(), await scored.text()).toBe(true);
  return id;
}

async function builtinPrimary(page: Page) {
  const profiles = await page.request.get(`${apiUrl}/v1/scoring/profiles`, { headers: { Origin: webUrl } });
  const items = ((await profiles.json()) as { items: { id: string; name: string; builtin: boolean }[] })
    .items;
  const builtin = items.find((profile) => profile.builtin && profile.name === 'New website');
  if (!builtin) throw new Error('no built-in new website profile');
  return builtin.id;
}

/** The listing's rows for this run, in their order. */
async function order(page: Page): Promise<string[]> {
  await page.goto(`/search?tag=${label}&sort=-score&mode=listings`);
  const rows = page.getByRole('row').filter({ hasText: run });
  await expect(rows).toHaveCount(2);
  return (await rows.allInnerTexts()).map((text) => (text.includes(`Appel ${run}`) ? 'phone' : 'quiet'));
}

test('tunes a profile with a live preview, saves, activates and reorders the listing', async ({ page }) => {
  await createBusiness(page, { displayName: `Appel ${run}`, phone: '+590 590 00 00 01' });
  await createBusiness(page, { displayName: `Silence ${run}` });
  // With the built-in profile, the phone counts for the business.
  await expect.poll(() => order(page), { timeout: 30_000 }).toEqual(['phone', 'quiet']);

  try {
    await page.goto('/settings/scoring');
    await expect(page.getByRole('heading', { level: 1, name: 'Scoring' })).toBeVisible();
    await page.getByRole('button', { name: 'Actions for New website' }).click();
    await page.getByRole('menuitem', { name: 'Duplicate' }).click();
    const dialog = page.getByRole('dialog', { name: 'Duplicate a profile' });
    await dialog.getByLabel('Name').fill(`Phone-averse ${run}`);
    await dialog.getByRole('button', { name: 'Duplicate' }).click();
    await expect(page).toHaveURL(/\/settings\/scoring\/[0-9a-f-]{36}$/);
    await expect(page.getByRole('heading', { level: 2, name: `Phone-averse ${run}` })).toBeVisible();

    // The draft: a phone now counts against.
    await expect(page.getByTestId('preview-status')).toBeVisible({ timeout: 30_000 });
    await page.getByRole('spinbutton', { name: 'Phone', exact: true }).fill('-100');
    await expect(page.getByText(/Unsaved changes, started from version 1/)).toBeVisible();
    await expect(page.getByTestId('top-movers')).toContainText(`Appel ${run}`, { timeout: 30_000 });
    await expect(page.getByTestId('preview-correlation')).toBeVisible();

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa'])
      .exclude('[data-sonner-toaster]')
      .analyze();
    expect(results.violations).toEqual([]);

    await page.getByRole('button', { name: 'Save as a new version' }).click();
    await expect(page.getByText('Version 2 saved.', { exact: false })).toBeVisible();
    await page.getByRole('button', { name: 'Activate version 2' }).click();
    await expect(page.getByText(/Version 2 activated/)).toBeVisible();
    await expect(page.getByText(/Recompute finished/)).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole('button', { name: 'Active version' })).toBeDisabled();

    // The listing follows the profile once it is primary.
    await page.goto(`/search?tag=${label}&sort=-score&mode=listings`);
    await page.getByRole('combobox', { name: 'Profile behind the score column' }).click();
    await page.getByRole('option', { name: `Phone-averse ${run}` }).click();
    await expect(
      page.getByText(`The listing now follows Phone-averse ${run}`, { exact: false }),
    ).toBeVisible();
    await expect.poll(() => order(page), { timeout: 30_000 }).toEqual(['quiet', 'phone']);
  } finally {
    // Other specs read the built-in new-website profile as primary.
    const reset = await page.request.put(`${apiUrl}/v1/scoring/primary-profile`, {
      data: { profileId: await builtinPrimary(page) },
      headers: { Origin: webUrl },
    });
    expect(reset.ok(), await reset.text()).toBe(true);
  }
});

test.describe('in French', () => {
  test.use({ locale: 'fr-FR' });

  test('reads the scoring settings and a built-in profile in French', async ({ page }) => {
    await page.goto('/settings/scoring');
    await expect(page.getByRole('heading', { name: 'Profils intégrés' })).toBeVisible();
    await page.goto(`/settings/scoring/${await builtinPrimary(page)}`);
    await expect(page.getByText(/Les profils intégrés sont en lecture seule/)).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Poids' })).toBeVisible();
    await expect(page.getByRole('spinbutton', { name: 'Téléphone', exact: true })).toBeDisabled();
  });
});
