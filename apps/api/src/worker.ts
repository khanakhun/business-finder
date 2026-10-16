// Worker entrypoint: BullMQ processors and schedulers, no HTTP API. Metrics/liveness on WORKER_METRICS_PORT.
//   node --import @swc-node/register/esm-register --import ./src/instrumentation.ts src/worker.ts
import 'reflect-metadata';
import { createServer } from 'node:http';
import { metricsHandler } from '@bf/observability';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.ts';
import { loadAppEnv } from './modules/platform/config/app-env.ts';
import { createAppLogger, NestPinoLogger } from './modules/platform/logging/logger.ts';

const env = loadAppEnv('worker');
const logger = createAppLogger('bf-worker', env.LOG_LEVEL, env.NODE_ENV);
const app = await NestFactory.createApplicationContext(AppModule.forWorker(env), {
  logger: new NestPinoLogger(logger),
  bufferLogs: true,
});
await app.init();

const metricsServer = createServer((req, res) => {
  if (req.url === '/metrics') {
    void metricsHandler().then(({ contentType, body }) =>
      res.writeHead(200, { 'content-type': contentType }).end(body),
    );
  } else if (req.url === '/health/live') {
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"status":"ok"}');
  } else {
    res.writeHead(404).end();
  }
}).listen(env.WORKER_METRICS_PORT);
logger.info({ metricsPort: env.WORKER_METRICS_PORT }, 'worker started');

// Graceful shutdown: workers stop fetching and wait for active jobs (BullMQ close), bounded by the timeout.
let shuttingDown = false;
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal, timeoutMs: env.WORKER_SHUTDOWN_TIMEOUT_MS }, 'worker shutting down');
    const force = setTimeout(() => {
      logger.error('active jobs did not finish in time, exiting');
      process.exit(1);
    }, env.WORKER_SHUTDOWN_TIMEOUT_MS);
    force.unref();
    metricsServer.close();
    await app.close();
    logger.info('worker shutdown complete');
    process.exit(0);
  });
}
