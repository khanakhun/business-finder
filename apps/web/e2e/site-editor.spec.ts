import salon from '@bf/site-schema/fixtures/salon-gustavia.json' with { type: 'json' };
import type { Page } from '@playwright/test';
import { apiUrl, webUrl } from './env.ts';
import { expect, test } from './fixtures.ts';

// The site editor (BF-037): a fixture site opened on Puck's canvas, a text edited in two languages and saved as a
// new version through the operations API; a save after someone else's is a conflict, never an overwrite.

const run = Date.now().toString(36);

async function createSite(page: Page, name: string): Promise<string> {
  const business = await page.request.post(`${apiUrl}/v1/businesses`, {
    data: { countryCode: 'BL', displayName: `${name} ${run}`, locality: 'Gustavia' },
    headers: { Origin: webUrl },
  });
  expect(business.status(), await business.text()).toBe(201);
  const { id: businessId } = (await business.json()) as { id: string };
  const site = await page.request.post(`${apiUrl}/v1/sites`, {
    data: { businessId, spec: salon },
    headers: { Origin: webUrl },
  });
  expect(site.status(), await site.text()).toBe(201);
  return ((await site.json()) as { id: string }).id;
}

async function currentVersion(page: Page, siteId: string) {
  const response = await page.request.get(`${apiUrl}/v1/sites/${siteId}`, { headers: { Origin: webUrl } });
  return ((await response.json()) as { currentVersion: { id: string; versionNumber: number } })
    .currentVersion;
}

const canvas = (page: Page) => page.frameLocator('iframe').first();
/** A text input of the fields panel (Puck also keeps a hidden copy of the panel for small screens). */
const field = (page: Page, name: string) =>
  page.getByRole('textbox', { name, exact: true }).filter({ visible: true });

test('edits the hero title in French and English, and saves a new version with its change summary', async ({
  page,
}) => {
  const siteId = await createSite(page, 'Salon éditeur');
  await page.goto(`/sites/${siteId}/edit`);
  const hero = canvas(page).getByRole('heading', { level: 1 });
  await expect(hero).toHaveText('Coiffure et soins à Gustavia');
  await hero.click();

  await field(page, 'Title (FR)').fill('Coiffure, soins et couleur à Gustavia');
  await expect(hero).toHaveText('Coiffure, soins et couleur à Gustavia');
  await expect(page.getByText('Unsaved changes')).toBeVisible();

  await page.getByLabel('Language').selectOption('en');
  await expect(hero).toHaveText('Hair and care in Gustavia');
  await field(page, 'Title (EN)').fill('Hair, care and colour in Gustavia');
  await expect(hero).toHaveText('Hair, care and colour in Gustavia');

  await page.keyboard.press('ControlOrMeta+s');
  await expect(page.getByText('Saved as version 2')).toBeVisible();
  await expect(page.getByText('All changes saved')).toBeVisible();

  const version = await currentVersion(page, siteId);
  expect(version.versionNumber).toBe(2);
  const saved = await page.request.get(`${apiUrl}/v1/sites/${siteId}/versions/${version.id}`, {
    headers: { Origin: webUrl },
  });
  const body = (await saved.json()) as {
    changeSummary: string;
    spec: { pages: { blocks: { props: { title?: Record<string, string> } }[] }[] };
  };
  expect(body.spec.pages[0]?.blocks[0]?.props.title).toEqual({
    fr: 'Coiffure, soins et couleur à Gustavia',
    en: 'Hair, care and colour in Gustavia',
  });
  expect(body.changeSummary).toBeTruthy();
});

test('stops a save made after someone else’s and loads the latest version', async ({ page }) => {
  const siteId = await createSite(page, 'Salon conflit');
  await page.goto(`/sites/${siteId}/edit`);
  const hero = canvas(page).getByRole('heading', { level: 1 });
  await hero.click();
  await field(page, 'Title (FR)').fill('Une modification locale');

  // Someone else saves first, from the same version.
  const v1 = await currentVersion(page, siteId);
  const other = await page.request.post(`${apiUrl}/v1/sites/${siteId}/operations`, {
    data: {
      baseVersionId: v1.id,
      operations: [
        { op: 'updateText', path: ['seo', 'title'], locale: 'fr', value: 'Salon Lumière à Gustavia' },
      ],
    },
    headers: { Origin: webUrl },
  });
  expect(other.status(), await other.text()).toBe(201);

  await page.getByRole('button', { name: 'Save' }).click();
  const dialog = page.getByRole('dialog', { name: 'Someone else saved this site' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Load the latest version' }).click();
  await expect(page.getByRole('heading', { name: /Version 2/ })).toBeVisible();
  await expect(hero).toHaveText('Coiffure et soins à Gustavia');
  expect((await currentVersion(page, siteId)).versionNumber).toBe(2);
});
