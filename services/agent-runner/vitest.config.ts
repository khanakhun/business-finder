import { defineVitestConfig } from '@bf/testing/vitest-config';

export default defineVitestConfig({
  type: 'unit',
  // The entry point wires process I/O; its parts are tested.
  coverageExclude: ['src/main.ts'],
});
