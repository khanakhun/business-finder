import { createHash } from 'node:crypto';

/** A deterministic unit vector for `text` (same text → same vector), for search tests without a model. */
export function fakeEmbedding(text: string, dims = 1536): number[] {
  const values: number[] = [];
  let block = 0;
  while (values.length < dims) {
    const digest = createHash('sha256').update(`${block++}\n${text}`).digest();
    for (let i = 0; i + 1 < digest.length && values.length < dims; i += 2) {
      values.push((digest.readUInt16BE(i) / 0xffff) * 2 - 1);
    }
  }
  const norm = Math.sqrt(values.reduce((sum, v) => sum + v * v, 0)) || 1;
  return values.map((v) => v / norm);
}
