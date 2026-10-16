/** Valkey keys owned by the job runner (namespaced away from BullMQ's own `bull:*` keys). */
export const keys = {
  idempotency: (queue: string, job: string, key: string) => `bf:job:idem:${queue}:${job}:${key}`,
  cancel: (queue: string, jobId: string) => `bf:job:cancel:${queue}:${jobId}`,
} as const;

/** BullMQ job id for an idempotency key: identical keys collapse into one queued job while it exists. */
export function jobIdFor(jobName: string, idempotencyKey: string): string {
  // BullMQ forbids ':' in custom ids (it uses it as a separator); keep ids readable and unambiguous.
  return `${jobName}__${idempotencyKey}`.replaceAll(':', '_');
}
