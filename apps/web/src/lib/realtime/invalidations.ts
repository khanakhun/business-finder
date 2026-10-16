import type { RealtimeEvent } from '@bf/contracts';
import type { QueryKey } from '@tanstack/react-query';

/**
 * Realtime event types, mirrored from @bf/contracts as plain strings: a value import from the contracts barrel would
 * pull Zod into the shell bundle (BF-007 budget). `realtime.test.tsx` checks they match.
 */
export const REALTIME_EVENTS = {
  notificationCreated: 'notification.created',
  crmActivityCreated: 'crm.activity.created',
  enrichmentRunProgressed: 'enrichment.run.progressed',
  scoringScoresUpdated: 'scoring.scores.updated',
  scoringRecomputeProgressed: 'scoring.recompute.progressed',
} as const;

const FINISHED_RUN = new Set(['completed', 'partially_completed', 'failed', 'cancelled']);

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
    // An enrichment run moved (BF-027): the business's page; the listing's status column once it ends.
    [REALTIME_EVENTS.enrichmentRunProgressed]: (event) => {
      const status = (event.payload as { status?: string } | null)?.status ?? '';
      return FINISHED_RUN.has(status)
        ? [
            ['business', event.entityId],
            ['search', 'listing'],
          ]
        : [['business', event.entityId]];
    },
    // A business's scores were written (BF-031): its page, and the listing's score and tier; a large batch sends one
    // workspace-wide event instead.
    [REALTIME_EVENTS.scoringScoresUpdated]: (event) =>
      event.entity === 'workspace'
        ? [['business'], ['search', 'listing']]
        : [
            ['business', event.entityId],
            ['search', 'listing'],
          ],
    // A bulk recompute ended: every score may have moved.
    [REALTIME_EVENTS.scoringRecomputeProgressed]: (event) =>
      (event.payload as { finished?: boolean } | null)?.finished
        ? [['business'], ['search', 'listing'], ['scoring']]
        : [],
  };

/** Sent by the server when the client may have missed events (slow connection, retention): refetch everything. */
export const RESYNC_EVENT = 'resync';
