// Lighthouse CI budgets (BF-034): static renders of the fixture sites (`pnpm prepare:suites`), mobile emulation,
// with the Chromium Playwright installs. Each fixture in its own style, plus the page with the most blocks. It runs
// from .lighthouseci/ (git-ignored): under WSL chrome-launcher writes its profile to a Windows-style relative path.
// DECISION(BF-034): Lighthouse CI runs through `pnpm dlx @lhci/cli@<pinned>` (package.json), out of the lockfile: its
// dependency tree is resolved at run time, unscanned. Accepted: it audits our local static pages only, in a job with
// read-only contents and no repository secret; on pushes to main the job still holds the Actions cache token (the
// shared pnpm store), a risk accepted until Lighthouse moves to a job without the setup cache.
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
        // The ticket's budgets: static blocks ship no script, images are sized (no layout shift), pages stay light.
        'resource-summary:script:count': ['error', { maxNumericValue: 0 }],
        'cumulative-layout-shift': ['error', { maxNumericValue: 0.02 }],
        'unsized-images': ['error', { minScore: 1 }],
        'total-byte-weight': ['error', { maxNumericValue: 800_000 }],
      },
    },
    upload: { target: 'filesystem', outputDir: 'reports' },
  },
};
