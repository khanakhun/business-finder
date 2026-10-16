import type { FeatureValue, Transform } from '@bf/contracts';

// Transforms (BF-031, Strategy): a raw feature value → 0–1. Every transform is monotone (non-decreasing, or
// non-increasing for `inverse`), clamps outside its range and is pure.

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

/** The transformed value, or null when the value is missing or of a kind the transform cannot read. */
export function applyTransform(transform: Transform | undefined, value: FeatureValue): number | null {
  if (value === null) return null;
  if (!transform) {
    // Defaults: a boolean is 1/0, a number already on 0–1 is itself; anything else needs a transform.
    if (typeof value === 'boolean') return value ? 1 : 0;
    return typeof value === 'number' ? clamp01(value) : null;
  }
  switch (transform.kind) {
    case 'boolean':
      return typeof value === 'boolean' ? (value ? transform.true : transform.false) : null;
    case 'enumMap':
      return typeof value === 'string' || typeof value === 'boolean'
        ? (transform.map[String(value)] ?? transform.default)
        : null;
    default:
      return typeof value === 'number' ? numeric(transform, value) : null;
  }
}

function numeric(transform: Exclude<Transform, { kind: 'boolean' | 'enumMap' }>, value: number): number {
  switch (transform.kind) {
    case 'linear':
      return clamp01((value - transform.min) / (transform.max - transform.min));
    case 'inverse':
      return 1 - clamp01((value - transform.min) / (transform.max - transform.min));
    case 'log':
      return clamp01(Math.log(1 + Math.max(0, value)) / Math.log(1 + transform.max));
    case 'piecewise': {
      const points = transform.points;
      const first = points[0];
      const last = points[points.length - 1];
      if (!first || !last) return 0;
      if (value <= first[0]) return first[1];
      if (value >= last[0]) return last[1];
      for (let i = 1; i < points.length; i++) {
        const [x0, y0] = points[i - 1] as [number, number];
        const [x1, y1] = points[i] as [number, number];
        if (value <= x1) return clamp01(y0 + ((value - x0) / (x1 - x0)) * (y1 - y0));
      }
      return last[1];
    }
  }
}
