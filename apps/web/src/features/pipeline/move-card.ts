import type { PipelineBoard, PipelineStatus } from '@bf/contracts';

export type Card = PipelineBoard['columns'][number]['cards'][number];

/** Moves a card from one column to another in the cached board (optimistic drag and drop). */
export function moveCard(board: PipelineBoard, businessId: string, to: PipelineStatus): PipelineBoard {
  const card = board.columns.flatMap((column) => column.cards).find((c) => c.businessId === businessId);
  if (!card) return board;
  return {
    columns: board.columns.map((column) => {
      const without = column.cards.filter((c) => c.businessId !== businessId);
      const removed = without.length !== column.cards.length;
      if (column.status === to)
        return {
          ...column,
          count: column.count + 1,
          cards: [{ ...card, allowedTransitions: [] }, ...without],
        };
      return removed ? { ...column, count: column.count - 1, cards: without } : column;
    }),
  };
}
