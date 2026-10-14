import { defineVitestConfig, PG_GLOBAL_SETUP, VALKEY_GLOBAL_SETUP } from '@bf/testing/vitest-config';
import swc from 'unplugin-swc';

export default defineVitestConfig({
  type: 'int',
  plugins: [swc.vite({ module: { type: 'es6' } })],
  globalSetup: [PG_GLOBAL_SETUP, VALKEY_GLOBAL_SETUP],
});
