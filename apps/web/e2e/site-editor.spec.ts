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
  await expect(page.getByText('Unsaved changes', { exact: true })).toBeVisible();

  await page.getByRole('combobox', { name: 'Language', exact: true }).selectOption('en');
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
  await expect(page.getByText('Unsaved changes', { exact: true })).toBeVisible();

  await page.unroute(`**/v1/sites/${siteId}/operations`);
  await page.keyboard.press('ControlOrMeta+s');
  await expect(page.getByText('Saved as version 3')).toBeVisible();
  // Stored trimmed: nothing is left to save (no empty versions).
  await expect(page.getByText('All changes saved')).toBeVisible();
  expect((await currentVersion(page, siteId)).versionNumber).toBe(3);
});

/** Opens one of the editor's side panels (Puck's plugin tabs). */
async function openPanel(page: Page, name: 'Site' | 'Pages' | 'Issues') {
  await page.getByRole('navigation').getByText(name, { exact: true }).click();
}

async function savedSpec(page: Page, siteId: string) {
  const version = await currentVersion(page, siteId);
  const response = await page.request.get(`${apiUrl}/v1/sites/${siteId}/versions/${version.id}`, {
    headers: { Origin: webUrl },
  });
  return {
    version,
    spec: ((await response.json()) as { spec: Record<string, unknown> }).spec as {
      theme: { radius: string };
      pages: { id: string; blocks: { props: Record<string, unknown> }[] }[];
      navigation: { items: { pageId: string }[] };
      seo: { title: Record<string, string> };
    },
  };
}

test('changes the theme and adds a page from a template, saved as one version', async ({ page }) => {
  const siteId = await createSite(page, 'Salon réglages');
  await page.goto(`/sites/${siteId}/edit`);
  await expect(canvas(page).getByRole('heading', { level: 1 })).toBeVisible();

  await openPanel(page, 'Site');
  await page.getByLabel('Corners').selectOption('none');
  await openPanel(page, 'Pages');
  await page.getByLabel('Add a page…').selectOption('faq');
  // The new page is open on the canvas.
  await expect(page.getByRole('combobox', { name: 'Page', exact: true })).toHaveValue('faq');
  await expect(canvas(page).getByRole('heading', { level: 1 })).toHaveText('FAQ');

  await page.keyboard.press('ControlOrMeta+s');
  await expect(page.getByText(/Saved as version 2/)).toBeVisible();
  const { spec } = await savedSpec(page, siteId);
  expect(spec.theme.radius).toBe('none');
  expect(spec.pages.map((candidate) => candidate.id)).toContain('faq');
  expect(spec.navigation.items.map((item) => item.pageId)).toContain('faq');
});

test('lists a missing translation as an issue and takes the person to its field', async ({ page }) => {
  const siteId = await createSite(page, 'Salon problèmes');
  await page.goto(`/sites/${siteId}/edit`);
  await canvas(page).getByRole('heading', { level: 1 }).click();
  await page.getByRole('combobox', { name: 'Language', exact: true }).selectOption('en');
  await field(page, 'Title (EN)').fill('');
  await expect(page.getByText('1 error', { exact: true })).toBeVisible();

  await openPanel(page, 'Issues');
  await page
    .getByRole('button', { name: /Translation missing/ })
    .first()
    .click();
  await expect(field(page, 'Title (EN)')).toBeFocused();

  // A draft keeps its errors (publishing will refuse them).
  await page.keyboard.press('ControlOrMeta+s');
  await expect(page.getByText(/Saved as version 2, with 1 problem to fix before publishing/)).toBeVisible();
});

test('offers back unsaved changes after a reload', async ({ page }) => {
  const siteId = await createSite(page, 'Salon brouillon');
  await page.goto(`/sites/${siteId}/edit`);
  await canvas(page).getByRole('heading', { level: 1 }).click();
  await field(page, 'Title (FR)').fill('Un titre pas encore enregistré');
  // Kept in the browser a moment after the change.
  await expect
    .poll(() =>
      page.evaluate(
        (id) =>
          new Promise<boolean>((resolve) => {
            const request = indexedDB.open('bf-site-editor', 1);
            request.onsuccess = () => {
              const db = request.result;
              if (!db.objectStoreNames.contains('drafts')) return resolve(false);
              const get = db.transaction('drafts').objectStore('drafts').get(id);
              get.onsuccess = () => resolve(get.result !== undefined);
              get.onerror = () => resolve(false);
            };
            request.onerror = () => resolve(false);
          }),
        siteId,
      ),
    )
    .toBe(true);
  page.once('dialog', (dialog) => void dialog.accept());
  await page.reload();
  const offer = page.getByRole('dialog', { name: 'Unsaved changes found' });
  await expect(offer).toBeVisible();
  await offer.getByRole('button', { name: 'Restore' }).click();
  await expect(canvas(page).getByRole('heading', { level: 1 })).toHaveText('Un titre pas encore enregistré');
  await expect(page.getByText('Unsaved changes', { exact: true })).toBeVisible();
});

test('re-applies local changes on the version someone else saved', async ({ page }) => {
  const siteId = await createSite(page, 'Salon rebase');
  await page.goto(`/sites/${siteId}/edit`);
  await canvas(page).getByRole('heading', { level: 1 }).click();
  await field(page, 'Title (FR)').fill('Notre titre à nous');

  const v1 = await currentVersion(page, siteId);
  const other = await page.request.post(`${apiUrl}/v1/sites/${siteId}/operations`, {
    data: {
      baseVersionId: v1.id,
      operations: [{ op: 'updateText', path: ['seo', 'title'], locale: 'fr', value: 'Leur titre de site' }],
    },
    headers: { Origin: webUrl },
  });
  expect(other.status(), await other.text()).toBe(201);

  await page.keyboard.press('ControlOrMeta+s');
  await page
    .getByRole('dialog', { name: 'Someone else saved this site' })
    .getByRole('button', {
      name: 'Re-apply my changes on it',
    })
    .click();
  const rebase = page.getByRole('dialog', { name: 'Re-apply your changes' });
  await expect(rebase).toContainText('1 change applies on version 2');
  await rebase.getByRole('button', { name: 'Keep the result' }).click();
  await page.keyboard.press('ControlOrMeta+s');
  await expect(page.getByText(/Saved as version 3/)).toBeVisible();
  const { spec } = await savedSpec(page, siteId);
  expect(spec.seo.title.fr).toBe('Leur titre de site');
  expect(spec.pages[0]?.blocks[0]?.props.title).toMatchObject({ fr: 'Notre titre à nous' });
});
