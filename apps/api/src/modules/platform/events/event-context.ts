import { AsyncLocalStorage } from 'node:async_hooks';

/** The event a subscriber is handling: events it records are caused by it and share its correlation id. */
export interface EventContext {
  readonly eventId: string;
  readonly correlationId: string;
  readonly subscriberId: string;
}

const storage = new AsyncLocalStorage<EventContext>();

export function runInEventContext<T>(context: EventContext, fn: () => Promise<T>): Promise<T> {
  return storage.run(context, fn);
}

export function getEventContext(): EventContext | undefined {
  return storage.getStore();
}
