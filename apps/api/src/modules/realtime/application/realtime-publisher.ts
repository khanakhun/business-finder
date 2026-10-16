import { type Clock, newId, type RealtimeEvent, RealtimeEventSchema } from '@bf/contracts';
import { metrics } from '@bf/observability';
import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { CLOCK } from '../../platform/clock/clock.module.ts';
import { VALKEY } from '../../platform/valkey/valkey.module.ts';
import { compareStreamIds, isStreamId, type SseMessage } from '../interface/sse.ts';

/** Events kept per workspace for `Last-Event-ID` replay (approximate trimming, api.md §7). */
export const REALTIME_RETENTION = 1_000;

export const orgStreamKey = (orgId: string) => `rt:org:${orgId}`;
export const ORG_CHANNEL_PATTERN = 'rt:org:*';

export interface PublishInput {
  readonly type: string;
  readonly entity: string;
  readonly entityId: string;
  readonly payload?: unknown;
}

/** What travels on the pub/sub channel: the stream entry id (the SSE `id`) and the event. */
export interface RealtimeMessage {
  readonly streamId: string;
  readonly event: RealtimeEvent;
}

const published = () =>
  metrics.counter({
    name: 'bf_realtime_events_published_total',
    help: 'Realtime events published',
    labelNames: ['type'],
  });

/**
 * Publishes workspace realtime events (api.md §7): appended to a capped Valkey stream per workspace (replay) and
 * announced on its channel (live). Payloads are small UI hints (ids, statuses), never secrets.
 */
@Injectable()
export class RealtimePublisher {
  constructor(
    @Inject(VALKEY) private readonly valkey: Redis,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async publish(orgId: string, input: PublishInput): Promise<RealtimeMessage> {
    const event = RealtimeEventSchema.parse({
      id: newId(),
      type: input.type,
      entity: input.entity,
      entityId: input.entityId,
      orgId,
      payload: input.payload ?? null,
      at: this.clock.now().toISOString(),
    });
    const key = orgStreamKey(orgId);
    const streamId = await this.valkey.xadd(
      key,
      'MAXLEN',
      '~',
      REALTIME_RETENTION,
      '*',
      'data',
      JSON.stringify(event),
    );
    if (!streamId) throw new Error('XADD returned no id');
    const message: RealtimeMessage = { streamId, event };
    await this.valkey.publish(key, JSON.stringify(message));
    published().inc({ type: event.type });
    return message;
  }

  /**
   * Events after `lastEventId`, oldest first. When that id is older than the retained window, the client missed
   * events: a `resync` message comes first so it refetches everything.
   */
  async replay(orgId: string, lastEventId: string | undefined): Promise<SseMessage[]> {
    if (!lastEventId || !isStreamId(lastEventId)) return [];
    const key = orgStreamKey(orgId);
    const [first] = await this.valkey.xrange(key, '-', '+', 'COUNT', 1);
    const entries = await this.valkey.xrange(key, `(${lastEventId}`, '+', 'COUNT', REALTIME_RETENTION);
    const messages = entries.flatMap(([id, fields]) => {
      const data = fields[fields.indexOf('data') + 1];
      return data ? [toSse({ streamId: id, event: JSON.parse(data) as RealtimeEvent })] : [];
    });
    const missedSome = first !== undefined && compareStreamIds(lastEventId, first[0]) < 0;
    return missedSome ? [{ event: 'resync', data: { reason: 'retention' } }, ...messages] : messages;
  }
}

export const toSse = (message: RealtimeMessage): SseMessage => ({
  id: message.streamId,
  event: message.event.type,
  data: message.event,
});
