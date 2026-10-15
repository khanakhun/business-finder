// Who may create an account (SIGNUP_MODE). Enforced in Better Auth's `user.create.before` hook, so it covers
// email/password and Google sign-ups alike. Accepting an invitation is always allowed for the invited address.
export const SIGNUP_MODES = ['invite_only', 'allowlist', 'open'] as const;
export type SignupMode = (typeof SIGNUP_MODES)[number];

export interface SignupPolicy {
  readonly mode: SignupMode;
  /** Lower-case domains (`example.com`) allowed to self-register in `allowlist` mode. */
  readonly allowedEmailDomains: readonly string[];
}

/** Pure decision, given whether the address has a pending, unexpired invitation. */
export function isSignupAllowed(policy: SignupPolicy, email: string, hasPendingInvitation: boolean): boolean {
  if (policy.mode === 'open' || hasPendingInvitation) return true;
  if (policy.mode === 'invite_only') return false;
  const domain = email.trim().toLowerCase().split('@').at(-1) ?? '';
  return policy.allowedEmailDomains.some((allowed) => allowed.toLowerCase() === domain);
}
