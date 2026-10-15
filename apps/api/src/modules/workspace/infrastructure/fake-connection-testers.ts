import { SECRET_NAMES } from '@bf/contracts';
import type { ConnectionTesterRegistry } from '../application/connection-testers.ts';

/**
 * FAKE_CONNECTION_TESTS (development and E2E only; refused in production): every secret gets a tester that
 * passes for values of 8+ characters without calling any provider.
 */
export function registerFakeConnectionTesters(registry: ConnectionTesterRegistry): void {
  for (const name of SECRET_NAMES) {
    registry.register(name, async ({ value }) =>
      value.length >= 8
        ? { ok: true, message: 'Fake connection test passed (no provider called).' }
        : { ok: false, message: 'Fake connection test failed: value too short.' },
    );
  }
}
