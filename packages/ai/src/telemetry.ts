import { type Span, SpanStatusCode, trace } from '@opentelemetry/api';

const tracer = () => trace.getTracer('@bf/ai');

/** Runs a gateway call in an `ai.task <name>` span; AI SDK spans (provider calls) nest inside it. */
export async function withTaskSpan<T>(
  name: string,
  attributes: Record<string, string | number | boolean>,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return tracer().startActiveSpan(`ai.task ${name}`, { attributes }, async (span) => {
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

export const activeTraceId = (span: Span): string | null => {
  const context = span.spanContext();
  return /^0+$/.test(context.traceId) ? null : context.traceId;
};

/** AI SDK telemetry settings: grouped by task; prompt/response bodies only when explicitly allowed. */
export const sdkTelemetry = (task: string, traceContent: boolean) => ({
  functionId: task,
  recordInputs: traceContent,
  recordOutputs: traceContent,
});
