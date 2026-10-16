// Lighthouse CI on the renderer (BF-036): the four fixture previews seeded by `pnpm sites:seed`, served by a running
// production build (scripts/perf.mjs starts it). Mobile emulation, the Chromium Playwright installs.
const { chromium } = require('@playwright/test');

const port = process.env.SITES_PORT || '3100';
const slugs = [
  'salon-gustavia-demo01',
  'cafe-saint-jean-demo02',
  'hardware-lorient-demo03',
  'villa-agency-demo04',
];
const atLeast = (minScore) => ['error', { minScore }];

module.exports = {
  ci: {
    collect: {
      url: slugs.map((slug) => `http://${slug}.sites.localhost:${port}/`),
      numberOfRuns: 1,
      chromePath: chromium.executablePath(),
      settings: { chromeFlags: process.env.LHCI_CHROME_FLAGS ?? '--headless=new --no-sandbox' },
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
