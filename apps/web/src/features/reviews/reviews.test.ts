import { describe, expect, it } from 'vitest';
import { splitPastedReviews } from './api.ts';

describe('splitPastedReviews', () => {
  it('splits on blank lines, joins wrapped lines, drops empties and bounds count and size', () => {
    const text = 'First review\nstill the first.\n\n  \n\nSecond review   \n\n\n' + 'x'.repeat(30);
    expect(splitPastedReviews(text, 10, 20)).toEqual([
      'First review still t',
      'Second review',
      'x'.repeat(20),
    ]);
    expect(splitPastedReviews('a\n\nb\n\nc', 2, 100)).toEqual(['a', 'b']);
    expect(splitPastedReviews(' \n \n', 5, 100)).toEqual([]);
  });
});
