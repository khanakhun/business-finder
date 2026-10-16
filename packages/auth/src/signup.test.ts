import { describe, expect, it } from 'vitest';
import { isSignupAllowed, type SignupPolicy } from './signup.ts';

const policy = (mode: SignupPolicy['mode'], allowedEmailDomains: string[] = []): SignupPolicy => ({
  mode,
  allowedEmailDomains,
});

describe('isSignupAllowed', () => {
  it.each([
    ['open', 'anyone@example.test', false, true],
    ['invite_only', 'anyone@example.test', false, false],
    ['invite_only', 'invited@example.test', true, true],
    ['allowlist', 'staff@agency.test', false, true],
    ['allowlist', 'STAFF@Agency.TEST', false, true],
    ['allowlist', 'someone@other.test', false, false],
    ['allowlist', 'someone@other.test', true, true],
    ['allowlist', 'staff@sub.agency.test', false, false],
  ] as const)('%s: %s (invited: %s) → %s', (mode, email, invited, expected) => {
    expect(isSignupAllowed(policy(mode, ['agency.test']), email, invited)).toBe(expected);
  });
});
