import type { GenerationJob } from '@bf/contracts';
import { describe, expect, it } from 'vitest';
import { progressTitle, statusChanges } from './announce.ts';

const job = (id: string, status: GenerationJob['status']) =>
  ({ id, businessName: `Business ${id}`, status }) as GenerationJob;

describe('board announcements', () => {
  it('reports only jobs whose status changed', () => {
    const previous = new Map<string, GenerationJob['status']>([
      ['a', 'queued'],
      ['b', 'running'],
    ]);
    expect(statusChanges(previous, [job('a', 'running'), job('b', 'running'), job('c', 'queued')])).toEqual([
      { name: 'Business a', status: 'running' },
    ]);
  });

  it('titles the tab with the progress', () => {
    expect(progressTitle(3, 6, 'Gustavia')).toBe('3/6 · Gustavia');
  });
});
