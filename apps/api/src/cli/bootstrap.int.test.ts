import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../../test/create-test-app.ts';
import { FakeMailer } from '../../test/fake-mailer.ts';
import { browser } from '../../test/identity-helpers.ts';
import { type Auth, BETTER_AUTH } from '../modules/identity/infrastructure/better-auth.provider.ts';
import { DB_CLIENT } from '../modules/platform/db/db.module.ts';
import { BootstrapRefusedError, bootstrap } from './bootstrap.ts';

let t: TestApp;
const mailer = new FakeMailer();

beforeAll(async () => {
  t = await createTestApp({ mailer, valkeyDb: 6, env: { SIGNUP_MODE: 'invite_only' } });
});

afterAll(async () => {
  await t?.close();
});

describe('pnpm admin:bootstrap', () => {
  const requestReset = async (email: string) => {
    await t.app.get<Auth>(BETTER_AUTH).api.requestPasswordReset({ body: { email } });
    return mailer.lastUrl('reset', email);
  };

  it('creates the first owner, whose link sets a password and signs in to their workspace', async () => {
    const result = await bootstrap(
      t.app.get(DB_CLIENT),
      { email: 'First@Owner.test', name: 'First', workspace: 'Agence Démo' },
      requestReset,
    );
    const link = new URL(result.link);
    expect(`${link.origin}${link.pathname}`).toBe('http://localhost:3000/reset-password');

    const client = browser(t);
    const password = 'a long and memorable passphrase';
    await client
      .post('/api/auth/reset-password', { token: link.searchParams.get('token'), newPassword: password })
      .expect(200);
    await client.post('/api/auth/sign-in/email', { email: 'first@owner.test', password }).expect(200);
    await client
      .post('/api/auth/organization/set-active', { organizationId: result.organizationId })
      .expect(200);
    const me = await client.get('/v1/me').expect(200);
    expect(me.body).toMatchObject({ role: 'owner', activeOrganization: { name: 'Agence Démo' } });
  });

  it('refuses once users exist, unless forced', async () => {
    const db = t.app.get(DB_CLIENT);
    await expect(
      bootstrap(db, { email: 'second@owner.test', name: 'S', workspace: 'W' }, requestReset),
    ).rejects.toThrow(BootstrapRefusedError);
    await expect(
      bootstrap(db, { email: 'second@owner.test', name: 'S', workspace: 'W', force: true }, requestReset),
    ).resolves.toMatchObject({ link: expect.stringContaining('/reset-password?token=') });
    await expect(
      bootstrap(db, { email: 'second@owner.test', name: 'S', workspace: 'W', force: true }, requestReset),
    ).rejects.toThrow(/already has an account/);
  });
});
