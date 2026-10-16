import { defineConfig, devices } from '@playwright/test';

// The block library's browser suites (BF-034): visual regression and accessibility on static renders of the fixture
// sites and the gallery (`pnpm --filter @bf/site-blocks prepare:suites` writes them into dist/). Baselines are
// rendered on Linux (CI and the dev containers); `test:visual --update-snapshots` refreshes them.
const port = 4411;
const ci = Boolean(process.env.CI);

export default defineConfig({
  testDir: './suites',
  fullyParallel: true,
  forbidOnly: ci,
  retries: ci ? 1 : 0,
  reporter: ci ? [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]] : 'list',
  snapshotPathTemplate: '{testDir}/__screenshots__/{arg}{ext}',
  expect: {
    // Text antialiasing differs slightly between machines; layout changes move far more pixels.
    toHaveScreenshot: { maxDiffPixelRatio: 0.01, animations: 'disabled', caret: 'hide', scale: 'css' },
  },
  use: { baseURL: `http://127.0.0.1:${port}`, trace: 'retain-on-failure', ...devices['Desktop Chrome'] },
  projects: [
    { name: 'visual', testMatch: /visual\.spec\.ts/ },
    { name: 'a11y', testMatch: /a11y\.spec\.ts/ },
  ],
  webServer: {
    command: `node --import tsx src/cli/serve.ts dist ${port}`,
    url: `http://127.0.0.1:${port}/styles.css`,
    reuseExistingServer: !ci,
    timeout: 30_000,
  },
});
