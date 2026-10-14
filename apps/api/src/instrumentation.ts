// Telemetry preload: must run before any instrumented module is imported (docs/OBSERVABILITY.md).
//   node --import @swc-node/register/esm-register --import ./src/instrumentation.ts src/main.ts
import { register } from 'node:module';
import { coreEnv, loadEnv } from '@bf/config';
import { initTelemetry } from '@bf/observability';

// ESM auto-instrumentation (e.g. ioredis imported from ESM) needs the import-in-the-middle hook.
register('@opentelemetry/instrumentation/hook.mjs', import.meta.url);

const env = loadEnv(coreEnv.pick({ OTEL_EXPORTER_OTLP_ENDPOINT: true, APP_VERSION: true }), {
  label: 'telemetry',
});
const service = process.argv.some((arg) => arg.endsWith('worker.ts') || arg.endsWith('worker.js'))
  ? 'bf-worker'
  : 'bf-api';

export const telemetry = initTelemetry({
  serviceName: service,
  serviceVersion: env.APP_VERSION,
  exporter: env.OTEL_EXPORTER_OTLP_ENDPOINT ? 'otlp' : 'none',
  ...(env.OTEL_EXPORTER_OTLP_ENDPOINT ? { otlpEndpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT } : {}),
  shutdownOnSignals: true,
});
