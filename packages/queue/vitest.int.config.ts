import { defineVitestConfig, VALKEY_GLOBAL_SETUP } from '@bf/testing/vitest-config';

export default defineVitestConfig({ type: 'int', globalSetup: [VALKEY_GLOBAL_SETUP] });
