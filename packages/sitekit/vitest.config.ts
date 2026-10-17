import { defineVitestConfig } from '@bf/testing/vitest-config';

export default defineVitestConfig({
  type: 'unit',
  // Chromium runs only where Playwright's browser is installed (the CI sites job: SITEKIT_BROWSER=1; the audit also
  // in the runner image's Docker test).
  // The entry points only call `main` and write files (bin.ts, write-schemas.ts).
  coverageExclude: [
    'src/lib/screenshot.ts',
    'src/lib/audit.ts',
    'src/cli/bin.ts',
    'src/cli/write-schemas.ts',
  ],
});
