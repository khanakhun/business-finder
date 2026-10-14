import { createHash } from 'node:crypto';
import { isSpanContextValid, trace } from '@opentelemetry/api';
import pino, { type DestinationStream, type Logger } from 'pino';
import { getLogContext } from './log-context.ts';

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
export type { Logger };

export interface CreateLoggerOptions {
  readonly service: string;
  readonly level?: LogLevel;
  /** Human-readable output for local development (never in production). */
  readonly pretty?: boolean;
  readonly env?: string;
  readonly version?: string;
  /** Extra exact pino paths to redact, e.g. `payload.ssn`. */
  readonly redactPaths?: readonly string[];
  /** Extra key names redacted at any depth. */
  readonly redactKeys?: readonly string[];
  /** Where to write; defaults to stdout. Tests pass an in-memory stream. */
  readonly destination?: DestinationStream;
}

export const REDACTED = '[redacted]';

/** Exact paths (security.md §7): request credentials and email bodies. */
const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["set-cookie"]',
  'body.html',
  'body.text',
];

/**
 * Key names redacted wherever they appear (normalised: lowercase, no `_`/`-`). pino's own paths cannot express
 * "any depth", so these are handled by `redactDeep` in the log formatter.
 */
const SENSITIVE_KEYS = [
  'password',
  'passwd',
  'secret',
  'clientsecret',
  'token',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'apikey',
  'authorization',
  'cookie',
  'privatekey',
  'credentials',
];

const MAX_DEPTH = 12;
const normalise = (key: string) => key.toLowerCase().replaceAll(/[_-]/g, '');

/** Copy of `value` with every property whose (normalised) name is in `keys` replaced by `[redacted]`. */
export function redactDeep(
  value: unknown,
  keys: ReadonlySet<string>,
  depth = 0,
  seen = new WeakSet<object>(),
): unknown {
  if (value === null || typeof value !== 'object' || value instanceof Date) return value;
  if (depth >= MAX_DEPTH) return REDACTED;
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, keys, depth + 1, seen));
  const out: Record<string, unknown> = {};
  // The log formatter runs before pino's err serializer; keep Error's non-enumerable fields or they are lost.
  if (value instanceof Error)
    Object.assign(out, { type: value.name, message: value.message, stack: value.stack });
  for (const [key, item] of Object.entries(value)) {
    out[key] = keys.has(normalise(key)) ? REDACTED : redactDeep(item, keys, depth + 1, seen);
  }
  return out;
}

/**
 * Structured JSON logger (pino). Every line carries `service`, `env`, `version`, the active `traceId`/`spanId`
 * and the `withLogContext` fields; secrets are redacted by path and by key name at any depth.
 */
export function createLogger(options: CreateLoggerOptions): Logger {
  const keys = new Set([...SENSITIVE_KEYS, ...(options.redactKeys ?? [])].map(normalise));
  const config: pino.LoggerOptions = {
    level: options.level ?? 'info',
    base: { service: options.service, env: options.env ?? 'development', version: options.version ?? 'dev' },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: { paths: [...REDACT_PATHS, ...(options.redactPaths ?? [])], censor: REDACTED },
    serializers: { err: pino.stdSerializers.err, error: pino.stdSerializers.err },
    formatters: {
      level: (label) => ({ level: label }),
      log: (object) => redactDeep(object, keys) as Record<string, unknown>,
    },
    mixin: () => {
      const span = trace.getActiveSpan()?.spanContext();
      const valid = span && isSpanContextValid(span);
      return { ...getLogContext(), ...(valid ? { traceId: span.traceId, spanId: span.spanId } : {}) };
    },
  };
  if (options.destination) return pino(config, options.destination);
  if (options.pretty)
    return pino({ ...config, transport: { target: 'pino-pretty', options: { colorize: true } } });
  return pino(config);
}

/**
 * Pseudonymous id for an email address in logs (emails are PII; security.md §7). Normalised and SHA-256 hashed;
 * pass a pepper (from config) to make dictionary reversal harder.
 */
export function hashEmail(email: string, pepper = ''): string {
  const digest = createHash('sha256').update(`${pepper}${email.trim().toLowerCase()}`).digest('hex');
  return `sha256:${digest.slice(0, 16)}`;
}
