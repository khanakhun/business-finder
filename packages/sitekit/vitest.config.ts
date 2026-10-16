import { defineVitestConfig } from '@bf/testing/vitest-config';

export default defineVitestConfig({
  type: 'unit',
  // Chromium runs only where Playwright's browser is installed (the CI sites job: SITEKIT_BROWSER=1).
  coverageExclude: ['src/lib/screenshot.ts'],
});
