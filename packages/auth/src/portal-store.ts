// Client portal sign-in (BF-062): magic links are only for business owners with a portal grant. Staff accounts
// (any workspace membership) and accounts with two-factor authentication never sign in by link, so a link can't
// bypass their password or second factor.
import type { DbClient } from '@bf/db';
import { member, sitePortalGrants, user } from '@bf/db/schema';
import { and, eq, isNull } from 'drizzle-orm';

export async function hasPortalGrant(db: DbClient, email: string): Promise<boolean> {
  const [grant] = await db
    .select({ id: sitePortalGrants.id })
    .from(sitePortalGrants)
    .where(and(eq(sitePortalGrants.email, email.trim().toLowerCase()), isNull(sitePortalGrants.revokedAt)))
    .limit(1);
  return grant !== undefined;
}

export async function portalSignInAllowed(db: DbClient, email: string): Promise<boolean> {
  if (!(await hasPortalGrant(db, email))) return false;
  const [account] = await db
    .select({ id: user.id, twoFactorEnabled: user.twoFactorEnabled })
    .from(user)
    .where(eq(user.email, email.trim().toLowerCase()))
    .limit(1);
  if (!account) return true;
  if (account.twoFactorEnabled) return false;
  const [membership] = await db
    .select({ id: member.id })
    .from(member)
    .where(eq(member.userId, account.id))
    .limit(1);
  return membership === undefined;
}
