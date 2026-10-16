/**
 * A failure after money was spent (a billed provider answer, model batches): the caller books `costUsd` whatever
 * happens next. Classifier verdicts already paid for are cached.
 */
export class SpentBeforeFailureError extends Error {
  constructor(
    override readonly cause: unknown,
    readonly costUsd: number,
  ) {
    super('Failed after spending', { cause });
    this.name = 'SpentBeforeFailureError';
  }
}
