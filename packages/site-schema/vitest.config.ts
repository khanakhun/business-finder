import { defineVitestConfig } from '@bf/testing/vitest-config';

export default defineVitestConfig({
  type: 'unit',
  // The generators write files (their output is checked by `--check` in CI).
  coverageExclude: ['src/cli/**'],
});
