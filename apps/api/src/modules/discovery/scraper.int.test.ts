import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../../../test/create-test-app.ts';
import { FakeMailer } from '../../../test/fake-mailer.ts';
import {
  type Browser,
  createWorkspace,
  inviteAndJoin,
  signUpVerified,
} from '../../../test/identity-helpers.ts';

// The Google Maps scraper deployed (BF-019): its own app, since the deployment switch is read at startup.
const mailer = new FakeMailer();
let scraperApp: TestApp;
let boss: Browser;
let admin: Browser;

afterAll(async () => {
  await scraperApp?.close();
});

describe('Google Maps scraper deployed', () => {
  beforeAll(async () => {
    scraperApp = await createTestApp({
      mailer,
      valkeyDb: 0,
      env: { FEATURE_MAPS_SCRAPER: 'true', MAPS_SCRAPER_URL: 'http://scraper.invalid:8080' },
    });
    boss = await signUpVerified(scraperApp, mailer, 'boss@scraper.test', 'Bea Boss');
    await createWorkspace(boss, 'Scraper Agency');
    admin = (await inviteAndJoin(scraperApp, mailer, boss, 'admin@scraper.test', 'admin')).client;
  });

  it('needs the workspace flag and an owner acknowledgement (recorded in the audit log)', async () => {
    const providers = async () =>
      (await admin.get('/v1/discovery/providers').expect(200)).body.items.find(
        (p: { id: string }) => p.id === 'gmaps_scraper',
      );
    expect(await providers()).toMatchObject({
      status: 'unavailable',
      licensing: { commercialUseAllowed: false },
    });

    await admin.post('/v1/discovery/scraper/acknowledgement', { warningVersion: 1 }).expect(403);
    await boss.post('/v1/discovery/scraper/acknowledgement', { warningVersion: 99 }).expect(403);
    const acknowledged = await boss
      .post('/v1/discovery/scraper/acknowledgement', { warningVersion: 1 })
      .expect(200);
    expect(acknowledged.body).toMatchObject({ deployed: true, flagEnabled: false, allowed: false });
    expect(acknowledged.body.acknowledgement).toMatchObject({
      warningVersion: 1,
      userId: expect.any(String),
    });
    expect(await providers()).toMatchObject({ status: 'unavailable' });

    await boss.patch('/v1/workspace/settings', { features: { mapsScraper: true } }).expect(200);
    expect((await boss.get('/v1/discovery/scraper').expect(200)).body.allowed).toBe(true);
    expect(await providers()).toMatchObject({ status: 'ready' });

    const audit = await boss.get('/v1/audit-logs?action=discovery.scraper_tos_').expect(200);
    expect(audit.body.items[0]).toMatchObject({ action: 'discovery.scraper_tos_acknowledged' });

    const revoked = await boss.delete('/v1/discovery/scraper/acknowledgement').expect(200);
    expect(revoked.body).toMatchObject({ acknowledgement: null, allowed: false });
    expect(await providers()).toMatchObject({ status: 'unavailable' });
  });
});
