import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { compareStreamIds, formatSse, isStreamId, type SseMessage, serveSse } from './sse.ts';

function fakeStream(writableLength = () => 0) {
  const req = new EventEmitter();
  const chunks: string[] = [];
  const res = {
    headers: {} as Record<string, string>,
    writableEnded: false,
    get writableLength() {
      return writableLength();
    },
    status: vi.fn(),
    setHeader(name: string, value: string) {
      this.headers[name] = value;
    },
    flushHeaders: vi.fn(),
    write: (chunk: string) => {
      chunks.push(chunk);
      return true;
    },
    end() {
      this.writableEnded = true;
    },
  };
  return { req, res, chunks };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('SSE format', () => {
  it('writes id, event and one JSON data line', () => {
    expect(formatSse({ id: '1-0', event: 'x.y', data: { a: 'line\nbreak' } })).toBe(
      'id: 1-0\nevent: x.y\ndata: {"a":"line\\nbreak"}\n\n',
    );
    expect(formatSse({ data: 1 })).toBe('data: 1\n\n');
  });

  it('orders Valkey stream ids numerically', () => {
    expect(compareStreamIds('10-0', '9-5')).toBe(1);
    expect(compareStreamIds('9-5', '9-10')).toBe(-1);
    expect(compareStreamIds('9-5', '9-5')).toBe(0);
    expect(isStreamId('1697000000000-3')).toBe(true);
    expect(isStreamId("1-0'; DROP")).toBe(false);
  });
});

describe('serveSse', () => {
  it('replays, then delivers live messages without duplicates or gaps', async () => {
    const { req, res, chunks } = fakeStream();
    let push: (m: SseMessage) => void = () => undefined;
    await serveSse(req as never, res as never, {
      lastEventId: '1-0',
      compareIds: compareStreamIds,
      subscribe: async (p) => {
        push = p;
        // A live message that the replay also returns arrives during the replay.
        p({ id: '3-0', event: 'e', data: 3 });
        return () => undefined;
      },
      replay: async () => [
        { id: '2-0', event: 'e', data: 2 },
        { id: '3-0', event: 'e', data: 3 },
      ],
    });
    push({ id: '4-0', event: 'e', data: 4 });
    push({ id: '2-0', event: 'e', data: 2 });
    const ids = chunks.filter((c) => c.startsWith('id:')).map((c) => c.split('\n')[0]);
    expect(ids).toEqual(['id: 2-0', 'id: 3-0', 'id: 4-0']);
    expect(res.headers['Content-Type']).toBe('text/event-stream; charset=utf-8');
    expect(chunks[0]).toBe('retry: 3000\n\n');
    req.emit('close');
  });

  it('sends heartbeats and closes after the maximum duration', async () => {
    vi.useFakeTimers();
    const { req, res, chunks } = fakeStream();
    const onClose = vi.fn();
    const unsubscribe = vi.fn();
    await serveSse(req as never, res as never, {
      lastEventId: undefined,
      heartbeatMs: 1_000,
      maxDurationMs: 2_500,
      subscribe: async () => unsubscribe,
      onClose,
    });
    vi.advanceTimersByTime(2_100);
    expect(chunks.filter((c) => c === ': ping\n\n')).toHaveLength(2);
    vi.advanceTimersByTime(500);
    expect(onClose).toHaveBeenCalledWith('expired');
    expect(unsubscribe).toHaveBeenCalled();
    expect(res.writableEnded).toBe(true);
  });

  it('tells a slow client to resync and disconnects it', async () => {
    let buffered = 0;
    const { req, res, chunks } = fakeStream(() => buffered);
    const onClose = vi.fn();
    let push: (m: SseMessage) => void = () => undefined;
    await serveSse(req as never, res as never, {
      lastEventId: undefined,
      maxBufferedBytes: 100,
      subscribe: async (p) => {
        push = p;
        return () => undefined;
      },
      onClose,
    });
    buffered = 1_000;
    push({ id: '5-0', event: 'e', data: 'x' });
    expect(chunks.at(-1)).toContain('event: resync');
    expect(onClose).toHaveBeenCalledWith('slow');
    push({ id: '6-0', event: 'e', data: 'y' });
    expect(chunks.some((c) => c.includes('6-0'))).toBe(false);
  });

  it('cleans up exactly once when the replay fails', async () => {
    const { req, res } = fakeStream();
    const onClose = vi.fn();
    const unsubscribe = vi.fn();
    await expect(
      serveSse(req as never, res as never, {
        lastEventId: '1-0',
        subscribe: async () => unsubscribe,
        replay: async () => {
          throw new Error('valkey down');
        },
        onClose,
      }),
    ).rejects.toThrow('valkey down');
    req.emit('close');
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledWith('error');
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(res.writableEnded).toBe(true);
  });

  it('drops a client that stopped reading even when no events flow', async () => {
    vi.useFakeTimers();
    let buffered = 0;
    const { req, res, chunks } = fakeStream(() => buffered);
    const onClose = vi.fn();
    await serveSse(req as never, res as never, {
      lastEventId: undefined,
      heartbeatMs: 1_000,
      maxBufferedBytes: 100,
      subscribe: async () => () => undefined,
      onClose,
    });
    buffered = 1_000;
    vi.advanceTimersByTime(1_000);
    expect(chunks.at(-1)).toContain('event: resync');
    expect(onClose).toHaveBeenCalledWith('slow');
  });
});
