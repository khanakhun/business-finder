import { defineVitestConfig } from './src/vitest-config.ts';

export default defineVitestConfig({
  type: 'unit',
  // Container lifecycle, template migration and cloning; covered by @bf/db's integration tests.
  coverageExclude: [
    'src/db/global-setup.ts',
    'src/db/migrations.ts',
    'src/db/isolated-db.ts',
    'src/valkey/**',
  ],
});
