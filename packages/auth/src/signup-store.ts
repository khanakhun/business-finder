// DB side of the sign-up policy: does the address have a pending, unexpired invitation (or a client portal grant,
// BF-062: the business owner's account is created on their first magic-link sign-in)?
import type { DbClient } from '@bf/db';
import { invitation } from '@bf/db/schema';
import { and, eq, gt } from 'drizzle-orm';
import { hasPortalGrant } from './portal-store.ts';
import { isSignupAllowed, type SignupPolicy } from './signup.ts';

export async function signupAllowed(db: DbClient, policy: SignupPolicy, email: string): Promise<boolean> {
  if (policy.mode === 'open') return true;
  const pending = await db
    .select({ id: invitation.id })
    .from(invitation)
    .where(
      and(
        eq(invitation.email, email.trim().toLowerCase()),
        eq(invitation.status, 'pending'),
        gt(invitation.expiresAt, new Date()),
      ),
    )
    .limit(1);
  return isSignupAllowed(policy, email, pending.length > 0 || (await hasPortalGrant(db, email)));
}
