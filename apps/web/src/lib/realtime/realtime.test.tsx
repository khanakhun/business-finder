import {
  CRM_ACTIVITY_CREATED,
  ENRICHMENT_RUN_PROGRESSED,
  NOTIFICATION_CREATED,
  SCORING_RECOMPUTE_PROGRESSED,
  SCORING_SCORES_UPDATED,
} from '@bf/contracts';
import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REALTIME_EVENTS, realtimeInvalidations } from './invalidations.ts';
import { COALESCE_MS, RealtimeConnection } from './provider.tsx';

class FakeEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  readyState = FakeEventSource.CONNECTING;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readonly listeners = new Map<string, (message: MessageEvent<string>) => void>();
  closed = false;
  constructor(readonly url: string) {}
  addEventListener(type: string, listener: (message: MessageEvent<string>) => void) {
    this.listeners.set(type, listener);
  }
  close() {
    this.closed = true;
  }
  emit(type: string, data: unknown, lastEventId = '') {
    this.listeners.get(type)?.({ data: JSON.stringify(data), lastEventId } as MessageEvent<string>);
  }
}

const event = (type: string) => ({
  id: '01990000-0000-7000-8000-000000000001',
  type,
  entity: 'thing',
  entityId: 't1',
  orgId: '01990000-0000-7000-8000-000000000002',
  payload: null,
  at: '2026-10-15T00:00:00.000Z',
});

describe('RealtimeConnection', () => {
  let sources: FakeEventSource[];
  let client: QueryClient;
  let connection: RealtimeConnection;

  beforeEach(() => {
    vi.stubGlobal('EventSource', FakeEventSource);
    sources = [];
    client = new QueryClient();
    connection = new RealtimeConnection('http://api.test/v1/realtime', client, (url) => {
      const source = new FakeEventSource(url);
      sources.push(source);
      return source as unknown as EventSource;
    });
    (realtimeInvalidations as Record<string, unknown>)['thing.changed'] = () => [['things']];
  });

  afterEach(() => {
    connection.stop();
    delete (realtimeInvalidations as Record<string, unknown>)['thing.changed'];
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('invalidates the queries mapped to an event and calls subscribers', () => {
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const handler = vi.fn();
    connection.subscribe('thing.changed', handler);
    connection.start();
    sources[0]?.emit('thing.changed', event('thing.changed'), '5-0');
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['things'] });
    expect(handler).toHaveBeenCalledWith(event('thing.changed'));
  });

  it('coalesces bursts: one refetch now, one more at the end of the window', () => {
    vi.useFakeTimers();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    connection.start();
    for (let i = 0; i < 50; i++) sources[0]?.emit('thing.changed', event('thing.changed'), `${i}-0`);
    expect(invalidate).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(COALESCE_MS);
    expect(invalidate).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(COALESCE_MS);
    expect(invalidate).toHaveBeenCalledTimes(2);
  });

  it('refetches everything on resync', () => {
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    connection.start();
    sources[0]?.emit('resync', { reason: 'retention' });
    expect(invalidate).toHaveBeenCalledWith();
  });

  it('reconnects with backoff when the browser gives up, resuming after the last event id', () => {
    vi.useFakeTimers();
    connection.start();
    const first = sources[0];
    if (!first) throw new Error('no source');
    first.emit('thing.changed', event('thing.changed'), '7-0');
    first.readyState = FakeEventSource.CONNECTING;
    first.onerror?.();
    expect(sources).toHaveLength(1);
    first.readyState = FakeEventSource.CLOSED;
    first.onerror?.();
    expect(first.closed).toBe(true);
    vi.advanceTimersByTime(1_000);
    expect(sources).toHaveLength(2);
    expect(sources[1]?.url).toBe('http://api.test/v1/realtime?lastEventId=7-0');
  });

  it('refetches everything once a refused first connection finally opens (nothing to resume from)', () => {
    vi.useFakeTimers();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    connection.start();
    const first = sources[0];
    if (!first) throw new Error('no source');
    // A first open is not a recovery.
    first.onopen?.();
    expect(invalidate).not.toHaveBeenCalled();
    // Refused (429: too many streams), then retried with backoff.
    first.readyState = FakeEventSource.CLOSED;
    first.onerror?.();
    vi.advanceTimersByTime(1_000);
    sources[1]?.onopen?.();
    expect(invalidate).toHaveBeenCalledWith();
    // Once: the browser's own reconnects of that stream resume (or the server sends a resync).
    sources[1]?.onopen?.();
    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  it('does not refetch when a reconnection can resume after the last event id', () => {
    vi.useFakeTimers();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    connection.start();
    const first = sources[0];
    if (!first) throw new Error('no source');
    first.emit('thing.changed', event('thing.changed'), '7-0');
    invalidate.mockClear();
    first.readyState = FakeEventSource.CLOSED;
    first.onerror?.();
    vi.advanceTimersByTime(1_000);
    sources[1]?.onopen?.();
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('stops for good when stopped', () => {
    vi.useFakeTimers();
    connection.start();
    connection.stop();
    const first = sources[0];
    expect(first?.closed).toBe(true);
    if (first) {
      first.readyState = FakeEventSource.CLOSED;
      first.onerror?.();
    }
    vi.advanceTimersByTime(60_000);
    expect(sources).toHaveLength(1);
  });
});

describe('realtime event names', () => {
  it('refresh scores where they show (BF-031)', () => {
    expect(REALTIME_EVENTS.scoringScoresUpdated).toBe(SCORING_SCORES_UPDATED);
    expect(REALTIME_EVENTS.scoringRecomputeProgressed).toBe(SCORING_RECOMPUTE_PROGRESSED);
    const scores = { type: SCORING_SCORES_UPDATED, entity: 'business', entityId: 'b1' } as never;
    expect(realtimeInvalidations[SCORING_SCORES_UPDATED]?.(scores)).toEqual([
      ['business', 'b1'],
      ['search', 'listing'],
    ]);
    const recompute = (finished: boolean) =>
      ({
        type: SCORING_RECOMPUTE_PROGRESSED,
        entity: 'scoring_profile',
        entityId: 'p1',
        payload: { finished },
      }) as never;
    expect(realtimeInvalidations[SCORING_RECOMPUTE_PROGRESSED]?.(recompute(false))).toEqual([]);
    expect(realtimeInvalidations[SCORING_RECOMPUTE_PROGRESSED]?.(recompute(true))).toEqual([
      ['business'],
      ['search', 'listing'],
      ['scoring'],
    ]);
  });

  it('match the contracts', () => {
    expect(REALTIME_EVENTS.notificationCreated).toBe(NOTIFICATION_CREATED);
    expect(REALTIME_EVENTS.crmActivityCreated).toBe(CRM_ACTIVITY_CREATED);
    const event = { type: CRM_ACTIVITY_CREATED, entity: 'business', entityId: 'b1' } as never;
    expect(realtimeInvalidations[CRM_ACTIVITY_CREATED]?.(event)).toEqual([['business', 'b1'], ['crm']]);
    expect(Object.keys(realtimeInvalidations)).toContain(NOTIFICATION_CREATED);
    expect(REALTIME_EVENTS.enrichmentRunProgressed).toBe(ENRICHMENT_RUN_PROGRESSED);
    const progress = (status: string) =>
      ({ type: ENRICHMENT_RUN_PROGRESSED, entity: 'business', entityId: 'b1', payload: { status } }) as never;
    // The listing's status column refreshes when a run ends, not on every step.
    expect(realtimeInvalidations[ENRICHMENT_RUN_PROGRESSED]?.(progress('running'))).toEqual([
      ['business', 'b1'],
    ]);
    expect(realtimeInvalidations[ENRICHMENT_RUN_PROGRESSED]?.(progress('completed'))).toEqual([
      ['business', 'b1'],
      ['search', 'listing'],
    ]);
  });
});
