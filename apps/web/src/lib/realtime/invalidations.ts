import type { RealtimeEvent } from '@bf/contracts';
import type { QueryKey } from '@tanstack/react-query';

/**
 * Realtime event types, mirrored from @bf/contracts as plain strings: a value import from the contracts barrel would
 * pull Zod into the shell bundle (BF-007 budget). `realtime.test.tsx` checks they match.
 */
export const REALTIME_EVENTS = {
  notificationCreated: 'notification.created',
  crmActivityCreated: 'crm.activity.created',
} as const;

/**
 * The one place that says which cached queries a realtime event makes stale (event type → query keys). Feature
 * tickets add their events here; components that need more than a refetch use `useRealtimeEvent`.
 */
export const realtimeInvalidations: Readonly<Record<string, (event: RealtimeEvent) => readonly QueryKey[]>> =
  {
    // The bell, the popover and the notifications page (BF-012).
    [REALTIME_EVENTS.notificationCreated]: () => [['notifications']],
    // Something happened on a business (BF-024): its page, the pipeline board and task lists.
    [REALTIME_EVENTS.crmActivityCreated]: (event) => [['business', event.entityId], ['crm']],
  };

/** Sent by the server when the client may have missed events (slow connection, retention): refetch everything. */
export const RESYNC_EVENT = 'resync';
