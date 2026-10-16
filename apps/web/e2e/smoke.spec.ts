import { expect, test, waitForHydration } from './fixtures.ts';

test.describe('dashboard shell', () => {
  test('loads, talks to the API through the typed client and sends a nonce CSP', async ({ page }) => {
    const response = await page.goto('/');
    expect(response?.headers()['content-security-policy']).toMatch(
      /script-src 'self' 'nonce-[^']+' 'strict-dynamic'/,
    );
    await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();
    await expect(page.getByTestId('api-version')).not.toBeEmpty();
    await expect(page.getByText('Connected')).toBeVisible();
  });

  test('navigates with the sidebar and marks the current page', async ({ page }) => {
    await page.goto('/');
    const nav = page.getByRole('navigation', { name: 'Main navigation' });
    await nav.getByRole('link', { name: 'Pipeline' }).click();
    await expect(page).toHaveURL(/\/pipeline$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Pipeline' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Pipeline' })).toHaveAttribute('aria-current', 'page');
  });

  test('works by keyboard: skip link, command palette, shortcuts help', async ({ page }) => {
    await page.goto('/');
    await waitForHydration(page);
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();

    await page.keyboard.press('ControlOrMeta+k');
    const palette = page.getByRole('dialog');
    await expect(palette).toBeVisible();
    await expect(page.getByRole('combobox')).toBeFocused();
    await page.keyboard.type('mailboxes');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/outreach\/mailboxes$/);
    await expect(palette).toBeHidden();

    await page.keyboard.press('?');
    await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toBeHidden();
  });

  test('switches language and keeps it across reloads', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Language' }).click();
    await page.getByRole('menuitemradio', { name: 'Français' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Vue d’ensemble' })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('lang', 'fr');
    await page.reload();
    await expect(page.getByRole('link', { name: 'Paramètres' })).toBeVisible();
  });

  test('switches theme from the command palette', async ({ page }) => {
    await page.goto('/');
    await waitForHydration(page);
    await page.keyboard.press('ControlOrMeta+k');
    await expect(page.getByRole('combobox')).toBeFocused();
    await page.keyboard.type('dark theme');
    await page.keyboard.press('Enter');
    await expect(page.locator('html')).toHaveClass(/dark/);
  });

  test('collapses the sidebar and remembers it', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Collapse sidebar' }).click();
    await expect(page.getByRole('button', { name: 'Expand sidebar' })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('button', { name: 'Expand sidebar' })).toBeVisible();
  });

  test('renders API errors with their trace id', async ({ page }) => {
    await page.route('**/v1/system/info', (route) =>
      route.fulfill({
        status: 503,
        contentType: 'application/problem+json',
        body: JSON.stringify({
          type: 'about:blank',
          title: 'Service unavailable',
          status: 503,
          code: 'INTERNAL',
          detail: 'Maintenance in progress.',
          traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
        }),
      }),
    );
    await page.goto('/');
    // Next.js renders its own (empty) route announcer with role="alert"; target the error panel.
    await expect(page.getByRole('alert').filter({ hasText: 'Service unavailable' })).toContainText(
      'Maintenance in progress.',
    );
    await expect(page.getByTestId('trace-id')).toHaveText('4bf92f3577b34da6a3ce929d0e0e4736');
    await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
  });

  test('answers unknown pages with 404 inside the shell', async ({ page }) => {
    const response = await page.goto('/no-such-page');
    expect(response?.status()).toBe(404);
    await expect(page.getByRole('heading', { level: 1, name: 'Page not found' })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible();
  });
});
