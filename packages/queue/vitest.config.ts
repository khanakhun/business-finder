import { defineVitestConfig } from '@bf/testing/vitest-config';

export default defineVitestConfig({
  type: 'unit',
  // Talk to Valkey/BullMQ; covered by src/**/*.int.test.ts.
  coverageExclude: ['src/idempotency.ts', 'src/cancellation.ts', 'src/runner.ts', 'src/producer.ts'],
});
