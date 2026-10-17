import { ExternalServiceError, type MailboxErrorCode } from '@bf/contracts';

/**
 * A provider call failed in a way the lifecycle understands: authentication and revoked consent put the mailbox in
 * `error`, quota and rate limits pause or delay it, the rest is retried. The message is credential-free.
 */
export class MailboxProviderError extends ExternalServiceError {
  readonly reason: MailboxErrorCode;
  readonly retryable: boolean;
  readonly retryAfterSeconds: number | undefined;

  constructor(
    provider: string,
    reason: MailboxErrorCode,
    message: string,
    options: { retryable?: boolean; retryAfterSeconds?: number; cause?: unknown } = {},
  ) {
    const retryable = options.retryable ?? (reason === 'unreachable' || reason === 'rate_limited');
    super(provider, message, { cause: options.cause, details: { reason, retryable } });
    this.reason = reason;
    this.retryable = retryable;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }

  /** Authentication is gone: the mailbox needs reconnecting. */
  get needsReconnect(): boolean {
    return this.reason === 'auth_failed' || this.reason === 'consent_revoked';
  }
}
