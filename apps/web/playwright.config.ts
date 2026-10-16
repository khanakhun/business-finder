import { defineConfig, devices } from '@playwright/test';
import { apiUrl, webUrl, workerMetricsUrl } from './e2e/env.ts';

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
      // The fake discovery provider (fixture businesses, no cost, no network) backs the search e2e (BF-023);
      // the fake site intel (a readable site derived from the URL, no crawl) the enrichment e2e (BF-027), and the
      // fake e-mail verifier (a verdict from the address, no SMTP or DNS) the contacts e2e (BF-028), and the fake
      // review sources and classifier (no Google, scraper or model call) the reviews e2e (BF-029).
      env: {
        AUTH_TRUSTED_PROXIES: '127.0.0.1,::1',
        FAKE_CONNECTION_TESTS: 'true',
        FAKE_DISCOVERY_PROVIDER: 'true',
        FAKE_SITE_INTEL: 'true',
        FAKE_EMAIL_VERIFIER: 'true',
        FAKE_REVIEWS: 'true',
      },
      url: `${apiUrl}/health/live`,
      reuseExistingServer: !ci,
      timeout: 60_000,
    },
    {
      // Outbox relay and event subscribers (notifications reach the bell through the worker).
      command: 'pnpm --filter @bf/api start:worker',
      env: {
        FAKE_DISCOVERY_PROVIDER: 'true',
        FAKE_SITE_INTEL: 'true',
        FAKE_EMAIL_VERIFIER: 'true',
        FAKE_REVIEWS: 'true',
      },
      url: workerMetricsUrl,
      reuseExistingServer: !ci,
      timeout: 60_000,
    },
    { command: 'pnpm build && pnpm start', url: webUrl, reuseExistingServer: !ci, timeout: 240_000 },
  ],
});
