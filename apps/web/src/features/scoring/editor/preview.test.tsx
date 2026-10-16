import type { ScoringProfileConfig } from '@bf/contracts';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const explainAll = vi.fn();
vi.mock('../api.ts', () => ({ explainAll: (...args: unknown[]) => explainAll(...args) }));

const { useDraftScores } = await import('./preview.tsx');

const config = (weight: number) =>
  ({
    offer: 'new_website',
    weights: { has_phone: weight },
    tiers: { A: 60, B: 30 },
  }) as unknown as ScoringProfileConfig;
const sample = [
  { businessId: 'a', displayName: 'A', score: 50, tier: 'B' as const },
  { businessId: 'b', displayName: 'B', score: null, tier: null },
];

describe('useDraftScores', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    explainAll.mockReset();
    explainAll.mockImplementation(async (draft: ScoringProfileConfig, ids: string[]) =>
      ids.map((businessId) => ({ businessId, score: draft.weights.has_phone ?? 0, tier: 'C', gate: null })),
    );
  });
  afterEach(() => vi.useRealTimers());

  it('scores once the edits stop for 700 ms, with the last config only', async () => {
    const { result, rerender } = renderHook(({ c }) => useDraftScores(c, sample), {
      initialProps: { c: config(10) },
    });
    expect(result.current.status).toBe('loading');
    await act(() => vi.advanceTimersByTimeAsync(300));
    rerender({ c: config(20) });
    await act(() => vi.advanceTimersByTimeAsync(699));
    expect(explainAll).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(explainAll).toHaveBeenCalledTimes(1);
    expect(explainAll.mock.calls[0]?.[0]).toEqual(config(20));
    expect(explainAll.mock.calls[0]?.[1]).toEqual(['a', 'b']);
    expect(result.current).toMatchObject({ status: 'done', items: [{ score: 20 }, { score: 20 }] });
  });

  it('does not score the same config over the same businesses twice in a row', async () => {
    const { result, rerender } = renderHook(({ items }) => useDraftScores(config(10), items), {
      initialProps: { items: sample },
    });
    await act(() => vi.advanceTimersByTimeAsync(700));
    // A refetched sample: new objects, same businesses.
    rerender({ items: sample.map((item) => ({ ...item })) });
    await act(() => vi.advanceTimersByTimeAsync(700));
    expect(explainAll).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe('done');
  });

  it('reports a failure, and makes no request without a config or businesses', async () => {
    explainAll.mockRejectedValueOnce(Object.assign(new Error('slow down'), { status: 429 }));
    const { result } = renderHook(() => useDraftScores(config(10), sample));
    await act(() => vi.advanceTimersByTimeAsync(700));
    expect(result.current).toMatchObject({ status: 'error' });
    renderHook(() => useDraftScores(null, sample));
    renderHook(() => useDraftScores(config(10), []));
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(explainAll).toHaveBeenCalledTimes(1);
  });
});
