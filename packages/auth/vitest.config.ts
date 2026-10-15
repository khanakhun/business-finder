import { defineVitestConfig } from '@bf/testing/vitest-config';

export default defineVitestConfig({
  type: 'unit',
  // Better Auth wiring and the DB-backed invitation lookup are exercised end to end by apps/api's identity
  // integration tests (real Postgres); the pure parts are unit-tested here.
  coverageExclude: [
    'src/server.ts',
    'src/client.ts',
    'src/index.ts',
    'src/signup-store.ts',
    'src/session-defaults.ts',
  ],
});
