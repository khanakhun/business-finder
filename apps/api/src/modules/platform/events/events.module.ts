import { type DynamicModule, Global, Module, type Provider } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import type { AppMode } from '../config/app-env.ts';
import { EventDeliveryProcessor } from './event-delivery.processor.ts';
import { EventRecorder } from './event-recorder.ts';
import { OutboxRepository } from './outbox.repository.ts';
import { OutboxReconciler } from './outbox-reconciler.service.ts';
import { DEFAULT_RELAY_OPTIONS, OUTBOX_RELAY_OPTIONS, OutboxRelay } from './outbox-relay.service.ts';
import { SubscriberRegistry } from './subscriber-registry.ts';

/**
 * Domain events (BF-012): every process records events (`EventRecorder`) and knows the subscribers
 * (`@OnDomainEvent`); the worker also runs the outbox relay, the delivery processor and the reconciler.
 */
@Global()
@Module({})
export class EventsModule {
  static forRoot(mode: AppMode): DynamicModule {
    const worker: Provider[] =
      mode === 'worker'
        ? [
            { provide: OUTBOX_RELAY_OPTIONS, useValue: DEFAULT_RELAY_OPTIONS },
            OutboxRelay,
            OutboxReconciler,
            EventDeliveryProcessor,
          ]
        : [];
    return {
      module: EventsModule,
      imports: [DiscoveryModule],
      providers: [OutboxRepository, EventRecorder, SubscriberRegistry, ...worker],
      exports: [
        OutboxRepository,
        EventRecorder,
        SubscriberRegistry,
        ...(mode === 'worker' ? [OutboxRelay] : []),
      ],
    };
  }
}
