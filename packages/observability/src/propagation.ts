import {
  context,
  type Link,
  propagation,
  ROOT_CONTEXT,
  type Span,
  SpanKind,
  SpanStatusCode,
  trace,
} from '@opentelemetry/api';

/** W3C trace context as carried in job payloads (`JobPayloadBase.traceparent` in @bf/contracts). */
export interface TraceCarrier {
  traceparent?: string;
  tracestate?: string;
}

/** Serialises the active trace context for a job payload (empty when there is no active span). */
export function injectTraceContext(): TraceCarrier {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  return {
    ...(carrier.traceparent ? { traceparent: carrier.traceparent } : {}),
    ...(carrier.tracestate ? { tracestate: carrier.tracestate } : {}),
  };
}

/**
 * Runs a job handler in a CONSUMER span that continues the producer's trace (child of the extracted context)
 * and links to the producer span. Without a carrier the job starts a new trace.
 */
export async function runWithExtractedContext<T>(
  carrier: TraceCarrier | undefined,
  name: string,
  fn: (span: Span) => Promise<T> | T,
): Promise<T> {
  const parent = propagation.extract(ROOT_CONTEXT, carrier ?? {});
  const producer = trace.getSpanContext(parent);
  const links: Link[] = producer ? [{ context: producer }] : [];
  const tracer = trace.getTracer('@bf/observability');
  return tracer.startActiveSpan(name, { kind: SpanKind.CONSUMER, links }, parent, async (span) => {
    try {
      return await fn(span);
    } catch (error) {
      span.recordException(error instanceof Error ? error : String(error));
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  });
}
