// pnpm api:openapi — writes packages/api-client/openapi.json. Needs no env and no running infrastructure.
import 'reflect-metadata';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.ts';
import { configureHttp } from './http.ts';
import { loadAppEnv } from './modules/platform/config/app-env.ts';
import { buildOpenApiDocument } from './modules/platform/openapi/document.ts';

export const OPENAPI_FILE = fileURLToPath(
  new URL('../../../packages/api-client/openapi.json', import.meta.url),
);

export async function generateOpenApi(): Promise<string> {
  const env = loadAppEnv('openapi');
  const app = await NestFactory.create(AppModule.forOpenApi(env), { logger: false, abortOnError: false });
  configureHttp(app, env);
  await app.init();
  const document = buildOpenApiDocument(app, env.APP_VERSION);
  await app.close();
  return `${JSON.stringify(document, null, 2)}\n`;
}

if (import.meta.main) {
  const json = await generateOpenApi();
  mkdirSync(dirname(OPENAPI_FILE), { recursive: true });
  writeFileSync(OPENAPI_FILE, json);
  console.log(`Wrote ${OPENAPI_FILE}`);
}
