import { type SecretName, secretDefinition, ValidationError } from '@bf/contracts';

/** Values shorter than this get no `last4`: four characters of a short secret reveal too much of it. */
export const LAST4_MIN_LENGTH = 16;

export function last4Of(value: string): string | null {
  return value.length >= LAST4_MIN_LENGTH ? value.slice(-4) : null;
}

/** Loose format check against the registry pattern, to catch pasting the wrong provider's key. */
export function assertSecretFormat(name: SecretName, value: string): void {
  const pattern = secretDefinition(name).validatePattern;
  if (pattern && !new RegExp(pattern).test(value)) {
    // Never echo the value back (security.md §2).
    throw new ValidationError(
      `This does not look like a ${name} key.`,
      [{ path: ['value'], message: 'Unexpected format for this provider' }],
      { details: { reason: 'SECRET_FORMAT' } },
    );
  }
}
