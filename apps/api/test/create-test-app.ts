import 'reflect-metadata';
import { type Clock, fixedClock } from '@bf/contracts';
import { createIsolatedDatabase } from '@bf/testing/db';
import { testValkeyUrl } from '@bf/testing/valkey';
import type { INestApplication, INestApplicationContext, Type } from '@nestjs/common';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module.ts';
import { configureHttp } from '../src/http.ts';
import { SYSTEM_MAILER, type SystemMailer } from '../src/modules/identity/application/ports.ts';
import { CLOCK } from '../src/modules/platform/clock/clock.module.ts';
import { type AppEnv, loadAppEnv } from '../src/modules/platform/config/app-env.ts';
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

  const moduleRef = await Test.createTestingModule({
    imports: [AppModule.forHttp(env), ExtraControllersModule],
  })
    .overrideProvider(CLOCK)
    .useValue(options.clock ?? fixedClock('2026-10-14T12:00:00.000Z'))
    .overrideProvider(SYSTEM_MAILER)
    .useValue(options.mailer ?? new FakeMailer())
    .compile();
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
export async function createTestWorker(app: TestApp): Promise<INestApplicationContext> {
  const env = loadAppEnv('worker', {
    ...TEST_ENV,
    DATABASE_URL: app.env.DATABASE_URL,
    VALKEY_URL: app.env.VALKEY_URL,
  });
  const { AppModule: Module_ } = await import('../src/app.module.ts');
  const worker = await NestFactory.createApplicationContext(Module_.forWorker(env), { logger: false });
  await worker.init();
  return worker;
}
