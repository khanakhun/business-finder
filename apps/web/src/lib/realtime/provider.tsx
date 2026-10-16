'use client';

import type { RealtimeEvent } from '@bf/contracts';
import { type QueryClient, type QueryKey, useQueryClient } from '@tanstack/react-query';
import * as React from 'react';
import { RESYNC_EVENT, realtimeInvalidations } from './invalidations.ts';

type Handler = (event: RealtimeEvent) => void;

const MAX_BACKOFF_MS = 30_000;
/** Bursts of events (a bulk change of 1,000 businesses) refetch a query at most once per window. */
export const COALESCE_MS = 500;

/**
 * One EventSource per tab on `/v1/realtime`. The browser reconnects by itself (sending `Last-Event-ID`); when it
 * gives up (e.g. after a 401/429), we reconnect with exponential backoff and pass the last id as a query parameter.
 */
export class RealtimeConnection {
  private source: EventSource | undefined;
  private readonly handlers = new Map<string, Set<Handler>>();
  private readonly listening = new Set<string>();
  private lastEventId: string | undefined;
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private readonly windows = new Map<string, { dirty: boolean; timer: ReturnType<typeof setTimeout> }>();

  constructor(
    private readonly url: string,
    private readonly queryClient: QueryClient,
    private readonly createSource: (url: string) => EventSource = (url) =>
      new EventSource(url, { withCredentials: true }),
  ) {}

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    for (const window of this.windows.values()) clearTimeout(window.timer);
    this.windows.clear();
    this.source?.close();
    this.source = undefined;
  }

  subscribe(type: string, handler: Handler): () => void {
    const set = this.handlers.get(type) ?? new Set<Handler>();
    set.add(handler);
    this.handlers.set(type, set);
    this.listen(type);
    return () => set.delete(handler);
  }

  private connect(): void {
    const url = this.lastEventId
      ? `${this.url}?lastEventId=${encodeURIComponent(this.lastEventId)}`
      : this.url;
    const source = this.createSource(url);
    this.source = source;
    this.listening.clear();
    for (const type of [RESYNC_EVENT, ...Object.keys(realtimeInvalidations), ...this.handlers.keys()])
      this.listen(type);
    source.onopen = () => {
      this.attempt = 0;
    };
    source.onerror = () => {
      // CONNECTING: the browser is retrying on its own. CLOSED: it gave up, so we take over.
      if (source.readyState !== EventSource.CLOSED || this.stopped) return;
      source.close();
      const delay = Math.min(MAX_BACKOFF_MS, 1_000 * 2 ** this.attempt) * (0.5 + Math.random() / 2);
      this.attempt += 1;
      this.timer = setTimeout(() => this.connect(), delay);
    };
  }

  /** Refetches now, then at most once more at the end of the window if more events asked for it. */
  private invalidate(queryKey: QueryKey): void {
    const id = JSON.stringify(queryKey);
    const open = this.windows.get(id);
    if (open) {
      open.dirty = true;
      return;
    }
    void this.queryClient.invalidateQueries({ queryKey });
    const window = {
      dirty: false,
      timer: setTimeout(() => {
        this.windows.delete(id);
        if (window.dirty) this.invalidate(queryKey);
      }, COALESCE_MS),
    };
    this.windows.set(id, window);
  }

  private listen(type: string): void {
    if (!this.source || this.listening.has(type)) return;
    this.listening.add(type);
    this.source.addEventListener(type, (message) => this.dispatch(type, message as MessageEvent<string>));
  }

  private dispatch(type: string, message: MessageEvent<string>): void {
    if (message.lastEventId) this.lastEventId = message.lastEventId;
    if (type === RESYNC_EVENT) {
      void this.queryClient.invalidateQueries();
      return;
    }
    let event: RealtimeEvent;
    try {
      event = JSON.parse(message.data) as RealtimeEvent;
    } catch {
      return;
    }
    for (const key of realtimeInvalidations[type]?.(event) ?? []) this.invalidate(key);
    for (const handler of this.handlers.get(type) ?? []) handler(event);
  }
}

const RealtimeContext = React.createContext<RealtimeConnection | null>(null);

/** Opens the workspace's realtime stream while mounted (inside the dashboard, with an active workspace). */
export function RealtimeProvider({
  enabled,
  children,
}: {
  readonly enabled: boolean;
  readonly children: React.ReactNode;
}) {
  const queryClient = useQueryClient();
  const [connection] = React.useState(
    () =>
      new RealtimeConnection(
        `${process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000'}/v1/realtime`,
        queryClient,
      ),
  );
  React.useEffect(() => {
    if (!enabled) return;
    connection.start();
    return () => connection.stop();
  }, [connection, enabled]);
  return <RealtimeContext.Provider value={connection}>{children}</RealtimeContext.Provider>;
}

/** Calls `handler` for every realtime event of `type` (latest handler, no resubscribe on each render). */
export function useRealtimeEvent(type: string, handler: Handler): void {
  const connection = React.useContext(RealtimeContext);
  const latest = React.useRef(handler);
  latest.current = handler;
  React.useEffect(() => connection?.subscribe(type, (event) => latest.current(event)), [connection, type]);
}
