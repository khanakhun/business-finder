import { EMAIL_VERIFIERS, type EmailVerifierId } from '@bf/contracts';

/** The order with the item at `index` moved by `delta` (clamped to the list): providers, verifiers. */
export function moveProvider<T>(order: readonly T[], index: number, delta: number): T[] {
  const next = [...order];
  const target = Math.max(0, Math.min(next.length - 1, index + delta));
  const [moved] = next.splice(index, 1);
  if (moved !== undefined) next.splice(target, 0, moved);
  return next;
}

/** Used e-mail verifiers in their order, then the unused ones (so they can be switched on). */
export function verifierRows(
  chain: readonly EmailVerifierId[],
): Array<{ id: EmailVerifierId; used: boolean }> {
  return [
    ...chain.map((id) => ({ id, used: true })),
    ...EMAIL_VERIFIERS.filter((id) => !chain.includes(id)).map((id) => ({ id, used: false })),
  ];
}
