import type { ApiEnv } from '@bf/config';
import request from 'supertest';
import type { TestApp } from './create-test-app.ts';
import type { FakeMailer } from './fake-mailer.ts';

export const PASSWORD = 'correct horse battery staple';

let nextIp = 1;

/**
 * A cookie-keeping client that behaves like one dashboard user: sends the app's Origin (as browsers do) and its
 * own client IP (as the reverse proxy would), so Better Auth's per-IP rate limits apply per simulated user.
 */
export function browser(t: TestApp) {
  const agent = request.agent(t.app.getHttpServer());
  const origin = (t.env as ApiEnv).APP_URL;
  const ip = `203.0.113.${nextIp++ % 250}`;
  const prepare = <T extends request.Test>(req: T) => req.set('Origin', origin).set('X-Forwarded-For', ip);
  return {
    agent,
    get: (path: string) => prepare(agent.get(path)),
    post: (path: string, body?: object) => prepare(agent.post(path)).send(body ?? {}),
    patch: (path: string, body?: object) => prepare(agent.patch(path)).send(body ?? {}),
    put: (path: string, body?: object) => prepare(agent.put(path)).send(body ?? {}),
    /** Raw body (e.g. an image upload). */
    putRaw: (path: string, body: Buffer, contentType: string) =>
      prepare(agent.put(path)).set('Content-Type', contentType).send(body),
    delete: (path: string) => prepare(agent.delete(path)),
  };
}
export type Browser = ReturnType<typeof browser>;

/** Path and query of an absolute link from an email. */
export const pathOf = (url: string) => {
  const parsed = new URL(url);
  return `${parsed.pathname}${parsed.search}`;
};

/** Sign up, follow the verification link, sign in. Returns a signed-in browser. */
export async function signUpVerified(t: TestApp, mailer: FakeMailer, email: string, name = 'Test User') {
  const client = browser(t);
  await client.post('/api/auth/sign-up/email', { email, password: PASSWORD, name }).expect(200);
  await client.get(pathOf(mailer.lastUrl('verify', email))).expect((res) => {
    if (res.status >= 400) throw new Error(`verify failed: ${res.status} ${res.text}`);
  });
  await client.post('/api/auth/sign-in/email', { email, password: PASSWORD }).expect(200);
  return client;
}

/** Creates a workspace (the creator becomes owner) and makes it active. */
export async function createWorkspace(client: Browser, name: string): Promise<string> {
  const slug = `${name.toLowerCase().replaceAll(/[^a-z0-9]+/g, '-')}-${crypto.randomUUID().slice(0, 6)}`;
  const created = await client.post('/api/auth/organization/create', { name, slug }).expect(200);
  const id = created.body.id as string;
  await client.post('/api/auth/organization/set-active', { organizationId: id }).expect(200);
  return id;
}

/** Invite `email` as `role` from `admin`'s active workspace; the invitee signs up, verifies and accepts. */
export async function inviteAndJoin(
  t: TestApp,
  mailer: FakeMailer,
  admin: Browser,
  email: string,
  role: string,
): Promise<{ client: Browser; memberId: string }> {
  const invitation = await admin.post('/v1/invitations', { email, role }).expect(201);
  const client = await signUpVerified(t, mailer, email);
  const accepted = await client
    .post('/api/auth/organization/accept-invitation', { invitationId: invitation.body.id })
    .expect(200);
  await client
    .post('/api/auth/organization/set-active', { organizationId: accepted.body.invitation.organizationId })
    .expect(200);
  return { client, memberId: accepted.body.member.id as string };
}
