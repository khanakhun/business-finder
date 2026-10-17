import { DomainError } from '@bf/contracts';

/** A query ran past its time limit (10 s): fewer dimensions or a shorter range answers it. */
export class AnalyticsQueryTooHeavyError extends DomainError {
  readonly code = 'ANALYTICS_QUERY_TOO_HEAVY';

  constructor() {
    super('This question takes too long to answer: try a shorter period or fewer breakdowns.', {
      details: { reason: 'QUERY_TIMEOUT' },
    });
  }
}
