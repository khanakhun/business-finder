import { defineVitestConfig } from '@bf/testing/vitest-config';

export default defineVitestConfig({
  type: 'unit',
  setupFiles: ['./test/no-network.ts'],
  // The eval CLI and the provider wiring (real SDK clients) are exercised by `pnpm eval`.
  coverageExclude: ['src/index.ts', 'src/testing/index.ts'],
});
