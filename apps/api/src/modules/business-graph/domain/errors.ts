import { ConflictError, ValidationError } from '@bf/contracts';

/** A value that cannot become a value object (phone, URL, email, name, coordinates…). */
export class InvalidValueError extends ValidationError {
  constructor(kind: string, message: string) {
    super(message, [{ path: [kind], message }], { details: { reason: `INVALID_${kind.toUpperCase()}` } });
  }
}

/** A merged business is read-only: writes go to the record it was merged into. */
export class BusinessMergedError extends ConflictError {
  constructor(businessId: string, intoId: string) {
    super(`Business ${businessId} was merged into another record.`, {
      details: { reason: 'BUSINESS_MERGED', intoId },
    });
  }
}

/** Someone saved the aggregate since it was loaded (optimistic concurrency on `version`). */
export class ConcurrentModificationError extends ConflictError {
  constructor(entity: string, id: string) {
    super(`${entity} ${id} was changed by someone else; reload and retry.`, {
      details: { reason: 'CONCURRENT_MODIFICATION' },
    });
  }
}
