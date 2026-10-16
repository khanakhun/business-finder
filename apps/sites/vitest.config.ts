import { fileURLToPath } from 'node:url';
import { defineVitestConfig } from '@bf/testing/vitest-config';
import { mergeConfig } from 'vitest/config';

export default mergeConfig(
  defineVitestConfig({
    type: 'unit',
    // The renderer's logic (host parsing, routing, policies, caching, signing) is unit-tested; pages, the proxy and
    // routes are covered by Playwright against a production build (pnpm --filter @bf/sites e2e).
    coverageInclude: ['src/lib/**'],
    // Request- and database-bound modules (next/headers, the read-only pool): exercised end to end.
    coverageExclude: ['src/lib/tenant.ts', 'src/lib/current-site.ts', 'src/lib/env.ts'],
  }),
  {
    resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
    test: { exclude: ['e2e/**', '**/node_modules/**'] },
  },
);
