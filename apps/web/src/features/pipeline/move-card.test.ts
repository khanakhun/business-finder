import type { PipelineBoard } from '@bf/contracts';
import { describe, expect, it } from 'vitest';
import { moveCard } from './move-card.ts';

const card = (id: string) =>
  ({
    businessId: id,
    displayName: id,
    allowedTransitions: [{ to: 'contacted', requiresReason: false }],
  }) as never;

const board: PipelineBoard = {
  columns: [
    { status: 'qualified', count: 3, cards: [card('a'), card('b')] },
    { status: 'contacted', count: 1, cards: [card('c')] },
  ],
} as PipelineBoard;

describe('moveCard', () => {
  it('moves the card to the top of the target column and fixes counts', () => {
    const moved = moveCard(board, 'a', 'contacted');
    expect(moved.columns.map((c) => [c.status, c.count, c.cards.map((x) => x.businessId)])).toEqual([
      ['qualified', 2, ['b']],
      ['contacted', 2, ['a', 'c']],
    ]);
    // Until the server answers, the moved card offers no further moves.
    expect(moved.columns[1]?.cards[0]?.allowedTransitions).toEqual([]);
  });

  it('leaves the board alone for an unknown card', () => {
    expect(moveCard(board, 'zzz', 'contacted')).toBe(board);
  });
});
