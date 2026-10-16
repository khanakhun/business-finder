import salon from '@bf/site-schema/fixtures/salon-gustavia.json' with { type: 'json' };
import { type Page, request as playwrightRequest } from '@playwright/test';
import { apiUrl, webUrl } from './env.ts';
import { expect, test } from './fixtures.ts';
import { browserHeaders, createVerifiedUser } from './users.ts';

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

  // The canvas is the site's content only: no script, no inline handler (it shares the dashboard's origin).
  expect(await canvas(page).locator('script').count()).toBe(0);
  expect(await canvas(page).locator('[onclick], [onload], [onerror], [onmouseover]').count()).toBe(0);

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

test('shows a viewer the canvas read-only, with no save', async ({ page, browser }) => {
  const siteId = await createSite(page, 'Salon lecture');
  const me = await page.request.get(`${apiUrl}/v1/me`, { headers: { Origin: webUrl } });
  const { activeOrganization } = (await me.json()) as { activeOrganization: { id: string } };

  const request = await playwrightRequest.newContext();
  const viewer = await createVerifiedUser(request, 'site-viewer');
  const invited = await page.request.post(`${apiUrl}/v1/invitations`, {
    data: { email: viewer.email, role: 'viewer' },
    headers: { Origin: webUrl },
  });
  expect(invited.status(), await invited.text()).toBe(201);
  const { id: invitationId } = (await invited.json()) as { id: string };
  const headers = browserHeaders();
  await expect(
    await request.post(`${apiUrl}/api/auth/organization/accept-invitation`, {
      data: { invitationId },
      headers,
    }),
  ).toBeOK();
  await expect(
    await request.post(`${apiUrl}/api/auth/organization/set-active`, {
      data: { organizationId: activeOrganization.id },
      headers,
    }),
  ).toBeOK();
  const context = await browser.newContext({ storageState: await request.storageState() });
  await request.dispose();
  const viewerPage = await context.newPage();
  try {
    await viewerPage.goto(`${webUrl}/sites/${siteId}/edit`);
    const hero = canvas(viewerPage).getByRole('heading', { level: 1 });
    await expect(hero).toHaveText('Coiffure et soins à Gustavia');
    await expect(viewerPage.getByText('Read only')).toBeVisible();
    await expect(viewerPage.getByRole('button', { name: 'Save' })).toHaveCount(0);
    // The page's fields (shown with nothing selected) are locked.
    await expect(field(viewerPage, 'Page name (FR)')).not.toBeEditable();
    await expect(field(viewerPage, 'Search title (FR)')).not.toBeEditable();
  } finally {
    await context.close();
  }
});

test('keeps what is typed while a save runs, and sends one save at a time', async ({ page }) => {
  const siteId = await createSite(page, 'Salon pendant');
  await page.goto(`/sites/${siteId}/edit`);
  await canvas(page).getByRole('heading', { level: 1 }).click();
  const title = field(page, 'Title (FR)');
  await title.fill('Coiffure à Gustavia');

  // The save request waits until released.
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let saves = 0;
  await page.route(`**/v1/sites/${siteId}/operations`, async (route) => {
    saves += 1;
    await held;
    await route.continue();
  });
  await page.keyboard.press('ControlOrMeta+s');
  await expect(page.getByRole('button', { name: 'Saving…' })).toBeVisible();
  await title.fill('Coiffure et couleur à Gustavia ');
  await page.keyboard.press('ControlOrMeta+s');
  release();
  await expect(page.getByText('Saved as version 2')).toBeVisible();
  expect(saves).toBe(1);
  // What was typed during the save is still there, and still to save.
  await expect(title).toHaveValue('Coiffure et couleur à Gustavia ');
  await expect(page.getByText('Unsaved changes')).toBeVisible();

  await page.unroute(`**/v1/sites/${siteId}/operations`);
  await page.keyboard.press('ControlOrMeta+s');
  await expect(page.getByText('Saved as version 3')).toBeVisible();
  // Stored trimmed: nothing is left to save (no empty versions).
  await expect(page.getByText('All changes saved')).toBeVisible();
  expect((await currentVersion(page, siteId)).versionNumber).toBe(3);
});
