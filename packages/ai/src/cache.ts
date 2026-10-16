import { createHash } from 'node:crypto';

/** JSON with sorted object keys, so equal inputs always hash the same. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

export const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/** Cache key = (task, prompt version, model, input, workspace when the input may be workspace-private). */
export function responseCacheKey(parts: {
  readonly task: string;
  readonly promptVersion: number;
  readonly model: string;
  readonly input: unknown;
  readonly orgScope: string | null;
}): string {
  return `bf:ai:resp:${sha256(stableStringify(parts))}`;
}

export const embeddingCacheKey = (model: string, text: string) => `bf:ai:emb:${sha256(`${model}\n${text}`)}`;
