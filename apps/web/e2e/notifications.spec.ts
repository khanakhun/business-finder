import AxeBuilder from '@axe-core/playwright';
import { apiUrl, webUrl } from './env.ts';
import { expect, test } from './fixtures.ts';
import { signedInAsNewUser } from './users.ts';

// Needs the worker (outbox relay → subscriber → notification → SSE): Playwright starts it with the API.
test('a test event raises the bell count without a reload; the popover lists it and marks all read', async ({
  browser,
}) => {
  // Its own user, so no other spec's notifications change the count.
  const { page, close } = await signedInAsNewUser(browser, 'bell', ['Bell Workspace']);
  await page.goto('/');
  const bell = page.getByRole('button', { name: /^Notifications/ });
  await expect(bell).toBeVisible();
  await expect(page.getByTestId('unread-count')).toHaveCount(0);

  const triggered = await page.request.post(`${apiUrl}/v1/notifications/test`, {
    headers: { Origin: webUrl },
  });
  expect(triggered.status()).toBe(202);
  await expect(page.getByTestId('unread-count')).toHaveText('1', { timeout: 15_000 });
  await expect(page.getByRole('button', { name: 'Notifications (1 unread)' })).toBeVisible();

  await page.getByRole('button', { name: 'Notifications (1 unread)' }).click();
  await expect(page.getByRole('dialog').getByText('Test notification')).toBeVisible();
  await page.getByRole('button', { name: 'Mark all as read' }).click();
  await expect(page.getByTestId('unread-count')).toHaveCount(0);
  await close();
});

for (const path of ['/notifications', '/settings/notifications']) {
  test(`${path} has no serious or critical axe violations`, async ({ page }) => {
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1, name: 'Notifications' })).toBeVisible();
    await page.waitForLoadState('networkidle');
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')).toEqual([]);
  });
}
