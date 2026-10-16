import type { SourceRecordInput } from '@bf/contracts';
import { runInTransaction } from '@bf/db';
import { loadTaxonomy, seedTaxonomy } from '@bf/db/seed';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../../../test/create-test-app.ts';
import { DB_CLIENT } from '../platform/db/db.module.ts';
import { IngestBatchCommand } from './application/resolution/ingest-batch.command.ts';

// Throughput benchmark (BF-016): `pnpm --filter @bf/api bench:ingest`. Skipped in normal runs.
const RUN = process.env.BF_BENCH === '1';
const RECORDS = Number(process.env.BF_BENCH_RECORDS ?? 1_200);

let t: TestApp;

/** Synthetic places on a grid over Saint-Barth-sized area; ~3 providers per place, some partial. */
function syntheticRecords(count: number): SourceRecordInput[] {
  const cuisines = [
    'restaurant',
    'cafe',
    'bar',
    'bakery',
    'hair_salon',
    'hardware_store',
    'pharmacy',
    'florist',
  ];
  const records: SourceRecordInput[] = [];
  for (let i = 0; records.length < count; i++) {
    const lat = 17.87 + (i % 40) * 0.0015;
    const lng = -62.88 + Math.floor(i / 40) * 0.0015;
    const phone = `+590590${String(200000 + i).slice(-6)}`;
    const type = cuisines[i % cuisines.length] as string;
    const base = { fetchedAt: '2026-10-01T10:00:00.000Z', location: { lat, lng } };
    records.push({
      ...base,
      provider: 'google_places',
      providerRef: `bench-g-${i}`,
      name: `Bench Place ${i} ${type.replace('_', ' ')}`,
      providerCategories: [{ key: type }],
      phones: [phone],
      website: `https://bench-place-${i}.com`,
      address: { line1: `${i} Rue des Bancs`, city: 'Gustavia', postalCode: '97133', countryCode: 'BL' },
    });
    records.push({
      ...base,
      provider: 'overture',
      providerRef: `bench-o-${i}`,
      name: `Bench Place ${i}`,
      providerCategories: [{ key: type }],
      phones: [phone],
    });
    if (i % 2 === 0) {
      records.push({
        ...base,
        provider: 'osm',
        providerRef: `bench-n-${i}`,
        name: `Bench Place ${i}`,
        phones: [phone],
      });
    }
  }
  // Interleave providers like a real discovery run.
  return records.slice(0, count).sort((a, b) => (a.providerRef > b.providerRef ? 1 : -1));
}

beforeAll(async () => {
  if (!RUN) return;
  t = await createTestApp({ valkeyDb: 15 });
  await runInTransaction(t.app.get(DB_CLIENT), (tx) => seedTaxonomy(tx, loadTaxonomy()));
});

afterAll(async () => {
  await t?.close();
});

it.runIf(RUN)(
  `ingests ${RECORDS} synthetic records at ≥ 1,000 records/minute`,
  async () => {
    const records = syntheticRecords(RECORDS);
    const batch = t.app.get(IngestBatchCommand);
    const started = performance.now();
    for (let i = 0; i < records.length; i += 100) {
      const { counts } = await batch.execute(records.slice(i, i + 100), { classifyWithModel: false });
      expect(counts.failed).toBe(0);
    }
    const seconds = (performance.now() - started) / 1000;
    const perMinute = Math.round((records.length / seconds) * 60);
    console.log(
      `BENCH ingest: ${records.length} records in ${seconds.toFixed(1)} s → ${perMinute} records/minute`,
    );
    expect(perMinute).toBeGreaterThanOrEqual(1_000);
  },
  600_000,
);
