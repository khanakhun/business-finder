// pnpm --filter @bf/observability demo:trace — sends a small producer → queue → consumer trace to the local
// collector (`pnpm infra:up --profile observability`) and prints where to see it in Jaeger.
import { coreEnv, loadEnvOrExit } from '@bf/config';
import { z } from 'zod';
import { createLogger } from '../logger.ts';
import { injectTraceContext, runWithExtractedContext } from '../propagation.ts';
import { initTelemetry, startSpan } from '../telemetry.ts';

const env = loadEnvOrExit(
  z.object({
    OTEL_EXPORTER_OTLP_ENDPOINT: coreEnv.shape.OTEL_EXPORTER_OTLP_ENDPOINT,
    BF_JAEGER_UI_PORT: z.string().default('16686'),
  }),
  { label: 'demo:trace' },
);
if (!env.OTEL_EXPORTER_OTLP_ENDPOINT) {
  console.error('OTEL_EXPORTER_OTLP_ENDPOINT is not set. Run `pnpm infra:up --profile observability` first.');
  process.exit(1);
}

const telemetry = initTelemetry({
  serviceName: 'bf-demo',
  serviceVersion: '0.0.0',
  exporter: 'otlp',
  otlpEndpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT,
  autoInstrument: false,
});
const logger = createLogger({ service: 'bf-demo', pretty: false });

const traceId = await startSpan('demo.request', { 'http.route': '/v1/demo' }, async (span) => {
  logger.info('producer: enqueueing a job');
  const job = await startSpan('demo.enqueue', { 'messaging.destination.name': 'demo' }, async () => ({
    idempotencyKey: 'demo-1',
    ...injectTraceContext(),
  }));
  await runWithExtractedContext(JSON.parse(JSON.stringify(job)), 'job.process demo', async () => {
    logger.info('consumer: processing the job');
    await startSpan(
      'demo.work',
      { 'bf.items': 3 },
      async () => new Promise((resolve) => setTimeout(resolve, 25)),
    );
  });
  return span.spanContext().traceId;
});

await telemetry.forceFlush();
await telemetry.shutdown();
console.log(`Sent trace ${traceId}`);
console.log(`Open http://127.0.0.1:${env.BF_JAEGER_UI_PORT}/trace/${traceId}`);
