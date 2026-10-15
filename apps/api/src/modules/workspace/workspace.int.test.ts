import { Writable } from 'node:stream';
import { LOGO_MAX_BYTES } from '@bf/contracts';
import type { DbClient } from '@bf/db';
import { auditLogs, secrets } from '@bf/db/schema';
import { createLogger } from '@bf/observability';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../../../test/create-test-app.ts';
import { FakeMailer } from '../../../test/fake-mailer.ts';
import {
  type Browser,
  createWorkspace,
  inviteAndJoin,
  signUpVerified,
} from '../../../test/identity-helpers.ts';
import { rotateMasterKey } from '../../cli/rotate-master-key.ts';
import { DB_CLIENT } from '../platform/db/db.module.ts';
import { InMemoryObjectStorage } from '../platform/storage/object-storage.ts';
import { StaticMasterKeys } from './application/testing.ts';
import { SecretResolver } from './index.ts';

// Distinctive fake values: tests search every response, audit row and log line for them.
const SENTINEL = 'sentinel-workspace-secret-7d1c0e9a4b';
const GOOGLE_KEY = `AIza${'Q'.repeat(31)}Zx9w`;
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 1),
]);

let t: TestApp;
let db: DbClient;
const mailer = new FakeMailer();
const storage = new InMemoryObjectStorage();
// Every log line at trace level, to prove secret values never reach the logs.
const logLines: string[] = [];
const logger = createLogger({
  service: 'api-test',
  level: 'trace',
  destination: new Writable({
    write(chunk, _encoding, done) {
      logLines.push(String(chunk));
      done();
    },
  }),
});
let owner: Browser;
let viewer: Browser;
let member: Browser;
let outsider: Browser;
let orgId: string;

beforeAll(async () => {
  t = await createTestApp({
    mailer,
    storage,
    logger,
    valkeyDb: 7,
    env: { FAKE_CONNECTION_TESTS: 'true', UNSPLASH_ACCESS_KEY: 'global-unsplash-access-key' },
  });
  db = t.app.get(DB_CLIENT);
  owner = await signUpVerified(t, mailer, 'owner@ws.test', 'Olive Owner');
  orgId = await createWorkspace(owner, 'Agence SBH');
  viewer = (await inviteAndJoin(t, mailer, owner, 'viewer@ws.test', 'viewer')).client;
  member = (await inviteAndJoin(t, mailer, owner, 'member@ws.test', 'member')).client;
  outsider = await signUpVerified(t, mailer, 'outsider@ws.test', 'Other Owner');
  await createWorkspace(outsider, 'Elsewhere');
});

afterAll(async () => {
  await t?.close();
});

describe('workspace settings', () => {
  it('any member reads them; only settings:manage changes them', async () => {
    const read = await viewer.get('/v1/workspace/settings').expect(200);
    expect(read.body).toMatchObject({ agencyName: null, outreachReadiness: { ready: false } });
    await viewer.patch('/v1/workspace/settings', { agencyName: 'Nope' }).expect(403);
    await member.patch('/v1/workspace/settings', { agencyName: 'Nope' }).expect(403);

    const saved = await owner
      .patch('/v1/workspace/settings', {
        agencyName: 'Agence SBH',
        postalAddress: {
          line1: '1 rue de la République',
          city: 'Gustavia',
          postalCode: '97133',
          countryCode: 'BL',
        },
        locales: ['fr', 'en'],
        primaryLocale: 'fr',
        timezone: 'America/St_Barthelemy',
        features: { semanticSearch: false },
      })
      .expect(200);
    expect(saved.body).toMatchObject({
      agencyName: 'Agence SBH',
      primaryLocale: 'fr',
      outreachReadiness: { ready: true, missing: [] },
      features: { semanticSearch: { enabled: false, available: true } },
    });
    expect((await viewer.get('/v1/workspace/settings').expect(200)).body.agencyName).toBe('Agence SBH');
  });

  it('validates input and refuses deployment-disabled features', async () => {
    await owner.patch('/v1/workspace/settings', { timezone: 'Mars/Olympus' }).expect(422);
    await owner.patch('/v1/workspace/settings', { primaryLocale: 'en', locales: ['fr'] }).expect(422);
    const refused = await owner.patch('/v1/workspace/settings', { features: { autoSend: true } }).expect(409);
    expect(refused.body).toMatchObject({ code: 'CONFLICT', reason: 'FEATURE_UNAVAILABLE' });
  });

  it('keeps workspaces apart', async () => {
    expect((await outsider.get('/v1/workspace/settings').expect(200)).body.agencyName).toBeNull();
  });
});

describe('workspace logo', () => {
  it('uploads, serves and removes an image; rejects other content', async () => {
    await viewer.putRaw('/v1/workspace/logo', PNG, 'image/png').expect(403);
    await owner.putRaw('/v1/workspace/logo', PNG, 'image/png').expect(204);
    expect([...storage.objects.keys()][0]).toMatch(new RegExp(`^orgs/${orgId}/logo/`));
    expect((await owner.get('/v1/workspace/settings').expect(200)).body.hasLogo).toBe(true);

    const served = await viewer.get('/v1/workspace/logo').expect(200);
    expect(served.headers['content-type']).toBe('image/png');
    expect(served.headers['x-content-type-options']).toBe('nosniff');
    expect(Buffer.from(served.body as Buffer).equals(PNG)).toBe(true);
    await outsider.get('/v1/workspace/logo').expect(404);

    const svg = await owner.putRaw(
      '/v1/workspace/logo',
      Buffer.from('<svg onload="alert(1)"/>'),
      'image/svg+xml',
    );
    expect(svg.status).toBe(422);
    expect(svg.body.reason).toBe('LOGO_FORMAT');
    await owner
      .putRaw('/v1/workspace/logo', Buffer.alloc(LOGO_MAX_BYTES + 1, 0xff), 'image/jpeg')
      .expect(422);
    await owner.putRaw('/v1/workspace/logo', Buffer.alloc(LOGO_MAX_BYTES * 3), 'image/png').expect(413);

    await owner.delete('/v1/workspace/logo').expect(204);
    await owner.delete('/v1/workspace/logo').expect(404);
    expect(storage.objects.size).toBe(0);
  });
});

describe('secrets', () => {
  it('stores encrypted values that the API never returns', async () => {
    await member.put('/v1/workspace/secrets/foursquare', { value: SENTINEL }).expect(403);
    const put = await owner.put('/v1/workspace/secrets/foursquare', { value: SENTINEL }).expect(200);
    expect(put.body).toMatchObject({
      name: 'foursquare',
      source: 'workspace',
      last4: SENTINEL.slice(-4),
    });
    await owner.put('/v1/workspace/secrets/google_places', { value: GOOGLE_KEY }).expect(200);

    const list = await owner.get('/v1/workspace/secrets').expect(200);
    const responses = JSON.stringify([put.body, list.body]);
    expect(responses).not.toContain(SENTINEL);
    expect(responses).not.toContain(GOOGLE_KEY);
    const byName = Object.fromEntries((list.body.items as Array<{ name: string }>).map((i) => [i.name, i]));
    expect(byName.google_places).toMatchObject({ source: 'workspace', last4: 'Zx9w', testable: true });
    expect(byName.unsplash).toMatchObject({ source: 'global', last4: null });
    expect(byName.anthropic).toMatchObject({ source: null });

    const [row] = await db.select().from(secrets).where(eq(secrets.name, 'foursquare'));
    expect(row?.ciphertext.includes(Buffer.from(SENTINEL))).toBe(false);
    expect(row).toMatchObject({ organizationId: orgId, keyVersion: 1 });
  });

  it('decrypts just in time for features (workspace first, then the global fallback)', async () => {
    const resolver = t.app.get(SecretResolver);
    expect(await resolver.resolve(orgId, 'foursquare')).toEqual({ value: SENTINEL, source: 'workspace' });
    expect(await resolver.resolve(orgId, 'unsplash')).toEqual({
      value: 'global-unsplash-access-key',
      source: 'global',
    });
  });

  it('validates names and formats, tests connections, deletes', async () => {
    await owner.put('/v1/workspace/secrets/not_a_secret', { value: 'x' }).expect(404);
    const wrong = await owner.put('/v1/workspace/secrets/google_places', { value: SENTINEL }).expect(422);
    expect(JSON.stringify(wrong.body)).not.toContain(SENTINEL);

    const tested = await owner.post('/v1/workspace/secrets/google_places/test').expect(200);
    expect(tested.body).toMatchObject({ ok: true, source: 'workspace' });
    await owner.post('/v1/workspace/secrets/anthropic/test').expect(409);
    // Failed attempts are audited too.
    const failed = await owner.get('/v1/audit-logs?action=secrets.tested').expect(200);
    expect(failed.body.items[0]).toMatchObject({
      entityId: 'anthropic',
      metadata: { outcome: 'error', code: 'CONFLICT' },
    });

    await owner.delete('/v1/workspace/secrets/foursquare').expect(204);
    await owner.delete('/v1/workspace/secrets/foursquare').expect(404);
  });

  it('an API key with settings:manage may manage secrets; others may not', async () => {
    const created = await owner
      .post('/v1/api-keys', { name: 'ops', permissions: ['settings:manage'] })
      .expect(201);
    const bearer = `Bearer ${created.body.key as string}`;
    await t.http.get('/v1/workspace/secrets').set('Authorization', bearer).expect(200);
    const readOnly = await owner
      .post('/v1/api-keys', { name: 'ro', permissions: ['business:read'] })
      .expect(201);
    await t.http
      .get('/v1/workspace/secrets')
      .set('Authorization', `Bearer ${readOnly.body.key as string}`)
      .expect(403);
  });
});

describe('audit log', () => {
  it('records settings, secrets and member actions with the request context, no secret values', async () => {
    const page = await owner.get('/v1/audit-logs?limit=200').expect(200);
    const actions = (page.body.items as Array<{ action: string }>).map((i) => i.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        'settings.updated',
        'settings.logo_updated',
        'settings.logo_removed',
        'secrets.created',
        'secrets.tested',
        'secrets.deleted',
        'identity.member_invited',
        'identity.api_key_created',
      ]),
    );
    const updated = (page.body.items as Array<Record<string, unknown>>).find(
      (i) => i.action === 'secrets.created',
    );
    expect(updated).toMatchObject({ actorType: 'user', entityType: 'secret', ip: expect.any(String) });

    const rows = await db.select().from(auditLogs);
    expect(logLines.length).toBeGreaterThan(10);
    const everything = JSON.stringify([page.body, rows, logLines]);
    expect(everything).not.toContain(SENTINEL);
    expect(everything).not.toContain(GOOGLE_KEY);
  });

  it('filters by action prefix and pages with a cursor; viewers and other workspaces see nothing', async () => {
    const secretsOnly = await owner.get('/v1/audit-logs?action=secrets.').expect(200);
    expect(
      (secretsOnly.body.items as Array<{ action: string }>).every((i) => i.action.startsWith('secrets.')),
    ).toBe(true);
    const first = await owner.get('/v1/audit-logs?limit=2').expect(200);
    expect(first.body.items).toHaveLength(2);
    const second = await owner
      .get(`/v1/audit-logs?limit=2&cursor=${encodeURIComponent(first.body.nextCursor as string)}`)
      .expect(200);
    expect(second.body.items[0].id).not.toBe(first.body.items[1].id);
    await viewer.get('/v1/audit-logs').expect(403);
    const theirs = await outsider.get('/v1/audit-logs').expect(200);
    expect((theirs.body.items as unknown[]).length).toBe(0);
  });

  it('is append-only in the database', async () => {
    // Drizzle wraps the driver error; the trigger's message is on the cause.
    const failure = (statement: Promise<unknown>) =>
      statement.then(
        () => 'succeeded',
        (error: Error & { cause?: Error }) => error.cause?.message ?? error.message,
      );
    expect(await failure(db.execute(sql`UPDATE audit_logs SET action = 'tampered.action'`))).toMatch(
      /append-only/,
    );
    expect(await failure(db.execute(sql`DELETE FROM audit_logs`))).toMatch(/append-only/);
    expect(await failure(db.execute(sql`TRUNCATE audit_logs`))).toMatch(/append-only/);
  });
});

describe('master key rotation (pnpm secrets:rotate-master)', () => {
  it('re-wraps every data key; secrets stay readable with the new key only; re-running is a no-op', async () => {
    const v1 = Buffer.from(t.env.SECRETS_MASTER_KEY, 'base64');
    const v2 = Buffer.alloc(32, 42);
    const rotating = new StaticMasterKeys(
      new Map([
        [1, v1],
        [2, v2],
      ]),
      2,
    );
    const report = await rotateMasterKey(db, rotating, { batchSize: 1 });
    expect(report).toEqual({ toVersion: 2, rotated: 1, skipped: 0, skippedVersions: [] });
    expect(await rotateMasterKey(db, rotating)).toMatchObject({ rotated: 0, skipped: 0 });

    const rows = await db.select({ keyVersion: secrets.keyVersion }).from(secrets);
    expect(rows.every((row) => row.keyVersion === 2)).toBe(true);

    // A process holding only the new key reads the rotated secret.
    const { SecretsVault } = await import('./index.ts');
    const vault = new SecretsVault(
      new (await import('./infrastructure/drizzle-secrets.repository.ts')).DrizzleSecretsRepository(db),
      StaticMasterKeys.single(2, 42),
      { now: () => new Date() },
      { warn: () => undefined } as never,
    );
    expect(await vault.get(orgId, 'google_places')).toBe(GOOGLE_KEY);

    const [audit] = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, 'secrets.master_key_rotated'));
    expect(audit).toMatchObject({
      organizationId: null,
      actorType: 'system',
      metadata: { rotated: 1, skipped: 0, toVersion: 2 },
    });
  });

  it('leaves a secret alone when it was replaced after being read (compare-and-set)', async () => {
    const { DrizzleSecretsRepository } = await import('./infrastructure/drizzle-secrets.repository.ts');
    const repository = new DrizzleSecretsRepository(db);
    const [row] = await repository.listForRotation(3, 10);
    if (!row) throw new Error('expected a secret');
    const stale = { keyVersion: row.keyVersion, dekIv: Buffer.alloc(12, 0xee) };
    const next = { keyVersion: 3, wrappedDek: row.wrappedDek, dekIv: row.dekIv, dekTag: row.dekTag };
    expect(await repository.rewrap(row.id, stale, next)).toBe(false);
  });

  it('reports rows it cannot open instead of failing silently', async () => {
    const v3Only = StaticMasterKeys.single(3, 99);
    expect(await rotateMasterKey(db, v3Only)).toMatchObject({ rotated: 0, skipped: 1, skippedVersions: [2] });
  });
});
