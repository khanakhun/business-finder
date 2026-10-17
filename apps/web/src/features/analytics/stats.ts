// Honest numbers (BF-058): Wilson score intervals for rates, a minimum sample under which a rate is muted, and the
// formatting of each metric format.

export const MIN_SAMPLE = 30;

/** The 95% Wilson score interval of `successes / n` (null when n is 0). */
export function wilson(successes: number, n: number, z = 1.96): { low: number; high: number } | null {
  if (n <= 0) return null;
  const p = Math.min(1, Math.max(0, successes / n));
  const z2 = z * z;
  const center = (p + z2 / (2 * n)) / (1 + z2 / n);
  const margin = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / (1 + z2 / n);
  return { low: Math.max(0, center - margin), high: Math.min(1, center + margin) };
}

/** Whether two intervals do not overlap (a difference worth looking at, not a verdict). */
export const separated = (a: { low: number; high: number } | null, b: { low: number; high: number } | null) =>
  a !== null && b !== null && (a.low > b.high || b.low > a.high);
