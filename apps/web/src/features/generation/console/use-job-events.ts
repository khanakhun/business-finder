'use client';

import { type GenerationJobStatus, SETTLED_JOB_STATUSES } from '@bf/contracts';
import * as React from 'react';
import { publicEnv } from '@/lib/public-env.ts';
import { type LoggedEvent, merge } from './event-log.ts';

// A job's activity stream (BF-046 on BF-039's SSE endpoint). The browser reconnects by itself with Last-Event-ID;
// when it gives up we reconnect with `?after=<last seq>` and a backoff. Events are deduplicated by seq (no gaps, no
// duplicates across reconnects) and rendered at most once per animation frame. A settled job ends the stream.

/** Named SSE events: one per engine event type (`error` is also the EventSource's own error event). */
const EVENT_TYPES = [
  'status',
  'progress',
  'log',
  'tool_call',
  'file_change',
  'usage',
  'artifact',
  'error',
  'done',
] as const;
const SETTLED: ReadonlySet<string> = new Set(SETTLED_JOB_STATUSES);
const MAX_BACKOFF_MS = 30_000;
/** `EventSource.CLOSED` (a literal: the global is missing where tests run). */
const CLOSED = 2;

export type StreamState = 'connecting' | 'live' | 'reconnecting' | 'ended';

export interface JobEvents {
  readonly events: readonly LoggedEvent[];
  readonly state: StreamState;
  /** The job's status as the stream last said it (null until it does). */
  readonly status: GenerationJobStatus | null;
}

export function useJobEvents(
  jobId: string,
  createSource: (url: string) => EventSource = (url) => new EventSource(url, { withCredentials: true }),
): JobEvents {
  const [snapshot, setSnapshot] = React.useState<JobEvents>({
    events: [],
    state: 'connecting',
    status: null,
  });
  const create = React.useRef(createSource);
  React.useEffect(() => {
    let log: LoggedEvent[] = [];
    let lastSeq = 0;
    let pending: LoggedEvent[] = [];
    let frame: number | null = null;
    let source: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;
    let ended = false;
    let state: StreamState = 'connecting';
    let status: GenerationJobStatus | null = null;

    const publish = () => setSnapshot({ events: log, state, status });
    const flush = () => {
      frame = null;
      if (pending.length === 0) return;
      ({ log, lastSeq } = merge(log, lastSeq, pending));
      pending = [];
      publish();
    };
    const schedule = () => {
      if (frame !== null) return;
      frame =
        typeof requestAnimationFrame === 'function'
          ? requestAnimationFrame(flush)
          : (setTimeout(flush, 16) as unknown as number);
    };
    const onEvent = (message: Event) => {
      // `error` without data is the connection's error, handled below.
      if (!(message instanceof MessageEvent) || typeof message.data !== 'string' || message.data === '')
        return;
      const seq = Number(message.lastEventId);
      if (!Number.isFinite(seq) || seq <= 0) return;
      try {
        pending.push({ ...(JSON.parse(message.data) as Omit<LoggedEvent, 'seq'>), seq } as LoggedEvent);
        schedule();
      } catch {
        // A malformed event is skipped; the next ones still count.
      }
    };
    const onJob = (message: Event) => {
      if (!(message instanceof MessageEvent)) return;
      try {
        status = (JSON.parse(message.data as string) as { status: GenerationJobStatus }).status;
      } catch {
        return;
      }
      if (SETTLED.has(status)) {
        ended = true;
        state = 'ended';
        source?.close();
        flush();
      }
      publish();
    };
    const connect = () => {
      const url = new URL(`/v1/generation-jobs/${jobId}/events`, publicEnv().apiUrl);
      if (lastSeq > 0) url.searchParams.set('after', String(lastSeq));
      const next = create.current(url.toString());
      source = next;
      for (const type of EVENT_TYPES) next.addEventListener(type, onEvent);
      next.addEventListener('job', onJob);
      next.onopen = () => {
        attempt = 0;
        state = 'live';
        publish();
      };
      next.onerror = () => {
        if (ended) return;
        if (next.readyState === CLOSED) {
          // The browser gave up (e.g. a 5xx): reconnect from the last seq, with a backoff.
          next.close();
          state = 'reconnecting';
          publish();
          const delay = Math.min(MAX_BACKOFF_MS, 1_000 * 2 ** attempt++);
          retry = setTimeout(connect, delay);
        } else {
          state = 'reconnecting';
          publish();
        }
      };
    };
    connect();
    return () => {
      ended = true;
      source?.close();
      if (retry) clearTimeout(retry);
      if (frame !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame);
    };
  }, [jobId]);
  return snapshot;
}
