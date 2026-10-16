// New sessions start in a workspace: the one the user joined first. Without this every sign-in would land on
// "choose a workspace" (Better Auth leaves activeOrganizationId empty on new sessions).
import type { DbClient } from '@bf/db';
import { member } from '@bf/db/schema';
import { asc, eq } from 'drizzle-orm';

export async function defaultOrganizationId(db: DbClient, userId: string): Promise<string | null> {
  const [first] = await db
    .select({ organizationId: member.organizationId })
    .from(member)
    .where(eq(member.userId, userId))
    .orderBy(asc(member.createdAt))
    .limit(1);
  return first?.organizationId ?? null;
}
