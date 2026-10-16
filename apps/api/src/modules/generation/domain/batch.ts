import type { GenerationBatchStatus, GenerationJobStatus } from '@bf/contracts';

// A batch's status is derived from its jobs (stored for lists), and its items' priorities from their order.

export type JobCounts = Partial<Record<GenerationJobStatus, number>>;

export function countStatuses(statuses: readonly GenerationJobStatus[]): JobCounts {
  const counts: JobCounts = {};
  for (const status of statuses) counts[status] = (counts[status] ?? 0) + 1;
  return counts;
}

export function batchStatus(counts: JobCounts): GenerationBatchStatus {
  const total = Object.values(counts).reduce((sum, n) => sum + (n ?? 0), 0);
  const n = (status: GenerationJobStatus) => counts[status] ?? 0;
  const settled = n('succeeded') + n('needs_review') + n('failed') + n('cancelled');
  if (total === 0) return 'queued';
  if (settled < total) return n('queued') === total ? 'queued' : 'running';
  if (n('cancelled') === total) return 'cancelled';
  return n('succeeded') === total ? 'completed' : 'completed_with_issues';
}

/**
 * Priorities 1–10 from the order the person chose (1 is the most urgent): an explicit priority wins, otherwise the
 * position spreads over the scale (the first item gets 1).
 */
export function priorityFor(position: number, total: number, explicit?: number): number {
  if (explicit !== undefined) return explicit;
  if (total <= 1) return 1;
  return 1 + Math.round((position / (total - 1)) * 9);
}

/** BullMQ priority (1 is the highest; a lower number runs first): the job's priority, then its position. */
export const queuePriority = (priority: number, position: number) =>
  priority * 100 + Math.min(position, 99) + 1;
