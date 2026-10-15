import { isDefaultExportSpan, LangfuseSpanProcessor } from '@langfuse/otel';

const EMAIL = /[\w.+-]+@[\w-]+(\.[\w-]+)+/g;
// International or local numbers with at least 8 digits (separators allowed); avoids masking short numbers.
const PHONE = /(?:\+?\d[\s().-]?){8,}\d/g;

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
