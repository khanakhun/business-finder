import type { RealtimeEvent } from '@bf/contracts';
import type { QueryKey } from '@tanstack/react-query';

/**
 * The one place that says which cached queries a realtime event makes stale (event type → query keys). Feature
 * tickets add their events here; components that need more than a refetch use `useRealtimeEvent`.
 */
export const realtimeInvalidations: Readonly<Record<string, (event: RealtimeEvent) => readonly QueryKey[]>> =
  {};

/** Sent by the server when the client may have missed events (slow connection, retention): refetch everything. */
export const RESYNC_EVENT = 'resync';
