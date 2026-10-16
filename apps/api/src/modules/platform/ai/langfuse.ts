import { isDefaultExportSpan, LangfuseSpanProcessor } from '@langfuse/otel';
import type { ReadableSpan, SpanProcessor } from '@opentelemetry/sdk-trace-base';

const EMAIL = /[\w.+-]+@[\w-]+(\.[\w-]+)+/g;
// Numbers of 9+ digits with any common separators (spaces, dots, dashes, parentheses, " - ").
const PHONE = /\(?\+?\d(?:[\s().\-\u00a0]{0,3}\d){8,}/g;

/** Masks emails and phone numbers anywhere in a traced value (prompt/response bodies). */
export function maskPersonalData(data: unknown): unknown {
  if (typeof data === 'string') return data.replace(EMAIL, '[email]').replace(PHONE, '[phone]');
  if (Array.isArray(data)) return data.map(maskPersonalData);
  if (data && typeof data === 'object') {
    return Object.fromEntries(Object.entries(data).map(([key, value]) => [key, maskPersonalData(value)]));
  }
  return data;
}

/**
 * Langfuse via OpenTelemetry (when LANGFUSE_* is set): exports only LLM spans — the AI SDK's and `@bf/ai`'s task
 * spans — never HTTP or database spans. Bodies are recorded only with AI_TRACE_CONTENT=true, and masked.
 */
export function langfuseProcessor(options: {
  readonly publicKey: string;
  readonly secretKey: string;
  readonly baseUrl: string;
  readonly environment: string;
  readonly release: string;
}): LangfuseSpanProcessor {
  return new LangfuseSpanProcessor({
    publicKey: options.publicKey,
    secretKey: options.secretKey,
    baseUrl: options.baseUrl,
    environment: options.environment,
    release: options.release,
    shouldExportSpan: ({ otelSpan }) =>
      isDefaultExportSpan(otelSpan) || otelSpan.instrumentationScope.name === '@bf/ai',
    mask: ({ data }) => maskPersonalData(data),
  });
}

/** Attributes the AI SDK uses for prompt and response bodies (only present with AI_TRACE_CONTENT=true). */
const CONTENT_ATTRIBUTE = /^(ai\.(prompt|response|toolCall|result)|gen_ai\.(prompt|completion|input|output))/;

/**
 * Masks emails and phone numbers in AI span bodies before any exporter sees them (OTLP and Langfuse alike).
 * Registered first: span processors run in order, exporters batch later.
 */
export class MaskAiContentProcessor implements SpanProcessor {
  onStart(): void {}

  onEnd(span: ReadableSpan): void {
    const attributes = span.attributes as Record<string, unknown>;
    for (const [key, value] of Object.entries(attributes)) {
      if (typeof value === 'string' && CONTENT_ATTRIBUTE.test(key)) attributes[key] = maskPersonalData(value);
    }
  }

  async forceFlush(): Promise<void> {}

  async shutdown(): Promise<void> {}
}
