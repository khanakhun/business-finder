import {
  ConflictError,
  DomainError,
  type ProblemDetails,
  type ProblemFieldError,
  ValidationError,
} from '@bf/contracts';

/** The site's current version is not the one the edit started from (optimistic concurrency). */
export class SiteVersionConflictError extends DomainError {
  readonly code = 'SITE_VERSION_CONFLICT';

  constructor(readonly currentVersionId: string | null) {
    super('The site has a newer version: reload it and apply your change again.', {
      details: { currentVersionId },
    });
  }

  override toProblem(instance?: string, traceId?: string): ProblemDetails {
    return {
      ...super.toProblem(instance, traceId),
      ...(this.currentVersionId ? { currentVersionId: this.currentVersionId } : {}),
    };
  }
}

/** A spec the validators refuse: each error at its path, with its issue code. */
export class SiteSpecInvalidError extends ValidationError {
  constructor(errors: readonly ProblemFieldError[]) {
    super('The site has errors: fix them before saving.', errors, {
      details: { reason: 'SITE_SPEC_INVALID' },
    });
  }
}

/** An archived site cannot change or publish. */
export class SiteArchivedError extends DomainError {
  readonly code = 'INVALID_STATE_TRANSITION';

  constructor(siteId: string, action: string) {
    super(`An archived site cannot ${action}.`, { details: { siteId, reason: 'SITE_ARCHIVED' } });
  }
}

/** No active preview to extend or unpublish. */
export class NoActivePublicationError extends ConflictError {
  constructor(environment: string) {
    super(`The site has no active ${environment} publication.`, {
      details: { reason: 'NO_ACTIVE_PUBLICATION' },
    });
  }
}
