import { defineConfig, devices } from '@playwright/test';
import { API_URL, BASE_DOMAIN, REVALIDATE_SECRET, sitesPort, VIEW_SECRET } from './e2e/env.ts';

const ci = Boolean(process.env.CI);

// The renderer's journeys (BF-036): a production build reading the e2e workspace's sites (seeded in the database
// by global-setup; `pnpm infra:up` and `pnpm db:migrate` first). Sites are served at <slug>.sites.localhost.
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: ci,
  retries: 0,
  reporter: ci ? [['list'], ['html', { open: 'never' }]] : 'list',
  globalSetup: './e2e/global-setup.ts',
  use: { trace: 'retain-on-failure', screenshot: 'only-on-failure', ...devices['Desktop Chrome'] },
  webServer: {
    command: 'pnpm build && pnpm start',
    url: `http://127.0.0.1:${sitesPort}/health/ready`,
    // Never reused: a running renderer keeps an earlier run's sites in its cache for a minute.
    reuseExistingServer: false,
    timeout: 240_000,
    env: {
      SITES_BASE_DOMAIN: BASE_DOMAIN,
      SITES_REVALIDATE_SECRET: REVALIDATE_SECRET,
      SITES_VIEW_TOKEN_SECRET: VIEW_SECRET,
      API_URL,
      // The fixtures' image host: their images are on our CDN as far as the policy is concerned.
      SITES_ASSETS_BASE_URL: 'https://assets.bf-sites.test',
    },
  },
});
