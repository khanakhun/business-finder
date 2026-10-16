import { test as base, expect } from '@playwright/test';

/** Fails the test on any CSP violation or uncaught page error (CSP regressions are silent otherwise). */
export const test = base.extend<{ cspErrors: string[] }>({
  cspErrors: [
    async ({ page }, use) => {
      const errors: string[] = [];
      page.on('console', (message) => {
        if (message.type() === 'error' && /Content Security Policy/i.test(message.text()))
          errors.push(message.text());
      });
      page.on('pageerror', (error) => errors.push(error.message));
      await use(errors);
      expect(errors, 'CSP violations or page errors').toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };

/** Waits until the client has hydrated (the API status card is a client component), so shortcuts are wired. */
export async function waitForHydration(page: import('@playwright/test').Page): Promise<void> {
  await page.getByTestId('api-version').waitFor();
}
