import { z } from 'zod';
import { EventId, OrgId } from './ids.ts';
import { IsoDateTimeSchema } from './time.ts';

/** Base shape of server-sent events on `/v1/realtime` (api.md §7); features narrow `type` and `payload`. */
export const RealtimeEventSchema = z.object({
  id: EventId,
  type: z.string().min(1),
  entity: z.string().min(1),
  entityId: z.string().min(1),
  orgId: OrgId,
  payload: z.unknown(),
  at: IsoDateTimeSchema,
});
export type RealtimeEvent = z.infer<typeof RealtimeEventSchema>;
