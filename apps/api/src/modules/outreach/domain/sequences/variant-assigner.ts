import { createHash } from 'node:crypto';

// A/B variants (BF-053): the same enrollment always gets the same variant of a step — a hash of the enrollment and
// step ids picks a bucket in 0..99 along the cumulative weights.

export function assignVariant(
  enrollmentId: string,
  stepId: string,
  variants: readonly { readonly id: string; readonly weight: number }[],
): string | null {
  const total = variants.reduce((sum, variant) => sum + variant.weight, 0);
  if (variants.length === 0 || total <= 0) return null;
  const digest = createHash('sha256').update(`${enrollmentId}:${stepId}`).digest();
  const bucket = digest.readUInt32BE(0) % total;
  let cumulative = 0;
  for (const variant of variants) {
    cumulative += variant.weight;
    if (bucket < cumulative) return variant.id;
  }
  return variants.at(-1)?.id ?? null;
}

/** Wilson score interval at 95% (stats of a step or variant). */
export function wilson(
  successes: number,
  n: number,
): { rate: number | null; low: number | null; high: number | null } {
  if (n === 0) return { rate: null, low: null, high: null };
  const z = 1.96;
  const p = successes / n;
  const denominator = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denominator;
  const margin = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denominator;
  return { rate: p, low: Math.max(0, centre - margin), high: Math.min(1, centre + margin) };
}
