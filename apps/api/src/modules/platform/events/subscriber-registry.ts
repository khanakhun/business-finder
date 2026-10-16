import { Injectable, type OnModuleInit } from '@nestjs/common';
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import {
  type DomainEventHandler,
  ON_DOMAIN_EVENT,
  type SubscriptionSpec,
} from './on-domain-event.decorator.ts';

export interface Subscriber {
  readonly id: string;
  readonly handle: DomainEventHandler;
}

const key = (type: string, version: number) => `${type}@${version}`;

/** Every `@OnDomainEvent` handler of the process, found at boot (worker) and looked up by the relay/processor. */
@Injectable()
export class SubscriberRegistry implements OnModuleInit {
  private readonly byEvent = new Map<string, Subscriber[]>();
  private readonly byId = new Map<string, Subscriber>();

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly scanner: MetadataScanner,
    private readonly reflector: Reflector,
  ) {}

  onModuleInit(): void {
    for (const wrapper of this.discovery.getProviders()) {
      const instance = wrapper.instance as Record<string, unknown> | undefined;
      if (!instance || typeof instance !== 'object' || !wrapper.isDependencyTreeStatic()) continue;
      const prototype = Object.getPrototypeOf(instance) as object;
      for (const method of this.scanner.getAllMethodNames(prototype)) {
        const spec = this.reflector.get<SubscriptionSpec | undefined>(
          ON_DOMAIN_EVENT,
          (prototype as Record<string, unknown>)[method] as () => void,
        );
        if (!spec) continue;
        const handler = (instance[method] as DomainEventHandler).bind(instance);
        this.add(spec, handler);
      }
    }
  }

  /** Registers a subscriber programmatically (tests, or modules wiring handlers by hand). */
  add(spec: SubscriptionSpec, handle: DomainEventHandler): void {
    if (this.byId.has(spec.id)) throw new Error(`Subscriber id "${spec.id}" is used twice`);
    const subscriber = { id: spec.id, handle };
    this.byId.set(spec.id, subscriber);
    for (const event of spec.events) {
      const list = this.byEvent.get(key(event.type, event.version)) ?? [];
      list.push(subscriber);
      this.byEvent.set(key(event.type, event.version), list);
    }
  }

  subscribersFor(type: string, version: number): readonly Subscriber[] {
    return this.byEvent.get(key(type, version)) ?? [];
  }

  get(id: string): Subscriber | undefined {
    return this.byId.get(id);
  }

  /** Subscriber ids per event, for diagnostics. */
  describe(): Record<string, string[]> {
    return Object.fromEntries([...this.byEvent].map(([event, list]) => [event, list.map((s) => s.id)]));
  }
}
