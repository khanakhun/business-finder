import { defineVitestConfig } from '@bf/testing/vitest-config';

export default defineVitestConfig({ type: 'unit', coverageExclude: ['src/cli/**'] });
