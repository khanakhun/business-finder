import { base, en, Faker } from '@faker-js/faker';

/**
 * Faker instance for tests and fixtures. `@bf/testing/setup` re-seeds it before every test from the
 * test's file and name, so generated data is reproducible regardless of test order or `-t` filters.
 * Import it from `@bf/testing`, not from `@faker-js/faker`, or the seeding does not apply.
 */
export const faker = new Faker({ locale: [en, base] });

/** Deterministic 32-bit seed for a string key (FNV-1a). */
export function seedFor(key: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Seed key for a test: its file path relative to the project root plus its full name. */
export function testSeedKey(file: string, fullName: string): string {
  return `${file}::${fullName}`;
}
