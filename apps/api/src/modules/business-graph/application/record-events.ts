import { EventRecorder } from '../../platform/events/event-recorder.ts';
import type { Business } from '../domain/business.entity.ts';

/** Records the aggregate's pending events in the outbox (inside the caller's transaction). */
export async function recordEvents(recorder: EventRecorder, business: Business): Promise<void> {
  for (const event of business.pullEvents()) {
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
}
