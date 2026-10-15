import { defineVitestConfig } from '@bf/testing/vitest-config';
import react from '@vitejs/plugin-react';

export default defineVitestConfig({
  type: 'unit',
  environment: 'happy-dom',
  plugins: [react()],
  setupFiles: ['./src/test-setup.ts'],
  // Tests cover what this package adds; the shadcn primitives are vendored upstream code.
  coverageInclude: [
    'src/components/{error-state,empty-state,page-header,keyboard-shortcut,combobox,category-picker}.tsx',
    'src/data-table/**',
    'src/lib/**',
  ],
});
