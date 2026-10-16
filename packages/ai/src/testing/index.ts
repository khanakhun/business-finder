// @bf/ai/testing — fakes for tests and CI evals (never import from production code).
export { fakeEmbedding } from './fake-embeddings.ts';
export {
  createFakeAiGateway,
  type FakeAiGateway,
  type FakeAiGatewayOptions,
  MissingFixtureError,
} from './fake-gateway.ts';
export { type Fixture, fixtureKey, fixturePath, readFixture, writeFixture } from './fixtures.ts';
