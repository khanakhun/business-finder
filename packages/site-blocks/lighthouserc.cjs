// Lighthouse CI budgets (BF-034): static renders of the fixture sites (`pnpm prepare:suites`), mobile emulation,
// with the Chromium Playwright installs. Each fixture in its own style, plus the page with the most blocks. It runs
// from .lighthouseci/ (git-ignored): under WSL chrome-launcher writes its profile to a Windows-style relative path.
const { chromium } = require('@playwright/test');

const port = 4412;
const pages = [
  'sites/salon-gustavia/luxe/',
  'sites/salon-gustavia/luxe/contact/',
  'sites/cafe-saint-jean/warm/',
  'sites/hardware-store-lorient/modern/',
  'sites/villa-agency/coastal/',
];
const atLeast = (minScore) => ['error', { minScore }];

module.exports = {
  ci: {
    collect: {
      startServerCommand: `node --import tsx ../src/cli/serve.ts ../dist ${port}`,
      startServerReadyPattern: 'Serving',
      url: pages.map((path) => `http://127.0.0.1:${port}/${path}`),
      numberOfRuns: 1,
      chromePath: chromium.executablePath(),
      settings: { chromeFlags: '--headless=new --no-sandbox' },
    },
    assert: {
      assertions: {
        'categories:performance': atLeast(0.95),
        'categories:accessibility': atLeast(0.95),
        'categories:best-practices': atLeast(0.95),
      },
    },
    upload: { target: 'filesystem', outputDir: 'reports' },
  },
};
