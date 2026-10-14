import { inject } from 'vitest';
import type {} from './global-setup.ts';

/**
 * URL of the shared test Valkey. Tests isolate by key prefix or by database index (`/1`…`/15`); call
 * `FLUSHDB` on their own database only.
 */
export function testValkeyUrl(database = 0): string {
  return `${inject('bfTestValkeyUrl')}/${database}`;
}
