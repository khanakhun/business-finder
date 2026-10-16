import { setupServer } from 'msw/node';
import { afterAll, beforeAll } from 'vitest';

// Tests never reach a real model provider (BF-013): any unmocked HTTP request fails the test.
const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterAll(() => server.close());
