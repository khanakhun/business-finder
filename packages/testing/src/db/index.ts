// Runtime helpers for integration tests. Register the global setup in vitest.int.config.ts:
//   defineVitestConfig({ type: 'int', globalSetup: [PG_GLOBAL_SETUP] })
export type { TestPostgres } from './connection.ts';
export { createIsolatedDatabase, type IsolatedDatabase, truncateAll } from './isolated-db.ts';
