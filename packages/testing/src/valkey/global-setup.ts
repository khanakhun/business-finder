// Vitest globalSetup: one Valkey container per run (same image as infra/compose), URL handed to workers.
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import type { TestProject } from 'vitest/node';

export const VALKEY_IMAGE = 'valkey/valkey:8.1.10-alpine';
/** Databases in the test container (`valkeyDb` 0–63). */
export const TEST_VALKEY_DATABASES = 64;

declare module 'vitest' {
  export interface ProvidedContext {
    bfTestValkeyUrl: string;
  }
}

let container: StartedTestContainer | undefined;

export async function setup(project: TestProject): Promise<void> {
  container = await new GenericContainer(VALKEY_IMAGE)
    // Each suite with a worker needs its own database (BullMQ queues): more than the default 16.
    .withCommand(['valkey-server', '--databases', String(TEST_VALKEY_DATABASES)])
    .withExposedPorts(6379)
    .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
    .start();
  project.provide('bfTestValkeyUrl', `redis://${container.getHost()}:${container.getMappedPort(6379)}`);
}

export async function teardown(): Promise<void> {
  await container?.stop();
}
