import type { SourceRecordInput } from '@bf/contracts';
import { type DbClient, runInTransaction } from '@bf/db';
import {
  businessContacts,
  businesses,
  businessSources,
  outboxEvents,
  possibleDuplicates,
} from '@bf/db/schema';
import { loadTaxonomy, seedTaxonomy } from '@bf/db/seed';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../../../test/create-test-app.ts';
import { DB_CLIENT } from '../platform/db/db.module.ts';
import { IngestBatchCommand } from './application/resolution/ingest-batch.command.ts';
import { IngestSourceRecordCommand } from './application/resolution/ingest-source-record.command.ts';

let t: TestApp;
let db: DbClient;
let ingest: IngestSourceRecordCommand;

/** A fake Saint-Barth place seen by several providers. `n` keeps places apart (coordinates, phone, names). */
function place(n: number, offset = 0) {
  const lat = 17.89 + n * 0.01 + offset;
  const lng = -62.85 - n * 0.01;
  // Offsets are separate copies of the place (order-independence runs): their own phone and site too.
  const v = Math.round(offset * 10);
  const phone = `+590590${String(100000 + n * 100 + v).slice(-6)}`;
  const site = v === 0 ? `tamarin-${n}` : `tamarin-${n}-${v}`;
  const common = { fetchedAt: '2026-10-01T10:00:00.000Z' };
  return {
    google: {
      ...common,
      provider: 'google_places',
      providerRef: `g-${n}-${offset}`,
      name: `Le Tamarin ${n}`,
      providerCategories: [{ key: 'restaurant' }],
      location: { lat, lng },
      address: { line1: 'Route de Saline', city: 'Saint-Jean', postalCode: '97133', countryCode: 'BL' },
      phones: [phone],
      website: `https://www.${site}.com/`,
      rating: 4.5,
      reviewCount: 200,
      operatingStatus: 'operational',
    },
    overture: {
      ...common,
      provider: 'overture',
      providerRef: `o-${n}-${offset}`,
      name: `Tamarin ${n} Restaurant`,
      providerCategories: [{ key: 'restaurant' }],
      location: { lat: lat + 0.0001, lng: lng + 0.0001 },
      address: { formatted: 'Route de Saline, Saint-Jean', countryCode: 'BL' },
      phones: [phone],
      emails: [`info@${site}.com`],
    },
    osm: {
      ...common,
      provider: 'osm',
      providerRef: `n/${n}-${offset}`,
      name: `Tamarin ${n}`,
      providerCategories: [{ key: 'amenity=restaurant' }],
      location: { lat: lat - 0.0001, lng },
      website: `https://${site}.com`,
      // Every pair shares strong evidence: matching is order-independent then. (A chain where only a third record
      // links two others yields a possible duplicate in some orders — see the ticket notes.)
      phones: [phone],
      hours: [{ weekday: 0, opensAt: '12:00', closesAt: '15:00' }],
    },
  } satisfies Record<string, SourceRecordInput>;
}

const golden = async (businessId: string) => {
  const [row] = await db.select().from(businesses).where(eq(businesses.id, businessId));
  return row;
};

beforeAll(async () => {
  t = await createTestApp({ valkeyDb: 14 });
  db = t.app.get(DB_CLIENT);
  ingest = t.app.get(IngestSourceRecordCommand);
  await runInTransaction(db, (tx) => seedTaxonomy(tx, loadTaxonomy()));
});

afterAll(async () => {
  await t?.close();
});

describe('ingestion', () => {
  it('creates, then is idempotent for the same content', async () => {
    const { google } = place(1);
    const first = await ingest.execute(google);
    expect(first).toMatchObject({ outcome: 'created', possibleDuplicates: [] });
    expect(await ingest.execute(google)).toMatchObject({
      outcome: 'unchanged',
      businessId: first.businessId,
    });
    const refetched = await ingest.execute({ ...google, fetchedAt: '2026-10-05T10:00:00.000Z' });
    expect(refetched.outcome).toBe('unchanged');
    const [source] = await db
      .select()
      .from(businessSources)
      .where(eq(businessSources.providerRef, google.providerRef));
    expect(source?.fetchedAt.toISOString()).toBe('2026-10-05T10:00:00.000Z');
    const row = await golden(first.businessId);
    expect(row).toMatchObject({
      displayName: 'Le Tamarin 1',
      primaryPhoneE164: '+590590100100',
      websiteRegistrableDomain: 'tamarin-1.com',
      ratingAvg: 4.5,
      operatingStatus: 'operational',
    });
    expect(row?.primaryCategoryId).not.toBeNull();
  });

  it('merges the same place from other providers, applying survivorship and unioning contacts', async () => {
    const { google, overture, osm } = place(2);
    const created = await ingest.execute(google);
    const fromOverture = await ingest.execute(overture);
    const fromOsm = await ingest.execute(osm);
    expect(fromOverture).toMatchObject({ outcome: 'merged', businessId: created.businessId });
    expect(fromOverture.score?.reasons).toContain('same phone number');
    expect(fromOsm).toMatchObject({ outcome: 'merged', businessId: created.businessId });
    const row = await golden(created.businessId);
    expect(row).toMatchObject({ displayName: 'Le Tamarin 2', location: google.location });
    expect(row?.attributes.displayName).toMatchObject({
      source: 'google_places',
      sourceRef: google.providerRef,
    });
    const contacts = await db
      .select({ type: businessContacts.type, value: businessContacts.normalizedValue })
      .from(businessContacts)
      .where(eq(businessContacts.businessId, created.businessId));
    expect(contacts).toEqual(
      expect.arrayContaining([
        { type: 'phone', value: '+590590100200' },
        { type: 'email', value: 'info@tamarin-2.com' },
      ]),
    );
    const sources = await db
      .select()
      .from(businessSources)
      .where(eq(businessSources.businessId, created.businessId));
    expect(sources.map((s) => s.provider).sort()).toEqual(['google_places', 'osm', 'overture']);
    const events = await db
      .select({ type: outboxEvents.type, payload: outboxEvents.payload })
      .from(outboxEvents)
      .where(sql`${outboxEvents.payload}->>'businessId' = ${created.businessId}`);
    expect(events[0]?.type).toBe('business.created');
    expect(events.slice(1).every((e) => e.type === 'business.updated')).toBe(true);
  });

  it('never lets a provider overwrite a manual value', async () => {
    const { google } = place(3);
    const manual: SourceRecordInput = {
      provider: 'manual',
      providerRef: 'manual-3',
      fetchedAt: '2026-09-01T10:00:00.000Z',
      name: 'Tamarin 3 (officiel)',
      location: google.location,
      phones: [google.phones[0] as string],
    };
    const created = await ingest.execute(manual, { classifyWithModel: false });
    const merged = await ingest.execute(google);
    expect(merged.businessId).toBe(created.businessId);
    const row = await golden(created.businessId);
    expect(row).toMatchObject({
      displayName: 'Tamarin 3 (officiel)',
      websiteRegistrableDomain: 'tamarin-3.com',
    });
    expect(row?.attributes.displayName?.source).toBe('manual');
  });

  it('flags look-alikes without strong evidence as possible duplicates, with reasons', async () => {
    const base = place(4).google;
    const created = await ingest.execute({ ...base, phones: [], website: undefined });
    const lookAlike = await ingest.execute({
      ...base,
      provider: 'foursquare',
      providerRef: 'fsq-4',
      name: 'Tamarin 4',
      phones: [],
      website: undefined,
      location: { lat: base.location.lat + 0.0003, lng: base.location.lng },
    });
    expect(lookAlike).toMatchObject({
      outcome: 'possible_duplicate',
      possibleDuplicates: [created.businessId],
    });
    const [pair] = await db
      .select()
      .from(possibleDuplicates)
      .where(
        and(
          inArray(possibleDuplicates.businessAId, [created.businessId, lookAlike.businessId]),
          inArray(possibleDuplicates.businessBId, [created.businessId, lookAlike.businessId]),
        ),
      );
    expect(pair).toMatchObject({ status: 'open' });
    expect(pair?.score).toBeGreaterThanOrEqual(0.6);
    expect((pair?.reasons as { reasons: string[] } | undefined)?.reasons.join(' ')).toMatch(
      /name similarity/,
    );
  });

  it('gives the same golden values whatever the ingestion order', async () => {
    const orders = [
      ['google', 'overture', 'osm'],
      ['google', 'osm', 'overture'],
      ['overture', 'google', 'osm'],
      ['overture', 'osm', 'google'],
      ['osm', 'google', 'overture'],
      ['osm', 'overture', 'google'],
    ] as const;
    const results = [];
    for (const [index, order] of orders.entries()) {
      // Same place shape, moved far apart per order so runs never interact.
      const records = place(5, index * 0.5);
      let businessId = '';
      for (const key of order) businessId = (await ingest.execute(records[key])).businessId;
      const row = await golden(businessId);
      results.push({
        displayName: row?.displayName,
        // Each copy has its own phone and site (last digits / suffix): compare their shape.
        phone: row?.primaryPhoneE164?.slice(0, -2),
        website: row?.websiteUrl?.replace(/tamarin-5(-\d+)?/, 'tamarin-5'),
        rating: row?.ratingAvg,
        status: row?.operatingStatus,
        address: row?.formattedAddress,
        category: row?.primaryCategoryId,
        sources: (await db.select().from(businessSources).where(eq(businessSources.businessId, businessId)))
          .length,
      });
    }
    for (const result of results) expect(result).toEqual(results[0]);
    expect(results[0]?.sources).toBe(3);
  });
});

describe('IngestBatchCommand', () => {
  it('isolates failing records and counts outcomes', async () => {
    const { google, overture } = place(6);
    const result = await t.app
      .get(IngestBatchCommand)
      .execute([
        google,
        { ...google, name: '   ', providerRef: 'bad' } as SourceRecordInput,
        overture,
        google,
      ]);
    expect(result.counts).toEqual({ created: 1, merged: 1, possible_duplicate: 0, unchanged: 1, failed: 1 });
    expect(result.results[1]).toMatchObject({
      outcome: 'failed',
      providerRef: 'bad',
      code: 'VALIDATION_FAILED',
    });
  });

  it('creates no duplicates when four workers ingest overlapping batches concurrently', async () => {
    const places = Array.from({ length: 10 }, (_, i) => place(100 + i));
    const records = places.flatMap((p) => [p.google, p.overture, p.osm]);
    const shuffle = (seed: number) =>
      [...records].sort(
        (a, b) =>
          ((a.providerRef.length * seed + a.providerRef.charCodeAt(2)) % 7) -
          ((b.providerRef.length * seed + b.providerRef.charCodeAt(2)) % 7),
      );
    const batch = t.app.get(IngestBatchCommand);
    const runs = await Promise.all([1, 2, 3, 4].map((seed) => batch.execute(shuffle(seed))));
    expect(runs.map((r) => r.counts.failed)).toEqual([0, 0, 0, 0]);
    const linked = await db
      .select({ businessId: businessSources.businessId })
      .from(businessSources)
      .where(
        inArray(
          businessSources.providerRef,
          records.map((r) => r.providerRef),
        ),
      );
    const distinct = new Set(linked.map((l) => l.businessId));
    expect(linked).toHaveLength(30);
    expect(distinct.size).toBe(10);
  });
});
