import { defineEvent } from '@bf/contracts';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { getEventContext, runInEventContext } from './event-context.ts';
import { ON_DOMAIN_EVENT, OnDomainEvent, type SubscriptionSpec } from './on-domain-event.decorator.ts';
import { SubscriberRegistry } from './subscriber-registry.ts';

const Created = defineEvent('unit.widget_created', 1, z.object({ id: z.string() }));
const CreatedV2 = defineEvent('unit.widget_created', 2, z.object({ id: z.string(), name: z.string() }));

describe('@OnDomainEvent', () => {
  it('stores the subscription on the handler', () => {
    class Handlers {
      @OnDomainEvent(Created, { id: 'unit.widgets' })
      async onCreated() {}
    }
    expect(Reflect.getMetadata(ON_DOMAIN_EVENT, Handlers.prototype.onCreated)).toEqual({
      id: 'unit.widgets',
      events: [Created],
    } satisfies SubscriptionSpec);
  });

  it('rejects malformed ids and empty subscriptions', () => {
    expect(() => OnDomainEvent(Created, { id: 'NoDots' })).toThrow(/context.name/);
    expect(() => OnDomainEvent([], { id: 'unit.empty' })).toThrow(/no event/);
  });
});

describe('SubscriberRegistry', () => {
  const registry = () =>
    new SubscriberRegistry({ getProviders: () => [] } as never, {} as never, {} as never);
  const noop = async () => undefined;

  it('matches subscribers by event type and version', () => {
    const subscribers = registry();
    subscribers.add({ id: 'unit.a', events: [Created] }, noop);
    subscribers.add({ id: 'unit.b', events: [Created, CreatedV2] }, noop);
    expect(subscribers.subscribersFor('unit.widget_created', 1).map((s) => s.id)).toEqual([
      'unit.a',
      'unit.b',
    ]);
    expect(subscribers.subscribersFor('unit.widget_created', 2).map((s) => s.id)).toEqual(['unit.b']);
    expect(subscribers.subscribersFor('unit.other', 1)).toEqual([]);
    expect(subscribers.get('unit.a')?.id).toBe('unit.a');
    expect(subscribers.describe()).toEqual({
      'unit.widget_created@1': ['unit.a', 'unit.b'],
      'unit.widget_created@2': ['unit.b'],
    });
  });

  it('refuses two subscribers with the same id (it keys idempotency)', () => {
    const subscribers = registry();
    subscribers.add({ id: 'unit.a', events: [Created] }, noop);
    expect(() => subscribers.add({ id: 'unit.a', events: [CreatedV2] }, noop)).toThrow(/used twice/);
  });
});

describe('event context', () => {
  it('is visible inside the handler only', async () => {
    expect(getEventContext()).toBeUndefined();
    const seen = await runInEventContext(
      { eventId: 'e1', correlationId: 'c1', subscriberId: 'unit.a' },
      async () => getEventContext(),
    );
    expect(seen).toEqual({ eventId: 'e1', correlationId: 'c1', subscriberId: 'unit.a' });
    expect(getEventContext()).toBeUndefined();
  });
});
