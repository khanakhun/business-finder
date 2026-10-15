import type { Request, Response } from 'express';

/** One server-sent event (api.md §7): `id: <id>` / `event: <type>` / `data: <json>`. */
export interface SseMessage {
  readonly id?: string;
  readonly event?: string;
  readonly data: unknown;
}

export interface SseStreamOptions {
  /** Messages after the client's `Last-Event-ID` (persisted log), sent before live ones. */
  readonly replay?: (lastEventId: string | undefined) => Promise<readonly SseMessage[]>;
  /** Starts live delivery; returns the unsubscribe function. Called before `replay`, so nothing falls in between. */
  readonly subscribe: (push: (message: SseMessage) => void) => Promise<() => void>;
  readonly lastEventId: string | undefined;
  /** Comment line keeping proxies and the browser from timing out (api.md §7: 15 s). */
  readonly heartbeatMs?: number;
  /** A client this far behind gets a `resync` event and is disconnected (it reconnects and refetches). */
  readonly maxBufferedBytes?: number;
  /** Connections are closed after this long, so credentials are re-checked on reconnect. */
  readonly maxDurationMs?: number;
  /** Orders ids to drop live messages already sent by the replay. */
  readonly compareIds?: (a: string, b: string) => number;
  /** Called exactly once, however the stream ends (including a failing replay). */
  readonly onClose?: (reason: 'client' | 'slow' | 'expired' | 'error') => void;
}

const STREAM_ID = /^\d{1,20}-\d{1,20}$/;

/** Valkey stream entry ids (`<ms>-<seq>`), the ids of org realtime events. */
export const isStreamId = (value: string): boolean => STREAM_ID.test(value);

export function compareStreamIds(a: string, b: string): number {
  const [aMs = '0', aSeq = '0'] = a.split('-');
  const [bMs = '0', bSeq = '0'] = b.split('-');
  const ms = BigInt(aMs) - BigInt(bMs);
  if (ms !== 0n) return ms < 0n ? -1 : 1;
  const seq = BigInt(aSeq) - BigInt(bSeq);
  return seq === 0n ? 0 : seq < 0n ? -1 : 1;
}

export function formatSse(message: SseMessage): string {
  const lines: string[] = [];
  if (message.id) lines.push(`id: ${message.id}`);
  if (message.event) lines.push(`event: ${message.event}`);
  // JSON never contains a raw newline, so one data line is enough.
  lines.push(`data: ${JSON.stringify(message.data)}`);
  return `${lines.join('\n')}\n\n`;
}

/**
 * Serves an SSE stream on an Express response until the client leaves (Template for `/v1/realtime` and resource
 * streams such as generation job events): replay after `Last-Event-ID`, then live messages without gaps or
 * duplicates, heartbeats, backpressure (slow clients get `resync`) and a maximum duration.
 */
export async function serveSse(req: Request, res: Response, options: SseStreamOptions): Promise<void> {
  const heartbeatMs = options.heartbeatMs ?? 15_000;
  const maxBuffered = options.maxBufferedBytes ?? 1024 * 1024;
  const compare = options.compareIds ?? (() => 1);
  let closed = false;
  let replaying = true;
  let lastSent: string | undefined = options.lastEventId;
  const pending: SseMessage[] = [];
  const timers: NodeJS.Timeout[] = [];
  let unsubscribe: (() => void) | undefined;

  const close = (reason: 'client' | 'slow' | 'expired' | 'error') => {
    if (closed) return;
    closed = true;
    for (const timer of timers) clearInterval(timer);
    unsubscribe?.();
    options.onClose?.(reason);
    if (!res.writableEnded) res.end();
  };
  /** A client this far behind is told to resync and dropped. */
  const checkBackpressure = () => {
    if (res.writableLength <= maxBuffered) return;
    res.write(formatSse({ event: 'resync', data: { reason: 'slow-client' } }));
    close('slow');
  };
  const send = (message: SseMessage) => {
    if (closed) return;
    if (message.id && lastSent && compare(message.id, lastSent) <= 0) return;
    res.write(formatSse(message));
    if (message.id) lastSent = message.id;
    checkBackpressure();
  };

  req.on('close', () => close('client'));
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  // Nginx and similar proxies must not buffer the stream.
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  res.write('retry: 3000\n\n');

  try {
    unsubscribe = await options.subscribe((message) => {
      if (replaying) pending.push(message);
      else send(message);
    });
    if (closed) {
      // The client left while we were subscribing.
      unsubscribe();
      return;
    }
    for (const message of (await options.replay?.(options.lastEventId)) ?? []) send(message);
    replaying = false;
    for (const message of pending.splice(0)) send(message);
  } catch (error) {
    close('error');
    throw error;
  }
  if (closed) return;
  // Live delivery is set up from here on (clients and tests can rely on it).
  res.write(': ready\n\n');
  timers.push(
    setInterval(() => {
      if (closed) return;
      res.write(': ping\n\n');
      // A client that stopped reading is caught even when no events flow.
      checkBackpressure();
    }, heartbeatMs),
  );
  if (options.maxDurationMs) timers.push(setInterval(() => close('expired'), options.maxDurationMs));
}
