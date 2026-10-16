import AxeBuilder from '@axe-core/playwright';
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
            // Drafts are keyed by person, workspace and site: any key ending with this site's id.
            const request = indexedDB.open('bf-site-editor');
            request.onsuccess = () => {
              const db = request.result;
              if (!db.objectStoreNames.contains('drafts')) return resolve(false);
              const keys = db.transaction('drafts').objectStore('drafts').getAllKeys();
              keys.onsuccess = () => resolve(keys.result.some((key) => String(key).endsWith(`:${id}`)));
              keys.onerror = () => resolve(false);
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

// ── Part 3: versions, publishing, images, JSON mode, shortcuts, accessibility, performance ─────────────────────

/** A 1×1 PNG, answered for the fixtures' image host (nothing is served there in the e2e). */
const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

async function serveImages(page: Page) {
  await page.route('https://assets.bf-sites.test/**', (route) =>
    route.fulfill({ status: 200, contentType: 'image/png', body: PIXEL }),
  );
}

test('lists versions, shows what changed, views one read-only and restores it as a new version', async ({
  page,
}) => {
  const siteId = await createSite(page, 'Salon versions');
  await page.goto(`/sites/${siteId}/edit`);
  const hero = canvas(page).getByRole('heading', { level: 1 });
  await hero.click();
  await field(page, 'Title (FR)').fill('Un nouveau titre');
  await page.keyboard.press('ControlOrMeta+s');
  await expect(page.getByText('Saved as version 2')).toBeVisible();

  await page.getByRole('button', { name: 'Versions' }).click();
  const drawer = page.getByRole('dialog', { name: 'Versions' });
  await expect(drawer.getByText('Version 2')).toBeVisible();
  await expect(drawer.getByText('Current')).toBeVisible();
  await drawer.getByRole('button', { name: 'Changes' }).first().click();
  const diff = page.getByRole('dialog', { name: 'Changes from version 1 to version 2' });
  await expect(diff.getByText('Coiffure et soins à Gustavia')).toBeVisible();
  await expect(diff.getByText('Un nouveau titre')).toBeVisible();
  await page.keyboard.press('Escape');

  // Version 1, read-only on the canvas; the editor comes back as it was.
  await drawer.getByRole('button', { name: 'View' }).nth(1).click();
  await expect(page.getByText('Viewing version 1 (read only)')).toBeVisible();
  await expect(hero).toHaveText('Coiffure et soins à Gustavia');
  await page.getByRole('button', { name: 'Back to editing' }).click();
  await expect(hero).toHaveText('Un nouveau titre');

  await page.getByRole('button', { name: 'Versions' }).click();
  await drawer.getByRole('button', { name: 'Restore' }).click();
  await page
    .getByRole('dialog', { name: 'Restore version 1?' })
    .getByRole('button', { name: 'Restore' })
    .click();
  await expect(page.getByText('Version 1 restored as version 3')).toBeVisible();
  await expect(hero).toHaveText('Coiffure et soins à Gustavia');
  const restored = await savedSpec(page, siteId);
  expect(restored.version.versionNumber).toBe(3);
  expect(restored.spec.pages[0]?.blocks[0]?.props.title).toMatchObject({
    fr: 'Coiffure et soins à Gustavia',
  });
});

test('publishes the preview, extends and unpublishes it; errors block publishing', async ({ page }) => {
  const siteId = await createSite(page, 'Salon publication');
  await page.goto(`/sites/${siteId}/edit`);
  await expect(canvas(page).getByRole('heading', { level: 1 })).toBeVisible();

  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  await page.getByRole('button', { name: 'Publish version 1' }).click();
  await expect(page.getByText('Version 1 published')).toBeVisible();
  const site = await page.request.get(`${apiUrl}/v1/sites/${siteId}`, { headers: { Origin: webUrl } });
  const { preview } = (await site.json()) as { preview: { url: string } | null };
  expect(preview?.url).toBeTruthy();
  await expect(page.getByRole('link', { name: new RegExp(preview?.url ?? '') })).toBeVisible();
  await page.getByRole('button', { name: 'Extend by 30 days' }).click();
  await expect(page.getByText('Preview extended by 30 days')).toBeVisible();
  await page.getByRole('button', { name: 'Unpublish' }).click();
  await page.getByRole('button', { name: 'Confirm: take it offline' }).click();
  await expect(page.getByText('Preview taken offline')).toBeVisible();
  await page.keyboard.press('Escape');

  // A missing translation is an error: saved, but not publishable.
  await canvas(page).getByRole('heading', { level: 1 }).click();
  await page.getByRole('combobox', { name: 'Language', exact: true }).selectOption('en');
  await field(page, 'Title (EN)').fill('');
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(page.getByText('Save your changes before publishing.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Publish version 1' })).toBeDisabled();
  await page.keyboard.press('Escape');
  await page.keyboard.press('ControlOrMeta+s');
  await expect(page.getByText(/Saved as version 2, with 1 problem/)).toBeVisible();
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(page.getByText('Fix the errors (Issues panel) before publishing.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Publish version 2' })).toBeDisabled();
});

test('swaps the hero image for another of the site’s, and uploads one with its licence and alt text', async ({
  page,
}) => {
  await serveImages(page);
  const siteId = await createSite(page, 'Salon images');
  await page.goto(`/sites/${siteId}/edit`);
  await canvas(page).getByRole('heading', { level: 1 }).click();
  // The hero's picture (the header's logo comes first on the page).
  const heroImage = canvas(page).locator('main img').first();
  await expect(heroImage).toHaveAttribute('src', /./);

  await page.getByRole('button', { name: 'Change the image for Image' }).filter({ visible: true }).click();
  const picker = page.getByRole('dialog', { name: 'Choose an image' });
  await picker.getByText('Logo du Salon Lumière').click();
  await expect(picker).toBeHidden();

  // An upload: the API's upload, the storage and the processing are answered here (no object storage in the e2e).
  const uploaded = {
    id: '0199a0b0-0000-7000-8000-0000000000aa',
    siteId,
    status: 'processing',
    mime: 'image/png',
    width: 1200,
    height: 800,
    bytes: PIXEL.length,
    publicUrl: null,
    variants: [],
    license: 'uploaded',
    licenseDetails: { author: 'Studio Test' },
    alt: { fr: 'La nouvelle terrasse' },
    dominantColors: null,
    kind: 'image',
    hosting: 'self',
    source: 'upload',
    restrictions: [],
    focalPoint: null,
    analysis: null,
    ownership: null,
    createdAt: new Date().toISOString(),
  };
  const ready = {
    ...uploaded,
    status: 'ready',
    publicUrl: 'https://assets.bf-sites.test/sites/x/new/1200.webp',
  };
  let puts = 0;
  await page.route(`${apiUrl}/v1/sites/${siteId}/assets`, (route) =>
    route.request().method() === 'POST'
      ? route.fulfill({
          status: 201,
          json: {
            asset: { ...uploaded, status: 'pending' },
            uploadUrl: 'https://uploads.bf-sites.test/assets/new',
            method: 'PUT',
            headers: { 'Content-Type': 'image/png' },
            expiresAt: new Date(Date.now() + 600_000).toISOString(),
          },
        })
      : route.fulfill({ status: 200, json: { items: [ready] } }),
  );
  await page.route('https://uploads.bf-sites.test/**', (route) => {
    puts += 1;
    return route.fulfill({ status: 200, body: '' });
  });
  await page.route(`${apiUrl}/v1/sites/${siteId}/assets/*/finalize`, (route) =>
    route.fulfill({ status: 200, json: uploaded }),
  );

  await page.getByRole('button', { name: 'Change the image for Image' }).filter({ visible: true }).click();
  await picker.getByRole('tab', { name: 'Upload' }).click();
  await picker
    .getByLabel('Image file')
    .setInputFiles({ name: 'terrace.png', mimeType: 'image/png', buffer: PIXEL });
  await picker.getByLabel('Alt text (FR) *').fill('La nouvelle terrasse');
  await expect(picker.getByRole('button', { name: 'Upload and use' })).toBeDisabled();
  await picker.getByLabel('Where does it come from? *').selectOption('uploaded');
  await picker.getByLabel('Author').fill('Studio Test');
  await picker.getByRole('button', { name: 'Upload and use' }).click();
  await expect(picker).toBeHidden();
  expect(puts).toBe(1);
  await expect(heroImage).toHaveAttribute('src', ready.publicUrl);

  await page.keyboard.press('ControlOrMeta+s');
  await expect(page.getByText(/Saved as version 2/)).toBeVisible();
  const { spec } = await savedSpec(page, siteId);
  const assets = (spec as unknown as { assets: { id: string; url: string; license: string; alt: unknown }[] })
    .assets;
  const added = assets.find((asset) => asset.url === ready.publicUrl);
  expect(added).toMatchObject({ license: 'uploaded', alt: { fr: 'La nouvelle terrasse' } });
  expect(added?.id).toMatch(/^img_[a-z0-9]{10}$/);
  expect(spec.pages[0]?.blocks[0]?.props.imageAssetId).toBe(added?.id);
});

test('lets an admin edit the site as JSON, saved as a new version', async ({ page }) => {
  const siteId = await createSite(page, 'Salon JSON');
  await page.goto(`/sites/${siteId}/edit`);
  await expect(canvas(page).getByRole('heading', { level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'JSON' }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit as JSON' });
  const editor = dialog.getByRole('textbox', { name: 'Site document (JSON)' });
  // CodeMirror renders the lines in view only: the document's start is there.
  await expect(editor).toContainText('Salon Lumière');
  await expect(dialog.getByText('No problem found.')).toBeVisible();

  const edited = JSON.stringify({ ...salon, theme: { ...salon.theme, radius: 'none' } }, null, 2);
  await editor.click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.insertText('{ "broken": ');
  await expect(dialog.getByText('This is not valid JSON yet.')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Save as a new version' })).toBeDisabled();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.insertText(edited);
  await expect(dialog.getByText('No problem found.')).toBeVisible();
  await dialog.getByRole('button', { name: 'Save as a new version' }).click();
  await expect(page.getByText('Saved as version 2')).toBeVisible();
  const { spec, version } = await savedSpec(page, siteId);
  expect(version.versionNumber).toBe(2);
  expect(spec.theme.radius).toBe('none');
});

test('shows the keyboard shortcuts with ?, and its chrome has no serious axe violation', async ({ page }) => {
  const siteId = await createSite(page, 'Salon a11y');
  await page.goto(`/sites/${siteId}/edit`);
  await expect(canvas(page).getByRole('heading', { level: 1 })).toBeVisible();
  const serious = async (include: string) => {
    const results = await new AxeBuilder({ page })
      .include(include)
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    return results.violations
      .filter((v) => v.impact === 'serious' || v.impact === 'critical')
      .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
  };
  expect(await serious('header')).toEqual([]);

  await page.locator('body').press('?');
  const shortcuts = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
  await expect(shortcuts).toBeVisible();
  expect(await serious('[role="dialog"]')).toEqual([]);
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: 'Versions' }).click();
  await expect(page.getByRole('dialog', { name: 'Versions' }).getByText('Version 1')).toBeVisible();
  expect(await serious('[role="dialog"]')).toEqual([]);
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Publish version 1' })).toBeVisible();
  expect(await serious('[data-slot="popover-content"]')).toEqual([]);
});

test('the editor is interactive within 2.5 s on a fixture site (production build)', async ({ page }) => {
  const siteId = await createSite(page, 'Salon vitesse');
  // Warm the lazy bundle once (a first visit after a build compiles nothing, but the browser cache is cold).
  await page.goto(`/sites/${siteId}/edit`);
  await expect(canvas(page).getByRole('heading', { level: 1 })).toBeVisible();
  const started = Date.now();
  await page.goto(`/sites/${siteId}/edit`);
  await canvas(page).getByRole('heading', { level: 1 }).click();
  await expect(field(page, 'Title (FR)')).toBeEditable();
  const elapsed = Date.now() - started;
  test.info().annotations.push({ type: 'Editor interactive (ms)', description: String(elapsed) });
  expect(elapsed).toBeLessThan(2_500);
});
