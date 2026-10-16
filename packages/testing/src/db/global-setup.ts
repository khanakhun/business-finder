// Vitest globalSetup for integration tests that need Postgres: starts ONE container from the project's own image
// (infra/docker/postgres, same as local and prod), migrates a template database once, and hands connection details
// to workers via provide/inject. Tests then clone the template per file with createIsolatedDatabase().
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import postgres from 'postgres';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import type { TestProject } from 'vitest/node';
import { databaseUrl, PROVIDE_KEY, type TestPostgres } from './connection.ts';
import { applyMigrations } from './migrations.ts';

const IMAGE_TAG = 'bf-postgres-test:local';
const TEMPLATE = 'bf_template';
const USER = 'bf';
const PASSWORD = 'bf_test_only';

let container: StartedTestContainer | undefined;

export async function setup(project: TestProject): Promise<void> {
  const root = findRepoRoot(project.config.root);
  // DECISION(BF-003): BF_TEST_PG_IMAGE lets CI reuse an image built once per pipeline instead of rebuilding.
  const image = process.env.BF_TEST_PG_IMAGE ?? (await buildImage(root));

  container = await new GenericContainer(image)
    .withEnvironment({
      POSTGRES_USER: USER,
      POSTGRES_PASSWORD: PASSWORD,
      POSTGRES_DB: 'postgres',
      BF_SITES_RO_PASSWORD: 'bf_sites_ro_test_only',
    })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forHealthCheck())
    .withStartupTimeout(120_000)
    .start();

  const pg: TestPostgres = {
    host: container.getHost(),
    port: container.getMappedPort(5432),
    user: USER,
    password: PASSWORD,
    template: TEMPLATE,
  };
  await createTemplate(pg, process.env.BF_TEST_MIGRATIONS_DIR ?? join(root, 'packages/db/migrations'));
  project.provide(PROVIDE_KEY, pg);
}

export async function teardown(): Promise<void> {
  await container?.stop();
}

async function buildImage(root: string): Promise<string> {
  // Docker's layer cache makes this near-instant after the first build.
  await GenericContainer.fromDockerfile(join(root, 'infra/docker/postgres')).build(IMAGE_TAG, {
    deleteOnExit: false,
  });
  return IMAGE_TAG;
}

async function createTemplate(pg: TestPostgres, migrationsFolder: string): Promise<void> {
  const admin = postgres(databaseUrl(pg, 'postgres'), { max: 1, onnotice: () => undefined });
  try {
    await admin.unsafe(`CREATE DATABASE ${TEMPLATE}`);
  } finally {
    await admin.end();
  }
  const client = postgres(databaseUrl(pg, TEMPLATE), { max: 1, onnotice: () => undefined });
  try {
    await applyMigrations(client, migrationsFolder);
  } finally {
    // CREATE DATABASE … TEMPLATE requires that nobody is connected to the template.
    await client.end();
  }
}

function findRepoRoot(start: string): string {
  let dir = resolve(start);
  while (!existsSync(join(dir, 'pnpm-workspace.yaml'))) {
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`No pnpm-workspace.yaml above ${start}`);
    dir = parent;
  }
  return dir;
}
