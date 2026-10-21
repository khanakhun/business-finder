import { ROLES, type Role } from '@bf/contracts';
import { eq } from 'drizzle-orm';
import { member, organization, user } from '../../schema/index.ts';
import type { DbExecutor } from '../../tx.ts';
import type { SeedModule } from '../runner.ts';

export interface TeamSeedMember {
  readonly email: string;
  readonly role: Role;
}

export interface TeamSeed {
  readonly workspace: string;
  readonly members: readonly TeamSeedMember[];
}

export class TeamSeedConfigError extends Error {}

const slugify = (value: string) =>
  value
    .normalize('NFKD')
    .replaceAll(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-|-$/g, '') || 'workspace';

/**
 * `a@x.com:owner,b@y.com:member` → members. The role defaults to `member`. People's addresses come from the
 * environment, never from this repository (it is public).
 */
export function parseTeamMembers(value: string): TeamSeedMember[] {
  const members = value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [rawEmail = '', rawRole = 'member'] = entry.split(':');
      const email = rawEmail.trim().toLowerCase();
      const role = rawRole.trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
        throw new TeamSeedConfigError(`Invalid email "${email}"`);
      if (!(ROLES as readonly string[]).includes(role)) {
        throw new TeamSeedConfigError(`Invalid role "${role}" for ${email} (expected ${ROLES.join(', ')})`);
      }
      return { email, role: role as Role };
    });
  if (!members.some((m) => m.role === 'owner')) throw new TeamSeedConfigError('The team needs an owner');
  return members;
}

/**
 * Creates the workspace, its people (verified, without a password: they choose one with "Forgot password")
 * and their memberships. Idempotent and additive: existing users, memberships and roles are left as they are.
 */
export async function seedTeam(tx: DbExecutor, team: TeamSeed): Promise<{ organizationId: string }> {
  const slug = slugify(team.workspace);
  await tx.insert(organization).values({ name: team.workspace, slug }).onConflictDoNothing();
  const [org] = await tx
    .select({ id: organization.id })
    .from(organization)
    .where(eq(organization.slug, slug));
  if (!org) throw new Error(`Workspace ${slug} missing after insert`);

  for (const person of team.members) {
    await tx
      .insert(user)
      .values({ email: person.email, name: person.email.split('@')[0] ?? person.email, emailVerified: true })
      .onConflictDoNothing();
    const [row] = await tx.select({ id: user.id }).from(user).where(eq(user.email, person.email));
    if (!row) throw new Error(`User ${person.email} missing after insert`);
    await tx
      .insert(member)
      .values({ organizationId: org.id, userId: row.id, role: person.role })
      .onConflictDoNothing();
  }
  return { organizationId: org.id };
}

/** Our own workspace and team (`SEED_WORKSPACE_NAME`, `SEED_WORKSPACE_MEMBERS`); added by `pnpm db:seed`. */
export function teamSeedModule(team: TeamSeed): SeedModule {
  return {
    name: 'team',
    environments: ['dev', 'staging'],
    async run(tx) {
      await seedTeam(tx, team);
    },
  };
}
