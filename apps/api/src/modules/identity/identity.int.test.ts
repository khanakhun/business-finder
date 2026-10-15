import { apikey } from '@bf/db/schema';
import { eq } from 'drizzle-orm';
import { generate } from 'otplib';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../../../test/create-test-app.ts';
import { FakeMailer } from '../../../test/fake-mailer.ts';
import {
  type Browser,
  browser,
  createWorkspace,
  inviteAndJoin,
  PASSWORD,
  signUpVerified,
} from '../../../test/identity-helpers.ts';
import { DB_CLIENT } from '../platform/db/db.module.ts';

let t: TestApp;
const mailer = new FakeMailer();
let owner: Browser;
let orgId: string;

const api = () => request(t.app.getHttpServer());
const db = () => t.app.get(DB_CLIENT);

beforeAll(async () => {
  t = await createTestApp({ mailer, valkeyDb: 5, env: { PLATFORM_OPERATOR_EMAILS: 'owner@example.test' } });
  owner = await signUpVerified(t, mailer, 'owner@example.test', 'Olive Owner');
  orgId = await createWorkspace(owner, 'Agence SBH');
});

afterAll(async () => {
  await t?.close();
});

describe('authentication', () => {
  it('signs up, verifies by email, signs in and describes the caller', async () => {
    const ana = await signUpVerified(t, mailer, 'ana@example.test', 'Ana');
    const me = await ana.get('/v1/me').expect(200);
    expect(me.body).toMatchObject({
      user: {
        email: 'ana@example.test',
        name: 'Ana',
        emailVerified: true,
        locale: 'en',
        twoFactorEnabled: false,
      },
      activeOrganization: null,
      role: null,
      permissions: [],
      organizations: [],
    });
  });

  it('refuses sign-in before the email is verified', async () => {
    const client = browser(t);
    await client
      .post('/api/auth/sign-up/email', { email: 'unverified@example.test', password: PASSWORD, name: 'U' })
      .expect(200);
    await client
      .post('/api/auth/sign-in/email', { email: 'unverified@example.test', password: PASSWORD })
      .expect(403);
  });

  it('answers 401 problem+json without credentials or with invalid ones', async () => {
    const res = await api().get('/v1/me').expect(401);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.body).toMatchObject({ code: 'UNAUTHENTICATED', status: 401 });
    await api().get('/v1/me').set('Authorization', 'Bearer bf_not-a-real-key').expect(401);
    await api().get('/v1/me').set('Authorization', 'Basic dXNlcjpwYXNz').expect(401);
  });

  it('keeps explicitly anonymous routes public', async () => {
    await api().get('/v1/system/info').expect(200);
    await api().get('/health/live').expect(200);
  });

  it('rate-limits sign-in attempts per IP', async () => {
    const client = browser(t);
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) {
      const res = await client.post('/api/auth/sign-in/email', {
        email: 'nobody@example.test',
        password: 'wrong-password-123',
      });
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
  });
});

describe('workspace context and permissions', () => {
  it('gives the creator the owner role and full permissions', async () => {
    const me = await owner.get('/v1/me').expect(200);
    expect(me.body.activeOrganization).toMatchObject({ id: orgId, name: 'Agence SBH', role: 'owner' });
    expect(me.body.permissions).toContain('billing:manage');
    expect(me.body.organizations).toEqual([expect.objectContaining({ id: orgId, role: 'owner' })]);
  });

  it('requires an active workspace for org-scoped routes (403)', async () => {
    const loner = await signUpVerified(t, mailer, 'loner@example.test');
    const res = await loner.get('/v1/members').expect(403);
    expect(res.body).toMatchObject({ code: 'FORBIDDEN', detail: 'Select a workspace first.' });
  });

  it('forbids a viewer from member management (403) but not from reading itself', async () => {
    const { client: viewer } = await inviteAndJoin(t, mailer, owner, 'viewer@example.test', 'viewer');
    const me = await viewer.get('/v1/me').expect(200);
    expect(me.body.role).toBe('viewer');
    expect(me.body.permissions).toEqual(['analytics:read', 'business:read', 'leads:read', 'sites:read']);
    const res = await viewer.post('/v1/invitations', { email: 'x@example.test', role: 'viewer' }).expect(403);
    expect(res.body.code).toBe('FORBIDDEN');
    await viewer.get('/v1/api-keys').expect(403);
  });

  it('refuses session writes from another origin (CSRF defence)', async () => {
    const cookie = (await owner.get('/v1/me')).request.cookies;
    await api()
      .post('/v1/invitations')
      .set('Cookie', cookie)
      .set('Origin', 'https://evil.example')
      .send({ email: 'csrf@example.test', role: 'viewer' })
      .expect(403);
    await api()
      .post('/v1/invitations')
      .set('Cookie', cookie)
      .send({ email: 'csrf@example.test', role: 'viewer' })
      .expect(403);
  });
});

describe('members and invitations', () => {
  it('invites by email; the invitee joins with the invited role', async () => {
    const { client } = await inviteAndJoin(t, mailer, owner, 'mia@example.test', 'member');
    expect((await client.get('/v1/me').expect(200)).body).toMatchObject({ role: 'member' });
    expect(mailer.lastUrl('invite', 'mia@example.test')).toMatch(
      /^http:\/\/localhost:3000\/invite\/[0-9a-f-]{36}$/,
    );
    const overview = await owner.get('/v1/members').expect(200);
    expect(overview.body.members.map((m: { email: string; role: string }) => [m.email, m.role])).toEqual(
      expect.arrayContaining([
        ['owner@example.test', 'owner'],
        ['mia@example.test', 'member'],
      ]),
    );
  });

  it('refuses inviting an existing member (409) and roles the inviter cannot grant (403)', async () => {
    await owner.post('/v1/invitations', { email: 'owner@example.test', role: 'member' }).expect(409);
    const { client: admin } = await inviteAndJoin(t, mailer, owner, 'adam@example.test', 'admin');
    const res = await admin
      .post('/v1/invitations', { email: 'boss@example.test', role: 'owner' })
      .expect(403);
    expect(res.body.code).toBe('FORBIDDEN');
  });

  it('re-invites, resends and revokes pending invitations', async () => {
    const first = await owner
      .post('/v1/invitations', { email: 'pending@example.test', role: 'viewer' })
      .expect(201);
    const second = await owner
      .post('/v1/invitations', { email: 'pending@example.test', role: 'member' })
      .expect(201);
    const pending = (await owner.get('/v1/members')).body.invitations.filter(
      (i: { email: string }) => i.email === 'pending@example.test',
    );
    expect(pending).toEqual([expect.objectContaining({ id: second.body.id, role: 'member' })]);
    await owner.post(`/v1/invitations/${first.body.id}/resend`).expect(404); // replaced
    await owner.post(`/v1/invitations/${second.body.id}/resend`).expect(200);
    await owner.delete(`/v1/invitations/${second.body.id}`).expect(204);
    await owner.delete(`/v1/invitations/${second.body.id}`).expect(404);
  });

  it('protects the last owner and transfers ownership', async () => {
    const me = await owner.get('/v1/me');
    const members = (await owner.get('/v1/members')).body.members as {
      id: string;
      userId: string;
      email: string;
    }[];
    const self = members.find((m) => m.userId === me.body.user.id);
    const mia = members.find((m) => m.email === 'mia@example.test');
    if (!self || !mia) throw new Error('fixture members missing');

    const demote = await owner.patch(`/v1/members/${self.id}`, { role: 'admin' }).expect(409);
    expect(demote.body).toMatchObject({ code: 'CONFLICT', reason: 'LAST_OWNER' });
    await owner.delete(`/v1/members/${self.id}`).expect(409);

    await owner.post('/v1/members/transfer-ownership', { memberId: mia.id }).expect(204);
    const after = (await owner.get('/v1/members')).body.members as { id: string; role: string }[];
    expect(after.find((m) => m.id === mia.id)?.role).toBe('owner');
    expect(after.find((m) => m.id === self.id)?.role).toBe('admin');

    // Give it back so later tests keep an owner session.
    const miaClient = await signInAs('mia@example.test');
    await miaClient.post('/v1/members/transfer-ownership', { memberId: self.id }).expect(204);
  });

  it('changes roles and removes members; the removed member loses access at once', async () => {
    const { client: ivy, memberId } = await inviteAndJoin(t, mailer, owner, 'ivy@example.test', 'member');
    const changed = await owner.patch(`/v1/members/${memberId}`, { role: 'viewer' }).expect(200);
    expect(changed.body).toMatchObject({ id: memberId, role: 'viewer' });
    await owner.delete(`/v1/members/${memberId}`).expect(204);
    expect((await ivy.get('/v1/me').expect(200)).body.activeOrganization).toBeNull();
    await ivy.get('/v1/members').expect(403);
  });
});

describe('cross-workspace isolation (404, never 403)', () => {
  it('does not find members, invitations or keys of another workspace', async () => {
    const other = await signUpVerified(t, mailer, 'rival@example.test');
    await createWorkspace(other, 'Rival');
    const ourMembers = (await owner.get('/v1/members')).body.members as { id: string }[];
    const ourInvite = await owner
      .post('/v1/invitations', { email: 'x-org@example.test', role: 'viewer' })
      .expect(201);
    const ourKey = await owner
      .post('/v1/api-keys', { name: 'ours', permissions: ['business:read'] })
      .expect(201);

    await other.patch(`/v1/members/${ourMembers[0]?.id}`, { role: 'viewer' }).expect(404);
    await other.delete(`/v1/members/${ourMembers[0]?.id}`).expect(404);
    await other.post(`/v1/invitations/${ourInvite.body.id}/resend`).expect(404);
    await other.delete(`/v1/api-keys/${ourKey.body.id}`).expect(404);
    expect((await other.get('/v1/members')).body.members).toHaveLength(1);
  });
});

describe('API keys', () => {
  it('shows the key once, authenticates with it, and stops on revoke', async () => {
    const created = await owner
      .post('/v1/api-keys', { name: 'zapier', permissions: ['settings:manage', 'business:read'] })
      .expect(201);
    expect(created.body.key).toMatch(/^bf_/);
    expect(created.body).toMatchObject({
      name: 'zapier',
      permissions: ['business:read', 'settings:manage'],
      revokedAt: null,
    });

    const listed = await owner.get('/v1/api-keys').expect(200);
    const item = listed.body.items.find((k: { id: string }) => k.id === created.body.id);
    expect(item).not.toHaveProperty('key');
    expect(item.start).toMatch(/^bf_/);

    const auth = `Bearer ${created.body.key}`;
    await api().get('/v1/api-keys').set('Authorization', auth).expect(200);
    await api().get('/v1/me').set('Authorization', auth).expect(403); // keys have no user
    await api()
      .post('/v1/invitations')
      .set('Authorization', auth)
      .send({ email: 'k@example.test', role: 'viewer' })
      .expect(403);

    await owner.delete(`/v1/api-keys/${created.body.id}`).expect(204);
    await api().get('/v1/api-keys').set('Authorization', auth).expect(401);
    const revoked = (await owner.get('/v1/api-keys')).body.items.find(
      (k: { id: string }) => k.id === created.body.id,
    );
    expect(revoked.revokedAt).not.toBeNull();
  });

  it('cannot carry more permissions than its creator, nor be created by non-admins', async () => {
    const { client: admin } = await inviteAndJoin(t, mailer, owner, 'keyadmin@example.test', 'admin');
    const res = await admin
      .post('/v1/api-keys', { name: 'escalate', permissions: ['billing:manage'] })
      .expect(403);
    expect(res.body.code).toBe('FORBIDDEN');
    await admin.post('/v1/api-keys', { name: 'fine', permissions: ['business:read'] }).expect(201);
    const { client: member } = await inviteAndJoin(t, mailer, owner, 'keymember@example.test', 'member');
    await member.post('/v1/api-keys', { name: 'nope', permissions: ['business:read'] }).expect(403);
  });

  it('rejects expired keys', async () => {
    const created = await owner
      .post('/v1/api-keys', { name: 'short', permissions: ['settings:manage'], expiresInDays: 1 })
      .expect(201);
    await db()
      .update(apikey)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(apikey.id, created.body.id));
    await api().get('/v1/api-keys').set('Authorization', `Bearer ${created.body.key}`).expect(401);
  });
});

describe('two-factor authentication (TOTP)', () => {
  it('enables 2FA, then requires the code at sign-in', async () => {
    const client = await signUpVerified(t, mailer, 'totp@example.test', 'Tom');
    const enabled = await client.post('/api/auth/two-factor/enable', { password: PASSWORD }).expect(200);
    const secret = new URL(enabled.body.totpURI as string).searchParams.get('secret') ?? '';
    expect(enabled.body.backupCodes.length).toBeGreaterThan(0);
    await client.post('/api/auth/two-factor/verify-totp', { code: await generate({ secret }) }).expect(200);
    expect((await client.get('/v1/me')).body.user.twoFactorEnabled).toBe(true);
    expect(mailer.sent).toContainEqual(
      expect.objectContaining({ kind: 'two-factor', to: 'totp@example.test' }),
    );

    const fresh = browser(t);
    const signIn = await fresh
      .post('/api/auth/sign-in/email', { email: 'totp@example.test', password: PASSWORD })
      .expect(200);
    expect(signIn.body.twoFactorRedirect).toBe(true);
    await fresh.get('/v1/me').expect(401);
    await fresh.post('/api/auth/two-factor/verify-totp', { code: await generate({ secret }) }).expect(200);
    await fresh.get('/v1/me').expect(200);
  });
});

describe('password reset', () => {
  it('emails a link to the dashboard and accepts the new password', async () => {
    const client = browser(t);
    await signUpVerified(t, mailer, 'forgot@example.test');
    await client.post('/api/auth/request-password-reset', { email: 'forgot@example.test' }).expect(200);
    const link = new URL(mailer.lastUrl('reset', 'forgot@example.test'));
    expect(link.origin).toBe('http://localhost:3000');
    expect(link.pathname).toBe('/reset-password');
    const newPassword = 'another long passphrase 42';
    await client
      .post('/api/auth/reset-password', { token: link.searchParams.get('token'), newPassword })
      .expect(200);
    await client
      .post('/api/auth/sign-in/email', { email: 'forgot@example.test', password: newPassword })
      .expect(200);
  });
});

describe('Better Auth surface', () => {
  it.each([
    '/api/auth/organization/invite-member',
    '/api/auth/organization/update-member-role',
    '/api/auth/organization/remove-member',
    '/api/auth/organization/leave',
    '/api/auth/api-key/create',
    '/api/auth/delete-user',
  ])('keeps %s closed (membership and keys go through /v1)', async (path) => {
    await owner.post(path, {}).expect(404);
  });
});

describe('Bull Board', () => {
  it('is for platform operators only — workspace roles do not qualify', async () => {
    await api().get('/admin/queues').expect(401);
    const { client: viewer } = await inviteAndJoin(t, mailer, owner, 'bullviewer@example.test', 'viewer');
    await viewer.get('/admin/queues').expect(403);
    const tenant = await signUpVerified(t, mailer, 'tenant@example.test');
    await createWorkspace(tenant, 'Tenant');
    await tenant.get('/admin/queues').expect(403); // owner of their own workspace, not an operator
    await owner.get('/admin/queues').expect(200); // listed in PLATFORM_OPERATOR_EMAILS
  });
});

describe('sessions', () => {
  it('revocation takes effect immediately (no cookie cache)', async () => {
    await signUpVerified(t, mailer, 'twodevices@example.test');
    const laptop = browser(t);
    const phone = browser(t);
    for (const device of [laptop, phone]) {
      await device
        .post('/api/auth/sign-in/email', { email: 'twodevices@example.test', password: PASSWORD })
        .expect(200);
      await device.get('/v1/me').expect(200);
    }
    await laptop.post('/api/auth/revoke-other-sessions').expect(200);
    await phone.get('/v1/me').expect(401);
    await laptop.get('/v1/me').expect(200);
  });

  it('throttles sign-in per account, whatever the IP', async () => {
    await signUpVerified(t, mailer, 'target@example.test');
    const statuses: number[] = [];
    for (let i = 0; i < 21; i++) {
      // A fresh client (and so a fresh IP) per attempt: the per-IP limit never triggers.
      const res = await browser(t).post('/api/auth/sign-in/email', {
        email: 'target@example.test',
        password: 'wrong password 123',
      });
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 18).every((s) => s === 401)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
  });
});

async function signInAs(email: string): Promise<Browser> {
  const client = browser(t);
  await client.post('/api/auth/sign-in/email', { email, password: PASSWORD }).expect(200);
  const me = await client.get('/v1/me');
  const org = me.body.organizations[0];
  if (org) await client.post('/api/auth/organization/set-active', { organizationId: org.id }).expect(200);
  return client;
}
