import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useJobEvents } from './use-job-events.ts';

// The console's stream (BF-046): events once each across reconnects, a reconnect from the last seq when the browser
// gives up, and the end of the stream once the job is settled.

vi.mock('@/lib/public-env.ts', () => ({ publicEnv: () => ({ apiUrl: 'https://api.test' }) }));

class FakeSource extends EventTarget {
  readyState = 0;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(readonly url: string) {
    super();
  }
  close() {
    this.closed = true;
    this.readyState = 2;
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  send(type: string, data: unknown, id = '') {
    this.dispatchEvent(new MessageEvent(type, { data: JSON.stringify(data), lastEventId: id }));
  }
  fail(readyState: number) {
    this.readyState = readyState;
    this.onerror?.();
  }
}

const at = '2026-10-17T08:00:00.000Z';
const log = (message: string) => ({ type: 'log', level: 'info', message, attempt: 1, at });

describe('useJobEvents', () => {
  let sources: FakeSource[];
  beforeEach(() => {
    sources = [];
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());
  const create = (url: string) => {
    const source = new FakeSource(url);
    sources.push(source);
    return source as unknown as EventSource;
  };

  it('keeps events once across reconnects and resumes after the last seq', async () => {
    const { result } = renderHook(() => useJobEvents('job-1', create));
    const first = sources[0] as FakeSource;
    expect(first.url).toBe('https://api.test/v1/generation-jobs/job-1/events');
    act(() => {
      first.open();
      first.send('log', log('a'), '1');
      first.send('log', log('b'), '2');
      // The browser replays an id it already delivered.
      first.send('log', log('b'), '2');
    });
    await act(async () => vi.advanceTimersByTimeAsync(20));
    expect(result.current.state).toBe('live');
    expect(result.current.events.map((event) => event.seq)).toEqual([1, 2]);

    // The browser gives up: we reconnect after a backoff, from seq 2.
    act(() => first.fail(2));
    expect(result.current.state).toBe('reconnecting');
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    const second = sources[1] as FakeSource;
    expect(second.url).toBe('https://api.test/v1/generation-jobs/job-1/events?after=2');
    act(() => {
      second.open();
      second.send('log', log('c'), '3');
      // An engine `error` event (with data) is an event; the connection's own error is not.
      second.send(
        'error',
        { type: 'error', code: 'X', message: 'boom', retryable: true, attempt: 1, at },
        '4',
      );
      second.send('job', { status: 'succeeded' });
    });
    await act(async () => vi.advanceTimersByTimeAsync(20));
    expect(result.current.events.map((event) => event.seq)).toEqual([1, 2, 3, 4]);
    expect(result.current.state).toBe('ended');
    expect(result.current.status).toBe('succeeded');
    expect(second.closed).toBe(true);
  });

  it('closes the stream when unmounted', () => {
    const { unmount } = renderHook(() => useJobEvents('job-2', create));
    unmount();
    expect(sources[0]?.closed).toBe(true);
  });
});
