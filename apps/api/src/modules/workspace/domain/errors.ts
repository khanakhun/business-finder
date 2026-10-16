import { DomainError } from '@bf/contracts';

/** A stored secret cannot be decrypted (master key version missing, or the row does not authenticate). */
export class SecretUnavailableError extends DomainError {
  readonly code = 'INTERNAL';
  constructor(name: string, reason: 'MASTER_KEY_MISSING' | 'DECRYPTION_FAILED') {
    // The message names the secret and the cause, never the value; 5xx details are hidden from clients anyway.
    super(`Secret ${name} is unavailable (${reason}).`, { details: { reason } });
  }
}
