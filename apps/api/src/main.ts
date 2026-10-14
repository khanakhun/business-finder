// HTTP entrypoint. Run with the telemetry preload: node --import ./src/instrumentation.ts src/main.ts
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module.ts';
import { configureHttp } from './http.ts';
import { loadAppEnv } from './modules/platform/config/app-env.ts';
import { createAppLogger, NestPinoLogger } from './modules/platform/logging/logger.ts';
import { buildOpenApiDocument } from './modules/platform/openapi/document.ts';

const SHUTDOWN_TIMEOUT_MS = 10_000;

const env = loadAppEnv('http');
const logger = createAppLogger('bf-api', env.LOG_LEVEL, env.NODE_ENV);
const app = await NestFactory.create(AppModule.forHttp(env), {
  logger: new NestPinoLogger(logger),
  bufferLogs: true,
});
configureHttp(app, env);
if (env.NODE_ENV !== 'production')
  SwaggerModule.setup('docs', app, () => buildOpenApiDocument(app, env.APP_VERSION));

await app.listen(env.API_PORT);
logger.info({ port: env.API_PORT }, 'api listening');

// Graceful shutdown: stop accepting connections, let in-flight requests finish, close pools; force-exit after 10 s.
let shuttingDown = false;
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    const force = setTimeout(() => {
      logger.error('shutdown timed out, exiting');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    force.unref();
    await app.close();
    logger.info('shutdown complete');
    process.exit(0);
  });
}
