import type { ProviderId } from '@bf/contracts';

/** The order with the provider at `index` moved by `delta` (clamped to the list). */
export function moveProvider(order: readonly ProviderId[], index: number, delta: number): ProviderId[] {
  const next = [...order];
  const target = Math.max(0, Math.min(next.length - 1, index + delta));
  const [moved] = next.splice(index, 1);
  if (moved !== undefined) next.splice(target, 0, moved);
  return next;
}
