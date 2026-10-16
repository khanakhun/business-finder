// Runtime helpers for test files. The Vitest config factory lives at `@bf/testing/vitest-config`
// so test files don't load Vite's config machinery.
export { faker, seedFor, testSeedKey } from './faker.ts';
