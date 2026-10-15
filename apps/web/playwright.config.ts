import { defineConfig, devices } from '@playwright/test';
import { apiUrl, webUrl } from './e2e/env.ts';

const ci = Boolean(process.env.CI);

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: ci,
  retries: ci ? 1 : 0,
  reporter: ci ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: { baseURL: webUrl, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [
    // Signs up a workspace owner once (needs Mailpit: `pnpm infra:up`) and stores the session.
    { name: 'setup', testMatch: /auth\.setup\.ts/ },
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], storageState: 'e2e/.auth/owner.json' },
      dependencies: ['setup'],
    },
  ],
  // Production build of the dashboard + the real API (database migrated, Mailpit running: pnpm infra:up).
  webServer: [
    {
      command: 'pnpm --filter @bf/api start',
      // Browsers and the test runner reach the API from loopback: treat it as the reverse proxy so the per-test
      // X-Forwarded-For (e2e/users.ts nextClientIp) separates rate-limit buckets. Never set this in production.
      // FAKE_CONNECTION_TESTS: provider connection tests pass without calling providers (refused in production).
      env: { AUTH_TRUSTED_PROXIES: '127.0.0.1,::1', FAKE_CONNECTION_TESTS: 'true' },
      url: `${apiUrl}/health/live`,
      reuseExistingServer: !ci,
      timeout: 60_000,
    },
    { command: 'pnpm build && pnpm start', url: webUrl, reuseExistingServer: !ci, timeout: 240_000 },
  ],
});
