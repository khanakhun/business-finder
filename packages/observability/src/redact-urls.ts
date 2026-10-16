import type { Context } from '@opentelemetry/api';
import type { ReadableSpan, Span, SpanProcessor } from '@opentelemetry/sdk-trace-base';
import { REDACTED } from './logger.ts';

/** Span attributes that carry a request URL or its query string (HTTP/undici semantic conventions, old and new). */
const URL_ATTRIBUTES = ['url.full', 'url.query', 'http.url', 'http.target'] as const;
/** Query parameters whose values are credentials or personal data (some APIs take keys in the query string). */
const SENSITIVE_PARAM = /^(api_?key|key|token|access_token|secret|sig|signature|password|email|to_email)$/i;
const EMAIL = /[^\s@&=?]+@[^\s@&=?]+/;

/** A query string (`a=1&b=2`, with or without `?`) with sensitive or e-mail-looking values replaced. */
export function redactQuery(query: string): string {
  return query
    .split('&')
    .map((pair) => {
      const separator = pair.indexOf('=');
      if (separator < 0) return pair;
      const name = pair.slice(0, separator);
      const value = pair.slice(separator + 1);
      let decoded = value;
      try {
        decoded = decodeURIComponent(value.replace(/\+/g, ' '));
      } catch {
        // Malformed escapes: judge the raw value.
      }
      return SENSITIVE_PARAM.test(name.replace(/^\?/, '')) || EMAIL.test(decoded)
        ? `${name}=${REDACTED}`
        : pair;
    })
    .join('&');
}

/** A URL (absolute, or a path with a query) with its sensitive query values replaced. */
export function redactUrl(value: string): string {
  const question = value.indexOf('?');
  if (question < 0) return value;
  const hash = value.indexOf('#', question);
  const query = value.slice(question + 1, hash < 0 ? undefined : hash);
  return `${value.slice(0, question + 1)}${redactQuery(query)}${hash < 0 ? '' : value.slice(hash)}`;
}

/**
 * Redacts credentials and e-mail addresses from request URLs on every span before any exporter sees them (some
 * provider APIs, e.g. ZeroBounce, take the key and the address in the query string). Registered first by
 * `initTelemetry`: processors run in order, exporters batch later.
 */
export class RedactUrlProcessor implements SpanProcessor {
  onStart(_span: Span, _context: Context): void {}

  onEnd(span: ReadableSpan): void {
    const attributes = span.attributes as Record<string, unknown>;
    for (const key of URL_ATTRIBUTES) {
      const value = attributes[key];
      if (typeof value !== 'string') continue;
      attributes[key] = key === 'url.query' ? redactQuery(value) : redactUrl(value);
    }
  }

  async forceFlush(): Promise<void> {}

  async shutdown(): Promise<void> {}
}
