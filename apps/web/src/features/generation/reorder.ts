// Ordering in the create flow and on the board (BF-046): position is priority, so moving an item is the only
// reordering there is. Pure: both lists use it, for drag and drop and for the keyboard (move up / move down).

/** `items` with the one at `from` moved to `to` (indices clamped; the same array when nothing moves). */
export function move<T>(items: readonly T[], from: number, to: number): T[] {
  const target = Math.max(0, Math.min(items.length - 1, to));
  if (from < 0 || from >= items.length || from === target) return [...items];
  const next = [...items];
  const [item] = next.splice(from, 1) as [T];
  next.splice(target, 0, item);
  return next;
}

/** The ids of `items` after moving `id` onto the position of `overId` (drag and drop). */
export function moveById<T extends { readonly id: string }>(
  items: readonly T[],
  id: string,
  overId: string,
): T[] {
  const from = items.findIndex((item) => item.id === id);
  const to = items.findIndex((item) => item.id === overId);
  return from < 0 || to < 0 ? [...items] : move(items, from, to);
}
