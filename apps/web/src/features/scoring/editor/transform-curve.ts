import type { Transform } from '@bf/contracts';

// The shape of a number transform, for the editor's small chart (BF-032). Illustration only: scores always come from
// the server's engine.

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

function at(transform: Transform, x: number): number {
  switch (transform.kind) {
    case 'linear':
      return clamp01((x - transform.min) / (transform.max - transform.min));
    case 'inverse':
      return 1 - clamp01((x - transform.min) / (transform.max - transform.min));
    case 'log':
      return clamp01(Math.log1p(Math.max(0, x)) / Math.log1p(transform.max));
    case 'piecewise': {
      const points = transform.points;
      const first = points[0];
      const last = points.at(-1);
      if (!first || !last) return 0;
      if (x <= first[0]) return first[1];
      if (x >= last[0]) return last[1];
      for (let i = 1; i < points.length; i += 1) {
        const [x1, y1] = points[i] as [number, number];
        const [x0, y0] = points[i - 1] as [number, number];
        if (x <= x1) return y0 + ((x - x0) / (x1 - x0)) * (y1 - y0);
      }
      return last[1];
    }
    default:
      return 0;
  }
}

/** The x span shown: the transform's own bounds, a little wider. */
function span(transform: Transform): [number, number] | null {
  switch (transform.kind) {
    case 'linear':
    case 'inverse': {
      const pad = (transform.max - transform.min) * 0.15;
      return [transform.min - pad, transform.max + pad];
    }
    case 'log':
      return [0, transform.max * 1.2];
    case 'piecewise': {
      const xs = transform.points.map(([x]) => x);
      const lo = Math.min(...xs);
      const hi = Math.max(...xs);
      const pad = (hi - lo) * 0.15 || 1;
      return [lo - pad, hi + pad];
    }
    default:
      return null;
  }
}

/** `[x, y]` samples of a number transform (null for boolean and enum maps, shown as their values instead). */
export function transformCurve(transform: Transform, samples = 40): [number, number][] | null {
  const bounds = span(transform);
  if (!bounds) return null;
  const [lo, hi] = bounds;
  if (!(hi > lo)) return null;
  return Array.from({ length: samples + 1 }, (_, i) => {
    const x = lo + ((hi - lo) * i) / samples;
    return [x, at(transform, x)];
  });
}
