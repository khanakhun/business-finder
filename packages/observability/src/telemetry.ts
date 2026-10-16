import { type Attributes, type Span, SpanStatusCode, trace } from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { IORedisInstrumentation } from '@opentelemetry/instrumentation-ioredis';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';
import { defaultResource, resourceFromAttributes } from '@opentelemetry/resources';
import { NodeSDK } from '@opentelemetry/sdk-node';
import {
  BatchSpanProcessor,
  ConsoleSpanExporter,
  ParentBasedSampler,
  type SpanProcessor,
  TraceIdRatioBasedSampler,
} from '@opentelemetry/sdk-trace-base';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';

export type TraceExporterKind = 'otlp' | 'console' | 'none';

export interface InitTelemetryOptions {
  readonly serviceName: string;
  readonly serviceVersion?: string;
  /** `none` exports nothing (tests); spans still propagate context so logs carry trace ids. */
  readonly exporter: TraceExporterKind;
  /** Base OTLP/HTTP endpoint, e.g. `http://127.0.0.1:4318` (from `OTEL_EXPORTER_OTLP_ENDPOINT`). */
  readonly otlpEndpoint?: string;
  /** Fraction of new root traces to sample (children follow their parent). Default 1. */
  readonly samplingRatio?: number;
  /** Extra span processors, e.g. an in-memory exporter in tests. */
  readonly spanProcessors?: readonly SpanProcessor[];
  /** Install http/undici/ioredis auto-instrumentation. Default true. */
  readonly autoInstrument?: boolean;
  /** Flush and shut down on SIGTERM/SIGINT. Leave off when the app framework handles shutdown. */
  readonly shutdownOnSignals?: boolean;
}

export interface Telemetry {
  /** Exports every ended span now (processors export asynchronously, after resource detection settles). */
  forceFlush(): Promise<void>;
  shutdown(): Promise<void>;
}

/**
 * Starts the OpenTelemetry Node SDK. Call it before importing anything it should instrument — in Node 24 ESM
 * that means a preload: `node --import ./instrumentation.ts main.ts` (docs/OBSERVABILITY.md).
 *
 * Note: postgres.js has no OpenTelemetry instrumentation (`instrumentation-pg` covers `pg` only); database
 * spans are created manually.
 */
export function initTelemetry(options: InitTelemetryOptions): Telemetry {
  const ratio = options.samplingRatio ?? 1;
  if (!(ratio >= 0 && ratio <= 1)) throw new Error(`samplingRatio must be within [0, 1], got ${ratio}`);
  if (options.exporter === 'otlp' && !options.otlpEndpoint)
    throw new Error('exporter "otlp" needs otlpEndpoint');

  const processors: SpanProcessor[] = [...(options.spanProcessors ?? [])];
  if (options.exporter === 'otlp') {
    const url = `${options.otlpEndpoint?.replace(/\/$/, '')}/v1/traces`;
    processors.push(new BatchSpanProcessor(new OTLPTraceExporter({ url })));
  } else if (options.exporter === 'console') {
    processors.push(new BatchSpanProcessor(new ConsoleSpanExporter()));
  }

  const sdk = new NodeSDK({
    resource: defaultResource().merge(
      resourceFromAttributes({
        [ATTR_SERVICE_NAME]: options.serviceName,
        [ATTR_SERVICE_VERSION]: options.serviceVersion ?? 'dev',
      }),
    ),
    sampler: new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(ratio) }),
    // Explicit (possibly empty) lists stop the SDK from configuring exporters from OTEL_* env vars, so
    // `exporter: 'none'` really makes zero network calls.
    spanProcessors: processors,
    logRecordProcessors: [],
    metricReaders: [],
    instrumentations:
      options.autoInstrument === false
        ? []
        : [new HttpInstrumentation(), new UndiciInstrumentation(), new IORedisInstrumentation()],
  });
  sdk.start();

  let stopped: Promise<void> | undefined;
  const shutdown = () => {
    stopped ??= sdk.shutdown();
    return stopped;
  };
  if (options.shutdownOnSignals) {
    for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => void shutdown());
  }
  const forceFlush = async () => {
    await Promise.all(processors.map((processor) => processor.forceFlush()));
  };
  return { forceFlush, shutdown };
}

const tracer = () => trace.getTracer('@bf/observability');

/**
 * Runs `fn` in a new active span named `<module>.<operation>`; exceptions are recorded, the span is marked as
 * an error and the exception is rethrown. The span always ends.
 */
export async function startSpan<T>(
  name: string,
  attributes: Attributes,
  fn: (span: Span) => Promise<T> | T,
): Promise<T> {
  return tracer().startActiveSpan(name, { attributes }, async (span) => {
    try {
      return await fn(span);
    } catch (error) {
      span.recordException(error instanceof Error ? error : String(error));
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      span.end();
    }
  });
}
