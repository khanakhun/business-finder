import { defineVitestConfig } from '@bf/testing/vitest-config';
import swc from 'unplugin-swc';

// SWC emits decorator metadata, which NestJS DI needs and Vite's default transform does not produce.
export default defineVitestConfig({
  type: 'unit',
  plugins: [swc.vite({ module: { type: 'es6' } })],
  // Unit coverage gates the logic: domain, application (use cases) and the pure platform helpers. Nest wiring —
  // modules, controllers, adapters, entrypoints — is verified by the integration suite (pnpm test:int).
  coverageInclude: [
    'src/modules/*/domain/**',
    'src/modules/*/application/**',
    'src/modules/platform/{config,context,errors,resilience,validation}/**',
  ],
  // Pure DI declarations; their wiring is what the integration suite boots.
  coverageExclude: ['**/*.module.ts'],
});
