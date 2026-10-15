import { EventRecorder } from '../../platform/events/event-recorder.ts';
import type { Business } from '../domain/business.entity.ts';

/** Records the aggregate's pending events in the outbox (inside the caller's transaction); returns the fields
 * `business.updated` announced. */
export async function recordEvents(recorder: EventRecorder, business: Business): Promise<string[]> {
  const changed: string[] = [];
  for (const event of business.pullEvents()) {
    if (event.type === 'business.updated') changed.push(...event.payload.fields);
    switch (event.type) {
      case 'business.created':
        await recorder.record(event.definition, { payload: event.payload });
        break;
      case 'business.updated':
        await recorder.record(event.definition, { payload: event.payload });
        break;
      case 'business.merged':
        await recorder.record(event.definition, { payload: event.payload });
        break;
    }
  }
  return changed;
}
