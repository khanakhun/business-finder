import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { apiUrl, webUrl } from './env.ts';
import { expect, test } from './fixtures.ts';

// Site generation from the dashboard (BF-046), on the fake engine (GENERATION_FAKE_ENGINE, scripted runs):
// select three businesses → café first → one by one → they run in that order → previews; on the board, start a
// waiting job next and cancel the running one; a site waiting for review is published anyway with a reason.
test.describe.configure({ mode: 'serial' });

const run = Date.now().toString(36);
const spot = () => ({ lat: 17.88 + Math.random() * 0.04, lng: -62.87 + Math.random() * 0.06 });

async function createBusiness(page: Page, displayName: string): Promise<string> {
  const response = await page.request.post(`${apiUrl}/v1/businesses`, {
    data: { countryCode: 'BL', displayName, locality: 'Gustavia', phone: '+590590000188', location: spot() },
    headers: { Origin: webUrl },
  });
  expect(response.status(), await response.text()).toBe(201);
  return ((await response.json()) as { id: string }).id;
}

/** New businesses reach the listing asynchronously; a selection is made from the listing. */
async function waitForListing(page: Page, ids: readonly string[]) {
  const query = ids.map((id) => `id=${id}`).join('&');
  await expect
    .poll(
      async () => {
        const response = await page.request.get(`${apiUrl}/v1/businesses?${query}&limit=50`);
        return response.ok() ? ((await response.json()) as { items: unknown[] }).items.length : 0;
      },
      { timeout: 30_000 },
    )
    .toBe(ids.length);
}

interface Job {
  id: string;
  businessName: string;
  status: string;
  startedAt: string | null;
  finishedAt: string | null;
}

async function batchJobs(page: Page, batchId: string): Promise<Job[]> {
  const response = await page.request.get(`${apiUrl}/v1/generation-batches/${batchId}`);
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { jobs: Job[] }).jobs;
}

const byStart = (jobs: Job[]) =>
  jobs
    .filter((job) => job.startedAt)
    .sort((a, b) => Date.parse(a.startedAt as string) - Date.parse(b.startedAt as string));

const card = (page: Page, name: string) => page.locator('article').filter({ hasText: name });

test('creates sites one by one in the chosen order, with previews (BF-046)', async ({ page }) => {
  test.setTimeout(180_000);
  const salon = `Salon Lumière ${run}`;
  const hardware = `Quincaillerie du Port ${run}`;
  const cafe = `Café des Marins ${run}`;
  const ids = [
    await createBusiness(page, salon),
    await createBusiness(page, hardware),
    await createBusiness(page, cafe),
  ];

  await waitForListing(page, ids);
  await page.goto(`/generation/new?ids=${ids.join(',')}`);
  await expect(page.getByRole('heading', { name: 'Create sites' })).toBeVisible();
  const order = page.getByRole('list', { name: 'Order (first starts first)' });
  await expect(order.locator('[data-item-id]')).toHaveCount(3);
  // Café first, with the keyboard alternative to dragging.
  await page.getByRole('button', { name: `Move ${cafe} up` }).click();
  await page.getByRole('button', { name: `Move ${cafe} up` }).click();
  await expect(order.locator('[data-item-id]').first()).toContainText(cafe);
  // Every item on the fake engine, with the assign helper.
  await page.getByRole('button', { name: 'Assign engines…' }).click();
  await page.getByLabel('Pattern').fill('rest fake');
  await expect(page.getByText('3 × Fake (tests)')).toBeVisible();
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect(page.getByRole('combobox', { name: `Engine for ${cafe}` })).toContainText('Fake (tests)');
  // The brief of an item, before it runs.
  await order.locator('[data-item-id]').first().getByRole('button', { name: 'Brief' }).click();
  await expect(page.getByText('Pages', { exact: true }).first()).toBeVisible();
  await page.getByLabel('One by one, in this order').check();
  await expect(page.getByTestId('estimate-cost')).toHaveText('$0.15');

  const axe = await new AxeBuilder({ page }).analyze();
  expect(axe.violations.map((violation) => violation.id)).toEqual([]);

  await page.getByRole('button', { name: 'Create 3 sites' }).click();
  await expect(page).toHaveURL(/\/generation\/batches\/[0-9a-f-]+$/);
  const batchId = page.url().split('/').at(-1) as string;
  // Live from realtime: each becomes ready, with its preview link.
  await expect(page.getByTestId('job-status').filter({ hasText: 'Ready' })).toHaveCount(3, {
    timeout: 150_000,
  });
  await expect(page.getByTestId('preview-url')).toHaveCount(3);
  await expect(page.getByTestId('batch-status')).toHaveText('Completed');

  const jobs = byStart(await batchJobs(page, batchId));
  expect(jobs.map((job) => job.businessName)).toEqual([cafe, salon, hardware]);
  // Strictly one at a time: each starts once the previous one has finished.
  for (let i = 1; i < jobs.length; i++)
    expect(Date.parse(jobs[i]?.startedAt as string)).toBeGreaterThanOrEqual(
      Date.parse(jobs[i - 1]?.finishedAt as string),
    );
});

test('starts a waiting job next and cancels the running one from the board (BF-046)', async ({ page }) => {
  test.setTimeout(180_000);
  // "(slow)" makes the fake engine run ten times longer: time to act on the board while it runs.
  const first = `Boutique Lente (slow) ${run}`;
  const second = `Bijouterie Anse ${run}`;
  const third = `Pâtisserie Colombier ${run}`;
  const items = [
    await createBusiness(page, first),
    await createBusiness(page, second),
    await createBusiness(page, third),
  ];
  const created = await page.request.post(`${apiUrl}/v1/generation-batches`, {
    data: {
      name: `Board ${run}`,
      items: items.map((businessId) => ({ businessId, engine: 'fake' })),
      settings: { maxParallel: 1 },
    },
    headers: { Origin: webUrl, 'Idempotency-Key': `board-${run}` },
  });
  expect(created.status(), await created.text()).toBe(201);
  const batchId = ((await created.json()) as { id: string }).id;

  await page.goto(`/generation/batches/${batchId}`);
  await expect(card(page, first).getByTestId('job-status')).toHaveText('Running', { timeout: 30_000 });
  await expect(card(page, third).getByTestId('job-status')).toHaveText('Queued');
  const axe = await new AxeBuilder({ page }).analyze();
  expect(axe.violations.map((violation) => violation.id)).toEqual([]);

  // The third goes before the second.
  await card(page, third).getByRole('button', { name: 'Start next' }).click();
  await expect(
    page.getByRole('list', { name: 'Jobs, in priority order' }).locator('[data-item-id]').nth(1),
  ).toContainText(third);
  // Cancel the running one: it stops within seconds, and the next one starts.
  await card(page, first).getByRole('button', { name: 'Cancel' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel it' }).click();
  await expect(card(page, first).getByTestId('job-status')).toHaveText('Cancelled', { timeout: 10_000 });
  await expect(page.getByTestId('job-status').filter({ hasText: 'Ready' })).toHaveCount(2, {
    timeout: 120_000,
  });

  const jobs = byStart(await batchJobs(page, batchId));
  expect(jobs.map((job) => job.businessName)).toEqual([first, third, second]);
});

test('publishes a site waiting for review anyway, with a reason (BF-046)', async ({ page }) => {
  test.setTimeout(180_000);
  // A placeholder in the name reaches the copy: the gates keep failing, the job waits for review after repairs.
  const name = `Salon [x] ${run}`;
  const id = await createBusiness(page, name);
  const created = await page.request.post(`${apiUrl}/v1/generation-batches`, {
    data: { items: [{ businessId: id, engine: 'fake' }] },
    headers: { Origin: webUrl, 'Idempotency-Key': `review-${run}` },
  });
  expect(created.status(), await created.text()).toBe(201);
  const batchId = ((await created.json()) as { id: string }).id;

  await page.goto(`/generation/batches/${batchId}`);
  await expect(card(page, name).getByTestId('job-status')).toHaveText('Needs review', { timeout: 120_000 });
  await card(page, name).getByRole('button', { name: 'Accept anyway' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText(/Quality score \d+/)).toBeVisible();
  await dialog.getByLabel('Why publish it').fill('short');
  await expect(dialog.getByRole('button', { name: 'Publish' })).toBeDisabled();
  await dialog.getByLabel('Why publish it').fill('The brackets are part of the real business name.');
  await dialog.getByRole('button', { name: 'Publish' }).click();
  await expect(card(page, name).getByTestId('job-status')).toHaveText('Ready', { timeout: 15_000 });
  await expect(card(page, name).getByTestId('preview-url')).toBeVisible();
});
