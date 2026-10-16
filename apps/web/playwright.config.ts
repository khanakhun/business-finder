import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { defineConfig, devices } from '@playwright/test';

// Same ports as `pnpm infra:up` / `pnpm dev`: .env and .env.generated at the repo root, real env wins.
const fileEnv: Record<string, string | undefined> = {};
for (const file of ['../../.env', '../../.env.generated']) {
  const url = new URL(file, import.meta.url);
  if (existsSync(url)) Object.assign(fileEnv, parseEnv(readFileSync(url, 'utf8')));
}
const env = { ...fileEnv, ...process.env };
const webUrl = `http://localhost:${env.WEB_PORT ?? '3000'}`;
const apiUrl = `http://localhost:${env.API_PORT ?? '4000'}`;
const ci = Boolean(process.env.CI);

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: ci,
  retries: ci ? 1 : 0,
  reporter: ci ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: { baseURL: webUrl, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  // Production build of the dashboard + the real API (it needs no database for these pages).
  webServer: [
    {
      command: 'pnpm --filter @bf/api start',
      url: `${apiUrl}/health/live`,
      reuseExistingServer: !ci,
      timeout: 60_000,
    },
    { command: 'pnpm build && pnpm start', url: webUrl, reuseExistingServer: !ci, timeout: 240_000 },
  ],
});
