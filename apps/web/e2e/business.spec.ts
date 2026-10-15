import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { apiUrl, webUrl } from './env.ts';
import { expect, test } from './fixtures.ts';

// The CRM journeys (BF-024): open a business from search → status → note → task → /tasks → complete; the kanban
// (drag allowed and refused, keyboard alternative); duplicate review and merge; the page in French.
test.describe.configure({ mode: 'serial' });

const run = `${Date.now().toString(36)}`;
// Somewhere in Saint-Barthélemy, different on every run so earlier runs' businesses never look alike.
const spot = () => ({ lat: 17.88 + Math.random() * 0.04, lng: -62.87 + Math.random() * 0.06 });

async function createBusiness(page: Page, body: Record<string, unknown>): Promise<string> {
  const response = await page.request.post(`${apiUrl}/v1/businesses`, {
    data: { countryCode: 'BL', ...body },
    headers: { Origin: webUrl },
  });
  expect(response.status(), await response.text()).toBe(201);
  return ((await response.json()) as { id: string }).id;
}

async function setStatus(page: Page, id: string, status: string, reason?: string) {
  const response = await page.request.post(`${apiUrl}/v1/businesses/${id}/status`, {
    data: { status, ...(reason ? { reason } : {}) },
    headers: { Origin: webUrl },
  });
  expect(response.ok(), await response.text()).toBe(true);
}

async function tag(page: Page, id: string, value: string) {
  const response = await page.request.post(`${apiUrl}/v1/businesses/${id}/tags`, {
    data: { add: [value] },
    headers: { Origin: webUrl },
  });
  expect(response.ok(), await response.text()).toBe(true);
}

/** Drags with real pointer moves (dnd-kit starts a drag after a few pixels). */
async function drag(
  page: Page,
  from: import('@playwright/test').Locator,
  to: import('@playwright/test').Locator,
) {
  const source = await from.boundingBox();
  const target = await to.boundingBox();
  if (!source || !target) throw new Error('nothing to drag');
  await page.mouse.move(source.x + source.width / 2, source.y + 12);
  await page.mouse.down();
  await page.mouse.move(source.x + source.width / 2 + 10, source.y + 20, { steps: 4 });
  await page.mouse.move(target.x + target.width / 2, target.y + 80, { steps: 12 });
  await page.mouse.up();
}

test('works a business: search → page → status → note → task → /tasks', async ({ page }) => {
  const name = `Boulangerie Journey ${run}`;
  await createBusiness(page, { displayName: name, phone: '+33 1 99 00 11 22', location: spot() });

  await page.goto(`/search?q=${encodeURIComponent(name)}`);
  await page.getByRole('row').filter({ hasText: name }).click();
  await page.getByRole('link', { name: 'Open business page' }).click();
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Overview', selected: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Call' })).toHaveAttribute('href', 'tel:+33199001122');

  // Status: only the allowed moves are offered.
  await page.getByRole('button', { name: new RegExp(`Pipeline status of ${name}: New`) }).click();
  await expect(page.getByRole('menuitem')).toHaveText(['Qualified', 'DisqualifiedNeeds a reason']);
  await page.getByRole('menuitem', { name: 'Qualified', exact: true }).click();
  await expect(page.getByText('Moved to Qualified')).toBeVisible();
  await expect(
    page.getByRole('button', { name: new RegExp(`Pipeline status of ${name}: Qualified`) }),
  ).toBeVisible();

  // Tags and do-not-contact (with its reason).
  await page.getByRole('button', { name: 'Add tag' }).click();
  await page.getByLabel('New tag').fill('vip');
  await page.getByLabel('New tag').press('Enter');
  await expect(page.getByRole('group', { name: 'Tags' }).getByText('vip')).toBeVisible();
  await page.getByRole('switch', { name: 'Do not contact' }).click();
  const why = page.getByRole('dialog', { name: 'Mark as do not contact' });
  await why.getByLabel('Reason').fill('Asked us by phone');
  await why.getByRole('button', { name: 'Mark do not contact' }).click();
  await expect(page.getByRole('switch', { name: 'Do not contact' })).toBeChecked();
  await expect(page.getByRole('button', { name: 'WhatsApp' })).toHaveAttribute('aria-disabled', 'true');

  // Activity: a note (markdown, sanitized), a task, and the timeline fed by events.
  await page.getByRole('tab', { name: 'Activity' }).click();
  await expect(page).toHaveURL(/tab=activity/);
  await page.getByLabel('New note').fill('**Owner** prefers WhatsApp <script>alert(1)</script>');
  await page.getByRole('button', { name: 'Add note' }).click();
  const notes = page.getByRole('region', { name: 'Notes' });
  await expect(notes.locator('strong', { hasText: 'Owner' })).toBeVisible();
  await expect(notes.locator('script')).toHaveCount(0);
  const taskTitle = `Call back ${run}`;
  await page.getByLabel('New task').fill(taskTitle);
  await page.getByRole('button', { name: 'Add task' }).click();
  await expect(page.getByText(`Task added: ${taskTitle}`)).toBeVisible();
  const timeline = page.getByRole('region', { name: 'Timeline' });
  await expect(timeline.getByText('Moved from New to Qualified')).toBeVisible({ timeout: 30_000 });
  await expect(timeline.getByText(`Created the task ${taskTitle}`)).toBeVisible({ timeout: 30_000 });

  // My tasks: no due date → upcoming; complete inline.
  await page.goto('/tasks?due=upcoming');
  const row = page.getByRole('listitem').filter({ hasText: taskTitle });
  await expect(row.getByRole('link', { name })).toBeVisible();
  await row.getByRole('checkbox', { name: `Mark ${taskTitle} done` }).click();
  await expect(page.getByText(`Done: ${taskTitle}`)).toBeVisible();
  await page.getByRole('tab', { name: 'Done' }).click();
  await expect(page.getByRole('listitem').filter({ hasText: taskTitle })).toBeVisible();
});

test('kanban: drag along allowed moves, refuse the others, keyboard alternative', async ({ page }) => {
  const label = `kanban-${run}`;
  const mover = `Kanban Mover ${run}`;
  const stuck = `Kanban Stuck ${run}`;
  const keyed = `Kanban Keyboard ${run}`;
  const ids = {
    mover: await createBusiness(page, { displayName: mover, location: spot() }),
    stuck: await createBusiness(page, { displayName: stuck, location: spot() }),
    keyed: await createBusiness(page, { displayName: keyed, location: spot() }),
  };
  for (const id of Object.values(ids)) await tag(page, id, label);
  await setStatus(page, ids.mover, 'qualified');

  await page.goto(`/pipeline?tag=${label}`);
  const column = (status: string) => page.locator(`section[data-status="${status}"]`);
  await expect(column('qualified').getByText(mover)).toBeVisible();
  await expect(column('new')).toContainText('2');

  await drag(page, column('qualified').getByText(mover), column('contacted'));
  await expect(page.getByText(`${mover} moved to Contacted`)).toBeVisible();
  await expect(column('contacted').getByText(mover)).toBeVisible();

  await drag(page, column('new').getByText(stuck), column('contacted'));
  await expect(page.getByText('A business cannot move from New to Contacted')).toBeVisible();
  await expect(column('new').getByText(stuck)).toBeVisible();

  // Keyboard: the card's status menu.
  const menu = page.getByRole('button', { name: new RegExp(`Pipeline status of ${keyed}: New`) });
  await menu.focus();
  await page.keyboard.press('Enter');
  await page.getByRole('menuitem', { name: /^Disqualified/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Why is it Disqualified?' });
  await dialog.getByLabel('Reason').fill('Closed for good');
  await dialog.getByRole('button', { name: 'Move to Disqualified' }).click();
  await expect(column('disqualified').getByText(keyed)).toBeVisible();

  // Toasts fade in and out (mid-animation colours are not what people read).
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa'])
    .exclude('[data-sonner-toaster]')
    .analyze();
  expect(results.violations).toEqual([]);
});

test('reviews a possible duplicate and merges it', async ({ page }) => {
  const at = spot();
  const original = `La Cabane Dupe ${run}`;
  const copy = `Cabane Dupe ${run}`;
  const keep = await createBusiness(page, {
    displayName: original,
    phone: '+33 1 99 00 88 77',
    location: at,
  });
  const dupe = await createBusiness(page, {
    displayName: copy,
    websiteUrl: `https://cabane-dupe-${run}.com`,
    location: { lat: at.lat + 0.0003, lng: at.lng },
  });
  expect(dupe).not.toBe(keep);
  await page.request.post(`${apiUrl}/v1/businesses/${dupe}/notes`, {
    data: { bodyMarkdown: `Note on the copy ${run}` },
    headers: { Origin: webUrl },
  });

  await page.goto(`/businesses/${dupe}`);
  const banner = page.getByRole('region', { name: 'Possible duplicates' });
  await expect(banner).toContainText(original);
  await banner.getByRole('button', { name: 'Compare' }).click();
  const dialog = page.getByRole('dialog', { name: 'Same business?' });
  await expect(dialog.getByRole('cell', { name: original })).toBeVisible();
  await dialog.getByRole('button', { name: `Keep ${original}` }).click();
  await expect(page.getByText('Businesses merged')).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/businesses/${keep}`));
  await page.getByRole('tab', { name: 'Activity' }).click();
  await expect(page.getByText(`Note on the copy ${run}`)).toBeVisible({ timeout: 30_000 });
});

test.describe('in French', () => {
  test.use({ locale: 'fr-FR' });

  test('shows the page, the board and the tasks in French', async ({ page }) => {
    const name = `Épicerie Française ${run}`;
    const id = await createBusiness(page, { displayName: name, location: spot() });
    await page.goto(`/businesses/${id}`);
    await expect(page.getByRole('tab', { name: 'Aperçu' })).toBeVisible();
    await expect(page.getByRole('switch', { name: 'Ne pas contacter' })).toBeVisible();
    await page.getByRole('button', { name: new RegExp(`Statut de ${name} : Nouveau`) }).click();
    await page.getByRole('menuitem', { name: 'Qualifié', exact: true }).click();
    await expect(page.getByText('Passée en Qualifié')).toBeVisible();
    await page.goto('/pipeline');
    await expect(page.getByRole('heading', { level: 1, name: 'Suivi commercial' })).toBeVisible();
    await expect(page.locator('section[data-status="qualified"] h2')).toContainText('Qualifié');
    await page.goto('/tasks');
    await expect(page.getByRole('tab', { name: 'Aujourd’hui' })).toBeVisible();
  });
});

test('has no detectable accessibility violations on the business page', async ({ page }) => {
  const id = await createBusiness(page, { displayName: `A11y Business ${run}`, location: spot() });
  await page.goto(`/businesses/${id}?tab=activity`);
  await expect(page.getByRole('region', { name: 'Timeline' })).toBeVisible();
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  expect(results.violations).toEqual([]);
});

test('enriches a business: Enrich now → live status → Website tab facts (BF-027)', async ({ page }) => {
  const name = `Salon Enrich ${run}`;
  const id = await createBusiness(page, {
    displayName: name,
    websiteUrl: `https://salon-enrich-${run}.com`,
    location: spot(),
  });
  await page.goto(`/businesses/${id}?tab=website`);
  await expect(page.getByText('Website not analysed yet')).toBeVisible();
  await page.getByRole('button', { name: 'Enrich now' }).first().click();
  // The worker runs the steps; realtime moves the status without a reload.
  await expect(page.getByText(/^Completed ·/)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(`hello@salon-enrich-${run}.com`)).toBeVisible();
  await expect(page.getByText('Planity')).toBeVisible();
  await expect(page.getByText('WordPress 6.4')).toBeVisible();
  // Sonner toasts fade out while axe runs (same exclusion as the other pages).
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa'])
    .exclude('[data-sonner-toaster]')
    .analyze();
  expect(results.violations).toEqual([]);
  // The e-mail joined the golden record, with the page that shows it, classified and verified (BF-028).
  await page.getByRole('tab', { name: 'Contacts' }).click();
  const email = `hello@salon-enrich-${run}.com`;
  await expect(page.getByRole('cell', { name: email }).first()).toBeVisible();
  const row = page.getByRole('row').filter({ hasText: email });
  await expect(row.getByText('Shared mailbox')).toBeVisible();
  await expect(row.getByRole('link', { name: 'Found on the contact page' })).toBeVisible();
  await expect(page.getByTestId(`verification-${email}`)).toHaveText('Valid');
  await page.getByTestId(`verification-${email}`).focus();
  await expect(page.getByRole('tooltip')).toContainText('The mailbox exists');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('tooltip')).toBeHidden();
  await row.getByRole('button', { name: `Verify ${email}` }).click();
  await expect(page.getByText('Verification started')).toBeVisible();
  const contactsA11y = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa'])
    .exclude('[data-sonner-toaster]')
    .analyze();
  expect(contactsA11y.violations).toEqual([]);
});
