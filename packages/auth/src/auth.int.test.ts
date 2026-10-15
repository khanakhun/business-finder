import { isUuidV7 } from '@bf/contracts';
import { closeDb, createDb, type DbClient } from '@bf/db';
import { account, invitation, member, organization, session, user } from '@bf/db/schema';
import { createIsolatedDatabase, type IsolatedDatabase } from '@bf/testing/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fromStatements, toStatements } from './roles.ts';
import { type AuthMailer, createAuth } from './server.ts';
import type { SignupPolicy } from './signup.ts';

let database: IsolatedDatabase;
let db: DbClient;

beforeAll(async () => {
  database = await createIsolatedDatabase();
  db = createDb({ url: database.url, max: 4 });
});

afterAll(async () => {
  await closeDb(db);
  await database.drop();
});

function makeAuth(signup: SignupPolicy) {
  const sent: { kind: string; to: string; url?: string }[] = [];
  const mailer: AuthMailer = {
    sendVerificationEmail: async ({ to, url }) => void sent.push({ kind: 'verify', to, url }),
    sendPasswordReset: async ({ to, url }) => void sent.push({ kind: 'reset', to, url }),
    sendInvitation: async ({ to, url }) => void sent.push({ kind: 'invite', to, url }),
    sendTwoFactorEnabled: async ({ to }) => void sent.push({ kind: '2fa', to }),
  };
  const auth = createAuth({
    db,
    secret: 'test-secret-for-better-auth-0123456789abcdef',
    apiUrl: 'http://api.test',
    appUrl: 'http://app.test',
    secureCookies: false,
    signup,
    mailer,
    breachedPasswordCheck: false,
    rateLimit: false,
  });
  return { auth, sent };
}

const signUp = (auth: ReturnType<typeof makeAuth>['auth'], email: string) =>
  auth.api.signUpEmail({ body: { email, password: 'correct horse battery', name: 'Test User' } });

describe('createAuth against the real schema', () => {
  it('signs up with a UUIDv7 id, the locale field and a verification email', async () => {
    const { auth, sent } = makeAuth({ mode: 'open', allowedEmailDomains: [] });
    const result = await signUp(auth, 'Open.User@Example.TEST');
    expect(isUuidV7(result.user.id)).toBe(true);
    const [row] = await db.select().from(user).where(eq(user.id, result.user.id));
    expect(row).toMatchObject({ email: 'open.user@example.test', emailVerified: false, locale: 'en' });
    expect(sent).toEqual([
      expect.objectContaining({
        kind: 'verify',
        to: 'open.user@example.test',
        url: expect.stringContaining('/api/auth/verify-email?token='),
      }),
    ]);
  });

  it('rejects passwords shorter than 12 characters', async () => {
    const { auth } = makeAuth({ mode: 'open', allowedEmailDomains: [] });
    await expect(
      auth.api.signUpEmail({ body: { email: 'short@example.test', password: 'too-short', name: 'S' } }),
    ).rejects.toThrow();
  });
});

/** An organization plus a member user with `role`, inserted directly (no auth flows involved). */
async function orgWithMember(role: string) {
  const suffix = crypto.randomUUID().slice(0, 8);
  const [org] = await db
    .insert(organization)
    .values({ name: `Org ${suffix}`, slug: `org-${suffix}` })
    .returning();
  const [person] = await db
    .insert(user)
    .values({ name: 'Member', email: `member-${suffix}@example.test`, emailVerified: true })
    .returning();
  if (!org || !person) throw new Error('fixture insert failed');
  await db.insert(member).values({ organizationId: org.id, userId: person.id, role });
  return { org, person };
}

async function invite(email: string, expiresInMs: number) {
  const { org, person } = await orgWithMember('owner');
  await db.insert(invitation).values({
    organizationId: org.id,
    email,
    role: 'member',
    inviterId: person.id,
    expiresAt: new Date(Date.now() + expiresInMs),
  });
}

/**
 * With email verification required, Better Auth answers a refused sign-up exactly like an accepted one (a synthetic
 * user, no session) so the response does not reveal who may register. The policy's effect is what we assert: no
 * account, no verification email.
 */
async function expectRefused(auth: ReturnType<typeof makeAuth>, email: string) {
  const result = await signUp(auth.auth, email);
  expect(result.token).toBeNull();
  expect(await db.select().from(user).where(eq(user.email, email.toLowerCase()))).toEqual([]);
  expect(auth.sent.filter((m) => m.to === email.toLowerCase())).toEqual([]);
}

async function expectAccepted(auth: ReturnType<typeof makeAuth>, email: string) {
  await signUp(auth.auth, email);
  expect(await db.select().from(user).where(eq(user.email, email.toLowerCase()))).toHaveLength(1);
  expect(auth.sent).toContainEqual(expect.objectContaining({ kind: 'verify', to: email.toLowerCase() }));
}

describe('sign-up policy', () => {
  it('invite_only refuses strangers and admits invited addresses', async () => {
    const auth = makeAuth({ mode: 'invite_only', allowedEmailDomains: [] });
    await expectRefused(auth, 'stranger@example.test');
    await invite('invited@example.test', 60_000);
    await expectAccepted(auth, 'Invited@Example.test');
  });

  it('expired invitations do not count', async () => {
    const auth = makeAuth({ mode: 'invite_only', allowedEmailDomains: [] });
    await invite('late@example.test', -1_000);
    await expectRefused(auth, 'late@example.test');
  });

  it('allowlist admits listed domains only', async () => {
    const auth = makeAuth({ mode: 'allowlist', allowedEmailDomains: ['agency.test'] });
    await expectAccepted(auth, 'staff@agency.test');
    await expectRefused(auth, 'staff@elsewhere.test');
  });

  it('fails closed for user creation outside a sign-up request', async () => {
    const { auth } = makeAuth({ mode: 'invite_only', allowedEmailDomains: [] });
    const context = await auth.$context;
    await expect(
      context.internalAdapter.createUser({ email: 'direct@example.test', name: 'D' }, { method: 'admin' }),
    ).rejects.toMatchObject({ statusCode: 403 });
  });
});

describe('organization API keys', () => {
  it('creates a bf_ key owned by the organization, hashed at rest, with a permission subset', async () => {
    const { auth } = makeAuth({ mode: 'open', allowedEmailDomains: [] });
    const { org, person } = await orgWithMember('admin');
    const created = await auth.api.createApiKey({
      body: {
        name: 'zapier',
        organizationId: org.id,
        userId: person.id,
        permissions: toStatements(['business:read', 'leads:read']),
      },
    });
    expect(created.key.startsWith('bf_')).toBe(true);

    const stored = await db.query.apikey.findFirst({
      where: (k, { eq: equals }) => equals(k.id, created.id),
    });
    expect(stored?.key).not.toBe(created.key); // only the hash is stored
    expect(stored?.referenceId).toBe(org.id);

    const verified = await auth.api.verifyApiKey({ body: { key: created.key } });
    expect(verified.valid).toBe(true);
    expect(verified.key?.referenceId).toBe(org.id);
    expect(fromStatements(verified.key?.permissions)).toEqual(['business:read', 'leads:read']);
    await expect(auth.api.verifyApiKey({ body: { key: `${created.key}x` } })).resolves.toMatchObject({
      valid: false,
    });
  });

  it('refuses key creation to roles without settings:manage', async () => {
    const { auth } = makeAuth({ mode: 'open', allowedEmailDomains: [] });
    const { org, person } = await orgWithMember('member');
    await expect(
      auth.api.createApiKey({ body: { name: 'nope', organizationId: org.id, userId: person.id } }),
    ).rejects.toMatchObject({ statusCode: 403 });
  });
});

describe('sessions', () => {
  it('start in the workspace the user joined first', async () => {
    const { auth } = makeAuth({ mode: 'open', allowedEmailDomains: [] });
    const { org, person } = await orgWithMember('member');
    const second = await orgWithMember('owner');
    await db.insert(member).values({ organizationId: second.org.id, userId: person.id, role: 'admin' });
    await db.insert(account).values({
      userId: person.id,
      providerId: 'credential',
      accountId: person.id,
      password: await (await auth.$context).password.hash('correct horse battery'),
    });
    const signedIn = await auth.api.signInEmail({
      body: { email: person.email, password: 'correct horse battery' },
    });
    const [row] = await db.select().from(session).where(eq(session.token, signedIn.token));
    expect(row?.activeOrganizationId).toBe(org.id);
  });

  it('start without a workspace for users who have none', async () => {
    const { auth } = makeAuth({ mode: 'open', allowedEmailDomains: [] });
    const [loner] = await db
      .insert(user)
      .values({
        name: 'L',
        email: `loner-${crypto.randomUUID().slice(0, 6)}@example.test`,
        emailVerified: true,
      })
      .returning();
    if (!loner) throw new Error('insert failed');
    await db.insert(account).values({
      userId: loner.id,
      providerId: 'credential',
      accountId: loner.id,
      password: await (await auth.$context).password.hash('correct horse battery'),
    });
    const signedIn = await auth.api.signInEmail({
      body: { email: loner.email, password: 'correct horse battery' },
    });
    const [row] = await db.select().from(session).where(eq(session.token, signedIn.token));
    expect(row?.activeOrganizationId).toBeNull();
  });
});
