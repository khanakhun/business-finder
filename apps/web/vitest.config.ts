import { fileURLToPath } from 'node:url';
import { defineVitestConfig } from '@bf/testing/vitest-config';
import react from '@vitejs/plugin-react';
import { mergeConfig } from 'vitest/config';

export default mergeConfig(
  defineVitestConfig({
    type: 'unit',
    environment: 'happy-dom',
    plugins: [react()],
    setupFiles: ['./src/test-setup.ts'],
    // Logic is unit-tested; pages and shell composition are covered by Playwright (pnpm e2e).
    coverageInclude: [
      'src/lib/**',
      'src/i18n/locales.ts',
      'src/proxy.ts',
      'src/components/states/**',
      // Feature logic (URL state, registries); feature components and hooks are covered by Playwright.
      'src/features/search/url-state.ts',
      'src/features/search/bulk-actions/registry.ts',
    ],
  }),
  {
    resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
    test: { exclude: ['e2e/**', '**/node_modules/**'] },
  },
);
