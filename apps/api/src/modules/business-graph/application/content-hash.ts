import { createHash } from 'node:crypto';

/** JSON with object keys sorted at every level, so equal content always hashes the same. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
}

/** `sha256:<hex>` of the canonical JSON: lets ingestion skip unchanged provider records (BF-016). */
export function contentHash(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}
