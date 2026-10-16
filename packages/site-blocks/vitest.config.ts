import { defineVitestConfig } from '@bf/testing/vitest-config';
import react from '@vitejs/plugin-react';

export default defineVitestConfig({
  type: 'unit',
  environment: 'happy-dom',
  plugins: [react()],
  setupFiles: ['./src/test-setup.ts'],
  // The CLIs (build, gallery) are exercised by the build and the visual suites.
  coverageInclude: ['src/**/*.{ts,tsx}', '!src/cli/**', '!src/icons/paths.ts'],
});
