/**
 * Classification stopped part-way (a later batch failed): what the earlier batches cost is booked by the caller,
 * and their verdicts are already cached.
 */
export class ClassificationInterruptedError extends Error {
  constructor(
    override readonly cause: unknown,
    readonly costUsd: number,
  ) {
    super('Review classification interrupted', { cause });
    this.name = 'ClassificationInterruptedError';
  }
}
