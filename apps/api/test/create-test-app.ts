import 'reflect-metadata';
import { type Clock, fixedClock } from '@bf/contracts';
import type { Logger } from '@bf/observability';
import { createIsolatedDatabase } from '@bf/testing/db';
import { testValkeyUrl } from '@bf/testing/valkey';
import type { INestApplication, INestApplicationContext, Type } from '@nestjs/common';
import { Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module.ts';
import { configureHttp } from '../src/http.ts';
import { SYSTEM_MAILER, type SystemMailer } from '../src/modules/identity/application/ports.ts';
import { CLOCK } from '../src/modules/platform/clock/clock.module.ts';
import { type AppEnv, loadAppEnv } from '../src/modules/platform/config/app-env.ts';
import { LOGGER } from '../src/modules/platform/logging/logger.ts';
import {
  InMemoryObjectStorage,
  OBJECT_STORAGE,
  type ObjectStorage,
} from '../src/modules/platform/storage/object-storage.ts';
import { FakeMailer } from './fake-mailer.ts';

/** A complete local environment for tests; secrets are throwaway constants. */
export const TEST_ENV = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'fatal',
  S3_ENDPOINT: 'http://127.0.0.1:9',
  S3_ACCESS_KEY_ID: 'test',
  S3_SECRET_ACCESS_KEY: 'test',
  BETTER_AUTH_SECRET: 'test-secret-test-secret-test-secret-00',
  SECRETS_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'),
  SMTP_URL: 'smtp://127.0.0.1:9',
  INTEL_SHARED_SECRET: 'test-intel-secret-test-intel-secret-00',
  // Supertest connects from loopback: treat it as the reverse proxy so tests can set per-user client IPs.
  AUTH_TRUSTED_PROXIES: '127.0.0.1,::1',
} as const;

export interface TestAppOptions {
  /** Clock seen by use cases; defaults to a fixed instant. */
  readonly clock?: Clock;
  /** Extra controllers (e.g. to exercise platform behaviour). */
  readonly controllers?: readonly Type[];
  /** Valkey database index (0–15); give each test file its own so rate limits do not interfere. */
  readonly valkeyDb?: number;
  readonly env?: Partial<Record<string, string>>;
  /** System mailer (verification, invitations…); defaults to a capturing fake, never real SMTP. */
  readonly mailer?: SystemMailer;
  /** Assets bucket; defaults to in-memory (no S3 in integration tests). */
  readonly storage?: ObjectStorage;
  /** Application logger (e.g. one writing to a capture stream); defaults to the env's (silent in tests). */
  readonly logger?: Logger;
  /** Any other provider to replace (e.g. AI_MODEL_FACTORY with mock models). */
  readonly overrides?: ReadonlyArray<{ readonly token: symbol | string; readonly value: unknown }>;
}

export interface TestApp {
  readonly app: INestApplication;
  readonly http: ReturnType<typeof request>;
  readonly env: AppEnv;
  close(): Promise<void>;
}

/** Boots the real HTTP app against an isolated database (from the migrated template) and the test Valkey. */
export async function createTestApp(options: TestAppOptions = {}): Promise<TestApp> {
  const database = await createIsolatedDatabase();
  const env = loadAppEnv('http', {
    ...TEST_ENV,
    DATABASE_URL: database.url,
    VALKEY_URL: testValkeyUrl(options.valkeyDb ?? 0),
    ...options.env,
  });

  @Module({ controllers: [...(options.controllers ?? [])] })
  class ExtraControllersModule {}

  const builder = Test.createTestingModule({
    imports: [AppModule.forHttp(env), ExtraControllersModule],
  })
    .overrideProvider(CLOCK)
    .useValue(options.clock ?? fixedClock('2026-10-14T12:00:00.000Z'))
    .overrideProvider(SYSTEM_MAILER)
    .useValue(options.mailer ?? new FakeMailer())
    .overrideProvider(OBJECT_STORAGE)
    .useValue(options.storage ?? new InMemoryObjectStorage());
  if (options.logger) builder.overrideProvider(LOGGER).useValue(options.logger);
  for (const { token, value } of options.overrides ?? []) builder.overrideProvider(token).useValue(value);
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication({ logger: false });
  configureHttp(app, env);
  await app.init();

  return {
    app,
    http: request(app.getHttpServer()),
    env,
    async close() {
      await app.close();
      await database.drop();
    },
  };
}

/** A worker process (processors only) on the same database/Valkey as a test app. Close it before the app. */
export async function createTestWorker(
  app: TestApp,
  options: {
    readonly mailer?: SystemMailer;
    readonly env?: Partial<Record<string, string>>;
    /** Worker clock (default: the system clock). */
    readonly clock?: Clock;
  } = {},
): Promise<INestApplicationContext> {
  const env = loadAppEnv('worker', {
    ...TEST_ENV,
    ...options.env,
    DATABASE_URL: app.env.DATABASE_URL,
    VALKEY_URL: app.env.VALKEY_URL,
  });
  const { AppModule: Module_ } = await import('../src/app.module.ts');
  // System mail never leaves the test (notification emails are sent by the worker).
  let builder = Test.createTestingModule({ imports: [Module_.forWorker(env)] })
    .overrideProvider(SYSTEM_MAILER)
    .useValue(options.mailer ?? new FakeMailer());
  if (options.clock) builder = builder.overrideProvider(CLOCK).useValue(options.clock);
  const moduleRef = await builder.compile();
  await moduleRef.init();
  return moduleRef;
}
