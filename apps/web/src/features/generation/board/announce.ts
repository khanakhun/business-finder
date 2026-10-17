import type { GenerationJob } from '@bf/contracts';

// What the board announces (BF-046): jobs whose status changed since the last look, in one polite message; the
// caller throttles. Pure.

export interface StatusChange {
  readonly name: string;
  readonly status: GenerationJob['status'];
}

/** The jobs whose status differs from `previous` (job id → status); new jobs are not changes. */
export function statusChanges(
  previous: ReadonlyMap<string, GenerationJob['status']>,
  jobs: readonly GenerationJob[],
): StatusChange[] {
  return jobs.flatMap((job) => {
    const before = previous.get(job.id);
    return before !== undefined && before !== job.status
      ? [{ name: job.businessName, status: job.status }]
      : [];
  });
}

/** "3/6 · Batch name": the tab title while the batch runs. */
export function progressTitle(done: number, total: number, name: string): string {
  return `${done}/${total} · ${name}`;
}
