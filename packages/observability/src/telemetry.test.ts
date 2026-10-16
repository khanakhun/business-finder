import { Writable } from 'node:stream';
import { SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createLogger } from './logger.ts';
import { injectTraceContext, runWithExtractedContext } from './propagation.ts';
import { initTelemetry, startSpan } from './telemetry.ts';

const exporter = new InMemorySpanExporter();
const telemetry = initTelemetry({
  serviceName: 'bf-test',
  serviceVersion: '1.0.0',
  exporter: 'none',
  autoInstrument: false,
  spanProcessors: [new SimpleSpanProcessor(exporter)],
});

afterAll(() => telemetry.shutdown());
beforeEach(() => exporter.reset());

/** Processors export asynchronously; flush before asserting on finished spans. */
async function finishedSpans() {
  await telemetry.forceFlush();
  return exporter.getFinishedSpans();
}

describe('startSpan', () => {
  it('creates an active span with attributes and ends it', async () => {
    const result = await startSpan('test.operation', { 'bf.org_id': 'org-1' }, async (span) => {
      expect(trace.getActiveSpan()).toBe(span);
      return 42;
    });
    expect(result).toBe(42);
    const [span] = await finishedSpans();
    expect(span?.name).toBe('test.operation');
    expect(span?.attributes).toEqual({ 'bf.org_id': 'org-1' });
    expect(span?.resource.attributes['service.name']).toBe('bf-test');
  });

  it('records errors and rethrows', async () => {
    await expect(startSpan('test.failing', {}, () => Promise.reject(new Error('nope')))).rejects.toThrow(
      'nope',
    );
    await expect(startSpan('test.failing_string', {}, () => Promise.reject('plain'))).rejects.toBe('plain');
    const [span, stringSpan] = await finishedSpans();
    expect(span?.status).toEqual({ code: SpanStatusCode.ERROR, message: 'nope' });
    expect(span?.events.map((e) => e.name)).toContain('exception');
    expect(stringSpan?.status.message).toBe('plain');
  });
});

describe('queue hop propagation', () => {
  it('continues the producer trace in the consumer and links the spans', async () => {
    // Producer: enqueue inside a span, carrying the context in the job payload.
    const payload = await startSpan('discovery.enqueue', {}, async () => ({
      data: 1,
      ...injectTraceContext(),
    }));
    expect(payload.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    // "Serialise" through the queue.
    const received = JSON.parse(JSON.stringify(payload));

    // Consumer: a different async chain (no active context) restores it from the payload.
    await runWithExtractedContext(received, 'job.process discovery', async () => {
      await startSpan('discovery.run', {}, async () => undefined);
    });

    const spans = await finishedSpans();
    const producer = spans.find((s) => s.name === 'discovery.enqueue');
    const consumer = spans.find((s) => s.name === 'job.process discovery');
    const child = spans.find((s) => s.name === 'discovery.run');
    const traceId = producer?.spanContext().traceId;
    expect(consumer?.spanContext().traceId).toBe(traceId);
    expect(child?.spanContext().traceId).toBe(traceId);
    expect(consumer?.kind).toBe(SpanKind.CONSUMER);
    expect(consumer?.parentSpanContext?.spanId).toBe(producer?.spanContext().spanId);
    expect(consumer?.links[0]?.context.spanId).toBe(producer?.spanContext().spanId);
    expect(child?.parentSpanContext?.spanId).toBe(consumer?.spanContext().spanId);
  });

  it('starts a new trace when the job carries no context', async () => {
    expect(injectTraceContext()).toEqual({});
    await runWithExtractedContext(undefined, 'job.process orphan', async () => undefined);
    const [span] = await finishedSpans();
    expect(span?.parentSpanContext).toBeUndefined();
    expect(span?.links).toEqual([]);
  });

  it('marks failed jobs', async () => {
    await expect(
      runWithExtractedContext({}, 'job.process broken', () => Promise.reject(new Error('x'))),
    ).rejects.toThrow('x');
    await expect(runWithExtractedContext({}, 'job.process broken2', () => Promise.reject('y'))).rejects.toBe(
      'y',
    );
    expect((await finishedSpans()).map((s) => s.status.code)).toEqual([
      SpanStatusCode.ERROR,
      SpanStatusCode.ERROR,
    ]);
  });
});

describe('logs inside spans', () => {
  it('carry the trace and span ids', async () => {
    const lines: Record<string, unknown>[] = [];
    const destination = new Writable({
      write(chunk, _e, cb) {
        lines.push(JSON.parse(String(chunk)));
        cb();
      },
    });
    const logger = createLogger({ service: 'test', destination });
    await startSpan('http.request', {}, async (span) => {
      logger.info('handled');
      // A real (non-zero) trace id proves the SDK is registered, not the no-op API.
      expect(span.spanContext().traceId).not.toMatch(/^0+$/);
      expect(lines[0]).toMatchObject({
        traceId: span.spanContext().traceId,
        spanId: span.spanContext().spanId,
      });
    });
  });
});

describe('initTelemetry validation', () => {
  it('rejects bad options', () => {
    expect(() => initTelemetry({ serviceName: 'x', exporter: 'none', samplingRatio: 2 })).toThrow(
      /samplingRatio/,
    );
    expect(() => initTelemetry({ serviceName: 'x', exporter: 'otlp' })).toThrow(/otlpEndpoint/);
  });
});
