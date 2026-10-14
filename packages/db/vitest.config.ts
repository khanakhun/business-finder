import { defineVitestConfig } from '@bf/testing/vitest-config';

export default defineVitestConfig({
  type: 'unit',
  // Need a real Postgres; covered by src/**/*.int.test.ts (pnpm test:int).
  coverageExclude: [
    'src/client.ts',
    'src/tx.ts',
    'src/testing.ts',
    'src/migrate.ts',
    'src/seed/**',
    'src/cli/{migrate,seed,reset,kit}.ts',
  ],
});
