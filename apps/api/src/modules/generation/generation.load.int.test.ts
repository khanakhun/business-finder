import { writeFileSync } from 'node:fs';
import type { DbClient } from '@bf/db';
import {
  businesses,
  generationAttempts,
  generationEvents,
  generationJobs,
  orgBusinesses,
} from '@bf/db/schema';
import { aBusiness } from '@bf/testing';
import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createTestApp, createTestWorker } from '../../../test/create-test-app.ts';
import { FakeMailer } from '../../../test/fake-mailer.ts';
import { createWorkspace, signUpVerified } from '../../../test/identity-helpers.ts';
import { DB_CLIENT } from '../platform/db/db.module.ts';
import { InMemoryObjectStorage } from '../platform/storage/object-storage.ts';
import { GENERATION_ARTIFACTS } from './application/ports.ts';

// Load (BF-039; `GENERATION_LOAD=1 pnpm test:int`, not in CI): a 50-job batch on the fake engine at a realistic
// duration, reporting the orchestration overhead per job (its wall time beyond the engine's) and the event-write rate.

const ENGINE_MS = 2_000;
const JOBS = 50;
const ENV = {
  SITES_BASE_DOMAIN: 'sites.test',
  SITES_ASSETS_BASE_URL: 'https://assets.bf-sites.test',
  GENERATION_FAKE_ENGINE: 'true',
  GENERATION_FAKE_DURATION_MS: String(ENGINE_MS),
  GENERATION_MAX_SANDBOXES: '8',
};

describe.skipIf(!process.env.GENERATION_LOAD)('generation load', () => {
  it(`runs ${JOBS} jobs and records the overhead`, async () => {
    const store = new InMemoryObjectStorage();
    const overrides = [
      {
        token: GENERATION_ARTIFACTS,
        value: {
          put: (k: string, b: Buffer, t: string) => store.put(k, b, t),
          get: async (k: string) => (await store.get(k))?.body,
        },
      },
    ];
    const mailer = new FakeMailer();
    const t = await createTestApp({ mailer, valkeyDb: 24, env: ENV, overrides });
    const worker = await createTestWorker(t, { mailer, env: ENV, overrides });
    try {
      const db = t.app.get<DbClient>(DB_CLIENT);
      const member = await signUpVerified(t, mailer, 'load@gen.test', 'Load');
      const org = await createWorkspace(member, 'Load');
      const ids: string[] = [];
      for (let i = 0; i < JOBS; i++) {
        const row = aBusiness({ displayName: `Load ${i}`, locality: 'G' });
        await db.insert(businesses).values(row);
        await db
          .insert(orgBusinesses)
          .values({ organizationId: org, businessId: row.id, addedVia: 'search' });
        ids.push(row.id);
      }
      const started = Date.now();
      const { body } = await member
        .post('/v1/generation-batches', { items: ids.map((businessId) => ({ businessId, engine: 'fake' })) })
        .expect(201);
      for (;;) {
        const [row] = await db
          .select({ n: sql<number>`count(*)::int` })
          .from(generationJobs)
          .where(
            sql`${generationJobs.batchId} = ${body.id} AND ${generationJobs.status} IN ('succeeded', 'needs_review', 'failed', 'cancelled')`,
          );
        if ((row?.n ?? 0) === JOBS) break;
        if (Date.now() - started > 600_000) throw new Error('load test timed out');
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      const wall = (Date.now() - started) / 1000;
      // Per attempt: its run beyond the engine's own time (prepare, event writes, quality and hand-off excluded).
      const attempts = await db
        .select({
          ms: sql<number>`extract(epoch from (${generationAttempts.finishedAt} - ${generationAttempts.startedAt})) * 1000`,
        })
        .from(generationAttempts)
        .innerJoin(generationJobs, eq(generationJobs.id, generationAttempts.jobId))
        .where(eq(generationJobs.batchId, body.id));
      const overhead = attempts.map((a) => Number(a.ms) - ENGINE_MS).sort((a, b) => a - b);
      const [events] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(generationEvents)
        .innerJoin(generationJobs, eq(generationJobs.id, generationEvents.jobId))
        .where(eq(generationJobs.batchId, body.id));
      const report = {
        jobs: JOBS,
        engineMs: ENGINE_MS,
        sandboxes: 8,
        wallSeconds: wall,
        idealSeconds: Math.ceil(JOBS / 4) * (ENGINE_MS / 1000),
        attemptOverheadMs: {
          p50: overhead[Math.floor(overhead.length / 2)],
          p95: overhead[Math.floor(overhead.length * 0.95)],
        },
        events: events?.n ?? 0,
        eventsPerSecond: Math.round((events?.n ?? 0) / wall),
      };
      writeFileSync(
        new URL('../../../../../.deploy-test/generation-load.json', import.meta.url),
        JSON.stringify(report, null, 2),
      );
      expect(report.attemptOverheadMs.p95).toBeLessThan(2_000);
    } finally {
      await worker.close();
      await t.close();
    }
  }, 700_000);
});
