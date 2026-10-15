// Audit metadata must never carry secret values (BF-011): keys that name credentials are redacted on write, and
// the structure is bounded so a careless caller cannot store a whole payload.

export const REDACTED = '[REDACTED]';

const SENSITIVE_KEY =
  /(secret|password|passphrase|token|authorization|cookie|credential|private|signature|^value$|^key$|apikey$|api_key$)/i;
const MAX_DEPTH = 4;
const MAX_ENTRIES = 50;
const MAX_STRING = 500;

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY.test(key);
}

function redactValue(value: unknown, depth: number): unknown {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
  if (value instanceof Date) return value.toISOString();
  if (depth >= MAX_DEPTH) return '[TRUNCATED]';
  if (Array.isArray(value)) return value.slice(0, MAX_ENTRIES).map((item) => redactValue(item, depth + 1));
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, MAX_ENTRIES)
        .map(([key, item]) => [key, isSensitiveKey(key) ? REDACTED : redactValue(item, depth + 1)]),
    );
  }
  // Functions, symbols, bigints, undefined: not JSON — dropped to null.
  return null;
}

export function redactMetadata(metadata: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return redactValue(metadata, 0) as Record<string, unknown>;
}
