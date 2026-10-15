import type { DbClient } from '@bf/db';
import {
  auditLogs,
  businessCategories,
  businessContacts,
  businesses,
  businessHours,
  businessMedia,
  businessSources,
  categories,
  orgBusinesses,
  outboxEvents,
} from '@bf/db/schema';
import { aBusiness, aContact, aSourceRecord, fakeUuidV7 } from '@bf/testing';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../../../test/create-test-app.ts';
import { FakeMailer } from '../../../test/fake-mailer.ts';
import {
  type Browser,
  createWorkspace,
  inviteAndJoin,
  signUpVerified,
} from '../../../test/identity-helpers.ts';
import { DB_CLIENT } from '../platform/db/db.module.ts';
import {
  BUSINESS_REPOSITORY,
  type BusinessRepository,
  SOURCE_RECORD_REPOSITORY,
  type SourceRecordRepository,
} from './application/ports.ts';
import { ConcurrentModificationError } from './domain/errors.ts';
import { PhoneNumber } from './domain/value-objects/phone-number.ts';

const mailer = new FakeMailer();
let t: TestApp;
let db: DbClient;
let owner: Browser;
let viewer: Browser;
let outsider: Browser;
let orgId: string;

const MANUAL = {
  displayName: 'La Case Gourmande SARL',
  countryCode: 'BL',
  websiteUrl: 'HTTP://WWW.Case-Gourmande.Example.COM/?utm_source=flyer',
  phone: '0590 27 12 34',
  email: 'Bonjour@Case-Gourmande.example',
  formattedAddress: '12 Rue du Port',
  locality: 'Gustavia',
  postalCode: '97133',
  location: { lat: 17.89618, lng: -62.84983 },
};

/** Inserts factory rows directly (global facts that discovery would normally create). */
async function insertBusiness(overrides: Parameters<typeof aBusiness>[0] = {}) {
  const business = aBusiness(overrides);
  await db.insert(businesses).values(business);
  return business;
}

beforeAll(async () => {
  t = await createTestApp({ mailer, valkeyDb: 12 });
  db = t.app.get(DB_CLIENT);
  owner = await signUpVerified(t, mailer, 'owner@bg.test', 'Olive Owner');
  orgId = await createWorkspace(owner, 'Agence Gustavia');
  viewer = (await inviteAndJoin(t, mailer, owner, 'viewer@bg.test', 'viewer')).client;
  outsider = await signUpVerified(t, mailer, 'outsider@bg.test', 'Other Owner');
  await createWorkspace(outsider, 'Elsewhere');
});

afterAll(async () => {
  await t?.close();
});

describe('POST /v1/businesses (manual add)', () => {
  it('creates a golden record with manual provenance, a source record and the workspace link', async () => {
    const res = await owner.post('/v1/businesses', MANUAL);
    expect(res.status).toBe(201);
    const id: string = res.body.id;
    expect(res.body).toMatchObject({
      displayName: 'La Case Gourmande SARL',
      operatingStatus: 'operational',
      websiteUrl: 'http://www.case-gourmande.example.com/',
      primaryPhone: '+590590271234',
      locality: 'Gustavia',
      postalCode: '97133',
      countryCode: 'BL',
      location: MANUAL.location,
      formattedAddress: '12 Rue du Port',
      pipelineStatus: 'new',
      orgState: { pipelineStatus: 'new', addedVia: 'manual', doNotContact: false },
      version: 1,
      categories: [],
      hours: [],
      media: [],
    });
    expect(res.body.attributes.primaryPhone).toMatchObject({
      value: '+590590271234',
      source: 'manual',
      confidence: 1,
    });
    expect(
      res.body.contacts.map((c: { type: string; normalizedValue: string; subtype: string }) => c),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'email',
          normalizedValue: 'bonjour@case-gourmande.example',
          subtype: 'generic',
        }),
        expect.objectContaining({ type: 'phone', normalizedValue: '+590590271234', subtype: 'landline' }),
      ]),
    );

    const [row] = await db
      .select({
        normalizedName: businesses.normalizedName,
        lat: sql<number>`ST_Y(${businesses.location}::geometry)`,
        lng: sql<number>`ST_X(${businesses.location}::geometry)`,
      })
      .from(businesses)
      .where(eq(businesses.id, id));
    expect(row).toEqual({
      normalizedName: 'la case gourmande',
      lat: MANUAL.location.lat,
      lng: MANUAL.location.lng,
    });

    const sources = await db.select().from(businessSources).where(eq(businessSources.businessId, id));
    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({
      provider: 'manual',
      linkedBy: 'manual',
      matchConfidence: 1,
      submittedByOrgId: orgId,
    });
    // Attribution stays internal: contacts carry it in the database, never in responses.
    const contactRows = await db.select().from(businessContacts).where(eq(businessContacts.businessId, id));
    expect(contactRows.map((c) => c.submittedByOrgId)).toEqual([orgId, orgId]);
    expect(JSON.stringify(res.body)).not.toContain(orgId);
    expect(res.body.attributes.displayName.sourceRef).toBe(sources[0]?.id);

    const events = await db
      .select()
      .from(outboxEvents)
      .where(sql`${outboxEvents.payload}->>'businessId' = ${id}`);
    expect(events.map((e) => e.type)).toEqual(['business.created']);
    expect(events[0]).toMatchObject({ organizationId: orgId, payload: { businessId: id, source: 'manual' } });

    const audit = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, 'business.created'), eq(auditLogs.entityId, id)));
    expect(audit).toHaveLength(1);
    expect(audit[0]?.organizationId).toBe(orgId);
  });

  it('needs business:write and valid values', async () => {
    await viewer.post('/v1/businesses', MANUAL).expect(403);
    await owner.post('/v1/businesses', { ...MANUAL, displayName: '' }).expect(422);
    const badPhone = await owner.post('/v1/businesses', { ...MANUAL, phone: '123' }).expect(422);
    expect(badPhone.body).toMatchObject({ reason: 'INVALID_PHONE' });
    const nullIsland = await owner
      .post('/v1/businesses', { ...MANUAL, location: { lat: 0, lng: 0 } })
      .expect(422);
    expect(nullIsland.body).toMatchObject({ reason: 'INVALID_LOCATION' });
  });
});

describe('GET /v1/businesses/:id', () => {
  it('returns 404 unless the workspace tracks the business, and 400 for malformed ids', async () => {
    const business = await insertBusiness();
    await owner.get(`/v1/businesses/${business.id}`).expect(404);
    await outsider.get(`/v1/businesses/${business.id}`).expect(404);
    await owner.get('/v1/businesses/not-a-uuid').expect(400);
  });

  it('joins contacts, categories, hours and media; viewers can read', async () => {
    const business = await insertBusiness();
    const [category] = await db
      .insert(categories)
      .values({
        slug: `cafe_${business.id.slice(-6)}`,
        path: 'food_drink.cafe',
        labels: { en: 'Café', fr: 'Café' },
      })
      .returning();
    if (!category) throw new Error('no category');
    await db.insert(businessCategories).values({
      businessId: business.id,
      categoryId: category.id,
      isPrimary: true,
      confidence: 0.92,
      source: 'google_places',
    });
    await db.insert(businessHours).values([
      { businessId: business.id, weekday: 0, opensAt: '08:00', closesAt: '12:30', source: 'google_places' },
      { businessId: business.id, weekday: 0, opensAt: '15:00', closesAt: '19:00', source: 'google_places' },
    ]);
    await db.insert(businessMedia).values({
      businessId: business.id,
      kind: 'logo',
      externalUrl: 'https://cdn.example/logo.png',
      source: 'website',
      license: 'owner_site',
    });
    await db.insert(businessContacts).values(aContact({ businessId: business.id }));
    await owner.post(`/v1/businesses/${business.id}/track`, { addedVia: 'search' }).expect(201);

    const res = await viewer.get(`/v1/businesses/${business.id}`).expect(200);
    expect(res.body).toMatchObject({
      id: business.id,
      displayName: business.displayName,
      location: business.location,
      ratingAvg: business.ratingAvg,
      orgState: { addedVia: 'search' },
      categories: [{ categoryId: category.id, isPrimary: true, confidence: expect.closeTo(0.92, 5) }],
      hours: [
        { weekday: 0, opensAt: '08:00', closesAt: '12:30' },
        { weekday: 0, opensAt: '15:00', closesAt: '19:00' },
      ],
      media: [{ kind: 'logo', license: 'owner_site', url: 'https://cdn.example/logo.png' }],
    });
    expect(res.body.contacts).toHaveLength(1);
  });
});

describe('POST /v1/businesses/:id/track', () => {
  it('is idempotent per workspace and makes the business visible to it', async () => {
    const business = await insertBusiness();
    const first = await outsider.post(`/v1/businesses/${business.id}/track`, {}).expect(201);
    expect(first.body).toMatchObject({ pipelineStatus: 'new', addedVia: 'manual', doNotContact: false });
    const again = await outsider
      .post(`/v1/businesses/${business.id}/track`, { addedVia: 'search' })
      .expect(200);
    expect(again.body).toEqual(first.body);
    await outsider.get(`/v1/businesses/${business.id}`).expect(200);
    await owner.get(`/v1/businesses/${business.id}`).expect(404);
    const audit = await db
      .select({ action: auditLogs.action, metadata: auditLogs.metadata })
      .from(auditLogs)
      .where(eq(auditLogs.entityId, business.id));
    expect(audit).toEqual([{ action: 'business.tracked', metadata: { addedVia: 'manual' } }]);
  });

  it('needs business:write; unknown businesses are 404, merged ones 409', async () => {
    const business = await insertBusiness();
    await viewer.post(`/v1/businesses/${business.id}/track`, {}).expect(403);
    await owner.post(`/v1/businesses/${fakeUuidV7()}/track`, {}).expect(404);
    const merged = await insertBusiness({ mergedIntoId: business.id });
    const res = await owner.post(`/v1/businesses/${merged.id}/track`, {}).expect(409);
    expect(res.body).toMatchObject({ code: 'CONFLICT', reason: 'BUSINESS_MERGED' });
  });
});

describe('contacts', () => {
  it('lists and adds manual contacts; the same contact again returns the existing one', async () => {
    const business = await insertBusiness({ primaryPhoneE164: null });
    await owner.post(`/v1/businesses/${business.id}/track`, {}).expect(201);
    expect((await viewer.get(`/v1/businesses/${business.id}/contacts`).expect(200)).body).toEqual({
      items: [],
    });

    const added = await owner
      .post(`/v1/businesses/${business.id}/contacts`, { type: 'phone', value: '0690 55 12 34' })
      .expect(201);
    expect(added.body).toMatchObject({
      type: 'phone',
      value: '0690 55 12 34',
      normalizedValue: '+590690551234',
      subtype: 'mobile',
      source: 'manual',
      confidence: 1,
      verificationStatus: 'unknown',
      personName: null,
    });
    const again = await owner
      .post(`/v1/businesses/${business.id}/contacts`, { type: 'phone', value: '+590 690 55 12 34' })
      .expect(201);
    expect(again.body.id).toBe(added.body.id);
    const list = await viewer.get(`/v1/businesses/${business.id}/contacts`).expect(200);
    expect(list.body.items).toHaveLength(1);

    const [row] = await db
      .select({ version: businesses.version })
      .from(businesses)
      .where(eq(businesses.id, business.id));
    // Contacts are upserted on their own key: adding one leaves the business row (and version) as it was.
    expect(row?.version).toBe(1);
    const events = await db
      .select({ type: outboxEvents.type, payload: outboxEvents.payload })
      .from(outboxEvents)
      .where(sql`${outboxEvents.payload}->>'businessId' = ${business.id}`);
    expect(events).toEqual([
      { type: 'business.updated', payload: { businessId: business.id, fields: ['contacts'] } },
    ]);
  });

  it('scopes to tracked businesses, checks permissions and validates values', async () => {
    const business = await insertBusiness();
    await owner.post(`/v1/businesses/${business.id}/track`, {}).expect(201);
    await outsider.get(`/v1/businesses/${business.id}/contacts`).expect(404);
    await outsider
      .post(`/v1/businesses/${business.id}/contacts`, { type: 'email', value: 'a@b.example' })
      .expect(404);
    await viewer
      .post(`/v1/businesses/${business.id}/contacts`, { type: 'email', value: 'a@b.example' })
      .expect(403);
    const bad = await owner
      .post(`/v1/businesses/${business.id}/contacts`, { type: 'social', value: 'https://example.org/me' })
      .expect(422);
    expect(bad.body).toMatchObject({ reason: 'INVALID_SOCIAL' });
    // Contacts are shared facts: person names are not accepted (the field is dropped).
    const named = await owner
      .post(`/v1/businesses/${business.id}/contacts`, {
        type: 'email',
        value: 'x@y.example',
        personName: 'Jane',
      })
      .expect(201);
    expect(named.body.personName).toBeNull();
  });
});

describe('GET /v1/businesses', () => {
  it('pages through tracked businesses, newest first, without duplicates', async () => {
    const tracker = await signUpVerified(t, mailer, 'pager@bg.test', 'Page Owner');
    await createWorkspace(tracker, 'Pager');
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const business = await insertBusiness();
      await tracker.post(`/v1/businesses/${business.id}/track`, {}).expect(201);
      ids.push(business.id);
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const query: string = cursor ? `?limit=1&cursor=${encodeURIComponent(cursor)}` : '?limit=1';
      const page = await tracker.get(`/v1/businesses${query}`).expect(200);
      seen.push(...page.body.items.map((item: { id: string }) => item.id));
      cursor = page.body.nextCursor;
    } while (cursor);
    expect(seen).toEqual([...ids].reverse());
    await tracker.get('/v1/businesses?cursor=garbage').expect(422);
  });

  it('breaks ties between businesses tracked in the same microsecond by id', async () => {
    const tracker = await signUpVerified(t, mailer, 'ties@bg.test', 'Tie Owner');
    const trackerOrg = await createWorkspace(tracker, 'Ties');
    const at = new Date('2026-10-01T12:00:00.123Z');
    const tied = [await insertBusiness(), await insertBusiness(), await insertBusiness()];
    await db.insert(orgBusinesses).values(
      tied.map((b) => ({
        organizationId: trackerOrg,
        businessId: b.id,
        addedVia: 'search' as const,
        createdAt: at,
      })),
    );
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const query: string = cursor ? `?limit=2&cursor=${encodeURIComponent(cursor)}` : '?limit=2';
      const page = await tracker.get(`/v1/businesses${query}`).expect(200);
      seen.push(...page.body.items.map((item: { id: string }) => item.id));
      cursor = page.body.nextCursor;
    } while (cursor);
    expect(seen).toEqual(
      tied
        .map((b) => b.id)
        .sort()
        .reverse(),
    );
  });
});

describe('repositories', () => {
  it('round-trips aggregates and rejects stale saves (optimistic concurrency)', async () => {
    const repository = t.app.get<BusinessRepository>(BUSINESS_REPOSITORY);
    const stored = await insertBusiness();
    const loaded = await repository.getById(stored.id);
    expect(loaded?.snapshot()).toMatchObject({
      id: stored.id,
      location: stored.location,
      ratingAvg: stored.ratingAvg,
      attributes: stored.attributes,
      version: 1,
    });

    const a = await repository.getById(stored.id);
    const b = await repository.getById(stored.id);
    if (!a || !b) throw new Error('not found');
    const observedAt = new Date();
    a.updateField(
      { field: 'primaryPhone', value: PhoneNumber.parse('+590590000001') },
      {
        source: 'manual',
        sourceRef: null,
        confidence: 1,
        observedAt,
      },
    );
    b.updateField(
      { field: 'priceLevel', value: 1 },
      { source: 'manual', sourceRef: null, confidence: 1, observedAt },
    );
    await repository.save(a);
    expect(a.version).toBe(2);
    const stale = repository.save(b);
    await expect(stale).rejects.toBeInstanceOf(ConcurrentModificationError);
    await expect(stale).rejects.toMatchObject({ httpStatus: 409 });
    expect((await repository.getById(stored.id))?.snapshot()).toMatchObject({
      primaryPhoneE164: '+590590000001',
      priceLevel: stored.priceLevel,
      version: 2,
    });
    expect(await repository.getByIds([stored.id, fakeUuidV7()])).toHaveLength(1);
  });

  it('adds contacts concurrently without version conflicts', async () => {
    const repository = t.app.get<BusinessRepository>(BUSINESS_REPOSITORY);
    const stored = await insertBusiness();
    const [a, b] = await Promise.all([repository.getById(stored.id), repository.getById(stored.id)]);
    if (!a || !b) throw new Error('not found');
    a.addContact({
      id: fakeUuidV7(),
      type: 'email',
      value: 'hello@shop.example',
      source: 'website',
      confidence: 0.7,
    });
    b.addContact({
      id: fakeUuidV7(),
      type: 'email',
      value: 'HELLO@shop.example',
      source: 'website',
      sourceUrl: 'https://shop.example.com/contact',
      publishedOnSite: true,
      confidence: 0.9,
    });
    await Promise.all([repository.save(a), repository.save(b)]);
    const rows = await db.select().from(businessContacts).where(eq(businessContacts.businessId, stored.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      confidence: expect.closeTo(0.9, 5),
      publishedOnSite: true,
      sourceUrl: 'https://shop.example.com/contact',
    });
    const [row] = await db
      .select({ version: businesses.version })
      .from(businesses)
      .where(eq(businesses.id, stored.id));
    expect(row?.version).toBe(1);
  });

  it('updates rows inserted outside the repository (version 0)', async () => {
    const repository = t.app.get<BusinessRepository>(BUSINESS_REPOSITORY);
    const stored = await insertBusiness({ version: 0 });
    const business = await repository.getById(stored.id);
    if (!business) throw new Error('not found');
    business.updateField(
      { field: 'priceLevel', value: 4 },
      {
        source: 'manual',
        sourceRef: null,
        confidence: 1,
        observedAt: new Date(),
      },
    );
    await repository.save(business);
    expect((await repository.getById(stored.id))?.snapshot()).toMatchObject({ priceLevel: 4, version: 1 });
  });

  it('upserts source records by provider ref, detects unchanged content and finds the linked business', async () => {
    const sources = t.app.get<SourceRecordRepository>(SOURCE_RECORD_REPOSITORY);
    const repository = t.app.get<BusinessRepository>(BUSINESS_REPOSITORY);
    const business = await insertBusiness();
    const record = aSourceRecord({ businessId: business.id });
    expect((await sources.upsert(record)).changed).toBe(true);
    const refetched = await sources.upsert({ ...record, id: fakeUuidV7(), fetchedAt: new Date() });
    expect(refetched.changed).toBe(false);
    expect(refetched.record.id).toBe(record.id);
    const changed = await sources.upsert({
      ...record,
      payload: { different: true },
      contentHash: 'sha256:other',
    });
    expect(changed.changed).toBe(true);
    expect(changed.record.payload).toEqual({ different: true });
    expect(changed.record.businessId).toBe(business.id);
    expect((await repository.findBySourceRef('google_places', record.providerRef))?.id).toBe(business.id);
    expect(await repository.findBySourceRef('google_places', 'unknown-ref')).toBeUndefined();
    expect(await sources.listByBusiness(business.id)).toHaveLength(1);
  });
});
