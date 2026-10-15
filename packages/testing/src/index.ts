// Runtime helpers for test files. The Vitest config factory lives at `@bf/testing/vitest-config`
// so test files don't load Vite's config machinery.

export {
  aBusiness,
  aContact,
  aGenericBusiness,
  aSourceRecord,
  type BusinessFixture,
  type ContactFixture,
  type FakeSourceProvider,
  fakeNormalizedName,
  fakeUuidV7,
  type SourceRecordFixture,
} from './factories/business.ts';
export { faker, seedFor, testSeedKey } from './faker.ts';
