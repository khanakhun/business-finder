import { defineVitestConfig, PG_GLOBAL_SETUP } from '@bf/testing/vitest-config';

export default defineVitestConfig({ type: 'int', globalSetup: [PG_GLOBAL_SETUP] });
