// pnpm admin:bootstrap --email <e> --name <n> --workspace <w> [--force]
// Creates the first owner and their workspace, then prints a one-time link to choose a password (a password-reset
// link: the account has no password until then). Refuses when users already exist, unless --force.
import 'reflect-metadata';
import { parseArgs } from 'node:util';
import { type Auth, createAuth } from '@bf/auth';
import type { ApiEnv } from '@bf/config';
import { closeDb, createDb, type DbClient, runInTransaction } from '@bf/db';
import { member, organization, user } from '@bf/db/schema';
import { count, eq } from 'drizzle-orm';
import { loadAppEnv } from '../modules/platform/config/app-env.ts';

export interface BootstrapInput {
  readonly email: string;
  readonly name: string;
  readonly workspace: string;
  readonly force?: boolean;
}

export class BootstrapRefusedError extends Error {}

const slugify = (value: string) =>
  value
    .normalize('NFKD')
    .replaceAll(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-|-$/g, '') || 'workspace';

/** Returns the set-password link. `requestReset` sends the reset through Better Auth (captured, not emailed). */
export async function bootstrap(
  db: DbClient,
  input: BootstrapInput,
  requestReset: (email: string) => Promise<string>,
): Promise<{ userId: string; organizationId: string; link: string }> {
  const email = input.email.trim().toLowerCase();
  const created = await runInTransaction(db, async (tx) => {
    const [existing] = await tx.select({ n: count() }).from(user);
    if ((existing?.n ?? 0) > 0 && !input.force) {
      throw new BootstrapRefusedError(
        'Users already exist. Use invitations, or pass --force to add another owner.',
      );
    }
    const [taken] = await tx.select({ id: user.id }).from(user).where(eq(user.email, email));
    if (taken) throw new BootstrapRefusedError(`${email} already has an account.`);
    const [person] = await tx
      .insert(user)
      .values({ email, name: input.name, emailVerified: true })
      .returning();
    const [org] = await tx
      .insert(organization)
      .values({
        name: input.workspace,
        slug: `${slugify(input.workspace)}-${crypto.randomUUID().slice(0, 6)}`,
      })
      .returning();
    if (!person || !org) throw new Error('insert returned nothing');
    await tx.insert(member).values({ organizationId: org.id, userId: person.id, role: 'owner' });
    return { userId: person.id, organizationId: org.id };
  });
  return { ...created, link: await requestReset(email) };
}

/** Better Auth instance whose reset email is captured instead of sent. */
function captureResetLinks(env: ApiEnv, db: DbClient): { auth: Auth; links: Map<string, string> } {
  const links = new Map<string, string>();
  const ignore = async () => undefined;
  const auth = createAuth({
    db,
    secret: env.BETTER_AUTH_SECRET,
    apiUrl: env.API_URL,
    appUrl: env.APP_URL,
    secureCookies: env.NODE_ENV === 'production',
    signup: { mode: 'invite_only', allowedEmailDomains: [] },
    mailer: {
      sendPasswordReset: async ({ to, url }) => void links.set(to, url),
      sendVerificationEmail: ignore,
      sendInvitation: ignore,
      sendTwoFactorEnabled: ignore,
    },
    breachedPasswordCheck: false,
    rateLimit: false,
  });
  return { auth, links };
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    // `pnpm admin:bootstrap -- …` forwards the `--` separator, after which parseArgs stops reading options.
    args: process.argv.slice(2).filter((arg) => arg !== '--'),
    options: {
      email: { type: 'string' },
      name: { type: 'string' },
      workspace: { type: 'string' },
      force: { type: 'boolean', default: false },
    },
  });
  if (!values.email || !values.name || !values.workspace) {
    console.error(
      'Usage: pnpm admin:bootstrap --email <email> --name <name> --workspace <workspace> [--force]',
    );
    return 2;
  }
  const env = loadAppEnv('http');
  const db = createDb({ url: env.DATABASE_URL, max: 2, applicationName: 'bf-bootstrap' });
  try {
    const { auth, links } = captureResetLinks(env, db);
    const result = await bootstrap(
      db,
      { email: values.email, name: values.name, workspace: values.workspace, force: values.force },
      async (email) => {
        await auth.api.requestPasswordReset({ body: { email, redirectTo: `${env.APP_URL}/reset-password` } });
        const link = links.get(email);
        if (!link) throw new Error('no reset link was produced');
        return link;
      },
    );
    console.log(`Created owner ${values.email} in workspace "${values.workspace}".`);
    console.log('Open this link once to choose a password (valid for 1 hour):');
    console.log(result.link);
    return 0;
  } catch (error) {
    if (error instanceof BootstrapRefusedError) {
      console.error(error.message);
      return 1;
    }
    throw error;
  } finally {
    await closeDb(db);
  }
}

if (import.meta.main) process.exitCode = await main();
