// Telemetry preload: must run before any instrumented module is imported (docs/OBSERVABILITY.md).
//   node --import @swc-node/register/esm-register --import ./src/instrumentation.ts src/main.ts
import { register } from 'node:module';
import { aiEnv, coreEnv, loadEnv } from '@bf/config';
import { initTelemetry } from '@bf/observability';
import { langfuseProcessor, MaskAiContentProcessor } from './modules/platform/ai/langfuse.ts';

// ESM auto-instrumentation (e.g. ioredis imported from ESM) needs the import-in-the-middle hook.
register('@opentelemetry/instrumentation/hook.mjs', import.meta.url);

const env = loadEnv(
  coreEnv
    .pick({ OTEL_EXPORTER_OTLP_ENDPOINT: true, APP_VERSION: true, NODE_ENV: true })
    .extend(
      aiEnv.pick({ LANGFUSE_PUBLIC_KEY: true, LANGFUSE_SECRET_KEY: true, LANGFUSE_BASE_URL: true }).shape,
    ),
  { label: 'telemetry' },
);
const service = process.argv.some((arg) => arg.endsWith('worker.ts') || arg.endsWith('worker.js'))
  ? 'bf-worker'
  : 'bf-api';

export const telemetry = initTelemetry({
  serviceName: service,
  serviceVersion: env.APP_VERSION,
  exporter: env.OTEL_EXPORTER_OTLP_ENDPOINT ? 'otlp' : 'none',
  ...(env.OTEL_EXPORTER_OTLP_ENDPOINT ? { otlpEndpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT } : {}),
  shutdownOnSignals: true,
  spanProcessors: [
    // First, so no exporter sees unmasked prompt/response bodies (BF-013).
    new MaskAiContentProcessor(),
    // LLM traces to Langfuse when configured.
    ...(env.LANGFUSE_PUBLIC_KEY && env.LANGFUSE_SECRET_KEY
      ? [
          langfuseProcessor({
            publicKey: env.LANGFUSE_PUBLIC_KEY,
            secretKey: env.LANGFUSE_SECRET_KEY,
            baseUrl: env.LANGFUSE_BASE_URL,
            environment: env.NODE_ENV,
            release: env.APP_VERSION,
          }),
        ]
      : []),
  ],
});
